/**
 * "Repos with commits since their last release."
 *
 * Two-stage to keep it cheap across 1400+ repos:
 *
 *   1. One GraphQL sweep pulls every repo's default-branch HEAD SHA and its
 *      most recent release's tag SHA, 50 repos per request (~30 requests total
 *      for the whole org). Repos with no releases drop out here for free —
 *      exactly the filter we wanted.
 *
 *   2. Only where those two SHAs differ do we spend a REST `compare` call to
 *      get the exact commit count. That's the expensive part, and it only runs
 *      on genuine candidates.
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
  for (const c of candidates) {
    let ahead = null;
    try {
      const cmp = await rest(
        `/repos/${ORG}/${c.repo}/compare/${c.tagSha}...${c.headSha}`
      );
      ahead = cmp.ahead_by;
    } catch (err) {
      // A force-push or deleted tag can orphan the base commit. Keep the repo
      // in the list flagged rather than dropping it silently.
      console.warn(`  compare failed for ${c.repo}: ${err.message.split("\n")[0]}`);
    }

    if (ahead !== null && ahead < RELEASE_COMMIT_THRESHOLD) continue;

    results.push({
      ...c,
      commitsAhead: ahead,
      daysSinceRelease: Math.floor((Date.now() - new Date(c.releasedAt)) / DAY),
    });
  }

  return results.sort((a, b) => (b.commitsAhead ?? 0) - (a.commitsAhead ?? 0));
}
