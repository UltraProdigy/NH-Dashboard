/**
 * "Needs a release", served from D1.
 *
 * The Node version spends a GraphQL sweep of the whole org plus a REST compare
 * per candidate. It didn't need to. It reads commits and release tags, which are
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
 * It doesn't carry the Node version's stale-repo cutoff. That predicate
 * bounds API cost, which is not a cost D1 has, and in production it was
 * removing repos that had commits inside the window. The `live` CTE below says
 * why at length.
 *
 * **Measured, on 295 repos and 80k commits: ~5ms locally, so roughly
 * 12ms on D1** at the 2.2× ratio this repo has measured twice. That is
 * the same order as the two review cards at ~68ms and ~55ms, and nowhere near
 * `analytics` at ~2.6s.
 *
 * `needsRelease` was promoted to the instant tier on those numbers. The
 * objection recorded here was never the 12ms — it was that the instant path
 * fires on `push`, which arrives far more often than `pull_request`, and every
 * run of it bumped `version` and so cost every open dashboard a full nine-panel
 * overlay. `refreshInstant` now bumps only when the rebuilt blob differs, and a
 * push that moves no repo across `RELEASE_COMMIT_THRESHOLD` produces a
 * byte-identical one, so the frequency of `push` stopped being the price.
 */

import { RELEASE_COMMIT_THRESHOLD } from "../../../src/config.js";
import { viaPullRequestSql } from "../../../src/shared/commit-rules.js";
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
 * predicate safe: `needsRelease` needs a commit newer than the release, so a
 * genuinely dormant repo still produces nothing. Filtering on `pushed_at` was never doing work the
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
 *   repo that just cut an rc is not waiting on a release. Releases on a
 *   snapshot's line (a 2.9.x patch after master moved to 2.10) are not
 *   master's, so they are skipped: in the series, not the base tag, and
 *   published after the snapshot row was saved.
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
const OFF_SNAPSHOT_LINE = `
            AND NOT EXISTS (
                  SELECT 1 FROM release_snapshot_tags s
                   WHERE s.repo = rl.repo AND s.series IS NOT NULL
                     AND rl.tag_name GLOB s.series AND rl.tag_name <> s.base_tag
                     AND rl.published_at > s.since)`;

export async function needsRelease(db, now = Date.now()) {
  let results;
  try {
    results = await needsReleaseRows(db, OFF_SNAPSHOT_LINE);
  } catch (err) {
    if (!/no such table: release_snapshot_tags/.test(String(err))) throw err;
    results = await needsReleaseRows(db, "");
  }
  return shapeNeedsRelease(results, now);
}

async function needsReleaseRows(db, offLine) {
  const { results } = await db
    .prepare(
      `WITH ${LIVE},
       latest AS (
         SELECT repo, tag_name, published_at,
                ROW_NUMBER() OVER (PARTITION BY repo
                                   ORDER BY published_at DESC) AS rn
           FROM releases rl
          WHERE draft = 0 AND published_at IS NOT NULL${offLine}
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
  return results;
}

function shapeNeedsRelease(results, now) {
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

export const RELEASE_PANELS = { needsRelease };
