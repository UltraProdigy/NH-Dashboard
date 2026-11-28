import { applyFilterOp, checkFilterOp, normaliseFilters } from "../../web/js/dream-filter-rules.js";

const KEY = "dream_filters";
const STAMP_KEY = "dream_filters_at";
const TRIES = 5;

async function readRow(db) {
  return db.prepare("SELECT value FROM meta WHERE key = ?").bind(KEY).first();
}

function parse(row) {
  try {
    return normaliseFilters(row ? JSON.parse(row.value) : null);
  } catch {
    return normaliseFilters(null);
  }
}

async function readStamp(db) {
  return (await db.prepare("SELECT value FROM meta WHERE key = ?").bind(STAMP_KEY).first())?.value ?? null;
}

export async function dreamFilters(env) {
  const [row, stamp] = await Promise.all([readRow(env.DB), readStamp(env.DB)]);
  return { status: 200, body: { filters: parse(row), stamp } };
}

// Compare-and-swap on the whole value, so two admins ticking at once both land.
export async function changeDreamFilter(env, sent, { now = Date.now() } = {}) {
  const problem = checkFilterOp(sent);
  if (problem) return { status: 400, body: { error: problem } };
  for (let i = 0; i < TRIES; i++) {
    const row = await readRow(env.DB);
    const next = JSON.stringify(applyFilterOp(parse(row), sent));
    const res = row
      ? await env.DB.prepare("UPDATE meta SET value = ? WHERE key = ? AND value = ?").bind(next, KEY, row.value).run()
      : await env.DB.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").bind(KEY, next).run();
    if (res.meta?.changes ?? res.changes) {
      const stamp = new Date(now).toISOString();
      await env.DB
        .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
        .bind(STAMP_KEY, stamp)
        .run();
      return { status: 200, body: { filters: JSON.parse(next), stamp } };
    }
  }
  return { status: 409, body: { error: "the filters kept changing underneath this edit, try again" } };
}
