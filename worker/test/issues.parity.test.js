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
 *
 * And the same for `fixer`'s pull-request test. Deleting it from `fixerSql`
 * passes every assertion in this file against the real seed, because the 386
 * `commit` and `projectv2` closes all carry a NULL author — not by rule, but
 * because `closure()` in the ingest only reads an author off the PullRequest
 * branch. That makes a rule in this file rest on a property of a different
 * file, so the day the ingest learns to record who wrote the closing commit,
 * the SQL would start crediting fixers the JavaScript does not. Rows 4–6 take
 * the branch the store cannot.
 */
function checkSyntheticEdges(db) {
  db.exec(`
    INSERT INTO issues (repo, number, created_at, updated_at, state, closed_at,
                        state_reason, closer_known, closed_by, response_unknown,
                        closed_via_kind, closed_via_author)
    VALUES ('t', 1, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z', 'CLOSED',
            '2020-01-02T00:00:00Z', 'COMPLETED', 0, NULL, 0, NULL, NULL),
           ('t', 2, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z', 'CLOSED',
            '2020-01-02T00:00:00Z', NULL, 1, 'someone', 0, NULL, NULL),
           ('t', 3, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z', 'OPEN',
            NULL, NULL, 0, NULL, 1, NULL, NULL),
           ('t', 4, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z', 'CLOSED',
            '2020-01-02T00:00:00Z', 'COMPLETED', 1, 'presser', 0,
            'commit', 'committer'),
           ('t', 5, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z', 'CLOSED',
            '2020-01-02T00:00:00Z', 'COMPLETED', 1, 'presser', 0,
            'pr', 'fixer-person'),
           ('t', 6, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z', 'CLOSED',
            '2020-01-02T00:00:00Z', 'COMPLETED', 1, 'presser', 0,
            'pr', 'dependabot')`);

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

  const credit = (n) =>
    db
      .prepare(
        `SELECT ${R.closerSql()} AS closer, ${R.fixerSql()} AS fixer
           FROM issues WHERE repo = 't' AND number = ?`,
      )
      .get(n);

  const viaCommit = credit(4);
  check("a commit close credits no fixer even when it names an author",
        viaCommit.fixer === null || viaCommit.fixer === undefined);
  check("a commit close still credits the person who pressed the button",
        viaCommit.closer === "presser");

  const viaPr = credit(5);
  check("a pull request close credits its author as the fixer",
        viaPr.fixer === "fixer-person");

  const viaBotPr = credit(6);
  check("a bot's pull request credits no fixer",
        viaBotPr.fixer === null || viaBotPr.fixer === undefined);

  /*
   * Which of two same-second issues counts as somebody's first.
   *
   * Three authors in this store filed more than one issue inside one second,
   * and on every one of them `repo || '#' || number` and `(repo, number)` pick
   * the same winner — so the store agrees with both orderings and cannot tell
   * them apart. They differ exactly when two numbers in one repo have
   * different digit counts: `t#9` sorts after `t#10` as a string and before it
   * as a number. That pair does not exist in the store, so it is built here.
   *
   * The winner decides `newReporters`, which is a count on the series chart.
   */
  db.exec(`
    INSERT INTO issues (repo, number, created_at, updated_at, state, author)
    VALUES ('t', 9,  '2021-05-05T00:00:00Z', '2021-05-05T00:00:00Z', 'OPEN', 'digits'),
           ('t', 10, '2021-05-05T00:00:00Z', '2021-05-05T00:00:00Z', 'OPEN', 'digits')`);

  const winner = db
    .prepare(
      `SELECT repo, number FROM issues
        WHERE author = 'digits'
        ORDER BY ${R.firstIssueOrderSql()}
        LIMIT 1`,
    )
    .get();

  const byId = [
    { repo: "t", number: 9 },
    { repo: "t", number: 10 },
  ].sort((a, b) => {
    const ka = R.issueId(a.repo, a.number);
    const kb = R.issueId(b.repo, b.number);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  })[0];

  check(
    "the first-issue tiebreak agrees with issueId where digit counts differ",
    winner.number === byId.number,
    `sql picked #${winner.number}, issueId picked #${byId.number}`,
  );

  db.exec("DELETE FROM issues WHERE repo = 't'");
}

/**
 * The panel's output against the build's, key by key.
 *
 * `issues` is going in in slices, so the panel names the keys it answers for in
 * `PORTED` and this compares exactly those. The last assertion is the one that
 * makes that safe: every key the build produces must be either ported or on
 * `PENDING`, so a key cannot fall between the two lists and go unnoticed —
 * which, on a panel with fifteen of them, is the likeliest way one gets lost.
 *
 * `now` is pinned to the build's own `generatedAt`. Half these numbers are day
 * counts measured from the moment the panel ran, and comparing a list sorted by
 * age against one built hours later would differ everywhere for no reason.
 */
async function checkPanel(db) {
  const { issues, PORTED, TOTALS_PENDING, byOpenThenRepo } = await import(
    "../src/panels/issues.js"
  );

  const built = JSON.parse(readFileSync(EXPECTED, "utf8"));
  const expected = built.panels.issues.data;
  const now = Date.parse(built.generatedAt);

  const actual = await issues(promised(db), now);

  const PENDING = [];

  for (const key of PORTED) {
    if (key === "totals") continue;
    const diff = firstDiff(expected[key], actual[key], key);
    check(`${key} matches the build`, diff === null, diff ?? "");
  }

  // Compared field by field rather than as a whole, because two of them belong
  // to a later slice and a whole-object diff would report the panel as wrong
  // fifteen times over for the two it does not claim yet.
  const totalsMissing = [];
  for (const [field, want] of Object.entries(expected.totals)) {
    if (TOTALS_PENDING.includes(field)) continue;
    if (!(field in actual.totals)) { totalsMissing.push(field); continue; }
    const diff = firstDiff(want, actual.totals[field], `totals.${field}`);
    if (diff) totalsMissing.push(diff);
  }
  check("totals matches the build", totalsMissing.length === 0,
        totalsMissing.slice(0, 4).join("; "));

  checkOrdersAreTotal(actual, byOpenThenRepo);

  const claimed = new Set([...PORTED, ...PENDING]);
  const unaccounted = Object.keys(expected).filter((k) => !claimed.has(k));
  check("every key the build produces is ported or listed as pending",
        unaccounted.length === 0, unaccounted.join(", "));

  const totalsClaimed = new Set([
    ...Object.keys(actual.totals), ...TOTALS_PENDING,
  ]);
  const totalsUnaccounted = Object.keys(expected.totals)
    .filter((k) => !totalsClaimed.has(k));
  check("every totals field is ported or listed as pending",
        totalsUnaccounted.length === 0, totalsUnaccounted.join(", "));

  // The recompute caches this as one JSON blob and a D1 row caps at 2 MB. This
  // is the largest panel here, and `drilldown` is the one that will not fit at
  // all — that is why it gets materialised tables instead.
  const kb = JSON.stringify(actual).length / 1024;
  check(
    `cached blob fits D1's 2 MB row cap (${Math.round(kb)} KB)`,
    kb < 2048,
  );

  await checkBotAssignee(db);

  console.log(`\n  ported: ${PORTED.join(", ")}`);
  console.log(`  pending: ${PENDING.join(", ")}\n`);
}

/**
 * A bot assignee is excluded; a label on the same issue is not.
 *
 * Deleting the `isBot` guard from the assignee expansion passes every other
 * assertion in this file, because none of the 188 people ever assigned an issue
 * in this org is a bot. That is not a guarantee, and it is a weaker one than it
 * looks next to its neighbour: `first_responder` cannot be a bot because
 * `firstResponse()` in the ingest refuses to pick one, whereas assignees are
 * stored exactly as GitHub gives them. One `github-actions[bot]` assigned by an
 * automation would land in `assignees` and `topAssignees` tomorrow.
 *
 * The label assertion is the positive control. Without it a guard that dropped
 * *everything* would pass this just as well.
 */
async function checkBotAssignee(db) {
  const { labelsAndAssignees } = await import("../src/panels/issues.js");

  db.exec(`
    INSERT INTO issues (repo, number, created_at, updated_at, state,
                        author, labels, assignees)
    VALUES ('t', 1, '2024-03-03T00:00:00Z', '2024-03-03T00:00:00Z', 'OPEN',
            'someone', '["Status: Synthetic"]',
            '["github-actions[bot]","a-real-person"]')`);

  const [map] = await labelsAndAssignees(promised(db), [
    { key: "all", from: "0000-01-01T00:00:00Z", to: "9999-12-31T23:59:59Z" },
  ]);

  check("a bot assignee is excluded from the assignee rollup",
        !map.assignees.has("github-actions[bot]"));
  check("a human assignee on the same issue is kept",
        map.assignees.has("a-real-person"));
  check("the label on that issue is counted",
        map.labels.has("Status: Synthetic"));

  db.exec("DELETE FROM issues WHERE repo = 't'");
}

/**
 * Every ordered list survives having its input shuffled.
 *
 * A tiebreak that is missing is invisible from the output: SQLite groups by
 * repo in name order and the store is walked in roughly issue order, so a
 * comparator that leaves ties level still produces the right-looking answer —
 * right by accident, and by an accident the other implementation does not
 * share. Deleting the repo name from the `repos` sort changes nothing in this
 * file's output while making the table depend on a query plan.
 *
 * So the order is not compared, it is *re-derived*: shuffle a copy, sort it
 * with the same comparator, and require the same list back. That can only hold
 * if the comparator alone decides the order, which is the actual property.
 * Seeded, so a failure reproduces.
 */
function checkOrdersAreTotal(actual, byOpenThenRepo) {
  const shuffled = (list) => {
    const out = [...list];
    let seed = 0x2f6e2b1;
    for (let i = out.length - 1; i > 0; i--) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const j = seed % (i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };

  const same = (a, b) =>
    a.length === b.length &&
    a.every((x, i) => x.repo === b[i].repo && x.number === b[i].number);

  for (const [name, list] of [
    ["triage.oldest", actual.triage.oldest],
    ["triage.quietest", actual.triage.quietest],
    ["triage.ignored", actual.triage.ignored],
    ["mostDiscussed", actual.mostDiscussed],
  ]) {
    const field = name === "triage.quietest" ? "staleDays"
                : name === "mostDiscussed" ? "comments" : "ageDays";
    const again = shuffled(list).sort(R.byMetricThenIssue((i) => i[field]));
    check(`${name} is ordered by the comparator alone`, same(list, again));
  }

  const repos = shuffled(actual.repos).sort(byOpenThenRepo);
  check(
    "repos is ordered by the comparator alone",
    actual.repos.length === repos.length &&
      actual.repos.every((r, i) => r.repo === repos[i].repo),
  );

  // The label table is per repo and the focus repo is much the largest, so the
  // check runs over every repo rather than the first: 86 of the 314 rows are
  // level on group, open and total, and they are not evenly spread.
  let stable = true;
  for (const [repo, rows] of Object.entries(actual.labelsByRepo)) {
    const again = shuffled(rows).sort(R.byLabelGroupThenOpen);
    if (!rows.every((l, i) => l.name === again[i].name)) {
      stable = false;
      check(`labelsByRepo[${repo}] is ordered by the comparator alone`, false);
      break;
    }
  }
  if (stable)
    check("every labelsByRepo table is ordered by the comparator alone", true);
}

/**
 * `node:sqlite` is synchronous and D1 is not, so the panel's `await` and
 * `.all()` shape needs a thin adapter. `first()` and `all()` only, because
 * that is all a read panel uses.
 */
function promised(db) {
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        bind: (...args) => ({
          all: async () => ({ results: stmt.all(...args) }),
          first: async () => stmt.get(...args) ?? null,
        }),
        all: async () => ({ results: stmt.all() }),
        first: async () => stmt.get() ?? null,
      };
    },
  };
}

/**
 * The first leaf where two values disagree, named by its path.
 *
 * A boolean "they differ" on a 670 KB panel is not a usable failure. Numbers
 * are compared exactly: every one of them is either an integer count or a
 * value both sides produced by the same `round1`, so a tolerance here would
 * only hide a real disagreement.
 */
function firstDiff(want, got, path) {
  if (Array.isArray(want)) {
    if (!Array.isArray(got)) return `${path}: expected an array, got ${typeof got}`;
    if (want.length !== got.length)
      return `${path}: length ${want.length} vs ${got.length}`;
    for (let i = 0; i < want.length; i++) {
      const d = firstDiff(want[i], got[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (want && typeof want === "object") {
    if (!got || typeof got !== "object") return `${path}: expected an object`;
    const keys = new Set([...Object.keys(want), ...Object.keys(got)]);
    for (const k of keys) {
      const d = firstDiff(want[k], got[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  const a = want ?? null;
  const b = got ?? null;
  if (a !== b) return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  return null;
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

  if (existsSync(PANEL)) await checkPanel(db);
  else console.log("\n  (panel not ported yet — rules checked, output not)\n");

  db.close();
  console.log(`\n${pass} passed, ${failures.length} failed\n`);
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
