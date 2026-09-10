/**
 * Repo activity, aggregated in SQL.
 *
 * The Node panel of the same name folds the two ingest stores in JavaScript.
 * Here the counting happens inside D1 and this module stitches the result sets
 * together, for the reason the contributors port gives: query time is I/O and
 * does not count against a Worker's CPU budget, while a loop over 29,000 pull
 * requests and 24,000 issues very much does.
 *
 * Eleven queries. Four grouped scans — pull requests, open-and-unreviewed,
 * approvals, issues — and then one percentile pass per window, because a median
 * per repo per window is the one figure that cannot be reached with SUM.
 *
 * Seven separate percentile queries rather than one seven-arm UNION: D1 caps
 * the terms in a compound SELECT far below SQLite's own default and rejects
 * six, which is why `contributors` splits its own UNION into three. Local
 * SQLite accepts what D1 refuses, so this cannot be caught anywhere but against
 * D1 itself.
 *
 * The output matches the Node panel's exactly, packed the same way against
 * `windowFields`. `worker/test/repos.parity.test.js` asserts that rather than
 * trusting it.
 */

import { WINDOWS, isHumanSql } from "../../../src/shared/contributor-rules.js";
import { hoursSql, isoBound, pctRankSql, round1 } from "../../../src/shared/analytics-rules.js";
import { unansweredSql } from "../../../src/shared/issue-rules.js";
import {
  CONCENTRATION_N,
  LIFECYCLE,
  STALE_OPEN_PR_DAYS,
  byActivityThenRepo,
  lifecycleOf,
} from "../../../src/shared/repo-activity-rules.js";

const DAY = 86_400_000;

const HUMAN_AUTHOR = isHumanSql("author");

/**
 * A pull request that was closed without merging, and when.
 *
 * `closed_at` where the backfill has reached it and `updated_at` where it has
 * not — the same fallback the analytics panel took when the field was added,
 * and the same one the Node twin spells out. Returns NULL for anything merged
 * or still open, which is what lets every window arm below be a bare
 * comparison: a comparison against NULL is NULL, and SUM skips it.
 */
const CLOSED_AT = `CASE WHEN merged_at IS NULL AND state = 'CLOSED'
                        THEN COALESCE(closed_at, updated_at) END`;

const dated = (now) =>
  WINDOWS.filter((w) => w.days !== null).map((w) => ({
    id: w.id,
    from: isoBound(now - w.days * DAY),
  }));

const sums = (expr, prefix, windows) =>
  windows.map((w) => `SUM(${expr} >= ?) AS ${prefix}_${w.id}`).join(",\n           ");

/**
 * Pull request counts, distinct authors and the activity bounds, per repo.
 *
 * One scan rather than three: every figure here groups by repo over the same
 * table, and splitting them would be three walks for one answer.
 *
 * `people` is a distinct count of non-bot authors while `opened` counts every
 * pull request including a bot's — the asymmetry the Node panel documents and
 * the drilldown's repo picker states outright. A repo is a thing pull requests
 * happen to; a bot is not a contributor.
 */
async function prCounts(db, windows, staleBefore) {
  const sql = `
    SELECT repo,
           COUNT(*) AS total_prs,
           SUM(state = 'OPEN') AS open_prs,
           SUM(state = 'OPEN' AND created_at <= ?) AS stale_open_prs,
           COUNT(DISTINCT CASE WHEN ${HUMAN_AUTHOR} THEN author END) AS people_all,
           SUM(merged_at IS NOT NULL) AS merged_all,
           SUM(${CLOSED_AT} IS NOT NULL) AS closed_all,
           ${sums("created_at", "opened", windows)},
           ${sums("merged_at", "merged", windows)},
           ${sums(CLOSED_AT, "closed", windows)},
           ${windows
             .map(
               (w) =>
                 `COUNT(DISTINCT CASE WHEN ${HUMAN_AUTHOR} AND created_at >= ? THEN author END) AS people_${w.id}`,
             )
             .join(",\n           ")},
           MIN(created_at) AS first_created,
           MAX(created_at) AS last_created,
           MIN(merged_at) AS first_merged,
           MAX(merged_at) AS last_merged,
           MIN(${CLOSED_AT}) AS first_closed,
           MAX(${CLOSED_AT}) AS last_closed
      FROM pull_requests
     GROUP BY repo`;

  // `staleBefore` first, because it is the first placeholder in the statement.
  // Then one pass of bounds per windowed block, in the order the blocks appear.
  const from = windows.map((w) => w.from);
  return (
    await db.prepare(sql).bind(staleBefore, ...from, ...from, ...from, ...from).all()
  ).results;
}

/** Open pull requests nobody has reviewed at all. */
async function unreviewed(db) {
  const sql = `
    SELECT p.repo AS repo, COUNT(*) AS n
      FROM pull_requests p
     WHERE p.state = 'OPEN'
       AND NOT EXISTS (
             SELECT 1 FROM reviews r
              WHERE r.repo = p.repo
                AND r.pr_number = p.number
                AND r.submitted_at IS NOT NULL)
     GROUP BY p.repo`;
  return (await db.prepare(sql).all()).results;
}

/**
 * Approvals and distinct approvers, per repo.
 *
 * The inner query collapses to one row per (repo, pull request, reviewer) and
 * takes the earliest submission, so re-approving after a round of changes is
 * one act rather than two. Bots are excluded; self-approval is not, matching
 * `approversOf` in both the Node panel and `drilldown-fold.js`.
 */
async function approvals(db, windows) {
  const sql = `
    SELECT repo,
           COUNT(*) AS approvals_all,
           COUNT(DISTINCT login) AS reviewers_all,
           ${sums("first_at", "approvals", windows)},
           ${windows
             .map(
               (w) =>
                 `COUNT(DISTINCT CASE WHEN first_at >= ? THEN login END) AS reviewers_${w.id}`,
             )
             .join(",\n           ")}
      FROM (SELECT repo, author AS login, MIN(submitted_at) AS first_at
              FROM reviews
             WHERE state = 'APPROVED'
               AND submitted_at IS NOT NULL
               AND ${HUMAN_AUTHOR}
             GROUP BY repo, pr_number, author)
     GROUP BY repo`;

  const from = windows.map((w) => w.from);
  return (await db.prepare(sql).bind(...from, ...from).all()).results;
}

/** Issue counts and bounds, per repo. */
async function issueCounts(db, windows) {
  const sql = `
    SELECT repo,
           COUNT(*) AS total_issues,
           SUM(state = 'OPEN') AS open_issues,
           SUM(state = 'OPEN' AND ${unansweredSql()}) AS unanswered_issues,
           COUNT(closed_at) AS iclosed_all,
           ${sums("created_at", "iopened", windows)},
           ${sums("closed_at", "iclosed", windows)},
           MIN(created_at) AS first_created,
           MAX(created_at) AS last_created,
           MIN(closed_at) AS first_closed,
           MAX(closed_at) AS last_closed
      FROM issues
     GROUP BY repo`;

  const from = windows.map((w) => w.from);
  return (await db.prepare(sql).bind(...from, ...from).all()).results;
}

/**
 * Median hours from opening to merge, per repo, for one window.
 *
 * `ROW_NUMBER()` ranks within the repo, `COUNT(*) OVER` gives that repo's
 * sample size, and the outer `MAX(CASE ...)` picks the single row whose rank is
 * the one `pct` would have indexed — the same shape `percentileByBucket` uses
 * in the analytics twin, with the repo as the bucket.
 *
 * The sample is pull requests **merged** in the window, not opened in it, which
 * is what the Node panel collects. A pull request opened two years ago and
 * merged last week belongs to last week's median.
 */
async function mergeMedians(db, from) {
  const sql = `
    WITH h AS (
      SELECT repo AS b,
             ${hoursSql("created_at", "merged_at")} AS hours
        FROM pull_requests
       WHERE merged_at IS NOT NULL
         ${from == null ? "" : "AND merged_at >= ?"}
    ), ranked AS (
      SELECT b, hours,
             ROW_NUMBER() OVER (PARTITION BY b ORDER BY hours) AS rn,
             COUNT(*) OVER (PARTITION BY b) AS n
        FROM h
    )
    SELECT b AS repo,
           MAX(CASE WHEN rn = ${pctRankSql("n", 50)} THEN hours END) AS p50
      FROM ranked
     GROUP BY b`;

  const stmt = db.prepare(sql);
  return (await (from == null ? stmt : stmt.bind(from)).all()).results;
}

const minISO = (a, b) => (!a ? b : !b ? a : a < b ? a : b);
const maxISO = (a, b) => (!a ? b : !b ? a : a > b ? a : b);

const WINDOW_FIELDS = [
  "opened",
  "merged",
  "closed",
  "mergeRate",
  "approvals",
  "people",
  "reviewers",
  "medianMergeHours",
  "issuesOpened",
  "issuesClosed",
];

const round3 = (n) => (n == null ? null : Math.round(n * 1000) / 1000);

export async function repos(db, now = Date.now()) {
  const windows = dated(now);
  const staleBefore = isoBound(now - STALE_OPEN_PR_DAYS * DAY);

  const [prs, unrev, apps, iss, ...medians] = await Promise.all([
    prCounts(db, windows, staleBefore),
    unreviewed(db),
    approvals(db, windows),
    issueCounts(db, windows),
    ...WINDOWS.map((w) =>
      mergeMedians(db, w.days == null ? null : isoBound(now - w.days * DAY)),
    ),
  ]);

  const medianBy = WINDOWS.map((w, i) => [
    w.id,
    new Map(medians[i].map((r) => [r.repo, r.p50])),
  ]);

  const byRepo = new Map();
  const entry = (repo) => {
    let r = byRepo.get(repo);
    if (!r) {
      r = {
        repo,
        totalPRs: 0,
        totalIssues: 0,
        openPRs: 0,
        staleOpenPRs: 0,
        unreviewedOpenPRs: 0,
        openIssues: 0,
        unansweredIssues: 0,
        first: null,
        last: null,
        _w: Object.fromEntries(
          WINDOWS.map((w) => [
            w.id,
            {
              opened: 0,
              merged: 0,
              closed: 0,
              approvals: 0,
              people: 0,
              reviewers: 0,
              issuesOpened: 0,
              issuesClosed: 0,
            },
          ]),
        ),
      };
      byRepo.set(repo, r);
    }
    return r;
  };

  for (const row of prs) {
    const r = entry(row.repo);
    r.totalPRs = row.total_prs;
    r.openPRs = row.open_prs ?? 0;
    r.staleOpenPRs = row.stale_open_prs ?? 0;
    r._w.all.opened = row.total_prs;
    r._w.all.merged = row.merged_all ?? 0;
    r._w.all.closed = row.closed_all ?? 0;
    r._w.all.people = row.people_all ?? 0;
    for (const w of windows) {
      r._w[w.id].opened = row[`opened_${w.id}`] ?? 0;
      r._w[w.id].merged = row[`merged_${w.id}`] ?? 0;
      r._w[w.id].closed = row[`closed_${w.id}`] ?? 0;
      r._w[w.id].people = row[`people_${w.id}`] ?? 0;
    }
    for (const key of ["first_created", "first_merged", "first_closed"])
      r.first = minISO(r.first, row[key]);
    for (const key of ["last_created", "last_merged", "last_closed"])
      r.last = maxISO(r.last, row[key]);
  }

  for (const row of unrev) entry(row.repo).unreviewedOpenPRs = row.n;

  for (const row of apps) {
    const r = entry(row.repo);
    r._w.all.approvals = row.approvals_all ?? 0;
    r._w.all.reviewers = row.reviewers_all ?? 0;
    for (const w of windows) {
      r._w[w.id].approvals = row[`approvals_${w.id}`] ?? 0;
      r._w[w.id].reviewers = row[`reviewers_${w.id}`] ?? 0;
    }
  }

  for (const row of iss) {
    const r = entry(row.repo);
    r.totalIssues = row.total_issues;
    r.openIssues = row.open_issues ?? 0;
    r.unansweredIssues = row.unanswered_issues ?? 0;
    r._w.all.issuesOpened = row.total_issues;
    r._w.all.issuesClosed = row.iclosed_all ?? 0;
    for (const w of windows) {
      r._w[w.id].issuesOpened = row[`iopened_${w.id}`] ?? 0;
      r._w[w.id].issuesClosed = row[`iclosed_${w.id}`] ?? 0;
    }
    r.first = minISO(minISO(r.first, row.first_created), row.first_closed);
    r.last = maxISO(maxISO(r.last, row.last_created), row.last_closed);
  }

  const rows = [];
  for (const r of byRepo.values()) {
    const idleDays = r.last == null ? null : Math.floor((now - Date.parse(r.last)) / DAY);
    const out = {
      repo: r.repo,
      totalPRs: r.totalPRs,
      totalIssues: r.totalIssues,
      openPRs: r.openPRs,
      staleOpenPRs: r.staleOpenPRs,
      unreviewedOpenPRs: r.unreviewedOpenPRs,
      openIssues: r.openIssues,
      unansweredIssues: r.unansweredIssues,
      first: r.first,
      last: r.last,
      idleDays,
      lifecycle: lifecycleOf(idleDays),
    };
    for (const [id, byRepoMedian] of medianBy) {
      const w = r._w[id];
      out[id] = [
        w.opened,
        w.merged,
        w.closed,
        round3(w.merged + w.closed ? w.merged / (w.merged + w.closed) : null),
        w.approvals,
        w.people,
        w.reviewers,
        round1(byRepoMedian.get(r.repo) ?? null),
        w.issuesOpened,
        w.issuesClosed,
      ];
    }
    rows.push(out);
  }

  const OPENED = WINDOW_FIELDS.indexOf("opened");
  const ISSUES_OPENED = WINDOW_FIELDS.indexOf("issuesOpened");
  const activityIn = (r, id) => r[id][OPENED] + r[id][ISSUES_OPENED];

  rows.sort(byActivityThenRepo((r) => activityIn(r, "all")));

  const org = {
    repos: rows.length,
    byLifecycle: LIFECYCLE.map((b) => ({
      id: b.id,
      label: b.label,
      detail: b.detail,
      count: rows.filter((r) => r.lifecycle === b.id).length,
    })),
    openPRs: rows.reduce((n, r) => n + r.openPRs, 0),
    staleOpenPRs: rows.reduce((n, r) => n + r.staleOpenPRs, 0),
    openIssues: rows.reduce((n, r) => n + r.openIssues, 0),
    unansweredIssues: rows.reduce((n, r) => n + r.unansweredIssues, 0),
    byWindow: Object.fromEntries(
      WINDOWS.map((w) => {
        const activity = rows.map((r) => activityIn(r, w.id)).sort((a, b) => b - a);
        const total = activity.reduce((n, v) => n + v, 0);
        const top = activity.slice(0, CONCENTRATION_N).reduce((n, v) => n + v, 0);
        return [
          w.id,
          {
            activeRepos: activity.filter((v) => v > 0).length,
            opened: rows.reduce((n, r) => n + r[w.id][OPENED], 0),
            issuesOpened: rows.reduce((n, r) => n + r[w.id][ISSUES_OPENED], 0),
            concentration: round3(total ? top / total : null),
          },
        ];
      }),
    ),
  };

  return {
    windows: WINDOWS,
    windowFields: WINDOW_FIELDS,
    concentrationN: CONCENTRATION_N,
    org,
    rows,
  };
}
