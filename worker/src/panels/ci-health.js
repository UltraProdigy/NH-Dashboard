/**
 * Default-branch CI health, served from D1.
 *
 * The Node version is the most expensive panel in the build: a GraphQL sweep of
 * the whole org, then one REST call per active repo, ~260 requests for a card
 * that changes whenever a workflow finishes. It was also the last panel still
 * on the daily build, because `workflow_run` was the last of the three events
 * the webhook received and threw away — `onRepoTouch` upserted the repo row and
 * dropped the payload. That is now `onWorkflowRun`, and a `workflow_run`
 * payload carries every field this panel reads.
 *
 * **The arithmetic is not reimplemented; the selection is.** Which runs count
 * is a query — newest N completed runs on the repo's default branch — and it
 * belongs in SQL. What those runs mean is `summarizeRuns`, and the shape of
 * that answer is the frontend's contract. So the SQL aggregates and the rules
 * it aggregates by live in `shared/ci-rules.js`, paired with the JavaScript
 * reading of each, exactly as `commit-rules.js` pairs the release panels'.
 *
 * The org roll-up is the one part reused outright rather than translated.
 * `summarizeOrg` is pure arithmetic over per-repo results the panel already
 * holds in the isolate — 250 small objects, not 96,000 rows — so a SQL twin of
 * it would be a second copy to keep in step for no benefit at all.
 *
 * Two things this panel does *not* do, both deliberate:
 *
 *   **No filter on `event`.** The Node panel passes `exclude_pull_requests=true`
 *   and its comment claims that drops PR-triggered runs. Measured against the
 *   API, that parameter returns a byte-identical set of runs and only empties
 *   each one's `pull_requests` array. What excludes PR runs is the branch
 *   filter — a pull request's `head_branch` is its source branch — so that is
 *   the only filter here. Note this means `workflow_run`-triggered runs are
 *   included, as they are in the build; on GT5-Unofficial they are 42 of 100.
 *
 *   **No stale-repo cutoff**, for the reason the release panels give at length:
 *   the cutoff bounds API cost, and reading a row already in D1 has no such
 *   cost. Here the run rows are the bound anyway — a repo with no runs produces
 *   nothing.
 */

import { CI_RUN_SAMPLE } from "../../../src/config.js";
import {
  isDecisiveSql,
  isPassSql,
  runMinutesSql,
  spanBetween,
  summarizeOrg,
} from "../../../src/shared/ci-rules.js";
import { round1 } from "../../../src/shared/analytics-rules.js";

/**
 * Repos this panel will consider.
 *
 * Not a CTE named `repos`. `scope.js` rewrites `FROM repos` into a filtered
 * subquery by regex, and a CTE carrying a real table's name would be rewritten
 * with it.
 *
 * The join to `default_branch` is what makes the branch filter correct across a
 * rename: runs are stored with the branch they ran on, and a repo that moved
 * from `master` to `main` should stop counting the old ones the moment it
 * moves. Filtering at write time would have frozen yesterday's answer into rows
 * nothing could later re-evaluate.
 */
const LIVE = `
  live AS (
    SELECT name, default_branch
      FROM repos
     WHERE archived = 0 AND default_branch IS NOT NULL
  )`;

/**
 * The sampled runs, one row each, with every per-run verdict already resolved.
 *
 * `ROW_NUMBER` rather than a correlated LIMIT: one pass over the index gives
 * every repo's newest runs at once, and the index is `(repo, run_started_at
 * DESC)` precisely for this.
 *
 * The tiebreak on `run_id` is not decoration. Two runs can share a start
 * timestamp to the second, and without a second key the cap would take an
 * arbitrary one of them — a difference of one row inside a median, which is the
 * kind of disagreement that shows up as a plausible number rather than an
 * error.
 */
const SAMPLE = `
  sample AS (
    SELECT r.repo                         AS repo,
           l.default_branch               AS default_branch,
           r.name                         AS workflow,
           r.conclusion                   AS conclusion,
           r.run_started_at               AS started_at,
           r.updated_at                   AS updated_at,
           r.html_url                     AS html_url,
           (${runMinutesSql("r")})        AS mins,
           CASE WHEN ${isDecisiveSql("r")} THEN 1 ELSE 0 END AS decisive,
           CASE WHEN ${isPassSql("r")}     THEN 1 ELSE 0 END AS passed,
           ROW_NUMBER() OVER (
             PARTITION BY r.repo
             ORDER BY r.run_started_at DESC, r.run_id DESC
           ) AS rn
      FROM workflow_runs r
      JOIN live l ON l.name = r.repo AND l.default_branch = r.head_branch
  )`;

export async function ciHealth(db, now = Date.now()) {
  const { results } = await db
    .prepare(
      `WITH ${LIVE},
       ${SAMPLE},
       taken AS (
         SELECT * FROM sample WHERE rn <= ?1
       ),
       -- The median position, computed the way JavaScript indexes it: sort
       -- ascending, take the element at floor(n / 2) zero-based, which is rank
       -- floor(n / 2) + 1 one-based. SQLite's / is integer division on integer
       -- operands, and COUNT(*) is an integer, so this is that floor.
       --
       -- Ranked over the timed runs only. A run whose duration was discarded is
       -- not a zero-minute run and must not sit at the bottom of the sort.
       ranked AS (
         SELECT repo, mins,
                ROW_NUMBER() OVER (PARTITION BY repo ORDER BY mins) AS mrn,
                COUNT(*)    OVER (PARTITION BY repo)                AS mn
           FROM taken
          WHERE mins IS NOT NULL
       ),
       agg AS (
         SELECT repo,
                default_branch,
                COUNT(*)                AS runs,
                SUM(decisive)           AS decisive,
                SUM(passed)             AS passes,
                COUNT(mins)             AS timed_runs,
                SUM(mins)               AS total_minutes,
                MIN(started_at)         AS oldest,
                MAX(started_at)         AS newest
           FROM taken
          GROUP BY repo, default_branch
       )
       SELECT a.repo               AS repo,
              a.default_branch     AS default_branch,
              a.runs               AS runs,
              a.decisive           AS decisive,
              a.passes             AS passes,
              a.timed_runs         AS timed_runs,
              a.total_minutes      AS total_minutes,
              a.oldest             AS oldest,
              a.newest             AS newest,
              m.mins               AS median_minutes,
              t.conclusion         AS latest_conclusion,
              COALESCE(t.updated_at, t.started_at) AS latest_at,
              t.html_url           AS latest_url,
              t.workflow           AS latest_workflow
         FROM agg a
         LEFT JOIN ranked m ON m.repo = a.repo AND m.mrn = m.mn / 2 + 1
         LEFT JOIN taken  t ON t.repo = a.repo AND t.rn = 1`,
    )
    .bind(CI_RUN_SAMPLE)
    .all();

  const repos = {};

  for (const r of results) {
    repos[r.repo] = {
      repo: r.repo,
      defaultBranch: r.default_branch,
      latest: r.latest_url
        ? {
            conclusion: r.latest_conclusion,
            at: r.latest_at,
            url: r.latest_url,
            workflow: r.latest_workflow ?? null,
          }
        : null,
      runs: r.runs,
      decisive: r.decisive,
      failures: r.decisive - r.passes,
      // Null rather than 0 when nothing was decisive — "no verdict" and "all
      // red" are very different and must not render the same.
      passRate: r.decisive ? r.passes / r.decisive : null,
      medianMinutes: round1(r.median_minutes),
      // SUM over no rows is NULL, which is the same answer the build gives when
      // no duration survived the ceiling. Rounded here rather than in SQL so
      // both sides round once, at the same point, on the same value.
      totalMinutes: r.timed_runs ? round1(r.total_minutes) : null,
      timedRuns: r.timed_runs,
      // `spanBetween` returns null for a zero width, which is what one run
      // produces — MAX and MIN over a single row are the same timestamp. The
      // build reaches the same null by refusing to measure a sample of one.
      sampleSpanDays: spanBetween(r.oldest, r.newest),
    };
  }

  return { repos, org: summarizeOrg(repos) };
}

/**
 * Trim `workflow_runs` back to the newest rows per repo.
 *
 * Called from the recompute rather than from the handler: a DELETE on every
 * delivery would double this event's write cost to bound a table that grows by
 * about 320 rows a day org-wide.
 *
 * The cap is five times the sample the panel reads, so pruning can never move a
 * number on the card and `CI_RUN_SAMPLE` has room to be raised without a
 * backfill. What it bounds is the one genuinely unbounded thing here —
 * `workflow_run` is by a wide margin the noisiest event this webhook receives,
 * and a table nobody ever deletes from is a storage bill that only goes up.
 *
 * **Takes the raw handle, not the scoped one.** `scope.js` rewrites
 * `FROM workflow_runs` into a filtered subquery, and `DELETE FROM (SELECT …)`
 * is not a statement. That rewrite is a read-path protection and this is a
 * write, so the two never needed to meet — but the failure would be a syntax
 * error at recompute time rather than anything visible here, which is why it is
 * written down at the point of the mistake.
 */
export const CI_RUN_RETAIN = CI_RUN_SAMPLE * 5;

export async function pruneWorkflowRuns(db) {
  const { meta } = await db
    .prepare(
      `DELETE FROM workflow_runs
        WHERE rowid IN (
          SELECT rowid FROM (
            SELECT rowid,
                   ROW_NUMBER() OVER (
                     PARTITION BY repo ORDER BY run_started_at DESC, run_id DESC
                   ) AS rn
              FROM workflow_runs
          )
          WHERE rn > ?1
        )`,
    )
    .bind(CI_RUN_RETAIN)
    .run();

  return { pruned: meta?.changes ?? 0 };
}
