/**
 * What the issue panels agree an issue means, in both languages.
 *
 * Three places aggregate the issue store in JavaScript — the org panel, the
 * per-repo drilldown and the per-person drilldown — and a fourth now reads the
 * same records as SQL rows inside a Worker. If the contributor page counts a
 * duplicate as a resolved close and the issue page does not, the two disagree
 * about the same person and nothing says which is lying.
 *
 * The JavaScript definitions live in `panels/issueMetrics.js`, close to the
 * accumulators that use them. What lives here is the pair: each rule and the
 * SQL that has to mean the same thing, generated side by side so they cannot
 * drift, and asserted against each other in the parity test.
 *
 * The translation is not mechanical, because the two see different shapes. A
 * JavaScript record carries a nested `closedVia: {kind, repo, number, author}`;
 * D1 flattened that into four columns when the schema was written, precisely so
 * closer attribution could be queried. So these are not the same expression in
 * two syntaxes — they are two readings of one rule, which is the whole reason
 * to keep them in one file.
 *
 * Dependency-free, because a Worker bundles it.
 */

import { isHumanSql } from "./contributor-rules.js";

/**
 * Close reasons that mean "this was never fixed".
 *
 * GitHub has grown the list over time — DUPLICATE arrived after NOT_PLANNED —
 * and anything not in here counts as completed, so a reason added later fails
 * towards the flattering side. Worth re-checking against live data rather than
 * trusting this to stay exhaustive.
 */
/**
 * How long an open issue goes quiet before it counts as stale.
 *
 * Ninety days rather than thirty: on a modpack this size a bug report going
 * quiet for a month usually means it's queued behind a release, not that it was
 * dropped. Three months is where "nobody has looked at this" stops being a
 * guess.
 *
 * Here rather than in `config.js`, which reaches for `node:child_process` and
 * so cannot be imported by a Worker. `config.js` re-exports it, the same way it
 * does `WINDOWS` and `BACKLOG_BUCKETS`.
 */
export const ISSUE_STALE_DAYS = 90;

export const UNRESOLVED = ["NOT_PLANNED", "DUPLICATE"];

const quoted = UNRESOLVED.map((r) => `'${r}'`).join(", ");

/**
 * The one spelling of `state_reason` every writer has to store.
 *
 * GraphQL returns the enum — `NOT_PLANNED` — and REST and the webhook payloads
 * return `not_planned`. Every comparison below is a plain SQLite string compare,
 * which is case-sensitive, so a lowercase row fails `IN ('NOT_PLANNED', …)` and
 * is read as completed. That is the flattering direction, and it is invisible:
 * the row is present, the count is plausible, and only `unknownReason` moving
 * off zero says anything at all.
 *
 * So normalisation belongs to whoever writes the row, not to whoever reads it —
 * a reader that tolerated both spellings would let the two writers keep
 * disagreeing about what is in the column.
 */
export const stateReason = (value) =>
  value ? String(value).toUpperCase() : null;

/** `state_reason` says this close resolved nothing. */
export const unresolvedSql = (col = "state_reason") =>
  `(${col} IN (${quoted}))`;

/**
 * Completed is the *absence* of an unresolved reason, not `= 'COMPLETED'`.
 *
 * A close reason has been recorded on every closed issue GitHub has returned so
 * far, including ones closed years before the feature existed — it appears to
 * have backfilled COMPLETED onto them. A NULL reason therefore counts as
 * completed, and `unknownReason` counts how many landed there so the assumption
 * is visible if it ever starts firing.
 */
export const completedSql = (col = "state_reason") =>
  `(NOT ${unresolvedSql(col)} OR ${col} IS NULL)`;

/** Closed, with a reason that is neither unresolved nor explicitly COMPLETED. */
export const unknownReasonSql = (col = "state_reason") =>
  `(${completedSql(col)} AND (${col} IS NULL OR ${col} <> 'COMPLETED'))`;

/**
 * An issue nobody outside the reporter ever replied to.
 *
 * `response_unknown` records exhausted the ingest's comment sample without
 * finding a human reply, which is a different thing from silence — those are
 * excluded from both sides rather than counted as unanswered.
 */
export const unansweredSql = () =>
  `(first_response_at IS NULL AND response_unknown = 0)`;

/* ==========================================================================
   Credit for a close

   Two people can reasonably be said to have closed an issue: whoever pressed
   the button, and whoever wrote the pull request that made pressing it
   possible. Both are counted, separately and by name, because on this org they
   are usually different people doing different jobs — one triages, one fixes —
   and collapsing them into a single "closes" number would flatter the first and
   erase the second.
   ========================================================================== */

/** Who pressed the button, or NULL when that was a bot or is unknown. */
export const closerSql = () =>
  `(CASE WHEN ${isHumanSql("closed_by")} THEN closed_by END)`;

/** The close came from a pull request. `commit` and `projectv2` also occur. */
export const closedByPrSql = () => `(closed_via_kind = 'pr')`;

/** Author of the closing pull request — "my PR closed this ticket". */
export const fixerSql = () =>
  `(CASE WHEN ${closedByPrSql()} AND ${isHumanSql("closed_via_author")}
         THEN closed_via_author END)`;

/**
 * True when the store cannot say who closed this.
 *
 * Only a record that explicitly says it asked counts as known. Records written
 * before the ingest learned the question carry no flag, and reading their
 * silence as "closed by nobody" would report a store awaiting a re-walk as a
 * team that never closes anything — so the test is `closer_known` being
 * anything other than true, not `closed_by` being null.
 */
export const closerUnknownSql = () =>
  `(closed_at IS NOT NULL AND closer_known <> 1)`;

/**
 * Labels on the modpack follow a "Prefix: Value" convention — `Mod: GT`,
 * `Status: Stale`, `Type: Recipe` — and the prefixes are different questions,
 * not one long list. Flattening them into one ranked chart buries the nine
 * labels describing where work is stuck under a hundred describing what it is
 * about.
 *
 * Kept as a regex rather than a SQL expression on purpose: labels are a JSON
 * column, the panel reads them as whole lists, and splitting a prefix is
 * something to do once per distinct label in the isolate rather than once per
 * row in the database.
 */
const LABEL_PREFIX = /^([A-Za-z0-9][A-Za-z0-9 ]*):\s*(.+)$/;

export function splitLabel(name) {
  const m = LABEL_PREFIX.exec(name);
  return m ? { group: m[1], short: m[2] } : { group: "Other", short: name };
}

/**
 * Groups in the order they answer an admin's questions: where is it stuck, how
 * bad is it, what kind of thing is it, which component, everything else.
 * Anything unlisted sorts after these, alphabetically.
 */
export const GROUP_ORDER = ["Status", "Bug", "Type", "Platform", "Mod", "Other"];

/**
 * Only labels with at least this many issues get a monthly series. The long
 * tail of `Mod:` labels carrying three issues each would triple the payload to
 * draw a chart that is two dots and a gap.
 */
export const SERIES_MIN = 20;

/** How far back per-label monthly series reach. */
export const SERIES_MONTHS = 60;

export const groupRank = (g) => {
  const i = GROUP_ORDER.indexOf(g);
  return i === -1 ? GROUP_ORDER.length : i;
};

/* ==========================================================================
   Ordering the triage lists

   `oldest`, `quietest`, `ignored` and `mostDiscussed` are top-40 and top-25
   cuts of a much longer list, sorted on a metric that ties constantly: the
   first three rank on a whole *day* count, so every issue filed in the same
   day is level. Nine open issues share the boundary age of the current
   `oldest` list and six of them fit, which means the other three are excluded
   by nothing but the order the store happened to yield.

   That is the same latent bug already fixed on `topRepos`, `topAuthors`,
   `topReviewers` and the leaderboard, arriving in a fourth place. Sorting on
   the metric alone leaves the tail in store order, which reshuffles whenever
   the ingest re-walks — and once the panel exists in two languages it stops
   being cosmetic, because store order is not something SQL can reproduce at
   all. The two would disagree by construction, on the six rows nobody looks
   at closely.

   `mostDiscussed` had a tiebreak already and it is not a total one: it breaks
   on `number`, which is unique per repo and not across them. 723 pairs of
   issues in this store share a `(comments, number)`, so the order of any two
   of those was still the store's to decide.

   Ties therefore break on the repo and then the number, which is unique by
   primary key and so can never leave two rows level.
   ========================================================================== */

/** Metric descending, then `(repo, number)` ascending. A total order. */
export const byMetricThenIssue = (metricOf) => (a, b) => {
  const diff = (metricOf(b) ?? 0) - (metricOf(a) ?? 0);
  if (diff !== 0) return diff;
  if (a.repo !== b.repo) return a.repo < b.repo ? -1 : 1;
  return a.number - b.number;
};

/**
 * The same order as an `ORDER BY` body.
 *
 * `number` is compared numerically on both sides. Note this is deliberately
 * *not* the `repo || '#' || number` string used to pick a reporter's first
 * issue below — that one has to stay a string compare because the JavaScript
 * it mirrors compares `id` strings, and the two orderings differ whenever two
 * numbers in one repo have different digit counts.
 */
export const issueOrderSql = (metric) => `${metric} DESC, repo ASC, number ASC`;

/**
 * An issue's identity as one string. `repo#number`.
 *
 * Used to decide which of two issues filed in the same second was somebody's
 * first ever, which is what `newReporters` counts. GitHub stamps to the second
 * and three authors in this store have filed more than one inside one, so with
 * no tiebreak "is this their first?" is true of *all* of them — which is how
 * the all-time first-time-reporter total once came out higher than the reporter
 * total it is a subset of.
 */
export const issueId = (repo, number) => `${repo}#${number}`;

/**
 * The same order in SQL: earliest `created_at`, then the smallest `id`.
 *
 * A string comparison of `repo || '#' || number`, matching `issueId` — and
 * deliberately not `(repo, number)`, which sorts `#10` after `#9` where the
 * string sorts it before. The two agree on every row in the store today,
 * because no two same-second issues in one repo differ in digit count, so the
 * parity test constructs a pair that does. This lived inline in the Worker
 * panel until it was needed twice, which is the unwatched second copy of a
 * definition that this file exists to prevent.
 */
export const firstIssueOrderSql = () => `created_at, repo || '#' || number`;

/**
 * The order of the per-repo label table: group, then busiest, then the name.
 *
 * Groups lead because they are different questions rather than one long list —
 * `Status:` is a triage pipeline, `Mod:` is a hundred components — and within a
 * group the busiest label is the one worth seeing.
 *
 * The name is the tiebreak, and it is not decoration: 86 of the 314 label rows
 * are level on both `open` and `total` inside their own group, because most
 * labels carry one issue. Without it that quarter of the table sits in store
 * order, which the SQL side cannot reproduce.
 *
 * Compared with `<` rather than `localeCompare` throughout, including the group
 * name, so two runtimes in two locales cannot disagree about the answer.
 */
export const byLabelGroupThenOpen = (a, b) => {
  const rank = groupRank(a.group) - groupRank(b.group);
  if (rank !== 0) return rank;
  if (a.group !== b.group) return a.group < b.group ? -1 : 1;
  if (b.open !== a.open) return b.open - a.open;
  if (b.total !== a.total) return b.total - a.total;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
};

/**
 * An empty JSON array, tested as a string.
 *
 * `labels` and `assignees` are JSON columns, and "has none" is the only
 * question the core panel asks of them. Every empty value in the store is
 * exactly `[]` — 8,389 issues with no labels and 22,336 with no assignee — so
 * this needs no JSON support at all, which keeps the whole core port
 * independent of whether D1 provides `json_each`. The label breakdown does need
 * it, and finds out separately.
 */
export const emptyJsonSql = (col) => `(${col} = '[]')`;
