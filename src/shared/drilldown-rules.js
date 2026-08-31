/**
 * The orderings the drilldown's lists are built on, in both languages.
 *
 * Every list in this panel was sorted on its metric alone. That is harmless
 * while one implementation produces it, because a stable sort leaves ties in
 * store order and the store yields the same order twice. It stops being
 * harmless the moment a second implementation reads the same rows out of SQL,
 * which has no store order to reproduce: the two then disagree by construction,
 * on exactly the rows nobody checks.
 *
 * Measured against the shipped `data/drilldown.json` before the port:
 *
 *   index.contributors   6,538 of 6,748 adjacent pairs tie   (97%)
 *   index.repos            187 of   297                      (63%)
 *   ranked lists        95,671 adjacent ties across 13,490 lists
 *                       10,659 of those lists contain at least one
 *   backlog `oldest`     1,490 ties on ageDays across 565 lists
 *   resolved PR rows     9,664 of 25,719 rows tie on the timestamp
 *
 * The contributor picker is the worst of them: 97% of its order is decided by
 * nothing. That is not a long tail, it is the list.
 *
 * So each ordering below is a comparator and the SQL that has to mean the same
 * thing, generated side by side, the same arrangement `issue-rules.js` uses and
 * for the same reason. Add a list to this panel, give it one of these.
 *
 * Dependency-free, because a Worker bundles it.
 */

/**
 * The tiebreak every list here ends with.
 *
 * `repo` then `number`, never the `"repo#number"` string the frontend renders.
 * A JavaScript compare of those strings disagrees with `(repo, number)` the
 * moment two numbers in one repo differ in digit count — `#99` sorts above
 * `#100` — and `issue-rules.js` already carries one ordering that has to mirror
 * the string form deliberately. This is not that one. Compare the parts.
 */
export const byRecord = (a, b) =>
  String(a.repo ?? "").localeCompare(String(b.repo ?? "")) ||
  (a.number ?? 0) - (b.number ?? 0);

export const byRecordSql = "repo ASC, number ASC";

/**
 * A ranked list: count descending, then the thing being counted.
 *
 * `key` is `repo` or `login` depending on the list. Almost every one of these
 * has a long tail at count 1 — the whole tail is a tie, and before this it came
 * out in whatever order the accumulating Map happened to hold.
 */
export const byCount = (key) => (a, b) =>
  b.count - a.count || String(a[key]).localeCompare(String(b[key]));

export const byCountSql = (key) => `count DESC, ${key} ASC`;

/**
 * The resolved and packed PR/issue row lists: newest first.
 *
 * `at` is a whole-second timestamp and a merge queue closes several at once, so
 * ties are routine rather than exotic — 38% of resolved rows share their
 * timestamp with the row above.
 */
export const byRecency = (at) => (a, b) =>
  String(at(b) ?? "").localeCompare(String(at(a) ?? "")) || byRecord(a, b);

export const byRecencySql = (col = "at") => `${col} DESC, ${byRecordSql}`;

/**
 * The backlog lists: oldest first.
 *
 * `ageDays` is a whole number of days, so every item opened on one day ties
 * with every other. This is the same shape as the issue panel's `oldest` /
 * `quietest` / `ignored`, where nine issues shared the boundary age and three
 * were excluded by nothing at all.
 */
export const byAge = (a, b) => b.ageDays - a.ageDays || byRecord(a, b);

export const byAgeSql = `age_days DESC, ${byRecordSql}`;

/**
 * The two picker indexes, which rank by a sum rather than a column.
 *
 * `involvement` is the sum each index sorts on — PRs plus approvals plus issues
 * for a contributor, PRs plus issues for a repo. Ties break on the id, which is
 * the login or the repo name and is unique by construction, so these are total
 * orders rather than merely better ones.
 */
export const byInvolvement = (involvement) => (a, b) =>
  involvement(b) - involvement(a) || String(a.id).localeCompare(String(b.id));

export const byInvolvementSql = (sum) => `${sum} DESC, id ASC`;

/**
 * Every ordering in this file, by name, for the parity test to walk.
 *
 * A comparator that exists and is never used reads exactly like one that is
 * used, so the test asserts against this list rather than against whatever it
 * can find. Adding an ordering without adding it here is the failure mode this
 * catches.
 */
export const ORDERINGS = [
  "byRecord",
  "byCount",
  "byRecency",
  "byAge",
  "byInvolvement",
];
