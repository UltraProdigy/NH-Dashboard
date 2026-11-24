import { githubDef, normDef, sameValue, storedValue } from "../../web/js/properties-calc.js";

export const PROPERTY_EVENTS = new Set(["custom_property", "custom_property_values"]);

const WINDOW_MS = 10 * 60_000;
const READ_LIMIT = 300;
const ROWS_PER_INSERT = 8;
const COLS = "at, repo, property, before, after, by, source, note, batch, step, state";

const missing = (err) => /no such table/i.test(String(err));

export async function readHistory(db, limit = READ_LIMIT) {
  try {
    const { results } = await db
      .prepare(`SELECT id, at, repo, property, before, after, by, source, note FROM property_history
                 WHERE state = 'done' ORDER BY id DESC LIMIT ?1`)
      .bind(limit)
      .all();
    return { rows: results, error: null };
  } catch (err) {
    return { rows: [], error: missing(err) ? "History is off until migration 011 is applied to D1." : "History couldn't be read." };
  }
}

async function insertRows(db, rows) {
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    const chunk = rows.slice(i, i + ROWS_PER_INSERT);
    const marks = chunk.map((_, r) => `(${Array.from({ length: 11 }, (_, c) => `?${r * 11 + c + 1}`).join(", ")})`).join(", ");
    const params = chunk.flatMap((row) => [row.at, row.repo ?? null, row.property, row.before ?? null, row.after ?? null, row.by, row.source, row.note ?? null, row.batch ?? null, row.step ?? null, row.state ?? "done"]);
    await db.prepare(`INSERT INTO property_history (${COLS}) VALUES ${marks}`).bind(...params).run();
  }
}

/** Written before any GitHub call, so the webhook echo of each write finds its row. */
export async function writePending(db, steps, { batch, at, by }) {
  const rows = steps.flatMap((s) => s.rows.map((r) => ({ ...r, at, by, source: "dashboard", batch, step: s.id, state: "pending" })));
  if (rows.length) await insertRows(db, rows);
  return rows.length;
}

export async function settleStep(db, batch, step, ok) {
  const sql = ok
    ? "UPDATE property_history SET state = 'done' WHERE batch = ?1 AND step = ?2"
    : "DELETE FROM property_history WHERE batch = ?1 AND step = ?2";
  await db.prepare(sql).bind(batch, step).run();
}

const isBot = (p) => p?.sender?.type === "Bot";

async function dashboardRow(db, property, repo, after, now) {
  const since = new Date(now - WINDOW_MS).toISOString();
  return db
    .prepare(`SELECT by FROM property_history
               WHERE source = 'dashboard' AND property = ?1 AND at >= ?2
                 AND (repo IS NULL OR (repo = ?3 AND after IS ?4))
               ORDER BY id DESC LIMIT 1`)
    .bind(property, since, repo, after)
    .first();
}

function changedValues(p) {
  const before = new Map((p.old_property_values ?? []).map((v) => [v.property_name, v.value]));
  const after = new Map((p.new_property_values ?? []).map((v) => [v.property_name, v.value]));
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((n) => !sameValue(before.get(n), after.get(n)))
    .map((n) => ({ property: n, before: storedValue(before.get(n)), after: storedValue(after.get(n)) }));
}

const definitionOf = (p) => (p.definition?.property_name ? p.definition : null);

/** Only a bot can be the dashboard's own echo: Org-Manager makes every dashboard write. */
export async function propertyAttribution(db, event, p, now = Date.now()) {
  if (!db || !isBot(p)) return null;
  try {
    if (event === "custom_property") {
      const def = definitionOf(p);
      return def ? (await dashboardRow(db, def.property_name, null, null, now))?.by ?? null : null;
    }
    const repo = p.repository?.name;
    for (const c of changedValues(p)) {
      const hit = await dashboardRow(db, c.property, repo, c.after, now);
      if (hit) return hit.by;
    }
  } catch {}
  return null;
}

export async function onCustomPropertyValues(db, p, now = Date.now()) {
  const repo = p.repository?.name;
  if (!repo) return { skipped: "no repo" };
  const changed = changedValues(p);
  if (!changed.length) return { skipped: "no change" };
  try {
    const rows = [];
    for (const c of changed) {
      if (isBot(p) && (await dashboardRow(db, c.property, repo, c.after, now))) continue;
      rows.push({ ...c, at: new Date(now).toISOString(), repo, by: p.sender?.login ?? "unknown", source: "github" });
    }
    if (!rows.length) return { skipped: "dashboard echo" };
    await insertRows(db, rows);
    return { table: "property_history", repo, logged: rows.length };
  } catch (err) {
    if (missing(err)) return { skipped: "no property_history table" };
    throw err;
  }
}

export async function onCustomProperty(db, p, now = Date.now()) {
  const def = definitionOf(p);
  if (!def || !["created", "updated", "deleted"].includes(p.action)) return { skipped: "not a definition change" };
  try {
    if (isBot(p) && (await dashboardRow(db, def.property_name, null, null, now))) return { skipped: "dashboard echo" };
    await insertRows(db, [{
      at: new Date(now).toISOString(),
      repo: null,
      property: def.property_name,
      before: null,
      after: p.action === "deleted" ? null : JSON.stringify(githubDef(normDef(def))),
      by: p.sender?.login ?? "unknown",
      source: "github",
      note: p.action,
    }]);
    return { table: "property_history", property: def.property_name, action: p.action };
  } catch (err) {
    if (missing(err)) return { skipped: "no property_history table" };
    throw err;
  }
}
