import { appReady, installationToken, rest } from "./github.js";
import { orgManagerReady, orgManagerToken } from "./org-manager.js";

const REPO = "DreamAssemblerXXL";
const WORKFLOW = "daily-modpack-build.yml";
const REF = "master";
const LOG_KEY = "daily_release_log";
const LOG_SIZE = 20;
const COOLDOWN_MS = 2 * 60_000;
const RUNNING = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);

const orgOf = (env) => env.GITHUB_ORG ?? "GTNewHorizons";
const workflowApi = (org) => `/repos/${org}/${REPO}/actions/workflows/${WORKFLOW}`;
export const workflowPage = (org) => `https://github.com/${org}/${REPO}/actions/workflows/${WORKFLOW}`;

async function readLog(db) {
  try {
    const row = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(LOG_KEY).first();
    const log = row ? JSON.parse(row.value) : [];
    return Array.isArray(log) ? log : [];
  } catch {
    return [];
  }
}

async function writeLog(db, log) {
  await db
    .prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    )
    .bind(LOG_KEY, JSON.stringify(log.slice(0, LOG_SIZE)))
    .run();
}

const runView = (run) =>
  run && {
    number: run.run_number,
    status: run.status,
    conclusion: run.conclusion ?? null,
    event: run.event,
    actor: run.triggering_actor?.login ?? run.actor?.login ?? null,
    startedAt: run.run_started_at ?? run.created_at,
    url: run.html_url,
  };

async function recentRuns(env) {
  if (!appReady(env)) return { runs: [], error: "GH_APP_ID or GH_APP_PRIVATE_KEY not set" };
  try {
    const token = await installationToken(env);
    const res = await rest(`${workflowApi(orgOf(env))}/runs?per_page=5`, token);
    return { runs: (await res.json()).workflow_runs ?? [], error: null };
  } catch (err) {
    return { runs: [], error: String(err) };
  }
}

async function snapshot(env) {
  const [{ runs, error }, log] = await Promise.all([recentRuns(env), readLog(env.DB)]);
  return {
    ready: orgManagerReady(env),
    workflowUrl: workflowPage(orgOf(env)),
    running: runView(runs.find((r) => RUNNING.has(r.status))) ?? null,
    latest: runView(runs[0]) ?? null,
    log,
    error,
  };
}

export async function dailyStatus(env) {
  const s = await snapshot(env);
  return { ...s, log: s.log.slice(0, 5) };
}

function explain(err) {
  const text = String(err);
  if (/installation -> 404/.test(text)) return "Org-Manager isn't installed on the org";
  if (/dispatches -> 40[34]/.test(text))
    return "Org-Manager can't run workflows in DreamAssemblerXXL. Check it has Actions: Read and write, accepted on the installation, and that the repo is in its list";
  return text;
}

export async function releaseDaily(env, by, { force = false, dryRun = false, now = Date.now() } = {}) {
  if (!dryRun && !orgManagerReady(env)) {
    return { status: 503, body: { error: "ORG_MANAGER_APP_ID or ORG_MANAGER_PRIVATE_KEY not set" } };
  }

  const s = await snapshot(env);
  const recent = s.log.find((e) => !e.dryRun && now - Date.parse(e.at) < COOLDOWN_MS);
  if (recent) {
    const seconds = Math.max(1, Math.round((now - Date.parse(recent.at)) / 1000));
    return { status: 429, body: { error: `${recent.by} released one ${seconds}s ago` } };
  }
  if (s.running && !force) {
    return { status: 409, body: { error: `build #${s.running.number} is still running`, running: s.running } };
  }

  if (!dryRun) {
    try {
      const token = await orgManagerToken(env, now);
      await rest(`${workflowApi(orgOf(env))}/dispatches`, token, { method: "POST", body: { ref: REF } });
    } catch (err) {
      console.error(JSON.stringify({ at: "daily-release", by, error: String(err) }));
      return { status: 502, body: { error: explain(err) } };
    }
  }

  const entry = {
    at: new Date(now).toISOString(),
    by,
    ...(s.running ? { alongside: s.running.number } : {}),
    ...(dryRun ? { dryRun: true } : {}),
  };
  await writeLog(env.DB, [entry, ...s.log]);
  console.log(JSON.stringify({ at: "daily-release", ...entry }));
  return { status: 200, body: { ok: true, entry, workflowUrl: s.workflowUrl } };
}
