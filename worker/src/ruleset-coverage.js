import { installationToken, rest } from "./github.js";

// Reading org rulesets directly needs organization Administration write, so
// coverage is read per repo instead, cached here, and only re-read where
// something changed.
const CACHE_KEY = "properties_rulesets";
const DIRTY = "properties_rulesets_dirty:";
const LOCK_KEY = "properties_rulesets_scan";
const LOCK_MS = 2 * 60_000;
export const RATE_FLOOR = 4000;
const WORKERS = 16;
const NO_RULESETS = /Upgrade to GitHub Pro/i;

const orgOf = (env) => env.GITHUB_ORG ?? "GTNewHorizons";
const parse = (row) => { try { return row ? JSON.parse(row.value) : null; } catch { return null; } };

export async function markRulesetsDirty(db, repo = "*", now = Date.now()) {
  try {
    await db.prepare("INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .bind(DIRTY + repo, String(now)).run();
  } catch {}
}

async function readAll(db) {
  const [cache, dirty, lock] = await Promise.all([
    db.prepare("SELECT value FROM meta WHERE key = ?1").bind(CACHE_KEY).first().catch(() => null),
    db.prepare("SELECT key, value FROM meta WHERE key >= ?1 AND key < ?2").bind(DIRTY, `${DIRTY}￿`).all().catch(() => ({ results: [] })),
    db.prepare("SELECT value FROM meta WHERE key = ?1").bind(LOCK_KEY).first().catch(() => null),
  ]);
  return {
    cache: parse(cache),
    dirty: new Set((dirty.results ?? []).map((r) => r.key.slice(DIRTY.length))),
    lock: parse(lock),
  };
}

function propertiesOf(detail) {
  const cond = detail?.conditions;
  if (!cond || typeof cond !== "object") return null;
  const p = cond.repository_property ?? {};
  return ["include", "exclude"].flatMap((side) => (p[side] ?? []).filter((c) => c?.name).map((c) => ({ name: c.name, side, values: c.property_values ?? [] })));
}

async function scan(env, need, { all, startedAt }) {
  const db = env.DB;
  const claimed = await db
    .prepare(
      `INSERT INTO meta (key, value) VALUES (?1, ?2)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value
       WHERE json_extract(meta.value, '$.seen') < ?3`,
    )
    .bind(LOCK_KEY, JSON.stringify({ seen: startedAt }), startedAt - LOCK_MS)
    .run()
    .then((r) => (r?.meta?.changes ?? r?.changes ?? 0) > 0, () => false);
  if (!claimed) return { skipped: "already scanning" };
  const org = orgOf(env);
  const { cache: old } = await readAll(db);
  const cache = { at: old?.at ?? null, repos: { ...(old?.repos ?? {}) }, rulesets: { ...(old?.rulesets ?? {}) }, skipped: null, failed: [] };
  try {
    const token = await installationToken(env);
    const left = (await (await rest("/rate_limit", token)).json())?.resources?.core?.remaining ?? 0;
    if (left - need.length < RATE_FLOOR) {
      await save(db, { ...cache, failed: old?.failed ?? [], skipped: { at: new Date(startedAt).toISOString(), remaining: left } });
      return { skipped: "rate limit", remaining: left };
    }
    const queue = [...need];
    const done = [];
    let low = null;
    await Promise.all(Array.from({ length: WORKERS }, async () => {
      for (let repo; low == null && (repo = queue.shift()); ) {
        try {
          const res = await rest(`/repos/${org}/${encodeURIComponent(repo)}/rulesets?includes_parents=true&per_page=100`, token);
          const ids = (await res.json()).filter((r) => r.source_type === "Organization").map((r) => r.id);
          cache.repos[repo] = ids;
          done.push(repo);
          const remaining = Number(res.headers.get("x-ratelimit-remaining"));
          if (Number.isFinite(remaining) && remaining < RATE_FLOOR) low = remaining;
        } catch (err) {
          if (NO_RULESETS.test(String(err))) { cache.repos[repo] = []; done.push(repo); }
          else cache.failed.push(repo);
        }
      }
    }));

    const complete = low == null && !cache.failed.length;
    if (all && complete) for (const repo of Object.keys(cache.repos)) if (!need.includes(repo)) delete cache.repos[repo];
    const used = new Set(Object.values(cache.repos).flat());
    for (const id of Object.keys(cache.rulesets)) if (!used.has(Number(id))) delete cache.rulesets[id];
    for (const id of used) {
      if (cache.rulesets[id] && !all) continue;
      const via = Object.keys(cache.repos).find((r) => cache.repos[r].includes(id));
      try {
        const d = await (await rest(`/repos/${org}/${encodeURIComponent(via)}/rulesets/${id}?includes_parents=true`, token)).json();
        cache.rulesets[id] = { name: d.name ?? `ruleset ${id}`, enforcement: d.enforcement ?? null, target: d.target ?? null, properties: propertiesOf(d), url: `https://github.com/organizations/${org}/settings/rules/${id}` };
      } catch {
        cache.rulesets[id] ??= { name: `ruleset ${id}`, enforcement: null, target: null, properties: null, url: `https://github.com/organizations/${org}/settings/rules/${id}` };
      }
    }
    cache.at = new Date(startedAt).toISOString();
    if (low != null) cache.skipped = { at: cache.at, remaining: low };
    await save(db, cache);
    for (const repo of done) {
      await db.prepare("DELETE FROM meta WHERE key = ?1 AND CAST(value AS INTEGER) <= ?2").bind(DIRTY + repo, startedAt).run().catch(() => {});
    }
    if (all && complete) await db.prepare("DELETE FROM meta WHERE key = ?1 AND CAST(value AS INTEGER) <= ?2").bind(`${DIRTY}*`, startedAt).run().catch(() => {});
    return { scanned: done.length, failed: cache.failed.length, low };
  } catch (err) {
    await save(db, { ...cache, failed: need, skipped: null, error: String(err).slice(0, 160) }).catch(() => {});
    return { error: String(err).slice(0, 160) };
  } finally {
    await db.prepare("DELETE FROM meta WHERE key = ?1").bind(LOCK_KEY).run().catch(() => {});
  }
}

const save = (db, cache) =>
  db.prepare("INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .bind(CACHE_KEY, JSON.stringify(cache)).run();

/**
 * What's cached, and a background scan of whatever is new or marked changed.
 * `force` re-reads every repo.
 */
export async function rulesetCoverage(env, ctx, repos, { force = false, now = Date.now() } = {}) {
  const { cache, dirty, lock } = await readAll(env.DB);
  const names = [...new Set(repos)];
  const all = force || !cache?.at || dirty.has("*");
  const need = all ? names : names.filter((n) => !(n in (cache?.repos ?? {})) || dirty.has(n));
  const running = Boolean(lock && lock.seen > now - LOCK_MS);
  let job = null;
  if (need.length && !running && ctx?.waitUntil) {
    job = scan(env, need, { all, startedAt: now });
    ctx.waitUntil(job);
  }
  const active = new Set(names);
  const covered = Object.fromEntries(Object.entries(cache?.repos ?? {}).filter(([r, ids]) => active.has(r) && ids.length));
  return {
    coverage: { repos: covered, rulesets: cache?.rulesets ?? {} },
    scan: {
      state: running || job ? "scanning" : !cache?.at ? "none" : cache.skipped ? "skipped" : "ready",
      at: cache?.at ?? null,
      pending: need.length,
      remaining: cache?.skipped?.remaining ?? null,
      failed: (cache?.failed ?? []).length,
      error: cache?.error ?? null,
    },
    job,
  };
}
