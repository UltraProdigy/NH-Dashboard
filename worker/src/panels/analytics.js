/**
 * Org-wide analytics, aggregated in SQL.
 *
 * The Node panel of the same name walks 29,000 pull requests in JavaScript,
 * building thirteen accumulators and three maps of time buckets as it goes.
 * That shape cannot move into a Worker — rebuilding the store alone costs 96 MB
 * against a 128 MB ceiling — so the counting happens inside D1 and this module
 * only stitches result sets together.
 *
 * It is the hardest panel in the set, for three reasons that are worth naming
 * before the code starts:
 *
 *   SQLite has no percentile function. Every median and p90 here is a
 *   `ROW_NUMBER()` picking the one row the JavaScript `pct` would have indexed.
 *
 *   ISO weeks are not `strftime('%Y-%W')`. They are defined by the nearest
 *   Thursday, and the two disagree at roughly every other year boundary.
 *
 *   Every dated window carries an equal-length period before it, for the
 *   "vs. previous" deltas. Thirteen periods, not seven.
 *
 * The output matches the Node panel's exactly, and
 * `test/analytics.parity.test.js` asserts that against a real seed rather than
 * trusting it.
 */

import { WINDOWS, isHumanSql } from "../../../src/shared/contributor-rules.js";
import {
  BACKLOG_BUCKETS,
  DAY_SERIES_DAYS,
  DEFAULT_ORG,
  GROSSING_ORG_N,
  HEATMAP_DAYS,
  byCountThenKey,
  dayKeySql,
  epochSql,
  hoursSql,
  monthKeySql,
  pctRankSql,
  round1,
  seconds,
  weekKeySql,
} from "../../../src/shared/analytics-rules.js";

const DAY = 86_400_000;

/**
 * Finite stand-ins for the unbounded ends of a period.
 *
 * The JavaScript uses ±Infinity, which cannot cross the D1 wire — parameters
 * are serialised as JSON and `Infinity` becomes `null` on the way, which would
 * silently turn every comparison into NULL and every count into zero. These are
 * epoch seconds far outside anything GitHub can stamp.
 */
const NEVER = -1e12;
const FOREVER = 1e12;

const HUMAN = isHumanSql("author");

/**
 * A first review by somebody other than a bot and other than the author — the
 * thing a contributor is actually waiting on.
 *
 * `r.author IS NOT p.author` rather than `<>`. A pull request whose author is a
 * deleted account has a NULL author, and `<>` against NULL is NULL, which would
 * quietly drop every review on it. `IS NOT` is the null-safe comparison, and
 * matches the JavaScript's `===`, which treats null as an ordinary value.
 */
const firstReview = (only = "1") => `
  first_review AS (
    SELECT r.repo, r.pr_number, MIN(r.submitted_at) AS at
      FROM pull_requests p
      JOIN reviews r ON r.repo = p.repo AND r.pr_number = p.number
     WHERE ${only}
       AND r.submitted_at IS NOT NULL
       AND ${isHumanSql("r.author")}
       AND r.author IS NOT p.author
     GROUP BY r.repo, r.pr_number
  )`;

const FIRST_REVIEW = firstReview();

/**
 * One approval per reviewer per pull request, dated to their first.
 *
 * Re-approving after a round of changes is not a second approval. The Node
 * panel builds the same map per PR and takes the earliest submission; this is
 * that, expressed once and reused by the totals, the per-window reviewer counts
 * and the merged-with-approval share.
 */
const APPROVER = `
  approver AS (
    SELECT repo, pr_number, author, MIN(submitted_at) AS at
      FROM reviews
     WHERE state = 'APPROVED' AND submitted_at IS NOT NULL AND ${HUMAN}
     GROUP BY repo, pr_number, author
  )`;

/**
 * The thirteen periods: each window, plus an equal-length one immediately
 * before it for the deltas. All-time has nothing before it.
 */
function periodsFor(now) {
  const out = [];
  for (const w of WINDOWS) {
    out.push({
      key: w.id,
      from: w.days == null ? NEVER : seconds(now - w.days * DAY),
      to: FOREVER,
    });
    if (w.days != null) {
      out.push({
        key: `prev:${w.id}`,
        from: seconds(now - 2 * w.days * DAY),
        to: seconds(now - w.days * DAY),
      });
    }
  }
  return out;
}

/** `SUM(col in period)` for every period, as one column each. */
const periodSums = (expr, prefix, periods) =>
  periods
    .map((_, i) => `SUM(${expr("?", "?")}) AS ${prefix}_${i}`)
    .join(",\n           ");

/** The bound pairs those columns consume, in the order they appear. */
const periodParams = (periods) => periods.flatMap((p) => [p.from, p.to]);

// --------------------------------------------------------------------- totals

async function totals(db) {
  const head = await db
    .prepare(
      `SELECT COUNT(*) AS prs,
              SUM(merged_at IS NOT NULL) AS merged,
              SUM(merged_at IS NULL AND state = 'OPEN') AS open,
              SUM(merged_at IS NULL AND state <> 'OPEN') AS closed,
              COUNT(DISTINCT repo) AS repos,
              COUNT(DISTINCT CASE WHEN ${HUMAN} THEN author END) AS contributors,
              MIN(CASE WHEN ${HUMAN} THEN created_at END) AS first_pr
         FROM pull_requests`,
    )
    .first();

  const appr = await db
    .prepare(`WITH ${APPROVER} SELECT COUNT(*) AS n FROM approver`)
    .first();

  return {
    prs: head?.prs ?? 0,
    merged: head?.merged ?? 0,
    open: head?.open ?? 0,
    closed: head?.closed ?? 0,
    approvals: appr?.n ?? 0,
    contributors: head?.contributors ?? 0,
    repos: head?.repos ?? 0,
    firstPR: head?.first_pr ?? null,
  };
}

// --------------------------------------------------------------------- series

const GRAINS = {
  day: dayKeySql,
  week: weekKeySql,
  month: monthKeySql,
};

/**
 * Counts for the bucket a pull request was *opened* in.
 *
 * `author_rn` is the trick that avoids a second pass: the Node panel walks the
 * store once to find each person's earliest PR, then again to label it. A
 * window function does both at once, and the outer CASE discards the ranking
 * SQLite computes for the bot partition — `SUM` skips the NULLs.
 *
 * The ordering inside the partition breaks ties on `repo#number`, deliberately.
 * GitHub stamps to the second, so two PRs opened in the same one would both
 * match a bare timestamp comparison and both count as somebody's first, which
 * is how the issue side once reported more first-time reporters than reporters.
 */
async function openedSeries(db, key, cutoff) {
  const sql = `
    WITH ranked AS (
      SELECT repo, number, author, created_at,
             CASE WHEN ${HUMAN}
                  THEN ROW_NUMBER() OVER (
                         PARTITION BY CASE WHEN ${HUMAN} THEN author END
                         ORDER BY created_at, repo || '#' || number)
             END AS author_rn
        FROM pull_requests
    )
    SELECT ${key("created_at")} AS b,
           MIN(created_at) AS t,
           COUNT(*) AS opened,
           COUNT(DISTINCT CASE WHEN ${HUMAN} THEN author END) AS authors,
           COALESCE(SUM(author_rn = 1), 0) AS new_authors
      FROM ranked
     ${cutoff == null ? "" : `WHERE ${epochSql("created_at")} >= ?`}
     GROUP BY b`;

  const stmt = db.prepare(sql);
  return (await (cutoff == null ? stmt : stmt.bind(cutoff)).all()).results;
}

/**
 * Counts for the bucket a pull request *ended* in.
 *
 * `updated_at` rather than `closed_at` for the closed side, matching the Node
 * panel. Not obviously right — but it is what the shipped numbers mean, and
 * changing it here would make the two disagree while looking like a fix.
 */
async function endedSeries(db, key, cutoff) {
  const sql = `
    SELECT ${key("ended_at")} AS b,
           MIN(ended_at) AS t,
           SUM(is_merged) AS merged,
           SUM(1 - is_merged) AS closed
      FROM (SELECT COALESCE(merged_at,
                            CASE WHEN state = 'CLOSED' THEN updated_at END) AS ended_at,
                   (merged_at IS NOT NULL) AS is_merged
              FROM pull_requests)
     WHERE ended_at IS NOT NULL
       ${cutoff == null ? "" : `AND ${epochSql("ended_at")} >= ?`}
     GROUP BY b`;

  const stmt = db.prepare(sql);
  return (await (cutoff == null ? stmt : stmt.bind(cutoff)).all()).results;
}

/**
 * Median and p90 of a per-bucket set of hours.
 *
 * `ROW_NUMBER()` ranks within the bucket, `COUNT(*) OVER` gives that bucket's
 * size, and the outer `MAX(CASE ...)` picks the single row whose rank matches
 * what `pct` would have indexed. `MAX` only because an aggregate is needed to
 * collapse the group — exactly one row per bucket survives the CASE.
 */
function percentileByBucket(inner) {
  return `
    WITH ${inner}
    , ranked AS (
      SELECT b, hours,
             ROW_NUMBER() OVER (PARTITION BY b ORDER BY hours) AS rn,
             COUNT(*) OVER (PARTITION BY b) AS n
        FROM h
    )
    SELECT b,
           MAX(n) AS n,
           MAX(CASE WHEN rn = ${pctRankSql("n", 50)} THEN hours END) AS p50,
           MAX(CASE WHEN rn = ${pctRankSql("n", 90)} THEN hours END) AS p90
      FROM ranked
     GROUP BY b`;
}

async function mergeHoursSeries(db, key, cutoff) {
  const sql = percentileByBucket(`
    h AS (
      SELECT ${key("created_at")} AS b,
             ${hoursSql("created_at", "merged_at")} AS hours
        FROM pull_requests
       WHERE merged_at IS NOT NULL
         ${cutoff == null ? "" : `AND ${epochSql("created_at")} >= ?`}
    )`);

  const stmt = db.prepare(sql);
  return (await (cutoff == null ? stmt : stmt.bind(cutoff)).all()).results;
}

async function reviewHoursSeries(db, key, cutoff) {
  const sql = percentileByBucket(`${FIRST_REVIEW}
    , h AS (
      SELECT ${key("p.created_at")} AS b,
             ${hoursSql("p.created_at", "fr.at")} AS hours
        FROM pull_requests p
        JOIN first_review fr ON fr.repo = p.repo AND fr.pr_number = p.number
       ${cutoff == null ? "" : `WHERE ${epochSql("p.created_at")} >= ?`}
    )`);

  const stmt = db.prepare(sql);
  return (await (cutoff == null ? stmt : stmt.bind(cutoff)).all()).results;
}

/**
 * One grain of the time series, stitched from four result sets.
 *
 * `t` is the earliest timestamp of anything that landed in the bucket, from
 * either side — a PR opened in it or a PR that ended in it. That is what the
 * Node panel's `bucketFor` accumulates, and the frontend sorts on it, so it is
 * part of the contract rather than a debugging field.
 */
async function seriesFor(db, grain, cutoff) {
  const key = GRAINS[grain];
  const [opened, ended, merge, review] = await Promise.all([
    openedSeries(db, key, cutoff),
    endedSeries(db, key, cutoff),
    mergeHoursSeries(db, key, cutoff),
    reviewHoursSeries(db, key, cutoff),
  ]);

  const buckets = new Map();
  const at = (b, t) => {
    let e = buckets.get(b);
    if (!e) {
      buckets.set(
        b,
        (e = {
          b,
          t,
          opened: 0,
          merged: 0,
          closed: 0,
          authors: 0,
          newAuthors: 0,
          mergeMedianH: null,
          mergeP90H: null,
          reviewMedianH: null,
          mergeN: 0,
          reviewN: 0,
        }),
      );
    }
    if (t && t < e.t) e.t = t;
    return e;
  };

  for (const r of opened) {
    const e = at(r.b, r.t);
    e.opened = r.opened;
    e.authors = r.authors;
    e.newAuthors = r.new_authors;
  }
  for (const r of ended) {
    const e = at(r.b, r.t);
    e.merged = r.merged;
    e.closed = r.closed;
  }
  // The percentile queries only ever see buckets the opened side already
  // created — both are keyed on `created_at` — so these do not widen the set.
  for (const r of merge) {
    const e = at(r.b, null);
    e.mergeN = r.n;
    e.mergeMedianH = round1(r.p50);
    e.mergeP90H = round1(r.p90);
  }
  for (const r of review) {
    const e = at(r.b, null);
    e.reviewN = r.n;
    e.reviewMedianH = round1(r.p50);
  }

  return [...buckets.values()].sort((a, b) => a.b.localeCompare(b.b));
}

// -------------------------------------------------------------- per-window

/**
 * The scalar counts for one period.
 *
 * Each event is counted against the period *its own* timestamp falls in, so
 * "merged in the last three months" does not quietly drop a PR opened before
 * the window started. `merged_with_approval` is the exception on purpose: it
 * asks whether a PR merged in this period ever drew a human approval, at any
 * time, which is not the same question as how many approvals landed here.
 */
/**
 * Seven measures × thirteen periods, as seven queries of thirteen columns.
 *
 * Periods as columns rather than as queries. The obvious shape — one query per
 * period — reads better and scans the table thirteen times instead of seven,
 * paying three `strftime` calls per row each time; this is the same trick
 * `periodGroups` already uses, and stays inside the same column budget, which
 * matters more here than elegance because D1's real limits are not the ones
 * SQLite documents.
 *
 * Ordered `?` throughout, never `?1`. D1 binds positionally and numbered
 * placeholders are not part of the contract it documents.
 *
 * No reviews in any of them. An approvals CTE here was rebuilt thirteen times
 * over 41,000 rows for a single column; that column is now its own query, run
 * once. See `approvedMerges`.
 */
const SCALARS = {
  opened: (a, b) => `c >= ${a} AND c < ${b}`,
  merged: (a, b) => `m >= ${a} AND m < ${b}`,
  closed: (a, b) =>
    `merged_at IS NULL AND state = 'CLOSED' AND u >= ${a} AND u < ${b}`,
  comments: (a, b) =>
    `CASE WHEN c >= ${a} AND c < ${b} THEN COALESCE(comments, 0) END`,
  additions: (a, b) =>
    `CASE WHEN c >= ${a} AND c < ${b} AND additions IS NOT NULL THEN additions END`,
  deletions: (a, b) =>
    `CASE WHEN c >= ${a} AND c < ${b} AND additions IS NOT NULL THEN COALESCE(deletions, 0) END`,
  commits: (a, b) =>
    `CASE WHEN c >= ${a} AND c < ${b} AND additions IS NOT NULL THEN COALESCE(commits, 0) END`,
};

async function periodScalars(db, periods) {
  const from = `
      FROM (SELECT state, merged_at, additions, deletions, commits, comments,
                   ${epochSql("created_at")} AS c,
                   ${epochSql("merged_at")} AS m,
                   ${epochSql("updated_at")} AS u
              FROM pull_requests)`;

  const bounds = periodParams(periods);
  const names = Object.keys(SCALARS);

  const rows = await Promise.all(
    names.map((name) =>
      db
        .prepare(`SELECT ${periodSums(SCALARS[name], "n", periods)}${from}`)
        .bind(...bounds)
        .first(),
    ),
  );

  return periods.map((_, i) =>
    Object.fromEntries(names.map((name, j) => [name, rows[j]?.[`n_${i}`] ?? 0])),
  );
}

/**
 * Pull requests merged in each period that ever drew a human approval.
 *
 * "Ever" is the point, and it is not the same question as how many approvals
 * landed in the period — a PR approved in March and merged in April counts
 * here, and does not count towards April's approval total.
 */
async function approvedMerges(db, periods) {
  const sql = `
    WITH ${APPROVER}
    , approved AS (SELECT DISTINCT repo, pr_number FROM approver)
    SELECT ${periodSums(
      (a, b) => `m >= ${a} AND m < ${b} AND ok`,
      "n",
      periods,
    )}
      FROM (SELECT ${epochSql("p.merged_at")} AS m,
                   (a.repo IS NOT NULL) AS ok
              FROM pull_requests p
              LEFT JOIN approved a ON a.repo = p.repo AND a.pr_number = p.number
             WHERE p.merged_at IS NOT NULL)`;

  const row = await db.prepare(sql).bind(...periodParams(periods)).first();
  return periods.map((_, i) => row?.[`n_${i}`] ?? 0);
}

/**
 * Median and p90 of one period's merge hours, first-review hours and PR sizes.
 *
 * Three independent orderings, so three ranked CTEs rather than one — a
 * percentile is a position in a sort, and these are sorts of different sets.
 * An empty set yields NULL from the scalar subquery, which is the `null` the
 * Node panel returns for the same case.
 */
async function periodPercentiles(db, from, to) {
  const ranked = (name) => `
    , ${name}_r AS (
      SELECT v,
             ROW_NUMBER() OVER (ORDER BY v) AS rn,
             COUNT(*) OVER () AS n
        FROM ${name}_v
    )`;

  const pick = (name, p) =>
    `(SELECT v FROM ${name}_r WHERE rn = ${pctRankSql("n", p)})`;

  // The period predicate is pushed inside the first-review grouping rather than
  // applied after it. Grouping every review in the org and then throwing away
  // the ones outside a one-month window cost 89ms a period, thirteen times
  // over; filtering the pull requests first leaves an index lookup per PR.
  const sql = `
    WITH ${firstReview(`${epochSql("p.created_at")} >= ? AND ${epochSql("p.created_at")} < ?`)}
    , merge_v AS (
      SELECT ${hoursSql("created_at", "merged_at")} AS v
        FROM pull_requests
       WHERE merged_at IS NOT NULL
         AND ${epochSql("merged_at")} >= ? AND ${epochSql("merged_at")} < ?
    )
    , review_v AS (
      SELECT ${hoursSql("p.created_at", "fr.at")} AS v
        FROM pull_requests p
        JOIN first_review fr ON fr.repo = p.repo AND fr.pr_number = p.number
    )
    , size_v AS (
      SELECT additions + COALESCE(deletions, 0) AS v
        FROM pull_requests
       WHERE additions IS NOT NULL
         AND ${epochSql("created_at")} >= ? AND ${epochSql("created_at")} < ?
    )
    ${ranked("merge")}${ranked("review")}${ranked("size")}
    SELECT ${pick("merge", 50)} AS merge_p50,
           ${pick("merge", 90)} AS merge_p90,
           ${pick("review", 50)} AS review_p50,
           ${pick("size", 50)} AS size_p50,
           ${pick("size", 90)} AS size_p90,
           (SELECT COUNT(*) FROM size_v) AS sized`;

  return db.prepare(sql).bind(from, to, from, to, from, to).first();
}

/**
 * Per-author, per-reviewer and per-repo counts across every period at once.
 *
 * Three queries rather than thirty-nine: the grouping key is the same for all
 * thirteen periods, so the periods become columns. `first_created` rides along
 * on the author query because a person's "first PR ever" is the only thing
 * `newContributors` needs, and which of two same-second PRs is chosen cannot
 * change the answer — both carry the same timestamp, so both fall in the same
 * period.
 */
async function periodGroups(db, periods) {
  // `c` is computed once per row in the subquery rather than inside each of the
  // twenty-six comparisons. Thirteen periods over 29,000 rows is 750,000
  // `strftime` calls the other way round, for a value that never changes.
  const inWindow = (col) => (a, b) => `${col} >= ${a} AND ${col} < ${b}`;
  const bounds = periodParams(periods);

  const authorsSql = `
    SELECT login, MIN(created_at) AS first_created,
           ${periodSums(inWindow("c"), "n", periods)}
      FROM (SELECT author AS login, created_at,
                   ${epochSql("created_at")} AS c
              FROM pull_requests
             WHERE ${HUMAN})
     GROUP BY login`;

  const reviewersSql = `
    WITH ${APPROVER}
    SELECT login, ${periodSums(inWindow("c"), "n", periods)}
      FROM (SELECT author AS login, ${epochSql("at")} AS c FROM approver)
     GROUP BY login`;

  const reposSql = `
    SELECT repo,
           ${periodSums(inWindow("c"), "n", periods)},
           ${periods
             .map((_, i) => `SUM(c >= ? AND c < ? AND merged) AS m_${i}`)
             .join(",\n           ")}
      FROM (SELECT repo, ${epochSql("created_at")} AS c,
                   (merged_at IS NOT NULL) AS merged
              FROM pull_requests)
     GROUP BY repo`;

  const [authors, reviewers, repos] = await Promise.all([
    db.prepare(authorsSql).bind(...bounds).all(),
    db.prepare(reviewersSql).bind(...bounds).all(),
    db.prepare(reposSql).bind(...bounds, ...bounds).all(),
  ]);

  return {
    authors: authors.results,
    reviewers: reviewers.results,
    repos: repos.results,
  };
}

const topN = (entries, keyName, countOf, n = 8) =>
  entries
    .sort(byCountThenKey((e) => e[keyName], countOf))
    .slice(0, n);

/** Scalar metrics only — the shape both a window and its prev period share. */
function summarize(s, q, groups, i) {
  const authors = groups.authors.filter((r) => r[`n_${i}`] > 0);
  const reviewers = groups.reviewers.filter((r) => r[`n_${i}`] > 0);
  const repos = groups.repos.filter((r) => r[`n_${i}`] > 0);

  const reviewerTotal = reviewers.reduce((n, r) => n + r[`n_${i}`], 0);
  const top5 = reviewers
    .map((r) => r[`n_${i}`])
    .sort((a, b) => b - a)
    .slice(0, 5)
    .reduce((n, v) => n + v, 0);

  return {
    opened: s.opened,
    merged: s.merged,
    closed: s.closed,
    activeAuthors: authors.length,
    activeReviewers: reviewers.length,
    activeRepos: repos.length,
    newContributors: groups.newContributors[i],
    approvals: reviewerTotal,
    // Of everything that reached a terminal state in this period, what fraction
    // landed? Ignores still-open PRs, which have no outcome yet.
    mergeRate: s.merged + s.closed ? s.merged / (s.merged + s.closed) : null,
    // Merged without a single human approval — the number an admin probably
    // wants to see trending down.
    approvedShare: s.merged ? groups.approvedMerges[i] / s.merged : null,
    unapprovedMerges: s.merged - groups.approvedMerges[i],
    reviewConcentration: reviewerTotal ? top5 / reviewerTotal : null,
    medianMergeHours: round1(q.merge_p50),
    p90MergeHours: round1(q.merge_p90),
    medianFirstReviewHours: round1(q.review_p50),
    additions: s.additions,
    deletions: s.deletions,
    linesChanged: s.additions + s.deletions,
    commits: s.commits,
    comments: s.comments,
    // Null rather than 0 when no PR in the period carries diff data — that is
    // "the ingest hasn't backfilled yet", which must not render as "nobody
    // wrote any code this quarter".
    medianPRLines: q.sized ? q.size_p50 : null,
    p90PRLines: q.sized ? q.size_p90 : null,
    sizedPRs: q.sized,
  };
}

// -------------------------------------------------------------------- backlog

/**
 * Open pull requests, in full.
 *
 * 447 rows against 29,091, so this is the one place the panel reads records
 * rather than counts — the bucket thresholds are day counts derived from the
 * same clock as `ageDays`, and deriving them twice in two languages is a worse
 * trade than a small read.
 *
 * Ordered oldest first with `repo#number` breaking ties. The Node panel sorts
 * on `ageDays`, which is a whole number of days and therefore ties constantly;
 * V8's stable sort then falls back to store order, which is not a thing SQL can
 * reproduce or a build should depend on.
 */
async function backlogRows(db) {
  const sql = `
    WITH ${firstReview("p.state = 'OPEN' AND p.merged_at IS NULL")}
    SELECT p.repo, p.number, p.author, p.created_at, p.updated_at,
           (fr.repo IS NOT NULL) AS reviewed
      FROM pull_requests p
      LEFT JOIN first_review fr ON fr.repo = p.repo AND fr.pr_number = p.number
     WHERE p.state = 'OPEN' AND p.merged_at IS NULL
     ORDER BY p.created_at, p.repo, p.number`;

  return (await db.prepare(sql).all()).results;
}

// ------------------------------------------------------------------- grossing

/**
 * The PRs that drew the most reaction, org-wide and all-time.
 *
 * Zeroes are dropped rather than padding the list out to ten — a list padded
 * with 0-comment PRs claims a ranking that isn't there. Ties break on PR number
 * descending, matching `topGrossing`.
 */
async function grossing(db, field) {
  const sql = `
    SELECT repo, number, COALESCE(title, '') AS title,
           CASE WHEN ${HUMAN} THEN author END AS author,
           ${field} AS count
      FROM pull_requests
     WHERE COALESCE(${field}, 0) > 0
     ORDER BY ${field} DESC, number DESC
     LIMIT ?`;

  return (await db.prepare(sql).bind(GROSSING_ORG_N).all()).results;
}

// -------------------------------------------------------------------- heatmap

async function heatmap(db, now) {
  const rows = (
    await db
      .prepare(
        `SELECT (CAST(strftime('%w', created_at) AS INTEGER) + 6) % 7 AS dow,
                CAST(strftime('%H', created_at) AS INTEGER) AS hr,
                COUNT(*) AS n
           FROM pull_requests
          WHERE ${HUMAN} AND ${epochSql("created_at")} >= ?
          GROUP BY dow, hr`,
      )
      .bind(seconds(now - HEATMAP_DAYS * DAY))
      .all()
  ).results;

  const heat = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const r of rows) heat[r.dow][r.hr] = r.n;
  return heat;
}

// ----------------------------------------------------------------------- main

export async function analytics(db, now = Date.now()) {
  const periods = periodsFor(now);
  const dayCutoff = now - DAY_SERIES_DAYS * DAY;

  const [
    head,
    day,
    week,
    month,
    groups,
    approved,
    open,
    commented,
    liked,
    disliked,
    heat,
  ] = await Promise.all([
    totals(db),
    seriesFor(db, "day", seconds(dayCutoff)),
    seriesFor(db, "week", null),
    seriesFor(db, "month", null),
    periodGroups(db, periods),
    approvedMerges(db, periods),
    backlogRows(db),
    grossing(db, "comments"),
    grossing(db, "thumbs_up"),
    grossing(db, "thumbs_down"),
    heatmap(db, now),
  ]);

  groups.approvedMerges = approved;

  // A person's first PR ever, counted into whichever periods contain it. Done
  // here rather than in SQL because the author query already carries the one
  // number it needs, and thirteen more columns would be thirteen more scans.
  groups.newContributors = periods.map(
    (p) =>
      groups.authors.filter((r) => {
        const t = seconds(Date.parse(r.first_created));
        return t >= p.from && t < p.to;
      }).length,
  );

  const [scalars, quantiles] = await Promise.all([
    periodScalars(db, periods),
    Promise.all(periods.map((p) => periodPercentiles(db, p.from, p.to))),
  ]);

  const index = new Map(periods.map((p, i) => [p.key, i]));

  const byWindow = Object.fromEntries(
    WINDOWS.map((w) => {
      const i = index.get(w.id);
      const prevI = index.get(`prev:${w.id}`);
      return [
        w.id,
        {
          ...summarize(scalars[i], quantiles[i], groups, i),
          topRepos: topN(
            groups.repos
              .filter((r) => r[`n_${i}`] > 0)
              .map((r) => ({ repo: r.repo, opened: r[`n_${i}`], merged: r[`m_${i}`] })),
            "repo",
            (e) => e.opened,
          ),
          topAuthors: topN(
            groups.authors
              .filter((r) => r[`n_${i}`] > 0)
              .map((r) => ({ login: r.login, count: r[`n_${i}`] })),
            "login",
            (e) => e.count,
          ),
          topReviewers: topN(
            groups.reviewers
              .filter((r) => r[`n_${i}`] > 0)
              .map((r) => ({ login: r.login, count: r[`n_${i}`] })),
            "login",
            (e) => e.count,
          ),
          prev:
            prevI == null
              ? null
              : summarize(scalars[prevI], quantiles[prevI], groups, prevI),
          prevLabel: w.days == null ? null : `previous ${w.label.toLowerCase()}`,
        },
      ];
    }),
  );

  const oldest = open.map((r) => ({
    repo: r.repo,
    number: r.number,
    author: r.author,
    url: `https://github.com/${DEFAULT_ORG}/${r.repo}/pull/${r.number}`,
    ageDays: Math.floor((now - Date.parse(r.created_at)) / DAY),
    staleDays: r.updated_at
      ? Math.floor((now - Date.parse(r.updated_at)) / DAY)
      : null,
    reviewed: !!r.reviewed,
  }));

  const backlogCounts = BACKLOG_BUCKETS.map((b) => ({ label: b.label, count: 0 }));
  for (const pr of oldest) {
    const i = BACKLOG_BUCKETS.findIndex((b) => pr.ageDays < b.max);
    backlogCounts[i === -1 ? BACKLOG_BUCKETS.length - 1 : i].count++;
  }

  return {
    windows: WINDOWS,
    totals: head,
    series: {
      day,
      week,
      month,
      dayFrom: new Date(dayCutoff).toISOString().slice(0, 10),
    },
    byWindow,
    backlog: {
      total: oldest.length,
      unreviewed: oldest.filter((p) => !p.reviewed).length,
      buckets: backlogCounts,
      oldest: oldest.slice(0, 25),
    },
    grossing: {
      commented: commented.map(grossRow),
      liked: liked.map(grossRow),
      disliked: disliked.map(grossRow),
    },
    heatmap: heat,
  };
}

const grossRow = (r) => ({
  repo: r.repo,
  number: r.number,
  title: r.title,
  author: r.author,
  count: r.count,
});
