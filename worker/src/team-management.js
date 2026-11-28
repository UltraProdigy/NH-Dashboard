/**
 * What Team Management adds on top of the permissions snapshot: team history,
 * when each person was last active, open review requests, and the shared
 * exclusion lists for the Developers ⇄ Hiatus panels. Changes to teams still go
 * through the Permissions page's apply route.
 */

import { LOG_NAME } from "./event-log.js";
import { permissionsStub } from "./permissions.js";
import { scopedDb } from "./scope.js";
import { lastActive } from "./team-activity.js";
import { validLogin } from "../../web/js/permission-changes.js";

const KEY = "team_exclusions";
const STAMP_KEY = "team_exclusions_at";
const TRIES = 5;
const MAX_NOTE = 200;
export const EXCLUSION_PANELS = ["inactive", "hiatus"];

export const teamConfig = (env) => ({
  developers: env?.DEVELOPERS_TEAM ?? "developers",
  hiatus: env?.HIATUS_TEAM ?? "developers-on-hiatus",
  inactiveDays: Number(env?.INACTIVE_DAYS ?? 365),
  returnDays: Number(env?.RETURN_DAYS ?? 30),
});

export function normaliseExclusions(raw) {
  const out = {};
  for (const panel of EXCLUSION_PANELS) {
    out[panel] = {};
    for (const [login, v] of Object.entries(raw?.[panel] ?? {})) {
      if (!validLogin(login)) continue;
      out[panel][login] = { by: typeof v?.by === "string" ? v.by : null, at: typeof v?.at === "string" ? v.at : null, note: typeof v?.note === "string" ? v.note.slice(0, MAX_NOTE) : "" };
    }
  }
  return out;
}

export function checkExclusionOp(op) {
  if (!EXCLUSION_PANELS.includes(op?.panel)) return "unknown panel";
  if (!validLogin(op.login)) return "not a GitHub login";
  if (typeof op.on !== "boolean") return "on must be true or false";
  if (op.note != null && (typeof op.note !== "string" || op.note.length > MAX_NOTE)) return `a note is at most ${MAX_NOTE} characters`;
  return null;
}

export function applyExclusionOp(list, op, { by, at }) {
  const next = normaliseExclusions(list);
  const panel = next[op.panel];
  const have = Object.keys(panel).find((l) => l.toLowerCase() === op.login.toLowerCase());
  const before = have ? panel[have] : null;
  if (have) delete panel[have];
  if (op.on) panel[have ?? op.login] = { by, at, note: (op.note ?? before?.note ?? "").trim() };
  return next;
}

const readRow = (db) => db.prepare("SELECT value FROM meta WHERE key = ?").bind(KEY).first();
const parse = (row) => {
  try { return normaliseExclusions(row ? JSON.parse(row.value) : null); } catch { return normaliseExclusions(null); }
};

export async function readExclusions(env) {
  const [row, stamp] = await Promise.all([readRow(env.DB), env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(STAMP_KEY).first()]);
  return { exclusions: parse(row), stamp: stamp?.value ?? null };
}

// Compare-and-swap on the whole value, the same as the Dream Panel filters.
export async function changeExclusion(env, by, sent, { now = Date.now() } = {}) {
  const problem = checkExclusionOp(sent);
  if (problem) return { status: 400, body: { error: problem } };
  const at = new Date(now).toISOString();
  for (let i = 0; i < TRIES; i++) {
    const row = await readRow(env.DB);
    const next = JSON.stringify(applyExclusionOp(parse(row), sent, { by, at }));
    const res = row
      ? await env.DB.prepare("UPDATE meta SET value = ? WHERE key = ? AND value = ?").bind(next, KEY, row.value).run()
      : await env.DB.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").bind(KEY, next).run();
    if (res.meta?.changes ?? res.changes) {
      await env.DB.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(STAMP_KEY, at).run();
      return { status: 200, body: { exclusions: JSON.parse(next), stamp: at } };
    }
  }
  return { status: 409, body: { error: "the list kept changing underneath this edit, try again" } };
}

const REQUESTS = `SELECT repo, number, title, author, created_at, updated_at, is_draft, review_requests, team_review_requests
  FROM pull_requests WHERE state = 'OPEN' AND (review_requests <> '[]' OR team_review_requests <> '[]')`;
const REQUESTS_OLD = `SELECT repo, number, title, author, created_at, updated_at, is_draft, review_requests, '[]' AS team_review_requests
  FROM pull_requests WHERE state = 'OPEN' AND review_requests <> '[]'`;

const list = (v) => {
  try { const x = JSON.parse(v ?? "[]"); return Array.isArray(x) ? x : []; } catch { return []; }
};

// Open pull requests waiting on a review from a team or a person. Without migration 013, people only.
export async function reviewRequests(env) {
  const db = scopedDb(env.DB, env);
  let teams = true;
  let results;
  try {
    ({ results } = await db.prepare(REQUESTS).all());
  } catch (err) {
    if (!/team_review_requests/.test(String(err))) throw err;
    teams = false;
    ({ results } = await db.prepare(REQUESTS_OLD).all());
  }
  return {
    teams,
    prs: results.map((r) => ({
      repo: r.repo, number: r.number, title: r.title, author: r.author, created: r.created_at, updated: r.updated_at,
      draft: Boolean(r.is_draft), people: list(r.review_requests), teams: list(r.team_review_requests),
    })),
  };
}

async function fromObject(stub, url, init) {
  const res = await stub.fetch(url, init);
  if (!res.ok) throw new Error(`${new URL(url).pathname} ${res.status}`);
  return res.json();
}

const settle = async (problems, name, work, fallback) => {
  try {
    return await work();
  } catch (err) {
    problems.push({ part: name, error: String(err?.message ?? err).slice(0, 200) });
    return fallback;
  }
};

export async function teamsState(env) {
  if (!env.PERMISSIONS) return { status: 503, body: { error: "permissions not bound" } };
  const stub = permissionsStub(env);
  let snapshot;
  try {
    snapshot = await fromObject(stub, "https://permissions/snapshot");
  } catch {
    return { status: 502, body: { error: "permissions unavailable" } };
  }
  const logins = new Set(Object.keys(snapshot.org?.members ?? {}));
  for (const t of Object.values(snapshot.teams ?? {})) for (const l of Object.keys(t.members ?? {})) logins.add(l);
  const people = [...logins];
  const problems = [];
  const [history, activity, seen, requests, excl] = await Promise.all([
    settle(problems, "history", () => fromObject(stub, "https://permissions/teams"), { historySince: null, history: [], since: {} }),
    settle(problems, "activity", () => lastActive(env.DB, people, { exclude: env.NH_INGEST_EXCLUDE }), { people: {}, missing: [] }),
    settle(problems, "seen", async () => (env.EVENT_LOG
      ? fromObject(env.EVENT_LOG.get(env.EVENT_LOG.idFromName(LOG_NAME)), "https://event-log/seen", { method: "POST", body: JSON.stringify({ logins: people }) })
      : {}), {}),
    settle(problems, "review requests", () => reviewRequests(env), { teams: false, prs: [] }),
    settle(problems, "exclusions", () => readExclusions(env), { exclusions: normaliseExclusions(null), stamp: null }),
  ]);
  return {
    status: 200,
    body: {
      config: teamConfig(env),
      ...history,
      activity: activity.people,
      activityMissing: activity.missing,
      seen,
      requests,
      exclusions: excl.exclusions,
      exclusionsAt: excl.stamp,
      problems,
    },
  };
}
