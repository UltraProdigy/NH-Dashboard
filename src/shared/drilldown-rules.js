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

/* ==========================================================================
   Column orders for the packed rows

   Moved here from `src/panels/drilldown.js` before a second implementation
   packs against them. Two packers reading two copies of a column order is the
   one bug in this panel that no amount of comparing values would catch: both
   sides would agree on every number and disagree about which column it is in.

   The rule each of these carries is the same, and it is load-bearing rather
   than stylistic: **append, never reorder.** A row is a positional array, and
   the frontend expands it against whichever copy of the list it was handed.
   ========================================================================== */

/**
 * Pack a contributor's resolved PRs into `{ repos, rows }`.
 *
 * 25,660 of these across the org, so the naive `{repo, number, at, merged}`
 * object costs about 1.9 MB in repeated key names and repeated repo strings —
 * more than every other contributor field combined. Rows become positional
 * arrays and the repo name is replaced by an index into a per-contributor
 * list, which is short because people work in a handful of repos even when
 * they have hundreds of PRs.
 *
 * Sorted newest-first here so the frontend doesn't re-sort on every render to
 * get back to the tab's default order.
 *
 * Diff size, commit and comment counts ride along on the same rows rather than
 * living in a separate "biggest PRs" list. A precomputed top-15 per contributor
 * would have been barely smaller (17,835 rows against 25,660) and could only
 * ever answer one question; carrying the numbers here means Biggest PRs, the
 * Closed PRs table and the merged/dropped toggle all read the same array and
 * every one of them follows the period control for free.
 *
 * `null`, not `0`, for records the ingest hasn't backfilled yet — "we haven't
 * asked" and "this PR changed nothing" have to render differently.
 */
export const RESOLVED_FIELDS =
  ["repo", "number", "at", "merged", "additions", "deletions", "commits",
   "comments", "title", "ageDays", "labels"];

/**
 * Column order for the packed issue window records, per subject type.
 *
 * Named objects here were 12.9 MB of the 40 MB this file first came out at —
 * thirty-odd key names like `medianResponseLagHours` repeated for every window
 * of every one of six thousand subjects. Positional arrays against these lists
 * cost about a seventh of that, and the frontend expands them once per subject
 * on first read, the same as it already does for the series and the resolved PR
 * rows. Append to these lists, never reorder them.
 */
export const ISSUE_WINDOW_FIELDS = {
  contributors: [
    "filed", "filedOpen", "filedClosed", "filedCompleted", "filedUnresolved",
    "acceptedShare", "filedAnswered", "filedUnanswered", "answeredShare",
    "commentsReceived", "medianWaitHours", "p90WaitHours",
    "responses", "medianResponseLagHours", "p90ResponseLagHours",
    "closed", "closedCompleted", "closedUnresolved", "closedOwn",
    "closedForOthers", "closedByTheirPR", "closedByHand",
    "medianCloseLagHours", "p90CloseLagHours",
    "fixed", "assigned", "assignedOpen",
    "triage", "involvement", "repos", "filedRepos", "helped",
  ],
  repos: [
    "opened", "closed", "completed", "notPlanned", "duplicate", "unresolved",
    "net", "completedShare", "medianCloseHours", "p90CloseHours",
    "medianFirstResponseHours", "p90FirstResponseHours",
    "labeledShare", "unlabeled", "answeredShare", "neverAnswered",
    "reporters", "newReporters", "responders", "responses",
    "closers", "closedByPR", "closedByHand", "unknownCloser",
    "assignees", "comments", "closedN", "respondedN",
  ],
};

export const FILED_FIELDS =
  ["repo", "number", "at", "open", "outcome", "comments", "waitDays", "title",
   "labels"];

export const CLOSED_FIELDS =
  ["repo", "number", "at", "outcome", "viaPR", "own", "title", "labels"];

/**
 * A person's review queue: PRs somebody is waiting on them for.
 *
 * One shape for both halves of it, because the two are the same row asked at
 * different points — "you've been asked" and "you've started" — and the card
 * shows them in one table. `at` is the request's PR open date on one side and
 * the date of their last review on the other, which is in both cases the date
 * that orders the list usefully. `state` is null on a request precisely because
 * they haven't said anything yet.
 *
 * Only open, unmerged PRs are in here. A review on something already merged
 * isn't ongoing, it's history, and history is what the Pull requests card is.
 */
export const REVIEW_FIELDS =
  ["repo", "number", "at", "author", "ageDays", "staleDays", "state", "draft",
   "title", "labels"];

/** Review verdicts, as the index the packed rows carry. */
export const REVIEW_STATES =
  ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"];

/**
 * PRs assigned to a person, open and resolved alike.
 *
 * Unlike the review queue this keeps closed rows: assignment is a record of
 * who owned a piece of work, and "what did I own last quarter" is as reasonable
 * a question as "what do I owe now". `at` is the resolution date, so it's null
 * on anything still open — which is also how the packer knows to sort those to
 * the top.
 */
export const ASSIGNED_FIELDS =
  ["repo", "number", "at", "outcome", "author", "ageDays", "staleDays", "draft",
   "title", "labels"];

/** How an assigned PR ended, as the index the packed rows carry. */
export const PR_OUTCOMES = ["open", "merged", "closed"];

/**
 * Trim to the last N months, filling gaps so charts don't lie about pauses.
 *
 * Emitted as `{ from, v: [[opened, merged, closed, approvals, people], …] }`
 * rather than an array of named objects, with quiet months as `null`. Most of
 * the 1,189 contributors are inactive in any given month, and repeating six key
 * names 24 times each cost more than every other field combined. The frontend
 * rehydrates this back into the named shape the chart helpers expect — a loop
 * over ~28k numbers, which is nothing.
 */
export const SERIES_FIELDS = ["opened", "merged", "closed", "approvals", "people"];

/**
 * The issue side of the same idea. Two shapes, because the four things a person
 * does to issues and the four things that happen to a tracker are not the same
 * four things — a repo has no "fixed by a PR of mine" and a person has no
 * "distinct reporters".
 */
export const ISSUE_SERIES_FIELDS = {
  contributors: ["filed", "closed", "responses", "fixed"],
  repos: ["opened", "closed", "responses", "people"],
};

/** Close reasons, as the index the packed rows carry. */
export const ISSUE_OUTCOMES = ["completed", "notPlanned", "duplicate"];
