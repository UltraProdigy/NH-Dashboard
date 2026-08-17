/**
 * "Repos with commits since their last release."
 *
 * Three-stage to keep it cheap across 1400+ repos:
 *
 *   1. One GraphQL sweep pulls every repo's default-branch HEAD SHA and its
 *      most recent release's tag SHA, 50 repos per request (~30 requests total
 *      for the whole org). Repos with no releases drop out here for free —
 *      exactly the filter we wanted.
 *
 *   2. Only where those two SHAs differ do we spend a REST `compare` call to
 *      get the exact commit count. That's the expensive part, and it only runs
 *      on genuine candidates.
 *
 *   3. Being ahead isn't enough on its own. Buildscript bumps, workflow edits
 *      and other housekeeping go straight to the default branch here, and
 *      nobody is waiting on a release for those — anything that does want one
 *      arrives as a PR. So a candidate only survives if at least one commit in
 *      the range has a pull request attached.
 */

import { graphql, rest } from "../github/client.js";
import {
  ORG,
  RELEASE_COMMIT_THRESHOLD,
  STALE_REPO_CUTOFF_DAYS,
  isReleaseExcluded,
} from "../config.js";

const DAY = 86_400_000;

const SWEEP = `
  query($org: String!, $cursor: String) {
    organization(login: $org) {
      repositories(
        first: 50
        after: $cursor
        isArchived: false
        orderBy: { field: PUSHED_AT, direction: DESC }
      ) {
        pageInfo { hasNextPage endCursor }
        nodes {
          name
          url
          pushedAt
          isFork
          # Default branch varies across this org — master vs main — so read
          # it rather than assuming.
          defaultBranchRef {
            name
            target { ... on Commit { oid committedDate } }
          }
          releases(first: 5, orderBy: { field: CREATED_AT, direction: DESC }) {
            nodes {
              tagName
              publishedAt
              url
              isDraft
              isPrerelease
              tagCommit { oid }
            }
          }
        }
      }
    }
  }
`;

/**
 * Commits probed for a pull request per request, newest first.
 *
 * Chunked with an early exit rather than asked all at once: a repo that just
 * merged something costs one small query, and only a repo with nothing but
 * direct pushes since its tag pays for the whole range.
 */
const PR_PROBE_CHUNK = 25;

async function hasPullRequestCommit(repo, shas) {
  for (let i = 0; i < shas.length; i += PR_PROBE_CHUNK) {
    const chunk = shas.slice(i, i + PR_PROBE_CHUNK);
    const fields = chunk
      .map(
        (sha, j) =>
          `c${j}: object(oid: "${sha}") { ... on Commit { associatedPullRequests(first: 1) { totalCount } } }`
      )
      .join("\n");

    const data = await graphql(
      `query($org: String!, $repo: String!) {
         repository(owner: $org, name: $repo) { ${fields} }
       }`,
      { org: ORG, repo }
    );

    const found = data.repository ?? {};
    if (chunk.some((_, j) => (found[`c${j}`]?.associatedPullRequests?.totalCount ?? 0) > 0)) {
      return true;
    }
  }
  return false;
}

export async function needsRelease() {
  const cutoff =
    STALE_REPO_CUTOFF_DAYS === null
      ? null
      : Date.now() - STALE_REPO_CUTOFF_DAYS * DAY;

  const candidates = [];
  let cursor = null;
  let scanned = 0;
  let excluded = 0;
  let hitStaleCutoff = false;

  // Stage 1 — sweep.
  while (!hitStaleCutoff) {
    const data = await graphql(SWEEP, { org: ORG, cursor });
    const page = data.organization?.repositories;
    if (!page) break;

    for (const repo of page.nodes) {
      scanned++;

      // Sorted by pushedAt desc, so the first stale repo means every repo
      // after it is stale too — stop sweeping entirely.
      if (cutoff && new Date(repo.pushedAt).getTime() < cutoff) {
        hitStaleCutoff = true;
        break;
      }

      // Checked before the stage-2 compare call, so an excluded repo costs
      // nothing beyond the sweep it was already part of.
      if (isReleaseExcluded(repo.name)) {
        excluded++;
        continue;
      }

      const head = repo.defaultBranchRef?.target;
      if (!head) continue; // empty repo

      // Newest non-draft release. Prereleases count as releases — a repo that
      // just cut an rc isn't "needing a release".
      const release = repo.releases.nodes.find((r) => !r.isDraft);
      if (!release?.tagCommit) continue; // no releases → not our problem

      if (release.tagCommit.oid === head.oid) continue; // up to date

      candidates.push({
        repo: repo.name,
        repoUrl: repo.url,
        isFork: repo.isFork,
        defaultBranch: repo.defaultBranchRef.name,
        headSha: head.oid,
        lastCommitAt: head.committedDate,
        tagName: release.tagName,
        tagSha: release.tagCommit.oid,
        releaseUrl: release.url,
        releasedAt: release.publishedAt,
        isPrerelease: release.isPrerelease,
      });
    }

    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }

  console.log(
    `  swept ${scanned} repos, ${candidates.length} ahead of their last release` +
      (excluded ? ` (${excluded} skipped by RELEASE_EXCLUDED_REPOS)` : "")
  );

  // Stage 2 — exact commit counts for candidates only.
  const results = [];
  let noPr = 0;
  for (const c of candidates) {
    let ahead = null;
    let shas = [];
    try {
      const cmp = await rest(
        `/repos/${ORG}/${c.repo}/compare/${c.tagSha}...${c.headSha}`
      );
      ahead = cmp.ahead_by;
      shas = (cmp.commits ?? []).map((x) => x.sha).reverse();
    } catch (err) {
      // A force-push or deleted tag can orphan the base commit. Keep the repo
      // in the list flagged rather than dropping it silently.
      console.warn(`  compare failed for ${c.repo}: ${err.message.split("\n")[0]}`);
    }

    if (ahead !== null && ahead < RELEASE_COMMIT_THRESHOLD) continue;

    // Stage 3. No commit list means the compare failed, and a repo we couldn't
    // read stays flagged rather than being filtered out on a guess.
    if (shas.length && !(await hasPullRequestCommit(c.repo, shas))) {
      noPr++;
      continue;
    }

    results.push({
      ...c,
      commitsAhead: ahead,
      daysSinceRelease: Math.floor((Date.now() - new Date(c.releasedAt)) / DAY),
    });
  }

  if (noPr) {
    console.log(`  ${noPr} dropped — ahead, but nothing in the range came from a PR`);
  }

  return results.sort((a, b) => (b.commitsAhead ?? 0) - (a.commitsAhead ?? 0));
}
