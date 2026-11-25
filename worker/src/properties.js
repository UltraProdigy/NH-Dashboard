import { rest } from "./github.js";
import { orgManagerReady, orgManagerToken } from "./org-manager.js";
import { repoList } from "./release-manager.js";
import { readHistory, settleStep, writePending } from "./property-history.js";
import { MAX_WRITES, outcome, planBatch, stateFrom } from "../../web/js/properties-calc.js";

const LOCK_KEY = "properties_apply";
const LOCK_MS = 3 * 60_000;
const PACE_MS = 1000;
const MAX_CHANGES = 5000;

const orgOf = (env) => env.GITHUB_ORG ?? "GTNewHorizons";
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const runId = () => crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

async function readLock(db) {
  const row = await db.prepare("SELECT value FROM meta WHERE key = ?1").bind(LOCK_KEY).first().catch(() => null);
  try { return row ? JSON.parse(row.value) : null; } catch { return null; }
}

async function claim(db, state, now) {
  const res = await db
    .prepare(
      `INSERT INTO meta (key, value) VALUES (?1, ?2)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value
       WHERE json_extract(meta.value, '$.seen') < ?3`,
    )
    .bind(LOCK_KEY, JSON.stringify(state), now - LOCK_MS)
    .run();
  return (res?.meta?.changes ?? res?.changes ?? 0) > 0;
}

const touch = (db, run, now) =>
  db.prepare("UPDATE meta SET value = json_set(value, '$.seen', ?1) WHERE key = ?2 AND json_extract(value, '$.run') = ?3")
    .bind(now, LOCK_KEY, run).run().catch(() => {});

const unlock = (db, run) =>
  db.prepare("DELETE FROM meta WHERE key = ?1 AND json_extract(value, '$.run') = ?2").bind(LOCK_KEY, run).run().catch(() => {});

export async function propertiesState(env, { now = Date.now() } = {}) {
  const { status, body } = await repoList(env);
  if (status !== 200) return { status, body };
  const [history, lock] = await Promise.all([readHistory(env.DB), readLock(env.DB)]);
  return {
    status: 200,
    body: {
      ...body,
      history: history.rows,
      historyError: history.error,
      running: lock && lock.seen > now - LOCK_MS ? { by: lock.by, at: lock.at } : null,
    },
  };
}

function explainWrite(err) {
  const t = String(err);
  const m = t.match(/-> (\d{3}) ([\s\S]*)$/);
  if (m && (m[1] === "403" || m[1] === "404")) return "Org-Manager was refused. Check it has organization Custom properties: Admin and that the change was accepted on the installation";
  if (m) {
    let msg = m[2];
    try { msg = JSON.parse(m[2]).message ?? msg; } catch {}
    return `GitHub answered ${m[1]}: ${String(msg).slice(0, 160)}`;
  }
  return t.slice(0, 200);
}

const fail = (status, error) => ({ status, body: { error } });

/**
 * Plans the batch against a fresh read of GitHub and, if there is anything to
 * write, hands back a stream of progress lines. Errors before the stream starts
 * come back as ordinary JSON.
 */
export async function applyProperties(env, by, sent, { dryRun = false, ctx, now = Date.now(), pace = PACE_MS } = {}) {
  const changes = Array.isArray(sent?.changes) ? sent.changes : null;
  if (!changes?.length) return fail(400, "Nothing to apply");
  if (changes.length > MAX_CHANGES) return fail(400, `At most ${MAX_CHANGES} changes at once`);
  if (!dryRun && !orgManagerReady(env)) return fail(503, "ORG_MANAGER_APP_ID or ORG_MANAGER_PRIVATE_KEY not set");

  const run = runId();
  const at = new Date(now).toISOString();
  if (!(await claim(env.DB, { run, by, at, seen: now }, now))) {
    const other = await readLock(env.DB);
    return fail(409, `${other?.by ?? "Someone"} is applying property changes right now. Wait for it to finish`);
  }

  const read = await repoList(env);
  if (read.status !== 200 || read.body.propertiesError) {
    await unlock(env.DB, run);
    return fail(502, read.body.propertiesError ?? read.body.error ?? "GitHub couldn't be read");
  }
  const plan = planBatch(changes, stateFrom(read.body), { org: orgOf(env) });
  if (plan.writes > MAX_WRITES) {
    await unlock(env.DB, run);
    return fail(400, `That takes ${plan.writes} writes to GitHub and the limit is ${MAX_WRITES}. Apply it in smaller batches`);
  }
  const listed = (done) => [...outcome(plan, done)].map(([key, r]) => ({ key, ...r }));
  if (!plan.steps.length) {
    await unlock(env.DB, run);
    return { status: 200, body: { results: listed(new Map()), dry: dryRun } };
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const send = (obj) => writer.write(enc.encode(`${JSON.stringify(obj)}\n`)).catch(() => {});

  const job = (async () => {
    const done = new Map();
    try {
      send({ type: "start", total: plan.steps.length, dry: dryRun, at });
      let history = true;
      if (!dryRun) history = await writePending(env.DB, plan.steps, { batch: run, at, by }).then(() => true, () => false);
      let token = null;
      let tokenError = null;
      if (!dryRun) {
        try { token = await orgManagerToken(env); } catch (err) { tokenError = `Org-Manager couldn't sign in: ${String(err).slice(0, 160)}`; }
      }
      let wrote = 0;
      for (const s of plan.steps) {
        const waiting = [...s.needs].some((id) => done.get(id)?.state !== "done");
        let result;
        if (waiting) result = { state: "blocked" };
        else if (tokenError) result = { state: "failed", error: tokenError };
        else {
          if (wrote++ && !dryRun) await sleep(pace);
          try {
            if (!dryRun) await rest(s.path, token, { method: s.method, body: s.body ?? undefined });
            result = { state: "done" };
          } catch (err) {
            result = { state: "failed", error: explainWrite(err) };
          }
        }
        done.set(s.id, result);
        if (!dryRun && history) await settleStep(env.DB, run, s.id, result.state === "done").catch(() => {});
        await touch(env.DB, run, Date.now());
        send({ type: "step", id: s.id, label: s.label, ...result });
      }
      send({ type: "done", results: listed(done), dry: dryRun, history });
    } catch (err) {
      send({ type: "error", error: String(err).slice(0, 200), results: listed(done) });
    } finally {
      await unlock(env.DB, run);
      await writer.close().catch(() => {});
    }
  })();
  ctx?.waitUntil?.(job);
  return { status: 200, stream: readable, job };
}
