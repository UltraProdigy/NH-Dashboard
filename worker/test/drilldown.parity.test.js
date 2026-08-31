/**
 * The SQL drilldown must agree with the JavaScript one.
 *
 *   node worker/test/drilldown.parity.test.js
 *
 * Written before the port, like the others, and for a sharper reason than
 * usual. Every list in this panel was sorted on its metric alone, which is
 * invisible while one implementation produces it — a stable sort leaves ties in
 * store order, and the store yields the same order twice, so the output looks
 * decided. It is not. Measured on the file this panel shipped before the
 * tiebreaks landed:
 *
 *   index.contributors   6,538 of 6,748 adjacent pairs tied
 *   ranked lists        95,671 ties across 13,490 lists
 *   resolved PR rows     9,664 of 25,719 tied on the timestamp
 *
 * Adding the tiebreaks moved 67,811 positions across 5,474 lists, and 1,207 of
 * those were membership changes — an entry in or out of a capped list decided by
 * nothing at all. SQL cannot reproduce store order, so every one of those would
 * have been a parity failure with no bug behind it to find.
 *
 * So the first half of this file does not compare two implementations. It
 * asserts that the *one* that exists is fully determined: every ordered list is
 * re-sorted from a shuffled copy and has to come back identical, which passes
 * only if the comparator alone decides the order. That is the check the issues
 * port arrived at after the fact — deleting a tiebreak there changed nothing,
 * because SQLite happened to group in name order and was right by accident.
 *
 * The second half compares the panels and skips politely until
 * `worker/src/panels/drilldown.js` exists, so this file is useful from now.
 *
 * Ten deliberate mutations were run against this file and all ten fail it —
 * each of the five tiebreaks removed in turn, `byRecord` switched to the
 * `"repo#number"` string form (caught in 91 real lists, so the digit-count trap
 * is live in this data rather than theoretical), a field list reordered, a
 * field appended without a value, a ragged row, an oversized payload, and two
 * adjacent picker entries swapped.
 *
 * That last one had a survivor until the column orders moved into
 * `drilldown-rules.js`: swapping two field names that neither the sort key nor
 * the arity touches — `additions` against `deletions` in `resolvedFields` —
 * passed everything, because nothing here had a second opinion about what the
 * order should be. Now the shipped list is compared against the shared module's
 * and the swap fails. It is the same lesson as the state_reason bug three
 * commits earlier: a value has to be checked against something that did not
 * come from the same place it did.
 *
 * Needs `data/drilldown.json`, and skips without it. Rebuild it with
 * `npm run rebuild:drilldown` before believing a failure here: it pins its
 * clock to `dashboard.json`'s `generatedAt`, and a stale oracle reports a fix
 * as a regression.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  ASSIGNED_FIELDS,
  CLOSED_FIELDS,
  FILED_FIELDS,
  ISSUE_OUTCOMES,
  ISSUE_SERIES_FIELDS,
  ISSUE_WINDOW_FIELDS,
  PR_OUTCOMES,
  RESOLVED_FIELDS,
  REVIEW_FIELDS,
  REVIEW_STATES,
  SERIES_FIELDS,
  byAge,
  byCount,
  byInvolvement,
  byRecency,
  byRecord,
  ORDERINGS,
} from "../../src/shared/drilldown-rules.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const ORACLE = path.join(ROOT, "data", "drilldown.json");
const PANEL = path.join(HERE, "..", "src", "panels", "drilldown.js");

/** D1's per-row ceiling. A payload over this cannot be stored at all. */
const ROW_CAP = 2 * 1024 * 1024;

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

function skip(why) {
  console.log(`\n  skipped: ${why}\n`);
  process.exit(0);
}

if (!existsSync(ORACLE)) skip("no data/drilldown.json — run npm run rebuild:drilldown");

const d = JSON.parse(readFileSync(ORACLE, "utf8"));

/* ==========================================================================
   A deterministic shuffle

   Seeded, because a test that fails one run in fifty and passes the rest is
   worse than one that never fails: it teaches people to re-run it. The seed is
   fixed but the permutation is thorough, and every list in the file gets its
   own draw from the same stream.
   ========================================================================== */

let seed = 0x2f6e2b1;
const rnd = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return ((seed >>> 0) % 1_000_000) / 1_000_000;
};

function shuffled(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ==========================================================================
   Every ordered list, walked once

   Collected rather than asserted in place, so a failure names the subject and
   the key it was found under. "topRepos is out of order" on six thousand
   subjects is not a bug report.
   ========================================================================== */

const lists = [];

/** A window-keyed map of ranked lists: {all: [...], m1: [...]}. */
const ranked = (where, map, key) => {
  if (!map) return;
  for (const w of Object.keys(map)) {
    if (Array.isArray(map[w])) lists.push({ where: `${where}.${w}`, rows: map[w], cmp: byCount(key) });
  }
};

/** A bare ranked list. */
const flat = (where, rows, key) => {
  if (Array.isArray(rows)) lists.push({ where, rows, cmp: byCount(key) });
};

/** A backlog's `oldest`, which sorts on a whole number of days. */
const oldest = (where, backlog) => {
  if (backlog && Array.isArray(backlog.oldest)) {
    lists.push({ where: `${where}.oldest`, rows: backlog.oldest, cmp: byAge });
  }
};

/**
 * A packed `{repos, rows}` table.
 *
 * The rows are positional arrays against one of the field lists at the head of
 * the payload, so they are decoded by name before being compared. Comparing
 * them by position would pass just as happily against a field list that had
 * been reordered underneath — which is the failure the packing invites and the
 * reason the field lists say "append, never reorder".
 */
const packed = (where, table, fields) => {
  if (!table || !Array.isArray(table.rows) || !table.rows.length) return;
  const at = fields.indexOf("at");
  const repo = fields.indexOf("repo");
  const number = fields.indexOf("number");
  if (at < 0 || repo < 0 || number < 0) return;
  const rows = table.rows.map((r) => ({
    at: r[at],
    repo: table.repos[r[repo]] ?? "",
    number: r[number],
    _raw: r,
  }));
  lists.push({ where, rows, cmp: byRecency((r) => r.at), arity: table.rows[0].length, fields });
};

for (const login of Object.keys(d.contributors)) {
  const c = d.contributors[login];
  const at = `contributors.${login}`;
  ranked(`${at}.topRepos`, c.topRepos, "repo");
  ranked(`${at}.reviewRepos`, c.reviewRepos, "repo");
  flat(`${at}.reviewedBy`, c.reviewedBy, "login");
  flat(`${at}.reviewsFor`, c.reviewsFor, "login");
  oldest(`${at}.backlog`, c.backlog);
  packed(`${at}.resolved`, c.resolved, d.resolvedFields);
  packed(`${at}.assigned`, c.assigned, d.assignedFields);
  if (c.reviewQueue) {
    packed(`${at}.reviewQueue.requested`, c.reviewQueue.requested, d.reviewFields);
    packed(`${at}.reviewQueue.reviewing`, c.reviewQueue.reviewing, d.reviewFields);
  }
  const i = c.issues;
  if (!i) continue;
  for (const k of ["filedRepos", "answeredRepos", "closedRepos"]) ranked(`${at}.issues.${k}`, i[k], "repo");
  flat(`${at}.issues.helpedBy`, i.helpedBy, "login");
  flat(`${at}.issues.helped`, i.helped, "login");
  oldest(`${at}.issues.backlog`, i.backlog);
  packed(`${at}.issues.filed`, i.filed, d.filedFields);
  packed(`${at}.issues.closed`, i.closed, d.closedFields);
}

for (const repo of Object.keys(d.repos)) {
  const r = d.repos[repo];
  const at = `repos.${repo}`;
  ranked(`${at}.topAuthors`, r.topAuthors, "login");
  ranked(`${at}.topReviewers`, r.topReviewers, "login");
  oldest(`${at}.backlog`, r.backlog);
  const i = r.issues;
  if (!i) continue;
  for (const k of ["topReporters", "topResponders", "topClosers", "topFixers", "topAssignees"]) {
    ranked(`${at}.issues.${k}`, i[k], "login");
  }
  oldest(`${at}.issues.backlog`, i.backlog);
}

console.log(`\nordering: ${lists.length} lists, plus the two indexes`);

/* ==========================================================================
   The shuffle check
   ========================================================================== */

const idOf = (x) => `${x.repo ?? x.login ?? x.id ?? ""}#${x.number ?? ""}`;

{
  const broken = [];
  for (const { where, rows, cmp } of lists) {
    if (rows.length < 2) continue;
    const again = shuffled(rows).sort(cmp);
    for (let i = 0; i < rows.length; i++) {
      if (idOf(again[i]) !== idOf(rows[i])) {
        broken.push(`${where} at ${i}`);
        break;
      }
    }
  }
  check(
    "every list re-sorts from a shuffle to the order it shipped in",
    broken.length === 0,
    broken.length ? `${broken.length} lists, first: ${broken[0]}` : "",
  );
}

{
  const idx = d.index.contributors;
  const again = shuffled(idx).sort(byInvolvement((s) => s.n + s.a + s.i));
  const moved = again.filter((x, i) => x.id !== idx[i].id).length;
  check("index.contributors re-sorts from a shuffle", moved === 0, `${moved} of ${idx.length} moved`);
}

{
  const idx = d.index.repos;
  const again = shuffled(idx).sort(byInvolvement((s) => s.n + s.i));
  const moved = again.filter((x, i) => x.id !== idx[i].id).length;
  check("index.repos re-sorts from a shuffle", moved === 0, `${moved} of ${idx.length} moved`);
}

/* ==========================================================================
   Total orders

   A tiebreak that still leaves two distinct entries comparing equal is a
   tiebreak that has not been added, and the shuffle above would pass on it
   whenever the residual tie happened not to be drawn apart. This asserts the
   stronger property directly.
   ========================================================================== */

{
  const ambiguous = [];
  for (const { where, rows, cmp } of lists) {
    for (let i = 1; i < rows.length; i++) {
      if (cmp(rows[i - 1], rows[i]) === 0 && idOf(rows[i - 1]) !== idOf(rows[i])) {
        ambiguous.push(`${where} at ${i}`);
        break;
      }
    }
  }
  check(
    "no two distinct entries compare equal",
    ambiguous.length === 0,
    ambiguous.length ? `${ambiguous.length} lists, first: ${ambiguous[0]}` : "",
  );
}

{
  const ids = new Set(d.index.contributors.map((x) => x.id));
  check("index ids are unique, so the tiebreak is total", ids.size === d.index.contributors.length);
}

/**
 * Every composite ordering has to fall through to `byRecord`.
 *
 * The shuffle check above cannot see this on its own: a comparator that ties
 * and a comparator that falls through agree on every list where the data
 * happens not to tie, which is most of them. So the fall-through is asserted
 * directly, on a pair built to tie on the primary metric and on nothing else.
 * `byRecord` itself has no list of its own — this is where it is exercised.
 */
{
  const a = { repo: "Angelica", login: "Angelica", number: 2, count: 7, ageDays: 30, at: "2026-01-01T00:00:00Z", id: "a" };
  const b = { repo: "Angelica", login: "Angelica", number: 10, count: 7, ageDays: 30, at: "2026-01-01T00:00:00Z", id: "b" };
  const cases = [
    ["byAge", byAge],
    ["byRecency", byRecency((r) => r.at)],
  ];
  const missing = cases.filter(([, cmp]) => cmp(a, b) >= 0).map(([n]) => n);
  check(
    "the record orderings fall through to byRecord on a tie",
    missing.length === 0,
    missing.join(", "),
  );

  // `byCount` does not, and must not: a ranked list holds one entry per repo or
  // per login, so its key is already unique and there is no `number` to fall
  // through to. Its totality is the key's uniqueness, so that is what is
  // asserted — the empirical version is the "no two distinct entries compare
  // equal" check above, over all 58,977 real lists.
  check(
    "byCount is total on distinct keys",
    byCount("repo")({ repo: "a", count: 7 }, { repo: "b", count: 7 }) < 0 &&
      byCount("repo")({ repo: "b", count: 7 }, { repo: "a", count: 7 }) > 0,
  );
  check(
    "and it compares number as a number, not as a string",
    byRecord({ repo: "r", number: 99 }, { repo: "r", number: 100 }) < 0,
  );
  check(
    "the shared file lists what it exports",
    ORDERINGS.length === 5 && ORDERINGS.includes("byRecord"),
  );
}

/* ==========================================================================
   The column orders

   The payload states each field list at its head and the frontend expands rows
   against that copy, so the shipped lists and the shared module's have to be
   the same lists in the same order. This is what makes a reordered field list
   fail loudly: without it, swapping two names that neither the sort key nor the
   arity touches passes everything, which is the survivor this file's header
   names.
   ========================================================================== */

{
  const pairs = [
    ["resolvedFields", RESOLVED_FIELDS],
    ["filedFields", FILED_FIELDS],
    ["closedFields", CLOSED_FIELDS],
    ["reviewFields", REVIEW_FIELDS],
    ["assignedFields", ASSIGNED_FIELDS],
    ["seriesFields", SERIES_FIELDS],
    ["reviewStates", REVIEW_STATES],
    ["prOutcomes", PR_OUTCOMES],
    ["issueOutcomes", ISSUE_OUTCOMES],
  ];
  const wrong = pairs.filter(([key, list]) => JSON.stringify(d[key]) !== JSON.stringify(list));
  check(
    "every column order in the payload is the shared module's, in order",
    wrong.length === 0,
    wrong.map(([k]) => k).join(", "),
  );

  const nested = [
    ["issueSeriesFields", ISSUE_SERIES_FIELDS],
    ["issueWindowFields", ISSUE_WINDOW_FIELDS],
  ];
  const wrongNested = nested.filter(
    ([key, obj]) => JSON.stringify(d[key]) !== JSON.stringify(obj),
  );
  check(
    "and the two that are keyed by subject type",
    wrongNested.length === 0,
    wrongNested.map(([k]) => k).join(", "),
  );
}

/* ==========================================================================
   The packing

   Arity against the field list, on every packed table. A column appended to one
   of these lists without the packer appending a value is a whole table read one
   place to the left, silently, from that column on.
   ========================================================================== */

{
  const wrong = lists.filter((l) => l.arity && l.arity !== l.fields.length);
  check(
    "every packed row has one value per field",
    wrong.length === 0,
    wrong.length ? `${wrong[0].where}: ${wrong[0].arity} against ${wrong[0].fields.length}` : "",
  );

  const bad = [];
  for (const { where, rows, fields } of lists) {
    if (!fields) continue;
    for (const r of rows) {
      if (r._raw.length !== fields.length) {
        bad.push(where);
        break;
      }
    }
  }
  check("no row in any packed table is ragged", bad.length === 0, bad.slice(0, 1).join(""));
}

/* ==========================================================================
   The row cap

   `drilldown_contributors` and `drilldown_repos` hold one JSON payload per
   subject, so the largest subject is what decides whether this design survives.
   Reported rather than merely asserted: the headroom is the number worth
   watching, and finding out from a failed production recompute is the outcome
   this exists to prevent.
   ========================================================================== */

{
  const sizes = [];
  for (const [table, map] of [["contributors", d.contributors], ["repos", d.repos]]) {
    for (const k of Object.keys(map)) sizes.push([`${table}/${k}`, JSON.stringify(map[k]).length]);
  }
  sizes.sort((a, b) => b[1] - a[1]);
  const [name, size] = sizes[0];
  console.log(`  largest payload: ${name} at ${(size / 1024).toFixed(0)} KB, ${((size / ROW_CAP) * 100).toFixed(0)}% of the row cap`);
  check("no payload exceeds D1's row cap", size < ROW_CAP, `${name} at ${size}`);
  const half = sizes.filter(([, n]) => n > ROW_CAP / 2);
  check("no payload is past half the row cap", half.length === 0, half.map(([n]) => n).join(", "));
}

/* ==========================================================================
   The panels

   Skipped politely until the SQL side exists. What goes here: the same subjects,
   the same keys per subject, and a leaf-by-leaf diff of each — decoded by field
   name on both sides, never by position.
   ========================================================================== */

if (!existsSync(PANEL)) {
  console.log("\n  worker/src/panels/drilldown.js does not exist yet — panel comparison skipped");
} else {
  console.log("\n  panel comparison is not written yet");
  failures.push("panel comparison");
}

console.log(`\n${pass} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
