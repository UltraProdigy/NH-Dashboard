/**
 * The definitions the repo activity panel is built out of, in both languages.
 *
 * Same reasoning as `contributor-rules.js` and `analytics-rules.js`: the panel
 * exists twice, once folding the ingest stores in JavaScript and once as SQL
 * inside a Worker, and anything both copies decide for themselves is free to
 * drift. A lifecycle boundary a day apart moves repos between buckets on two
 * dashboards that then disagree about how much of the org is alive.
 *
 * Dependency-free, because a Worker bundles it.
 */

/**
 * How long a repo can go untouched before it moves down a rung.
 *
 * The boundaries are 30, 90 and 365 days, which are the `m1`, `m3` and `y1`
 * window spans — deliberately, because the page offers those windows in its own
 * toolbar and a lifecycle cut at some fourth number would be a second
 * vocabulary for the same idea.
 *
 * They also happen to split this org evenly, which is the other half of the
 * argument. Measured over the 299 repos carrying any pull request or issue:
 * 124 active, 74 slowing, 64 dormant, 37 silent. No bucket is a sliver, so the
 * card is a distribution rather than one bar and three slivers — the test the
 * changes-requested histogram failed on PR Analytics.
 *
 * The split barely moves if last activity is taken to include `updatedAt`
 * rather than acts alone — 133/70/60/36 — so the boundaries are not balanced on
 * that choice.
 *
 * `maxDays` is exclusive of the next rung and the last is unbounded, matching
 * how `BACKLOG_BUCKETS` and `SIZE_BUCKETS` are read.
 */
export const LIFECYCLE = [
  { id: "active", label: "Active", detail: "touched this month", maxDays: 30 },
  { id: "slowing", label: "Slowing", detail: "1–3 months quiet", maxDays: 90 },
  { id: "dormant", label: "Dormant", detail: "3–12 months quiet", maxDays: 365 },
  { id: "silent", label: "Silent", detail: "over a year quiet", maxDays: Infinity },
];

/**
 * A repo with no activity at all is `silent`, not `unknown`.
 *
 * It cannot arise from the stores — a repo enters this panel by having a pull
 * request or an issue, so it always has a last-activity date — but the SQL twin
 * reaches the same expression through a LEFT JOIN that can produce NULL, and
 * two implementations disagreeing about the null case is exactly what this file
 * exists to prevent.
 */
export const lifecycleOf = (days) => {
  if (days == null) return LIFECYCLE[LIFECYCLE.length - 1].id;
  return (LIFECYCLE.find((b) => days < b.maxDays) ?? LIFECYCLE[LIFECYCLE.length - 1]).id;
};

/** The same decision as SQL, generated from the same list. */
export const lifecycleSql = (daysCol) =>
  "CASE " +
  `WHEN ${daysCol} IS NULL THEN '${LIFECYCLE[LIFECYCLE.length - 1].id}' ` +
  LIFECYCLE.slice(0, -1)
    .map((b) => `WHEN ${daysCol} < ${b.maxDays} THEN '${b.id}'`)
    .join(" ") +
  ` ELSE '${LIFECYCLE[LIFECYCLE.length - 1].id}' END`;

/**
 * When an open pull request stops being a backlog item and starts being a
 * question about the repo.
 *
 * Six months rather than one of the `BACKLOG_BUCKETS` boundaries, because this
 * is a different measurement. The backlog buckets describe the shape of what is
 * open; this is a single count meant to be read per repo and summed org-wide,
 * and it wants a threshold nobody argues with. 35 repos hold 66 such pull
 * requests today.
 */
export const STALE_OPEN_PR_DAYS = 180;

/**
 * How many repos the concentration figure covers.
 *
 * Five, matching the top-5 reviewer share on Review load, so the two numbers on
 * two pages mean the same kind of thing. The org's top five repos carry 59.9%
 * of the last quarter's activity.
 */
export const CONCENTRATION_N = 5;

/**
 * Busiest first, name ascending on a tie.
 *
 * The tiebreak is not decoration — see `byCountThenKey`. Without it a table
 * reshuffles between builds because an unrelated repo gained a pull request,
 * and the SQL twin has no way to reproduce whatever order the store yielded.
 */
export const byActivityThenRepo = (activityOf) => (a, b) => {
  const diff = activityOf(b) - activityOf(a);
  if (diff !== 0) return diff;
  return a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0;
};
