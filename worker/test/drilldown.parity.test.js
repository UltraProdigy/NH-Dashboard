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
 * The third half is the per-subject payloads, and it is a different kind of
 * check again. Those are not being ported into SQL — one subject is 5.9 MB
 * against the 96 MB that made reusing the store impossible, so the Worker hands
 * one subject's rows to the same Node functions the build runs and there is no
 * second implementation to disagree with. What is left to get wrong is the
 * extraction: a fold that could reach the whole store, handed a subset, reads
 * something that is no longer there and returns a smaller number rather than an
 * error. So a subject computed from its own rows is compared against the same
 * subject computed from all of them, leaf by leaf, with labels resolved through
 * each side's own table rather than by index. It skips politely too.
 *
 * That half was checked the only way it can be before the entry point exists: a
 * throwaway shim returning the build's own payload, which passes over 67
 * subjects, then mutated eight ways. All eight fail it:
 *
 *   a row dropped from a packed table            resolved.length
 *   every label index shifted by one             the names, not the indexes
 *   a window count moved by one                  windows.m1.opened
 *   a positional issue window moved by one       issues.windows.all.filed
 *   a zero written as null                       windows.all.closed
 *   a subject returning nothing                  the existence-only three
 *   a series with its first month dropped        series.from and every bucket
 *   the org's label table returned unchanged     the leaf diff and the
 *                                                self-sufficiency check
 *
 * The label shift is the one worth keeping: it passes if the two sides are
 * compared by index and fails only because they are compared by name, which is
 * the whole reason a payload carries its own table.
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
 * The panel half was broken nine ways in turn and all nine fail it:
 *
 *   each of the three existence-only sources removed   subject membership
 *   self-approvals excluded from the approval count    13 people's `a`
 *   COMMENTED counted as an approval                   487 fields, 8 subjects
 *   every APPROVED review counted rather than one      67 fields
 *     per reviewer per pull request
 *   an approval dated to the latest, not the earliest  one person, by 8 minutes
 *   repo pull request counts excluding bots            137 fields
 *   a repo's `last` ignoring issue close dates         9 repos
 *   involvement dropping the fixer                     388 fields
 *
 * The tenth attempt is worth recording because it was a bad mutation rather
 * than a survivor: replacing `MIN(submitted_at)` with a bare `submitted_at`
 * while leaving the `GROUP BY` in place passed, and looked at first like a hole.
 * SQLite picks an arbitrary row's value for a bare column under a GROUP BY, so
 * the count never moved and nothing was actually being tested. 148 reviewer/PR
 * pairs in the seed do carry more than one approval; the two mutations above
 * exercise them properly.
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
const SEED = path.join(HERE, "..", "seed.sql");
const SCHEMA = path.join(HERE, "..", "schema.sql");

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
   The per-subject payloads

   Skipped politely until the entry point exists, so this half is useful from
   now — the same arrangement the panel half below used before the SQL index was
   written.

   This does not compare two implementations either, and that is the point.
   The design settled on for the payloads is to *reuse* the Node panel's own
   functions rather than translate them: one subject is 5.9 MB against the 96 MB
   that made reusing the whole store impossible, so the Worker computes a
   subject by handing that subject's rows to the same code the build runs. There
   is no second implementation to disagree with, and the agreement is therefore
   structural.

   What can still go wrong is the extraction. A fold that reaches the whole
   store can read anything; the same fold handed one subject's rows can quietly
   read something that is no longer there, and the failure looks like a smaller
   number rather than an error. So this compares **one subject computed from its
   own rows against the same subject computed from all of them** — the build's
   `drilldown.json`, which is the only oracle this project has.

   The row selection is half the risk and lives in `subjectRows`, shared with
   the Worker's SQL twin for the reason every other rule here is shared: a
   selection that is right in JavaScript and narrower in SQL is a subject that
   silently loses rows in production and nowhere else.
   ========================================================================== */

const ENTRY = path.join(ROOT, "src", "panels", "drilldown.js");

/**
 * Decode a packed row into named values, resolving every index against the
 * table it indexes.
 *
 * `labels` resolves against the payload's *own* label table, which is the thing
 * a per-subject payload cannot inherit: the build interns every label in the org
 * into one list at the head of a 23 MB file, and a row cached on its own has no
 * such head to point into. So each payload carries its own table and the
 * comparison happens on the names — the same rule as decoding rows by field
 * name, applied one level down. Comparing the indexes would pass against two
 * tables that disagree about what 33 means.
 */
const decodeRow = (row, fields, repos, labelNames, outcomes) => {
  const out = {};
  fields.forEach((f, i) => {
    const v = row[i];
    if (f === "repo") out.repo = repos[v] ?? null;
    else if (f === "labels") out.labels = v == null ? null : v.map((ix) => labelNames[ix] ?? `?${ix}`);
    else if (f === "state") out.state = v == null ? null : REVIEW_STATES[v] ?? `?${v}`;
    else if (f === "outcome") out.outcome = v == null ? null : outcomes[v] ?? `?${v}`;
    else out[f] = v;
  });
  return out;
};

const decodeTable = (table, fields, labelNames, outcomes) =>
  !table || !Array.isArray(table.rows)
    ? table ?? null
    : table.rows.map((r) => decodeRow(r, fields, table.repos ?? [], labelNames, outcomes));

const decodeNamed = (rows, labelNames) =>
  !Array.isArray(rows)
    ? rows ?? null
    : rows.map((r) =>
        r && Array.isArray(r.labels)
          ? { ...r, labels: r.labels.map((ix) => labelNames[ix] ?? `?${ix}`) }
          : r,
      );

const decodePositional = (v, fields) =>
  !Array.isArray(v) ? v ?? null : Object.fromEntries(fields.map((f, i) => [f, v[i] ?? null]));

/**
 * A subject payload with every packed and interned thing expanded by name.
 *
 * Everything the two sides could agree on positionally and mean differently is
 * resolved here, so the diff below compares values rather than encodings.
 */
function expand(s, kind, labelNames) {
  if (!s) return s;
  const out = { ...s };

  if (s.series?.v) out.series = { from: s.series.from, v: s.series.v.map((m) => decodePositional(m, SERIES_FIELDS)) };
  if (s.backlog?.oldest) out.backlog = { ...s.backlog, oldest: decodeNamed(s.backlog.oldest, labelNames) };

  if (kind === "contributors") {
    out.resolved = decodeTable(s.resolved, RESOLVED_FIELDS, labelNames, PR_OUTCOMES);
    out.assigned = decodeTable(s.assigned, ASSIGNED_FIELDS, labelNames, PR_OUTCOMES);
    if (s.reviewQueue) {
      out.reviewQueue = {
        requested: decodeTable(s.reviewQueue.requested, REVIEW_FIELDS, labelNames, PR_OUTCOMES),
        reviewing: decodeTable(s.reviewQueue.reviewing, REVIEW_FIELDS, labelNames, PR_OUTCOMES),
      };
    }
  }

  if (s.issues) {
    const i = s.issues;
    const iw = ISSUE_WINDOW_FIELDS[kind];
    const is = ISSUE_SERIES_FIELDS[kind];
    out.issues = {
      ...i,
      windows: i.windows
        ? Object.fromEntries(Object.entries(i.windows).map(([w, v]) => [w, decodePositional(v, iw)]))
        : i.windows ?? null,
      series: i.series
        ? Object.fromEntries(Object.entries(i.series).map(([m, v]) => [m, decodePositional(v, is)]))
        : i.series ?? null,
      backlog: i.backlog ? { ...i.backlog, oldest: decodeNamed(i.backlog.oldest, labelNames) } : i.backlog ?? null,
      filed: decodeTable(i.filed, FILED_FIELDS, labelNames, ISSUE_OUTCOMES),
      closed: decodeTable(i.closed, CLOSED_FIELDS, labelNames, ISSUE_OUTCOMES),
    };
  }

  return out;
}

/** Every leaf of an expanded payload, as path → value. */
function leaves(v, at = "", into = new Map()) {
  if (v === null || typeof v !== "object") into.set(at, v);
  else if (Array.isArray(v)) {
    into.set(`${at}.length`, v.length);
    v.forEach((x, i) => leaves(x, `${at}[${i}]`, into));
  } else {
    for (const k of Object.keys(v).sort()) leaves(v[k], at ? `${at}.${k}` : k, into);
  }
  return into;
}

if (!existsSync(ENTRY)) {
  console.log("\n  no panel source — payload comparison skipped");
} else {
  const entry = await import(ENTRY);

  if (typeof entry.subjectPayload !== "function" || typeof entry.subjectRows !== "function") {
    console.log("\n  no per-subject entry point — payload comparison skipped");
    console.log("  expected src/panels/drilldown.js to export:");
    console.log("    subjectRows(kind, id, prs, issues) -> { prs, issues }");
    console.log("    subjectPayload(kind, id, rows, { now, activeDays }) -> { payload, labelNames }");
  } else {
    const { readStore } = await import(path.join(ROOT, "src", "ingest", "pullRequests.js"));
    const { readStore: readIssueStore } = await import(path.join(ROOT, "src", "ingest", "issues.js"));
    const { activeDayIndex } = await import(path.join(ROOT, "src", "panels", "activeDays.js"));
    const { WINDOWS } = await import(path.join(ROOT, "src", "panels", "contributors.js"));

    const prs = await readStore();
    const issues = await readIssueStore();
    const activeDays = await activeDayIndex(WINDOWS);
    const now = Date.parse(d.generatedAt);

    /**
     * Which subjects to compute.
     *
     * The largest of each kind, because they are the ones that decide whether
     * the design survives the row cap and the only ones whose cost is worth
     * measuring. Then a seeded spread, because the median subject exercises
     * paths the busiest one never reaches — an empty review queue, a null
     * backlog, a series that starts last month.
     *
     * And then the three subjects that exist for no number at all. Two are
     * Copilot accounts `BOT_PATTERN` does not match and one is a bare assignee;
     * all three are created by a `person()` call that contributes nothing, so a
     * row selection that reasons from "what did they do" drops them entirely
     * and the picker quietly loses three people. Derived rather than named, so
     * the set stays true as the org changes, with the count asserted so a change
     * announces itself instead of weakening the test.
     */
    const spread = (map, n) => {
      const ids = Object.keys(map).sort();
      return shuffled(ids).slice(0, n);
    };
    const biggest = (map, n) =>
      Object.entries(map)
        .map(([k, v]) => [k, JSON.stringify(v).length])
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([k]) => k);

    const existenceOnly = d.index.contributors.filter((s) => s.n + s.a + s.i === 0).map((s) => s.id);
    check(
      "three contributors exist for no number at all",
      existenceOnly.length === 3,
      `${existenceOnly.length}: ${existenceOnly.slice(0, 5).join(", ")}`,
    );

    const subjects = [
      ...new Set([...biggest(d.contributors, 2), ...existenceOnly, ...spread(d.contributors, 40)]),
    ].map((id) => ["contributors", id]);
    subjects.push(
      ...[...new Set([...biggest(d.repos, 2), ...spread(d.repos, 20)])].map((id) => ["repos", id]),
    );

    console.log(`\npayloads: ${subjects.length} subjects, against the build`);

    const missing = [];
    const wrong = [];
    const oversize = [];
    let compared = 0;
    let worst = ["", 0];

    for (const [kind, id] of subjects) {
      const theirs = d[kind][id];
      const rows = entry.subjectRows(kind, id, prs, issues);
      const { payload, labelNames } = await entry.subjectPayload(kind, id, rows, { now, activeDays });

      if (!payload) {
        missing.push(`${kind}/${id}`);
        continue;
      }

      const size = JSON.stringify(payload).length;
      if (size > worst[1]) worst = [`${kind}/${id}`, size];
      if (size > ROW_CAP) oversize.push(`${kind}/${id} at ${size}`);

      const mine = leaves(expand(payload, kind, labelNames));
      const built = leaves(expand(theirs, kind, d.labelNames));
      compared++;

      const paths = new Set([...mine.keys(), ...built.keys()]);
      for (const p of paths) {
        const a = mine.get(p) ?? null;
        const b = built.get(p) ?? null;
        if (JSON.stringify(a) !== JSON.stringify(b)) {
          wrong.push(`${kind}/${id} ${p}: ${JSON.stringify(a)} against ${JSON.stringify(b)}`);
          break;
        }
      }
    }

    check("every subject computes from its own rows", missing.length === 0, missing.slice(0, 3).join(", "));
    check(
      "and agrees with the build leaf for leaf",
      wrong.length === 0,
      `${wrong.length} of ${compared}, first: ${wrong[0]}`,
    );

    console.log(`  largest computed: ${worst[0]} at ${(worst[1] / 1024).toFixed(0)} KB, ${((worst[1] / ROW_CAP) * 100).toFixed(0)}% of the row cap`);
    check("no computed payload exceeds the row cap", oversize.length === 0, oversize.slice(0, 2).join(", "));

    /**
     * The label table has to be self-sufficient.
     *
     * Every index a payload carries must resolve within its own table. An index
     * inherited from the build's 323-name list would resolve to the wrong name,
     * or to nothing, and the leaf diff above would catch it only where the two
     * tables happen to disagree — which is most places, but not all, and "most"
     * is not what a cache keyed on a version number can rest on.
     */
    {
      const [kind, id] = ["contributors", biggest(d.contributors, 1)[0]];
      const rows = entry.subjectRows(kind, id, prs, issues);
      const { payload, labelNames } = await entry.subjectPayload(kind, id, rows, { now, activeDays });
      const dangling = [];
      for (const [p, v] of leaves(payload)) {
        if (!/\.labels\[\d+\]$/.test(p)) continue;
        if (typeof v === "number" && labelNames[v] === undefined) dangling.push(p);
      }
      check("every label index resolves in the payload's own table", dangling.length === 0, dangling.slice(0, 2).join(", "));
      check("and the table is the subject's, not the org's", labelNames.length < d.labelNames.length);
    }
  }
}

/* ==========================================================================
   The panels

   The same subjects, the same keys per subject, and a leaf-by-leaf diff of
   each — decoded by field name on both sides, never by position.
   ========================================================================== */

if (!existsSync(PANEL) || !existsSync(SEED) || !existsSync(SCHEMA)) {
  console.log("\n  no panel or no seed — panel comparison skipped");
} else {
  const { DatabaseSync } = await import("node:sqlite");
  const { drilldown } = await import(PANEL);

  const raw = new DatabaseSync(":memory:");
  raw.exec(readFileSync(SCHEMA, "utf8"));
  raw.exec("BEGIN");
  raw.exec(readFileSync(SEED, "utf8"));
  raw.exec("COMMIT");

  // The Worker's D1 surface, over node:sqlite. `all()` returns `{results}`,
  // which is what the panel destructures.
  const db = {
    prepare(sql) {
      return {
        async all() {
          return { results: raw.prepare(sql).all() };
        },
      };
    },
  };

  const built = await drilldown(db, Date.parse(d.generatedAt));

  console.log("\npanel: the index, against the build");

  for (const [side, sum] of [
    ["contributors", (s) => s.n + s.a + s.i],
    ["repos", (s) => s.n + s.i],
  ]) {
    const mine = built.index[side];
    const theirs = d.index[side];

    const a = new Set(mine.map((x) => x.id));
    const b = new Set(theirs.map((x) => x.id));
    const missing = [...b].filter((x) => !a.has(x));
    const extra = [...a].filter((x) => !b.has(x));
    check(
      `${side}: the same subjects exist`,
      missing.length === 0 && extra.length === 0,
      `${missing.length} missing (${missing.slice(0, 3)}), ${extra.length} extra (${extra.slice(0, 3)})`,
    );

    const byId = new Map(mine.map((x) => [x.id, x]));
    const fields = side === "contributors" ? ["n", "a", "i", "last"] : ["n", "open", "i", "iOpen", "last"];
    const wrong = [];
    for (const t of theirs) {
      const m = byId.get(t.id);
      if (!m) continue;
      for (const f of fields) {
        if ((m[f] ?? null) !== (t[f] ?? null)) {
          wrong.push(`${t.id}.${f}: ${m[f]} against ${t[f]}`);
          break;
        }
      }
    }
    check(`${side}: every field agrees`, wrong.length === 0, `${wrong.length}, first: ${wrong[0]}`);

    const order = mine.filter((x, i) => x.id !== theirs[i]?.id).length;
    check(`${side}: in the same order`, order === 0, `${order} of ${theirs.length} positions`);

    // The sort is the shared comparator on both sides, so agreeing on the
    // ordering only means something if the values it sorts on also agree —
    // which the field check above establishes. This one catches the reverse:
    // a comparator applied to the right values in the wrong direction.
    const sorted = [...mine].every((x, i) => i === 0 || sum(mine[i - 1]) >= sum(x));
    check(`${side}: descends by involvement`, sorted);
  }

  const keys = [
    "windows", "seriesFields", "resolvedFields", "issueSeriesFields",
    "issueWindowFields", "backlogBuckets", "filedFields", "closedFields",
    "issueOutcomes", "reviewFields", "reviewStates", "assignedFields",
    "prOutcomes",
  ];
  const drifted = keys.filter((k) => JSON.stringify(built[k]) !== JSON.stringify(d[k]));
  check("every schema key matches the build", drifted.length === 0, drifted.join(", "));
}

console.log(`\n${pass} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
