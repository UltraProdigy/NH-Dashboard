/**
 * The SQL issues panel must agree with the JavaScript one.
 *
 *   node --experimental-sqlite worker/test/issues.parity.test.js
 *
 * Written before the port, like the other two. What is different here is that
 * the rules come first and the panel second: `issues` is built on definitions —
 * what counts as resolved, unanswered, closed-by-whom — that the JavaScript
 * reads off a nested record and the SQL reads off flattened columns. Those are
 * two readings of one rule rather than one expression in two syntaxes, so they
 * are checked directly, row by row, before anything aggregates them.
 *
 * The panel comparison skips politely until `worker/src/panels/issues.js`
 * exists, so this file is useful from the moment the rules land.
 *
 * Needs `worker/seed.sql` and `data/dashboard.json`, and skips without either.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import * as R from "../../src/shared/issue-rules.js";
import * as M from "../../src/panels/issueMetrics.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const SEED = path.join(HERE, "..", "seed.sql");
const SCHEMA = path.join(HERE, "..", "schema.sql");
const EXPECTED = path.join(ROOT, "data", "dashboard.json");
const PANEL = path.join(HERE, "..", "src", "panels", "issues.js");

let pass = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ok    ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function load() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(SCHEMA, "utf8"));
  db.exec("BEGIN");
  db.exec(readFileSync(SEED, "utf8"));
  db.exec("COMMIT");
  return db;
}

/**
 * Every rule, against every issue in the seed.
 *
 * Aggregates hide disagreement — two definitions of "unanswered" that differ on
 * eleven issues produce two plausible totals. Comparing per row means a
 * difference names the issue it happens on.
 */
async function checkRules(db) {
  const { readStore } = await import("../../src/ingest/issues.js");

  const rows = db
    .prepare(
      `SELECT repo, number, closed_at,
              ${R.unresolvedSql()}            AS unresolved,
              ${R.completedSql()}             AS completed,
              ${R.unknownReasonSql()}         AS unknown_reason,
              ${R.unansweredSql()}            AS unanswered,
              ${R.closerSql()}                AS closer,
              ${R.fixerSql()}                 AS fixer,
              ${R.closerUnknownSql()}         AS closer_unknown,
              ${R.emptyJsonSql("labels")}     AS no_labels,
              ${R.emptyJsonSql("assignees")}  AS no_assignees
         FROM issues`,
    )
    .all();

  const byKey = new Map(rows.map((r) => [`${r.repo}#${r.number}`, r]));
  const store = await readStore();
  const diffs = new Map();
  const note = (rule, detail) => {
    if (!diffs.has(rule)) diffs.set(rule, []);
    diffs.get(rule).push(detail);
  };

  for (const i of store) {
    const r = byKey.get(`${i.repo}#${i.number}`);
    if (!r) { note("present in D1", `${i.repo}#${i.number}`); continue; }
    const eq = (rule, js, sql) => {
      if (js !== sql) note(rule, `${i.repo}#${i.number}: js=${js} sql=${sql}`);
    };

    eq("unresolved", M.UNRESOLVED.has(i.stateReason), r.unresolved === 1);
    eq("unanswered", M.isUnanswered(i), r.unanswered === 1);
    eq("closer", M.closerOf(i) ?? null, r.closer ?? null);
    eq("fixer", M.fixerOf(i) ?? null, r.fixer ?? null);
    eq("closerUnknown", M.closerUnknown(i), r.closer_unknown === 1);
    eq("unlabelled", (i.labels ?? []).length === 0, r.no_labels === 1);
    eq("unassigned", (i.assignees ?? []).length === 0, r.no_assignees === 1);

    if (i.closedAt) {
      const completed = !M.UNRESOLVED.has(i.stateReason);
      eq("completed", completed, r.completed === 1);
      eq("unknownReason", completed && i.stateReason !== "COMPLETED",
         r.unknown_reason === 1);
    }
  }

  check(
    `every rule agrees across ${store.length} issues`,
    diffs.size === 0,
    [...diffs].map(([k, v]) => `${k} ×${v.length} (${v[0]})`).join("; "),
  );
}

/**
 * The cases the real store cannot exercise.
 *
 * `closer_known` is 1 on all 26,161 records today, so the store agrees with any
 * implementation of `closerUnknown` including a wrong one. The rule exists for
 * records written before the ingest learned to ask — reading their silence as
 * "closed by nobody" would report a store awaiting a re-walk as a team that
 * never closes anything — so the branch that matters is the one no row takes.
 *
 * Same for a NULL `state_reason` on a closed issue, which `unknownReason`
 * counts and which the backfill has so far made unobservable.
 */
function checkSyntheticEdges(db) {
  db.exec(`
    INSERT INTO issues (repo, number, created_at, updated_at, state, closed_at,
                        state_reason, closer_known, closed_by, response_unknown)
    VALUES ('t', 1, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z', 'CLOSED',
            '2020-01-02T00:00:00Z', 'COMPLETED', 0, NULL, 0),
           ('t', 2, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z', 'CLOSED',
            '2020-01-02T00:00:00Z', NULL, 1, 'someone', 0),
           ('t', 3, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z', 'OPEN',
            NULL, NULL, 0, NULL, 1)`);

  const row = (n) =>
    db
      .prepare(
        `SELECT ${R.closerUnknownSql()}  AS closer_unknown,
                ${R.completedSql()}      AS completed,
                ${R.unknownReasonSql()}  AS unknown_reason,
                ${R.unansweredSql()}     AS unanswered
           FROM issues WHERE repo = 't' AND number = ?`,
      )
      .get(n);

  const a = row(1);
  check("closed with closer_known 0 reads as unknown closer",
        a.closer_unknown === 1);
  check("an explicit COMPLETED is not an unknown reason",
        a.unknown_reason === 0);

  const b = row(2);
  check("a NULL close reason counts as completed", b.completed === 1);
  check("a NULL close reason counts as an unknown reason",
        b.unknown_reason === 1);
  check("closer_known 1 is not an unknown closer", b.closer_unknown === 0);

  const c = row(3);
  check("an open issue is never an unknown closer", c.closer_unknown === 0);
  check("response_unknown is not the same as unanswered", c.unanswered === 0);

  db.exec("DELETE FROM issues WHERE repo = 't'");
}

async function main() {
  if (!existsSync(SEED) || !existsSync(EXPECTED)) {
    console.log("\nskipped: needs worker/seed.sql and data/dashboard.json\n");
    return;
  }

  console.log("\nissues: SQL against JavaScript\n");
  const db = load();

  await checkRules(db);
  checkSyntheticEdges(db);

  if (!existsSync(PANEL)) {
    console.log("\n  (panel not ported yet — rules checked, output not)\n");
  }

  db.close();
  console.log(`\n${pass} passed, ${failures.length} failed\n`);
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
