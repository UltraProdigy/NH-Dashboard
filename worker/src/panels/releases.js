/**
 * "Needs a release" and "Time since last update", served from D1.
 *
 * The Node versions spend a GraphQL sweep of the whole org plus a REST compare
 * per candidate, and `depUpdates` walks up to ten pages of history per repo on
 * top of that. Neither needed to. They read commits and release tags, which are
 * facts, and the webhook has been receiving both all along — `onRepoTouch` took
 * `push` and `release`, upserted the repo row, and dropped the payload.
 *
 * One substitution is not a translation and should not be read as one.
 * `needsRelease` decides "is this repo ahead of its last release" by comparing
 * the default branch's HEAD SHA against the release's tag SHA. **A release
 * webhook carries no tag SHA** — it has `tag_name` and `target_commitish`, and
 * the latter is normally a branch name. So this asks a different question with
 * the same meaning: is there a commit on the default branch newer than the
 * latest release. That is answerable from what the store holds, and it is
 * strictly better behaved than the SHA test on a repo whose tag was force-moved.
 *
 * The commit count follows from it. The Node panel spends a `compare` call for
 * `ahead_by`; here it is the COUNT of the same rows the filter already scanned.
 *
 * Neither panel carries the Node versions' stale-repo cutoff. That predicate
 * bounds API cost, which is not a cost D1 has, and in production it was
 * removing repos that had commits inside the window. The `live` CTE below says
 * why at length.
 *
 * **Measured, on 295 repos and 80k commits: ~5ms and ~36ms locally, so roughly
 * 12ms and 79ms on D1** at the 2.2× ratio this repo has measured twice. That is
 * the same order as the two review cards at ~68ms and ~55ms, and nowhere near
 * `analytics` at ~2.6s — so both are on the cron for a reason that is *not*
 * cost. Promoting them means firing the instant path on `push`, which arrives
 * far more often than `pull_request` does, and the ten-minute cron is already
 * inside the window either card is read on. If that trade is ever worth making,
 * the numbers above are the argument for it, not against.
 */

import {
  DEP_UPDATE_LOOKBACK_DAYS,
  DEP_UPDATE_MIN_DAYS,
  RELEASE_COMMIT_THRESHOLD,
} from "../../../src/config.js";
import { isDirectCommitSql, viaPullRequestSql } from "../../../src/shared/commit-rules.js";
import { isoBound } from "../../../src/shared/analytics-rules.js";
import { DEFAULT_ORG } from "../../../src/shared/analytics-rules.js";

const DAY = 86_400_000;

/**
 * Repos either panel will consider.
 *
 * Not a CTE named `repos`. `scope.js` rewrites `FROM repos` into a filtered
 * subquery by regex, and a CTE carrying a real table's name would be rewritten
 * along with it — which is why this is `live` and why the file that does the
 * rewriting says so in its own header.
 *
 * **There is deliberately no `private = 0` here**, and it is worth saying why,
 * because the schema says the opposite. `idx_repos_public` exists so restricted
 * repos are opted *into* by queries rather than filtered out — a panel that
 * forgets the predicate then returns public data instead of leaking, which is
 * the right default for a table that might hold anything.
 *
 * It is the wrong default for these two. The org's recorded decision is that
 * private repo data ships publicly and there is no display filter; the Node
 * build has always published these repos, and the exclusion that actually
 * protects anything is `NH_INGEST_EXCLUDE`, applied in `scope.js` to every
 * table at once. Filtering here as well made the Worker quietly stricter than
 * the build it replaces — seven repos present on the page and absent from the
 * live card, which reads as a bug in the port rather than as a policy.
 *
 * If that policy changes, the lever is `NH_INGEST_EXCLUDE`, not a predicate
 * added back here — one place, all panels, rather than a rule each panel has to
 * remember.
 *
 * **Both panels are only as complete as this table**, which is worth knowing
 * because it is the least obvious dependency either has. `seed.sql` never wrote
 * a `repos` row — it loaded pull requests, reviews, issues and traffic — so in
 * production this holds only what a webhook has upserted since the Worker went
 * live. A repo nobody has touched since then is not filtered out here, it is
 * simply absent, and the card cannot tell the two apart. The backfill writes
 * `repos` for exactly this reason.
 *
 * **There is no stale-repo cutoff here either, and that is a departure from the
 * Node panels rather than an oversight.** Both of them stop sweeping at the
 * first repo pushed longer ago than `STALE_REPO_CUTOFF_DAYS`, which is a bound
 * on *API cost*: the sweep is ordered by `pushedAt` descending, so stopping
 * early saves requests. Reading a row that is already in D1 costs nothing, so
 * the same predicate here buys nothing and only removes repos.
 *
 * It was removing real ones. Measured in production: 270 repos had a commit
 * inside the lookback and the panel returned 245, with 27 repos carrying a
 * `pushed_at` older than a year. A repo cannot both have been pushed to last
 * week and have a year-old `pushed_at`, so that column disagrees with the
 * commits — and between a timestamp copied from a payload and the commit rows
 * themselves, the commits are the better authority.
 *
 * The commit data also *is* the bound, which is what makes dropping the
 * predicate safe: `needsRelease` needs a commit newer than the release and
 * `depUpdates` needs one inside the lookback, so a genuinely dormant repo
 * still produces nothing. Filtering on `pushed_at` was never doing work the
 * data was not already doing correctly.
 */
const LIVE = `
  live AS (
    SELECT name, default_branch, commits_since
      FROM repos
     WHERE archived = 0
  )`;

const repoUrl = (repo) => `https://github.com/${DEFAULT_ORG}/${repo}`;

const days = (now, iso) =>
  iso === null ? null : Math.floor((now - Date.parse(iso)) / DAY);

/**
 * Repos with commits their last release does not contain.
 *
 * The three-stage shape of the Node panel survives as three predicates:
 *
 *   `latest` is stage 1 — the newest non-draft release per repo. A repo with
 *   no releases produces no row and drops out of the join for free, which is
 *   exactly what the GraphQL sweep got for free too. Prereleases are kept: a
 *   repo that just cut an rc is not waiting on a release.
 *
 *   `COUNT(*) >= RELEASE_COMMIT_THRESHOLD` is stage 2, replacing `ahead_by`.
 *
 *   `MAX(via_pr) = 1` is stage 3, and it is the one that matters. Being ahead
 *   is not enough: buildscript bumps and workflow edits go straight to the
 *   default branch here and nobody is waiting on a release for them. Anything
 *   that does want one arrived as a pull request.
 *
 * `c.committed_at > r.published_at` is a string comparison, not `strftime`.
 * Both columns are Z-normalised whole seconds, so lexical order is
 * chronological order — and `strftime` parses a date per row per call, which
 * measured 43ms against 7ms for the equivalent compare in `analytics`.
 */
export async function needsRelease(db, now = Date.now()) {
  const { results } = await db
    .prepare(
      `WITH ${LIVE},
       latest AS (
         SELECT repo, tag_name, published_at,
                ROW_NUMBER() OVER (PARTITION BY repo
                                   ORDER BY published_at DESC) AS rn
           FROM releases
          WHERE draft = 0 AND published_at IS NOT NULL
       )
       SELECT l.name              AS repo,
              l.default_branch    AS default_branch,
              l.commits_since     AS commits_since,
              r.tag_name          AS tag_name,
              r.published_at      AS published_at,
              rel.prerelease      AS prerelease,
              COUNT(*)            AS commits_ahead,
              MAX(${viaPullRequestSql("c", "p")}) AS has_pr
         FROM commits c
         JOIN live l     ON l.name = c.repo
         JOIN latest r   ON r.repo = c.repo AND r.rn = 1
         JOIN releases rel ON rel.repo = r.repo AND rel.tag_name = r.tag_name
         LEFT JOIN pull_requests p
                ON p.repo = c.repo AND p.merge_commit_sha = c.sha
        WHERE c.committed_at > r.published_at
        GROUP BY l.name, l.default_branch, l.commits_since,
                 r.tag_name, r.published_at, rel.prerelease
       HAVING COUNT(*) >= ?1 AND MAX(${viaPullRequestSql("c", "p")}) = 1
        ORDER BY commits_ahead DESC, repo`,
    )
    .bind(RELEASE_COMMIT_THRESHOLD)
    .all();

  return results.map((r) => {
    // The count is only a count when the store reaches back past the release.
    // Otherwise it is "however many commits the sweep happened to capture",
    // which measured 20 against a true 106 on TC4Tweaks — and the card renders
    // it as a bare number either way. Saying so is the difference between a
    // floor and a lie.
    const truncated = Boolean(r.commits_since && r.published_at < r.commits_since);

    return {
      repo: r.repo,
      repoUrl: repoUrl(r.repo),
      defaultBranch: r.default_branch,
      tagName: r.tag_name,
      releaseUrl: `${repoUrl(r.repo)}/releases/tag/${r.tag_name}`,
      releasedAt: r.published_at,
      isPrerelease: Boolean(r.prerelease),
      commitsAhead: r.commits_ahead,
      commitsAheadApprox: truncated,
      daysSinceRelease: days(now, r.published_at),
    };
  });
}

/**
 * How long since somebody pushed to a repo without going through review.
 *
 * The proxy the Node panel explains at length holds unchanged: there is no
 * cheap way to ask GitHub what a commit changed, and in this org practically
 * everything arrives as a pull request, so the newest commit with no pull
 * request attached is a decent stand-in for the newest dependency bump. It is
 * an estimate and the card says so.
 *
 * What changes is the confidence, and it moves in one direction. GraphQL
 * answers the PR question itself; the store answers it by matching
 * `merge_commit_sha`, which misses a rebase merge's replayed commits. A missed
 * PR commit reads as direct, which dates the repo *younger* than it is — the
 * failure hides staleness rather than inventing it, and the daily build
 * overwrites `via_pr` with GitHub's own answer on its next pass.
 *
 * A repo whose entire window is pull requests gets a floor row rather than a
 * date, matching the Node panel's `approx: true` — the card renders those
 * differently, as "more than N days" rather than a link to a commit.
 *
 * **A repo with no commits at all gets a floor too**, which is why `seen` is a
 * LEFT JOIN. Requiring a commit row dropped six repos the build listed, and
 * they were the worst ones on the card: no commits inside the lookback is the
 * strongest possible version of "nothing has touched this", and the panel was
 * answering by omitting them. That is the same flattering direction as the
 * shallow floors above, and it is the one this card exists to catch.
 *
 * The cost is a handful of repos that hold no code at all — issue-only trackers
 * — reporting a 365-day floor. That is noise in the right direction: a true
 * statement about a repo nobody needed to look at, rather than silence about
 * one they did.
 *
 * **The floor is how far back the store can see, not how far back this repo's
 * rows happen to go.** The first version used `MIN(committed_at)` per repo and
 * was wrong in the flattering direction: DummyCore's oldest stored commit is
 * 102 days old, so it reported a 102-day floor, while the build — which walked
 * the full horizon and found nothing — reported 365. Both are looking at the
 * same fact, that the repo has no direct commit in a year, and only one of them
 * says so. A repo with a gap in its history is not a repo we cannot see into.
 *
 * So the horizon comes from `meta.commits_since`, written by the backfill to
 * record the date it actually swept from. Falling back to the per-repo oldest
 * only makes sense when no backfill has run, which is the one case where the
 * store really can only see as far as the webhook has been running.
 */
export async function depUpdates(db, now = Date.now()) {
  const since = isoBound(now - DEP_UPDATE_LOOKBACK_DAYS * DAY);

  const { results } = await db
    .prepare(
      `WITH ${LIVE},
       direct AS (
         SELECT c.repo, c.sha, c.committed_at, c.author, c.message,
                ROW_NUMBER() OVER (PARTITION BY c.repo
                                   ORDER BY c.committed_at DESC) AS rn
           FROM commits c
           LEFT JOIN pull_requests p
                  ON p.repo = c.repo AND p.merge_commit_sha = c.sha
          WHERE c.committed_at >= ?1 AND ${isDirectCommitSql()}
       ),
       seen AS (
         SELECT repo, MIN(committed_at) AS oldest
           FROM commits
          WHERE committed_at >= ?1
          GROUP BY repo
       )
       SELECT l.name           AS repo,
              l.default_branch AS default_branch,
              l.commits_since  AS commits_since,
              d.sha            AS sha,
              d.committed_at   AS committed_at,
              d.author         AS author,
              d.message        AS message,
              s.oldest         AS oldest
         FROM live l
         LEFT JOIN seen s ON s.repo = l.name
         LEFT JOIN direct d ON d.repo = l.name AND d.rn = 1`,
    )
    .bind(since)
    .all();

  const rows = results.map((r) =>
    r.sha
      ? {
          repo: r.repo,
          repoUrl: repoUrl(r.repo),
          defaultBranch: r.default_branch,
          sha: r.sha.slice(0, 7),
          commitUrl: `${repoUrl(r.repo)}/commit/${r.sha}`,
          committedAt: r.committed_at,
          author: r.author,
          message: r.message,
          approx: false,
          daysSinceDirect: days(now, r.committed_at),
        }
      : {
          repo: r.repo,
          repoUrl: repoUrl(r.repo),
          defaultBranch: r.default_branch,
          sha: null,
          commitUrl: null,
          committedAt: null,
          author: null,
          message: null,
          approx: true,
          daysSinceDirect: Math.min(
            DEP_UPDATE_LOOKBACK_DAYS,
            days(now, r.commits_since ?? r.oldest) ?? DEP_UPDATE_LOOKBACK_DAYS,
          ),
        },
  );

  // Oldest first, which is the only order this card is read in. Repos sitting
  // on the same floor tie, so an exact date beats an estimate and the name
  // breaks what is left — the Node panel's ordering exactly.
  return rows
    .filter((r) => r.daysSinceDirect >= DEP_UPDATE_MIN_DAYS)
    .sort(
      (a, b) =>
        b.daysSinceDirect - a.daysSinceDirect ||
        Number(b.approx) - Number(a.approx) ||
        a.repo.localeCompare(b.repo),
    );
}

export const RELEASE_PANELS = { needsRelease, depUpdates };
