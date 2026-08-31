/**
 * Issue analytics, aggregated in SQL.
 *
 * The Node panel of the same name walks 26,161 records in JavaScript, keeping
 * a dozen accumulators and six `Set`s alive across the loop. Here the counting
 * happens inside D1 and this module stitches the result sets together, for the
 * reason every panel before it did: query time is I/O and free, a loop over the
 * whole store is CPU and is not.
 *
 * Every definition comes from `src/shared/issue-rules.js`, which pairs each
 * rule with its SQL twin. Nothing in this file decides what "unanswered" or
 * "closed by" means, because the JavaScript panel decides that too and two
 * copies of a definition is a bet that nobody edits one of them.
 *
 * ## Ported in slices, and the panel says which
 *
 * `issues` is fifteen keys — the largest single panel here, larger than
 * `analytics`. It went in in three parts, and `PORTED` below is the list this
 * file answers for. The parity test reads it: any key that is neither in
 * `PORTED` nor in its own pending list fails, so a key could not be quietly
 * forgotten between slices. All fifteen are ported and `PENDING` is empty.
 *
 * It is registered in `recompute.js` and deliberately **not** in `LIVE_PANELS`.
 * Every key reconciles against the build, but on the *seed* — and the seed is
 * not production. `ciHealth` went through the same gate: build the cache, diff
 * `/api/panel/issues` against `data/dashboard.json`, and only then let a card
 * claim to be current. `web/js/live.js` overlays a panel by replacing the whole
 * object, so a wrong answer here would not degrade, it would tint every issue
 * card **blue** over it.
 *
 * ## Cost, measured rather than guessed
 *
 * 44 queries, 1,913ms on the local replica — so about **4.2s projected on D1**
 * at the 2.2x ratio `analytics` established, against that panel's 3.08s. The
 * cached blob is 655 KB against D1's 2 MB row cap, and the peak working set is
 * 35.4 MB against a Worker's 128 MB.
 *
 * `people` and `labels` share one full-row fetch rather than taking one each,
 * which is 32 MB and a table scan saved for nothing but passing an array.
 *
 * Two panels at ~7s of a ten-minute cron is comfortable, but it is no longer
 * negligible, and this is now the most expensive one. The headroom below is
 * where to start if a third pushes it.
 *
 * Headroom deliberately left, in order of size, if `people` makes the whole
 * recompute too slow later:
 *
 *   - the `firsts` CTE is rebuilt four times — once per series grain and once
 *     for `byWindow` — at 98, 65, 61 and 61ms locally. Computing the
 *     first-issue flag once would return ~220ms local, ~490ms on D1, and is
 *     the single largest piece of waste here.
 *   - `weekKeySql` costs 96–127ms in the week-grain percentile queries. Same
 *     expression `analytics` already lists as its own top headroom item.
 *
 * Neither is touched yet. `analytics` spent three deploys on theories about
 * where its time went and was wrong twice; the numbers are recorded so the
 * trade can be made on evidence if it ever needs making.
 */

import { ISSUE_LABEL_REPO, ISSUE_STALE_DAYS } from "../../../src/config.js";
import {
  BACKLOG_BUCKETS,
  DAY_SERIES_DAYS,
  DEFAULT_ORG,
  dayKeySql,
  hoursSql,
  isoBound,
  monthKeySql,
  pctRankSql,
  round1,
  weekKeySql,
} from "../../../src/shared/analytics-rules.js";
import { WINDOWS, isBot, isHumanSql } from "../../../src/shared/contributor-rules.js";
import { byCountThenKey } from "../../../src/shared/analytics-rules.js";
import {
  PEOPLE_CAP,
  PERSON_FIELDS,
  blankPersonPeriod,
  closerOf,
  fixerOf,
  foldPerson,
  inPeriod,
  median,
  packPerson,
  summarizePersonPeriod,
} from "../../../src/panels/issueMetrics.js";
import {
  percentilesAcrossPeriods,
  periodParams,
  periodSums,
  periodsFor,
} from "../periods.js";
import {
  byMetricThenIssue,
  closedByPrSql,
  closerSql,
  closerUnknownSql,
  GROUP_ORDER,
  SERIES_MIN,
  SERIES_MONTHS,
  byLabelGroupThenOpen,
  completedSql,
  emptyJsonSql,
  splitLabel,
  firstIssueOrderSql,
  issueOrderSql,
  unansweredSql,
  unknownReasonSql,
  unresolvedSql,
} from "../../../src/shared/issue-rules.js";

const DAY = 86_400_000;

/** The keys this file answers for. See the slice note above. */
export const PORTED = [
  "totals",
  "series",
  "triage",
  "repos",
  "mostDiscussed",
  "windows",
  "byWindow",
  "people",
  "personFields",
  "peopleCap",
  "labelFocus",
  "labelsByRepo",
  "labelSeries",
  "labelSeriesMin",
  "labelGroupOrder",
];

/** Nothing left. Kept so a future slice has somewhere honest to declare itself. */
export const TOTALS_PENDING = [];

const round3 = (n) => (n == null ? null : Math.round(n * 1000) / 1000);

/* ------------------------------------------------------------------ helpers */

/**
 * The three series grains, each with its key expression.
 *
 * `day` is bounded — the org's history starts in 2014 and an all-time daily
 * series is ~4,300 buckets for a chart nobody can read at that width.
 */
const GRAINS = [
  { id: "day", key: dayKeySql },
  { id: "week", key: weekKeySql },
  { id: "month", key: monthKeySql },
];

/**
 * `staleDays >= ISSUE_STALE_DAYS`, as a comparison the index can use.
 *
 * The JavaScript is `floor((now - updated) / DAY) >= 90`, which is
 * `updated_ms <= now - 90*DAY`. That is a `<=`, and `isoBound` is documented
 * only for `>=` and `<` — so it is expressed as `< bound + 1ms`, which is the
 * same set over integer milliseconds and stays inside the helper's contract.
 * Reimplementing the ceiling here would be a second copy of the one rule that
 * has already gotten a boundary second backwards once.
 */
const staleBefore = (now) => isoBound(now - ISSUE_STALE_DAYS * DAY + 1);

/**
 * Median and p90 of one duration, per group, in a single query.
 *
 * The obvious shape — one query per percentile — reads the same rows twice and
 * ranks them twice. Here the set is ranked once and both ranks are picked out
 * of it by `pctRankSql`, which is the one-based rank the JavaScript `pct` would
 * index.
 *
 * `ROWS UNBOUNDED PRECEDING` is not needed because this ranks with
 * `ROW_NUMBER` rather than a running total — every row gets a distinct rank
 * whether or not it ties on the value, which is what `pct`'s array index does.
 */
function percentileSql(groupExpr, valueExpr, where) {
  return `
    WITH ranked AS (
      SELECT ${groupExpr} AS grp,
             ${valueExpr} AS value,
             ROW_NUMBER() OVER (PARTITION BY ${groupExpr} ORDER BY ${valueExpr})
               AS rn,
             COUNT(*)     OVER (PARTITION BY ${groupExpr}) AS n
        FROM issues
       WHERE ${where}
    )
    SELECT grp,
           MAX(CASE WHEN rn = ${pctRankSql("n", 50)} THEN value END) AS p50,
           MAX(CASE WHEN rn = ${pctRankSql("n", 90)} THEN value END) AS p90
      FROM ranked
     GROUP BY grp`;
}

const closeHours = hoursSql("created_at", "closed_at");
const responseHours = hoursSql("created_at", "first_response_at");

/* ------------------------------------------------------------------- totals */

/**
 * Every all-time scalar, in one pass.
 *
 * The close breakdown is a `CASE` chain rather than three predicates because
 * that is what the JavaScript is — an if / else-if / else — and the difference
 * shows up on NULLs. `closed_via_kind = 'pr'` is NULL when the column is, and
 * `NOT NULL` is NULL, so a negated predicate would drop every hand-closed issue
 * out of all three counts at once. A `CASE` falls through to `ELSE` instead,
 * which is the branch the JavaScript takes.
 */
async function totals(db) {
  const human = isHumanSql("author");
  const sql = `
    SELECT COUNT(*) AS issues,
           SUM(state = 'OPEN')  AS open,
           SUM(state <> 'OPEN') AS closed,
           SUM(state <> 'OPEN' AND state_reason = 'NOT_PLANNED')
             AS not_planned,
           SUM(state <> 'OPEN' AND state_reason = 'DUPLICATE')
             AS duplicate,
           SUM(state <> 'OPEN' AND ${completedSql()})     AS completed,
           SUM(state <> 'OPEN' AND ${unknownReasonSql()}) AS unknown_reason,
           SUM(response_unknown <> 0) AS response_unknown,
           SUM(CASE WHEN closed_at IS NULL      THEN 0
                    WHEN ${closedByPrSql()}     THEN 1
                    ELSE 0 END) AS closed_by_pr,
           SUM(CASE WHEN closed_at IS NULL      THEN 0
                    WHEN ${closedByPrSql()}     THEN 0
                    WHEN ${closerUnknownSql()}  THEN 1
                    ELSE 0 END) AS unknown_closer,
           SUM(CASE WHEN closed_at IS NULL      THEN 0
                    WHEN ${closedByPrSql()}     THEN 0
                    WHEN ${closerUnknownSql()}  THEN 0
                    ELSE 1 END) AS closed_by_hand,
           COUNT(DISTINCT CASE WHEN ${human} THEN author END) AS reporters,
           COUNT(DISTINCT repo) AS repos,
           MIN(CASE WHEN ${human} THEN created_at END) AS first_issue
      FROM issues`;

  const r = await db.prepare(sql).first();
  return {
    issues: r.issues,
    open: r.open,
    closed: r.closed,
    completed: r.completed,
    notPlanned: r.not_planned,
    duplicate: r.duplicate,
    unknownReason: r.unknown_reason,
    responseUnknown: r.response_unknown,
    closedByPR: r.closed_by_pr,
    closedByHand: r.closed_by_hand,
    unknownCloser: r.unknown_closer,
    reporters: r.reporters,
    repos: r.repos,
    firstIssue: r.first_issue ?? null,
  };
}

/* ------------------------------------------------------------------- series */

/**
 * Opened-side counts for one grain.
 *
 * `newReporters` is the interesting half. A reporter is "new" on the one issue
 * that was their first ever, and the JavaScript breaks a same-second tie on
 * `repo#number` as a *string* — so the CTE orders on the same concatenation
 * rather than on `(repo, number)`, which would disagree the moment two numbers
 * in one repo have different digit counts. This is the one place in the file
 * that ordering is used; the triage lists use the numeric one.
 *
 * The CTE is named `firsts` rather than anything resembling a table name.
 * `scope.js` rewrites `FROM issues` into a filtered subquery, and a CTE named
 * after a real table would be rewritten with it.
 */
async function openedSeries(db, key, where) {
  const sql = `
    WITH firsts AS (
      SELECT repo, number,
             ROW_NUMBER() OVER (
               PARTITION BY author
               ORDER BY ${firstIssueOrderSql()}
             ) AS rn
        FROM issues
       WHERE ${isHumanSql("author")}
    )
    SELECT ${key("i.created_at")} AS b,
           MIN(i.created_at) AS t,
           COUNT(*) AS opened,
           COUNT(DISTINCT CASE WHEN ${isHumanSql("i.author")} THEN i.author END)
             AS reporters,
           SUM(CASE WHEN f.rn = 1 THEN 1 ELSE 0 END) AS new_reporters,
           SUM(i.closed_at IS NOT NULL)        AS close_n,
           SUM(i.first_response_at IS NOT NULL) AS response_n
      FROM issues i
      LEFT JOIN firsts f ON f.repo = i.repo AND f.number = i.number
     WHERE ${where("i.created_at")}
     GROUP BY b`;

  return (await db.prepare(sql).all()).results;
}

/** Closes are counted against the period they happened in, not the one the issue was opened in. */
async function closedSeries(db, key, where) {
  const sql = `
    SELECT ${key("closed_at")} AS b,
           MIN(closed_at) AS t,
           COUNT(*) AS closed,
           SUM(${unresolvedSql()}) AS unresolved
      FROM issues
     WHERE closed_at IS NOT NULL AND ${where("closed_at")}
     GROUP BY b`;

  return (await db.prepare(sql).all()).results;
}

/**
 * One grain of the series.
 *
 * Four queries rather than one join: the two sides key on different columns and
 * a bucket can exist on either side alone — a month in which everything filed
 * years earlier was finally closed has a `closed` count and no `opened` one.
 *
 * Note both duration sets are attributed to the bucket the issue was *opened*
 * in, not the one it was closed in. That is what the JavaScript does, and it is
 * not obviously right — it means a bucket's median close time describes how
 * long its own issues took, not how long the things closed that week had been
 * waiting. Reproduced rather than corrected: this port's job is to agree.
 */
async function seriesFor(db, grain, now) {
  const key = grain.key;
  const where =
    grain.id === "day"
      ? (col) => `${col} >= '${isoBound(now - DAY_SERIES_DAYS * DAY)}'`
      : () => "1";

  const [opened, closed, close, response] = await Promise.all([
    openedSeries(db, key, where),
    closedSeries(db, key, where),
    db
      .prepare(
        percentileSql(
          key("created_at"),
          closeHours,
          `closed_at IS NOT NULL AND ${where("created_at")}`,
        ),
      )
      .all(),
    db
      .prepare(
        percentileSql(
          key("created_at"),
          responseHours,
          `first_response_at IS NOT NULL AND ${where("created_at")}`,
        ),
      )
      .all(),
  ]);

  const buckets = new Map();
  const at = (b, t) => {
    let x = buckets.get(b);
    if (!x) buckets.set(b, (x = { b, t, opened: 0, closed: 0, unresolved: 0,
                                  reporters: 0, newReporters: 0,
                                  closeN: 0, responseN: 0 }));
    if (t < x.t) x.t = t;
    return x;
  };

  for (const r of opened) {
    const x = at(r.b, r.t);
    x.opened = r.opened;
    x.reporters = r.reporters;
    x.newReporters = r.new_reporters;
    x.closeN = r.close_n;
    x.responseN = r.response_n;
  }
  for (const r of closed) {
    const x = at(r.b, r.t);
    x.closed = r.closed;
    x.unresolved = r.unresolved;
  }

  const closeBy = new Map(close.results.map((r) => [r.grp, r]));
  const respBy = new Map(response.results.map((r) => [r.grp, r]));

  const out = [];
  for (const x of buckets.values()) {
    const c = closeBy.get(x.b);
    const p = respBy.get(x.b);
    out.push({
      b: x.b,
      t: x.t,
      opened: x.opened,
      closed: x.closed,
      unresolved: x.unresolved,
      // The only number on the chart that can go negative, and the one that
      // answers "are we keeping up".
      net: x.opened - x.closed,
      reporters: x.reporters,
      newReporters: x.newReporters,
      closeMedianH: round1(c?.p50 ?? null),
      closeP90H: round1(c?.p90 ?? null),
      responseMedianH: round1(p?.p50 ?? null),
      closeN: x.closeN,
      responseN: x.responseN,
    });
  }

  // `<` rather than `localeCompare`, which is what the Node panel uses. The
  // keys are ASCII and fixed-width per grain so the two orders are identical,
  // and `<` cannot disagree between two runtimes in two locales.
  out.sort((a, b) => (a.b < b.b ? -1 : a.b > b.b ? 1 : 0));
  return out;
}

/* ------------------------------------------------------------------- triage */

/**
 * The open backlog, read into the isolate.
 *
 * This is the one place the panel deliberately does not aggregate in SQL. The
 * open set is 2,486 rows — three orders of magnitude off the 96,000-row loop
 * that made reusing the Node panels impossible — and it feeds five different
 * shapes: two bucket histograms and three top-40 lists over two different sort
 * keys and a filter. Expressing that as five queries would be five chances to
 * write a predicate that differs from `isUnanswered` by a NULL.
 */
async function triage(db, now) {
  const sql = `
    SELECT repo, number, title, author, labels, assignees, comments,
           created_at, updated_at, first_response_at, response_unknown
      FROM issues
     WHERE state = 'OPEN'`;

  const rows = (await db.prepare(sql).all()).results;

  const open = rows.map((r) => {
    const created = Date.parse(r.created_at);
    const respHours =
      r.first_response_at
        ? (Date.parse(r.first_response_at) - created) / 3_600_000
        : null;
    return {
      repo: r.repo,
      number: r.number,
      title: r.title ?? "",
      author: r.author,
      url: `https://github.com/${DEFAULT_ORG}/${r.repo}/issues/${r.number}`,
      labels: JSON.parse(r.labels || "[]"),
      assigned: JSON.parse(r.assignees || "[]").length > 0,
      comments: r.comments ?? 0,
      ageDays: Math.floor((now - created) / DAY),
      staleDays: r.updated_at
        ? Math.floor((now - Date.parse(r.updated_at)) / DAY)
        : null,
      // `isUnanswered` inverted, and written the same falsy way it is: a
      // record that exhausted the comment sample without finding a reply is
      // not silence, and is excluded from both sides rather than counted.
      answered: !(!r.first_response_at && !r.response_unknown),
      responseDays: respHours == null ? null : Math.round(respHours / 24),
    };
  });

  const bucketize = (list, field) => {
    const counts = BACKLOG_BUCKETS.map((b) => ({ label: b.label, count: 0 }));
    for (const it of list) {
      const v = it[field];
      if (v == null) continue;
      const i = BACKLOG_BUCKETS.findIndex((b) => v < b.max);
      counts[i === -1 ? BACKLOG_BUCKETS.length - 1 : i].count++;
    }
    return counts;
  };

  const unanswered = open.filter((i) => !i.answered);

  return {
    open: open.length,
    unlabeled: open.filter((i) => !i.labels.length).length,
    unanswered: unanswered.length,
    unassigned: open.filter((i) => !i.assigned).length,
    stale: open.filter((i) => (i.staleDays ?? 0) >= ISSUE_STALE_DAYS).length,
    staleDays: ISSUE_STALE_DAYS,
    ageBuckets: bucketize(open, "ageDays"),
    staleBuckets: bucketize(open, "staleDays"),
    oldest: [...open].sort(byMetricThenIssue((i) => i.ageDays)).slice(0, 40),
    quietest: [...open].sort(byMetricThenIssue((i) => i.staleDays)).slice(0, 40),
    ignored: [...unanswered].sort(byMetricThenIssue((i) => i.ageDays)).slice(0, 40),
  };
}

/* -------------------------------------------------------------------- repos */

async function repos(db, now) {
  const human = isHumanSql("author");
  const stale = staleBefore(now);

  const sql = `
    SELECT repo,
           COUNT(*) AS total,
           SUM(state = 'OPEN')  AS open,
           SUM(state <> 'OPEN') AS closed,
           SUM(state = 'OPEN' AND ${unansweredSql()})        AS unanswered,
           SUM(state = 'OPEN' AND ${emptyJsonSql("labels")}) AS unlabeled,
           SUM(state = 'OPEN' AND ${emptyJsonSql("assignees")})
             AS unassigned,
           SUM(state = 'OPEN' AND updated_at < '${stale}')   AS stale,
           SUM(CASE WHEN closed_at IS NULL  THEN 0
                    WHEN ${closedByPrSql()} THEN 1
                    ELSE 0 END) AS closed_by_pr,
           COUNT(DISTINCT CASE WHEN ${human} THEN author END) AS reporters,
           COUNT(DISTINCT ${closerSql()}) AS closers,
           MAX(updated_at) AS last
      FROM issues
     GROUP BY repo`;

  const [base, close, response] = await Promise.all([
    db.prepare(sql).all(),
    db.prepare(percentileSql("repo", closeHours, "closed_at IS NOT NULL")).all(),
    db
      .prepare(
        percentileSql("repo", responseHours, "first_response_at IS NOT NULL"),
      )
      .all(),
  ]);

  const closeBy = new Map(close.results.map((r) => [r.grp, r]));
  const respBy = new Map(response.results.map((r) => [r.grp, r]));

  const rows = base.results.map((r) => ({
    repo: r.repo,
    total: r.total,
    open: r.open,
    closed: r.closed,
    unanswered: r.unanswered,
    unlabeled: r.unlabeled,
    unassigned: r.unassigned,
    stale: r.stale,
    closedByPR: r.closed_by_pr,
    // Of everything closed here, how much landed through a pull request. The
    // rest was closed by hand, which is triage.
    prShare: r.closed ? round3(r.closed_by_pr / r.closed) : null,
    reporters: r.reporters,
    closers: r.closers,
    last: r.last,
    medianCloseHours: round1(closeBy.get(r.repo)?.p50 ?? null),
    medianFirstResponseHours: round1(respBy.get(r.repo)?.p50 ?? null),
  }));

  rows.sort(byOpenThenRepo);
  return rows;
}

/**
 * Open descending, then total, then the repo name.
 *
 * The Node panel had no third key, and 61 repos ranked on two small integers
 * tie readily: seven pairs do, one of them at `open = 22, total = 71`, well up
 * the visible part of the table. Without the name those seven land in whatever
 * order the store or `GROUP BY` yielded, which is not something the other
 * implementation can reproduce.
 *
 * Exported because a dropped tiebreak is invisible from the output — SQLite
 * happens to group by repo in name order, so removing this changes nothing
 * today while making the result depend on a query plan. The parity test sorts a
 * shuffled copy with it instead, which fails the moment it stops being total.
 */
export const byOpenThenRepo = (a, b) =>
  b.open - a.open ||
  b.total - a.total ||
  (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0);

/* ------------------------------------------------------------ mostDiscussed */

/**
 * Ordered and cut in SQL, which only became possible once the order was total.
 *
 * The Node panel broke ties on `number` alone. That is unique within a repo and
 * not across them — 723 pairs in this store share a `(comments, number)` — so
 * `LIMIT 25` would have returned whichever 25 D1 felt like among the ties.
 */
async function mostDiscussed(db, now) {
  // The author is nulled for bots rather than filtered out — a busy
  // bot-authored thread is still one of the most discussed, it just has nobody
  // to credit. `isHumanSql` does the nulling in SQL so the bot rule is not
  // spelled a second time here.
  const sql = `
    SELECT repo, number, title, comments, state, created_at,
           CASE WHEN ${isHumanSql("author")} THEN author END AS author
      FROM issues
     WHERE comments > 0
     ORDER BY ${issueOrderSql("comments")}
     LIMIT 25`;

  const rows = (await db.prepare(sql).all()).results;

  return rows.map((r) => ({
    repo: r.repo,
    number: r.number,
    title: r.title ?? "",
    author: r.author ?? null,
    comments: r.comments,
    open: r.state === "OPEN",
    ageDays: Math.floor((now - Date.parse(r.created_at)) / DAY),
  }));
}

/* ----------------------------------------------------------------- byWindow */

/**
 * `COUNT(DISTINCT …)` for every period, as one column each.
 *
 * The sibling of `periodSums`, which wraps its expression in `SUM`. Four of
 * this panel's window figures are set sizes rather than counts — how many
 * distinct people reported, responded, closed, and how many repos saw activity
 * — and a `SUM` cannot answer any of them.
 */
const periodDistincts = (expr, prefix, periods) =>
  periods
    .map((_, i) => `COUNT(DISTINCT ${expr("?", "?")}) AS ${prefix}_${i}`)
    .join(",\n           ");

const opened = (a, b) => `created_at >= ${a} AND created_at < ${b}`;
const closedIn = (a, b) => `closed_at >= ${a} AND closed_at < ${b}`;
const responded = (a, b) =>
  `first_response_at >= ${a} AND first_response_at < ${b}`;

/**
 * The window scalars, one query each.
 *
 * Thirteen columns per query rather than one query of ~150 columns. The wide
 * shape is tempting and is exactly what `analytics` left on its own list of
 * untried optimisations, with the note that D1's compound-SELECT limit is far
 * below SQLite's and a local replica cannot prove dialect. The widest thing
 * running in production today is 39 columns, so these stay well inside what is
 * known to work.
 */
const SCALARS = {
  opened,
  comments: (a, b) =>
    `CASE WHEN ${opened(a, b)} THEN COALESCE(comments, 0) ELSE 0 END`,
  labeled: (a, b) => `${opened(a, b)} AND NOT ${emptyJsonSql("labels")}`,
  unanswered: (a, b) => `${opened(a, b)} AND ${unansweredSql()}`,
  // Not the negation of `unanswered`: an issue whose comment sample ran out
  // without finding a reply is neither, and is excluded from both.
  answered: (a, b) => `${opened(a, b)} AND first_response_at IS NOT NULL`,
  closed: closedIn,
  notPlanned: (a, b) => `${closedIn(a, b)} AND state_reason = 'NOT_PLANNED'`,
  duplicate: (a, b) => `${closedIn(a, b)} AND state_reason = 'DUPLICATE'`,
  completed: (a, b) => `${closedIn(a, b)} AND ${completedSql()}`,
  closedByPR: (a, b) => `${closedIn(a, b)} AND ${closedByPrSql()}`,
  // The `closed_at IS NULL` arm is load-bearing and was missing once. With a
  // NULL close date the period test is `NOT (NULL >= ? AND NULL < ?)`, which is
  // NULL, and a `CASE WHEN NULL` does not match — so every *open* issue fell
  // through all three arms into `ELSE 1` and was counted as closed by hand.
  // 2,484 of them, on a figure of 19,011, and the all-time `totals` version of
  // the same count was right the whole time because it leads with this arm.
  unknownCloser: (a, b) =>
    `CASE WHEN closed_at IS NULL       THEN 0
          WHEN NOT (${closedIn(a, b)}) THEN 0
          WHEN ${closedByPrSql()}      THEN 0
          WHEN ${closerUnknownSql()}   THEN 1
          ELSE 0 END`,
  closedByHand: (a, b) =>
    `CASE WHEN closed_at IS NULL       THEN 0
          WHEN NOT (${closedIn(a, b)}) THEN 0
          WHEN ${closedByPrSql()}      THEN 0
          WHEN ${closerUnknownSql()}   THEN 0
          ELSE 1 END`,
  // How many first replies were given in the period, as opposed to how many
  // distinct people gave them.
  //
  // The bot filter is unexercised and stays anyway: `firstResponse()` in the
  // ingest already skips bots when picking a responder, so no row in the store
  // can fail this test and deleting it changes nothing today. That is an
  // argument for keeping it rather than against — the day the ingest is asked
  // to record that a stale bot replied, this is what stops the bot appearing
  // in a responder count.
  responses: (a, b) =>
    `${responded(a, b)} AND ${isHumanSql("first_responder")}`,
};

const DISTINCTS = {
  reporters: (a, b) =>
    `CASE WHEN ${opened(a, b)} AND ${isHumanSql("author")} THEN author END`,
  activeRepos: (a, b) => `CASE WHEN ${opened(a, b)} THEN repo END`,
  closers: (a, b) => `CASE WHEN ${closedIn(a, b)} THEN ${closerSql()} END`,
  responders: (a, b) =>
    `CASE WHEN ${responded(a, b)} AND ${isHumanSql("first_responder")}
          THEN first_responder END`,
};

/**
 * `newReporters` needs the first-issue ranking, so it cannot join the others.
 */
async function newReporters(db, periods) {
  const sql = `
    WITH firsts AS (
      SELECT repo, number,
             ROW_NUMBER() OVER (
               PARTITION BY author
               ORDER BY ${firstIssueOrderSql()}
             ) AS rn
        FROM issues
       WHERE ${isHumanSql("author")}
    )
    SELECT ${periodSums(
      (a, b) =>
        `i.created_at >= ${a} AND i.created_at < ${b} AND f.rn = 1`,
      "n",
      periods,
    )}
      FROM issues i
      LEFT JOIN firsts f ON f.repo = i.repo AND f.number = i.number`;

  const row = await db.prepare(sql).bind(...periodParams(periods)).first();
  return periods.map((_, i) => row?.[`n_${i}`] ?? 0);
}

/**
 * A ranked list per period, from one grouped query.
 *
 * The whole group set comes back with its thirteen per-period counts and the
 * cutting happens here, because a top-8 per period in SQL would be thirteen
 * windowed queries over the same grouping. The widest of these is the reporter
 * list at ~6,500 rows, which is a tenth of what the panel already reads for
 * triage.
 */
async function topPerPeriod(db, { select, from, group, key }, periods, at, n) {
  const sql = `
    SELECT ${select} AS k,
           ${periodSums(at, "n", periods)}
      FROM ${from}
     ${group}
    HAVING k IS NOT NULL`;

  const rows = (await db.prepare(sql).bind(...periodParams(periods)).all())
    .results;

  return periods.map((_, i) =>
    rows
      .filter((r) => r[`n_${i}`] > 0)
      .map((r) => ({ [key]: r.k, count: r[`n_${i}`] }))
      .sort(byCountThenKey((x) => x[key], (x) => x.count))
      .slice(0, n),
  );
}

/**
 * Labels and assignees per period, expanded in the isolate.
 *
 * These are the two JSON columns, and the obvious SQL is `json_each` — the one
 * D1 feature this store has never exercised, which cannot be probed through
 * wrangler because `--file` discards result rows. So it would cost a deploy to
 * find out, and it gates five separate figures.
 *
 * Measured instead: the two columns are 0.76 MB across the rows that carry
 * one, and expanding them into thirteen period maps costs ~42ms locally, ~92ms
 * projected on D1 — the same order as `json_each` would be, against a panel
 * whose `analytics` sibling runs in three seconds. `by-label.js` made the same
 * call for the same reason at a smaller scale.
 *
 * Only rows carrying a non-empty array are fetched: 17,827 of 26,161 have a
 * label and 4,167 an assignee, so the empty majority never crosses the wire.
 */
export async function labelsAndAssignees(db, periods) {
  const sql = `
    SELECT created_at, labels, assignees
      FROM issues
     WHERE ${`NOT ${emptyJsonSql("labels")}`}
        OR ${`NOT ${emptyJsonSql("assignees")}`}`;

  const rows = (await db.prepare(sql).all()).results;

  const maps = periods.map(() => ({ labels: new Map(), assignees: new Map() }));

  for (const r of rows) {
    const at = r.created_at;
    let parsedL = null;
    let parsedA = null;
    for (let i = 0; i < periods.length; i++) {
      const p = periods[i];
      if (!(at >= p.from && at < p.to)) continue;
      parsedL ??= JSON.parse(r.labels || "[]");
      parsedA ??= JSON.parse(r.assignees || "[]");
      const m = maps[i];
      for (const name of parsedL) {
        const cell = m.labels.get(name) ?? { name, opened: 0 };
        cell.opened++;
        m.labels.set(name, cell);
      }
      for (const login of parsedA) {
        if (isBot(login)) continue;
        m.assignees.set(login, (m.assignees.get(login) ?? 0) + 1);
      }
    }
  }

  return maps;
}

/**
 * Per-period repo activity, which is not the same shape as the other top lists.
 *
 * Its rows carry two numbers — how many issues the repo saw opened in the
 * period, and how many of *those* have since been closed at any time. That
 * second one is dated by the issue's opening, not its close, so it cannot come
 * from the closed-side counts.
 */
async function topRepos(db, periods) {
  const sql = `
    SELECT repo,
           ${periodSums(opened, "o", periods)},
           ${periodSums(
             (a, b) => `${opened(a, b)} AND closed_at IS NOT NULL`,
             "c",
             periods,
           )}
      FROM issues
     GROUP BY repo`;

  const bounds = periodParams(periods);
  const rows = (await db.prepare(sql).bind(...bounds, ...bounds).all()).results;

  return periods.map((_, i) =>
    rows
      .filter((r) => r[`o_${i}`] > 0)
      .map((r) => ({ repo: r.repo, opened: r[`o_${i}`], closed: r[`c_${i}`] }))
      .sort(byCountThenKey((x) => x.repo, (x) => x.opened))
      .slice(0, 8),
  );
}

async function byWindow(db, now) {
  const periods = periodsFor(now);
  const names = Object.keys(SCALARS);
  const distinctNames = Object.keys(DISTINCTS);
  const bounds = periodParams(periods);

  const [scalarRows, distinctRows, firsts, closeP, respP, expanded, repoTop,
         reporterTop, responderTop, closerTop] = await Promise.all([
    Promise.all(
      names.map((n) =>
        db
          .prepare(`SELECT ${periodSums(SCALARS[n], "n", periods)} FROM issues`)
          .bind(...bounds)
          .first(),
      ),
    ),
    Promise.all(
      distinctNames.map((n) =>
        db
          .prepare(
            `SELECT ${periodDistincts(DISTINCTS[n], "n", periods)} FROM issues`,
          )
          .bind(...bounds)
          .first(),
      ),
    ),
    newReporters(db, periods),
    // Close durations are dated by the close; response durations by the
    // opening, matching where `foldTracker` pushes each sample.
    percentilesAcrossPeriods(
      db,
      periods,
      {
        source: `SELECT ${closeHours} AS v, closed_at AS at
                   FROM issues WHERE closed_at IS NOT NULL`,
        at: "at",
      },
      [50, 90],
    ),
    percentilesAcrossPeriods(
      db,
      periods,
      {
        source: `SELECT ${responseHours} AS v, created_at AS at
                   FROM issues WHERE first_response_at IS NOT NULL`,
        at: "at",
      },
      [50, 90],
    ),
    labelsAndAssignees(db, periods),
    topRepos(db, periods),
    topPerPeriod(
      db,
      {
        select: `CASE WHEN ${isHumanSql("author")} THEN author END`,
        from: "issues",
        group: "GROUP BY k",
        key: "login",
      },
      periods,
      opened,
      8,
    ),
    topPerPeriod(
      db,
      {
        select: `CASE WHEN ${isHumanSql("first_responder")}
                      THEN first_responder END`,
        from: "issues",
        group: "GROUP BY k",
        key: "login",
      },
      periods,
      responded,
      8,
    ),
    topPerPeriod(
      db,
      { select: closerSql(), from: "issues", group: "GROUP BY k", key: "login" },
      periods,
      closedIn,
      12,
    ),
  ]);

  const scalars = Object.fromEntries(
    names.map((n, j) => [
      n,
      periods.map((_, i) => scalarRows[j]?.[`n_${i}`] ?? 0),
    ]),
  );
  const distincts = Object.fromEntries(
    distinctNames.map((n, j) => [
      n,
      periods.map((_, i) => distinctRows[j]?.[`n_${i}`] ?? 0),
    ]),
  );

  const summarize = (i) => {
    const s = (name) => scalars[name][i];
    const decided = s("answered") + s("unanswered");
    const closedN = s("closed");
    const openedN = s("opened");
    return {
      opened: openedN,
      closed: closedN,
      completed: s("completed"),
      notPlanned: s("notPlanned"),
      duplicate: s("duplicate"),
      unresolved: s("notPlanned") + s("duplicate"),
      net: openedN - closedN,
      completedShare: closedN ? s("completed") / closedN : null,
      medianCloseHours: round1(closeP[i].p50),
      p90CloseHours: round1(closeP[i].p90),
      medianFirstResponseHours: round1(respP[i].p50),
      p90FirstResponseHours: round1(respP[i].p90),
      labeledShare: openedN ? s("labeled") / openedN : null,
      unlabeled: openedN - s("labeled"),
      answeredShare: decided ? s("answered") / decided : null,
      neverAnswered: s("unanswered"),
      reporters: distincts.reporters[i],
      newReporters: firsts[i],
      responders: distincts.responders[i],
      responses: s("responses"),
      closers: distincts.closers[i],
      closedByPR: s("closedByPR"),
      closedByHand: s("closedByHand"),
      unknownCloser: s("unknownCloser"),
      assignees: expanded[i].assignees.size,
      activeRepos: distincts.activeRepos[i],
      comments: s("comments"),
      closedN: closeP[i].n,
      respondedN: respP[i].n,
    };
  };

  const index = new Map(periods.map((p, i) => [p.key, i]));

  const out = {};
  for (const w of WINDOWS) {
    const i = index.get(w.id);
    const prevIdx = index.get(`prev:${w.id}`);
    out[w.id] = {
      ...summarize(i),
      topRepos: repoTop[i],
      topReporters: reporterTop[i],
      topResponders: responderTop[i],
      topClosers: closerTop[i],
      topAssignees: [...expanded[i].assignees.entries()]
        .map(([login, count]) => ({ login, count }))
        .sort(byCountThenKey((x) => x.login, (x) => x.count))
        .slice(0, 8),
      topLabels: [...expanded[i].labels.values()]
        .sort(byCountThenKey((x) => x.name, (x) => x.opened))
        .slice(0, 12),
      prev: w.days == null ? null : summarize(prevIdx),
      prevLabel: w.days == null ? null : `previous ${w.label.toLowerCase()}`,
    };
  }
  return out;
}

/* ------------------------------------------------------------------- people */

/**
 * The by-contributor table, folded with the Node panel's own accumulators.
 *
 * This is the one panel here that does *not* reimplement its arithmetic in SQL,
 * and the reason is measured rather than stylistic.
 *
 * The rule everywhere else is to aggregate in the database, and the finding
 * behind it was that rebuilding the store inside a Worker costs 96 MB against a
 * 128 MB ceiling — a measurement about *pull requests*, whose records are large
 * and numerous. Re-measured for issues, holding all 26,161 rows costs **32 MB**,
 * and the fold adds a few more. So the constraint that motivated the rule does
 * not bind here, and the alternative is a real cost: 32 packed fields per person
 * per window, six of them percentiles, is a great deal of SQL whose only proof
 * of correctness would be a parity test — and the `closedByHand` NULL trap in
 * `byWindow` is what that surface looks like when it goes wrong.
 *
 * Feeding `foldPerson` and `summarizePersonPeriod` directly instead makes the
 * agreement structural. There is one implementation of "closed for others", not
 * two that a test holds together.
 *
 * ## Two passes, because the accumulators are the expensive part
 *
 * Only the top 200 per window are ever output. Building full accumulators for
 * all 6,450 participants is 45,150 of them — three arrays and three Sets each:
 *
 *   26,161 fetched rows               32.3 MB
 *   553 x 7 scoped accumulators        3.1 MB   ->  35.4 MB working set
 *   6,450 x 7, the version rejected   34.2 MB   ->  66.5 MB
 *
 * So the first pass counts nothing but involvement and assignment, into an
 * `Int32Array` per person, and picks who can still make a cut. The second
 * builds real accumulators for those 553 people only. Scoping the *rows* would
 * not help — 94% of issues involve somebody who makes some window's top 200 —
 * so it is the accumulators that had to go.
 *
 * Both passes derive involvement the same way, from the same rules, because a
 * cheap first pass that disagreed with the real one would silently cut the
 * wrong people. Three mutations of that agreement are in the parity test.
 */
/**
 * Every column the two isolate-side rollups read, fetched once.
 *
 * `people` and the label breakdown both walk the whole store, and each holding
 * its own copy is 32 MB twice for no reason. `response_unknown` is the one that
 * looks optional and is not: `isUnanswered` is "no reply *and* we actually
 * looked", so leaving it out silently reclassifies every issue whose comment
 * sample ran out as one nobody answered. It cost one on the busiest reporter's
 * `filedUnanswered` and would have shipped.
 */
const ISSUE_ROWS = `
  SELECT repo, number, author, created_at, closed_at, state, state_reason,
         labels, assignees, comments, first_response_at, first_responder,
         response_unknown, closed_by, closer_known,
         closed_via_kind, closed_via_repo, closed_via_number,
         closed_via_author
    FROM issues`;

function people(raw, now) {
  const wins = WINDOWS.map((w) => ({
    key: w.id,
    from: w.days == null ? -Infinity : now - w.days * DAY,
    to: Infinity,
  }));

  // The flat D1 row back into the shape `issueMetrics` reads. `closedVia` is
  // the one that matters: the schema flattened it into four columns precisely
  // so closer attribution could be queried, and the JavaScript expects it
  // nested. A bare `{ kind }` for a commit close and the full shape for a pull
  // request, matching what `closure()` in the ingest writes.
  const record = (r) => ({
    repo: r.repo,
    number: r.number,
    author: r.author,
    createdAt: r.created_at,
    closedAt: r.closed_at,
    state: r.state,
    stateReason: r.state_reason,
    labels: JSON.parse(r.labels || "[]"),
    assignees: JSON.parse(r.assignees || "[]"),
    comments: r.comments,
    firstResponseAt: r.first_response_at,
    firstResponder: r.first_responder,
    responseUnknown: r.response_unknown === 1,
    closedBy: r.closed_by,
    closerKnown: r.closer_known === 1,
    closedVia: r.closed_via_kind
      ? {
          kind: r.closed_via_kind,
          repo: r.closed_via_repo ?? null,
          number: r.closed_via_number ?? null,
          author: r.closed_via_author ?? null,
        }
      : null,
  });

  /** Everyone this issue can credit, and the two facts both passes need. */
  const roles = (i) => {
    const closedBy = closerOf(i);
    const fixer = fixerOf(i);
    const involved = new Set();
    if (!isBot(i.author)) involved.add(i.author);
    if (i.firstResponder && !isBot(i.firstResponder))
      involved.add(i.firstResponder);
    if (closedBy) involved.add(closedBy);
    if (fixer) involved.add(fixer);
    for (const a of i.assignees) if (!isBot(a)) involved.add(a);
    return { closedBy, fixer, involved };
  };

  // ---- pass one: who is still in contention ----
  const counts = new Map();
  const bump = (login, wi, slot) => {
    let a = counts.get(login);
    if (!a) counts.set(login, (a = new Int32Array(wins.length * 2)));
    a[wi * 2 + slot]++;
  };

  for (const r of raw) {
    const i = record(r);
    const { closedBy, fixer } = roles(i);
    for (let wi = 0; wi < wins.length; wi++) {
      const p = wins[wi];
      // `involvement` is filed + responses + closed + fixed, each dated by its
      // own event — the same four `foldPerson` increments, counted without the
      // accumulator around them.
      if (!isBot(i.author) && inPeriod(p, i.createdAt)) bump(i.author, wi, 0);
      if (i.firstResponder && !isBot(i.firstResponder) &&
          inPeriod(p, i.firstResponseAt))
        bump(i.firstResponder, wi, 0);
      if (closedBy && inPeriod(p, i.closedAt)) bump(closedBy, wi, 0);
      if (fixer && inPeriod(p, i.closedAt)) bump(fixer, wi, 0);
      if (inPeriod(p, i.createdAt))
        for (const a of i.assignees) if (!isBot(a)) bump(a, wi, 1);
    }
  }

  const selected = new Set();
  for (let wi = 0; wi < wins.length; wi++) {
    const eligible = [...counts.entries()].filter(
      ([, a]) => a[wi * 2] || a[wi * 2 + 1],
    );
    eligible.sort(byCountThenKey((e) => e[0], (e) => e[1][wi * 2]));
    for (const [login] of eligible.slice(0, PEOPLE_CAP)) selected.add(login);
  }

  // ---- pass two: real accumulators, for those people only ----
  const acc = new Map();
  for (const login of selected)
    acc.set(
      login,
      Object.fromEntries(wins.map((w) => [w.key, blankPersonPeriod()])),
    );

  for (const r of raw) {
    const i = record(r);
    const { closedBy, fixer, involved } = roles(i);
    let ctx = null;
    for (const login of involved) {
      const rec = acc.get(login);
      if (!rec) continue;
      ctx ??= {
        labels: i.labels,
        closeHours: i.closedAt
          ? (Date.parse(i.closedAt) - Date.parse(i.createdAt)) / 3_600_000
          : null,
        responseHours: i.firstResponseAt
          ? (Date.parse(i.firstResponseAt) - Date.parse(i.createdAt)) / 3_600_000
          : null,
        closedBy,
        fixer,
      };
      for (const p of wins) foldPerson(rec[p.key], i, p, login, ctx);
    }
  }

  const out = {};
  for (const w of WINDOWS) {
    const rows = [];
    for (const [login, byWin] of acc) {
      const s = summarizePersonPeriod(byWin[w.id]);
      if (!s.involvement && !s.assigned) continue;
      rows.push([s.involvement, login, s]);
    }
    rows.sort(byCountThenKey((r) => r[1], (r) => r[0]));
    out[w.id] = rows
      .slice(0, PEOPLE_CAP)
      .map(([, login, s]) => packPerson(login, s));
  }

  return { people: out, participants: counts.size };
}

/* ------------------------------------------------------------------- labels */

/**
 * The per-repo label tables, and the focus repo's monthly series.
 *
 * Folded in the isolate, over the rows `people` already fetched. `byWindow`
 * settled the argument for this shape by measurement — expanding the JSON
 * columns costs about what `json_each` would, and needs nothing D1 has never
 * been asked to do — and here it is free, because the rows are already in hand.
 *
 * So `json_each` is not merely avoided, it is never needed by this panel at
 * all: the label breakdown was the last thing waiting on it.
 *
 * Keyed by repo *and* name. "Which labels are busy" is a question about one
 * tracker, and the org-wide sum of a per-repo taxonomy means nothing. The
 * separator is a NUL rather than a space, because a repo or a label containing
 * a space would otherwise collide with a different pair.
 */
function labels(raw, now) {
  const stats = new Map();
  const series = new Map();

  // Only months something happened, only the focus repo, only the last sixty.
  const seriesCutoff = new Date(now - SERIES_MONTHS * 30.4 * DAY)
    .toISOString()
    .slice(0, 7);

  const bumpSeries = (name, month, slot) => {
    if (month < seriesCutoff) return;
    let byMonth = series.get(name);
    if (!byMonth) series.set(name, (byMonth = new Map()));
    const cell = byMonth.get(month) ?? [0, 0];
    cell[slot]++;
    byMonth.set(month, cell);
  };

  for (const r of raw) {
    const names = JSON.parse(r.labels || "[]");
    if (!names.length) continue;

    const open = r.state === "OPEN";
    const created = Date.parse(r.created_at);
    const closeH = r.closed_at
      ? (Date.parse(r.closed_at) - created) / 3_600_000
      : null;
    const respH = r.first_response_at
      ? (Date.parse(r.first_response_at) - created) / 3_600_000
      : null;
    const unanswered = !r.first_response_at && !r.response_unknown;
    const focus = r.repo === ISSUE_LABEL_REPO;
    const openedMonth = r.created_at.slice(0, 7);
    const closedMonth = r.closed_at ? r.closed_at.slice(0, 7) : null;

    for (const name of names) {
      const key = `${r.repo} ${name}`;
      let l = stats.get(key);
      if (!l) {
        const { group, short } = splitLabel(name);
        stats.set(key, (l = {
          repo: r.repo, name, group, short,
          total: 0, open: 0, closed: 0, unanswered: 0,
          closeHours: [], responseHours: [],
        }));
      }
      l.total++;
      if (open) {
        l.open++;
        if (unanswered) l.unanswered++;
      } else l.closed++;
      if (closeH != null) l.closeHours.push(closeH);
      if (respH != null) l.responseHours.push(respH);

      if (focus) {
        bumpSeries(name, openedMonth, 0);
        if (closedMonth) bumpSeries(name, closedMonth, 1);
      }
    }
  }

  const rows = [...stats.values()]
    .map((l) => ({
      repo: l.repo,
      name: l.name,
      group: l.group,
      short: l.short,
      total: l.total,
      open: l.open,
      closed: l.closed,
      unanswered: l.unanswered,
      medianCloseHours: median(l.closeHours),
      medianFirstResponseHours: median(l.responseHours),
    }))
    .sort(byLabelGroupThenOpen);

  const byRepo = {};
  for (const l of rows) (byRepo[l.repo] ??= []).push(l);

  // Sparse and capped: only labels on the focus repo above SERIES_MIN. The long
  // tail of `Mod:` labels carrying three issues each would triple the payload
  // to draw a chart that is two dots and a gap.
  const bigEnough = new Set(
    rows
      .filter((l) => l.repo === ISSUE_LABEL_REPO && l.total >= SERIES_MIN)
      .map((l) => l.name),
  );
  const seriesOut = {};
  for (const [name, byMonth] of series) {
    if (!bigEnough.has(name)) continue;
    seriesOut[name] = Object.fromEntries(
      [...byMonth.entries()].sort((a, b) =>
        a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
      ),
    );
  }

  return {
    labelFocus: byRepo[ISSUE_LABEL_REPO]
      ? ISSUE_LABEL_REPO
      : Object.keys(byRepo)[0] ?? null,
    labelsByRepo: byRepo,
    labelSeries: seriesOut,
    labelSeriesMin: SERIES_MIN,
    labelGroupOrder: GROUP_ORDER,
    count: stats.size,
  };
}

/* --------------------------------------------------------------------- main */

export async function issues(db, now = Date.now()) {
  // The full-row fetch runs alongside the aggregate queries rather than before
  // them, and both isolate-side rollups read the one copy.
  const [t, day, week, month, tri, repoRows, discussed, windows, rows] =
    await Promise.all([
      totals(db),
      seriesFor(db, GRAINS[0], now),
      seriesFor(db, GRAINS[1], now),
      seriesFor(db, GRAINS[2], now),
      triage(db, now),
      repos(db, now),
      mostDiscussed(db, now),
      byWindow(db, now),
      db.prepare(ISSUE_ROWS).all(),
    ]);

  const folk = people(rows.results, now);
  const lab = labels(rows.results, now);

  return {
    windows: WINDOWS,
    byWindow: windows,
    people: folk.people,
    personFields: PERSON_FIELDS,
    peopleCap: PEOPLE_CAP,
    labelFocus: lab.labelFocus,
    labelsByRepo: lab.labelsByRepo,
    labelSeries: lab.labelSeries,
    labelSeriesMin: lab.labelSeriesMin,
    labelGroupOrder: lab.labelGroupOrder,
    totals: { ...t, participants: folk.participants, labels: lab.count },
    series: {
      day,
      week,
      month,
      dayFrom: new Date(now - DAY_SERIES_DAYS * DAY).toISOString().slice(0, 10),
    },
    triage: tri,
    repos: repoRows,
    mostDiscussed: discussed,
  };
}
