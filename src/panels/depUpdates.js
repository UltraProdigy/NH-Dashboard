/**
 * "How long since this repo's dependencies were touched", estimated.
 *
 * There is no cheap way to ask GitHub what a commit changed. GraphQL gives a
 * changed-file *count* and no names, so a real answer — did this commit touch
 * dependencies.gradle — costs one REST call per commit, which across a few
 * hundred repos is thousands of requests. This panel takes a proxy instead.
 *
 * In this org practically everything arrives as a pull request, and the things
 * that don't are almost always a maintainer bumping a dependency or a
 * buildscript straight on the default branch. So the newest commit with no
 * pull request attached to it is a decent stand-in for the newest dep update.
 * It is an estimate and the card says so: a repo where somebody pushed a typo
 * fix directly will read younger than it is.
 *
 * Cost is one GraphQL request per REPOS_PER_SWEEP repos, plus one more for
 * each repo whose first page of history was entirely pull requests. Most repos
 * resolve on the sweep, because a direct commit is usually only a few commits
 * back or isn't there at all.
 */

import { graphql } from "../github/client.js";
import {
  BOT_PATTERN,
  DEP_UPDATE_IGNORE_BOTS,
  DEP_UPDATE_LOOKBACK_DAYS,
  DEP_UPDATE_MAX_PAGES,
  DEP_UPDATE_MIN_DAYS,
  ORG,
  STALE_REPO_CUTOFF_DAYS,
} from "../config.js";

const DAY = 86_400_000;

/** Commits per history page. 100 is the connection's ceiling. */
const PAGE = 100;

/**
 * Repos per sweep request. Ten rather than the fifty the release sweep uses:
 * each node here drags a hundred commits and their pull-request connections
 * behind it, and a query that asks for too much at once gets timed out by the
 * API rather than rate-limited, which no amount of backing off fixes.
 */
const REPOS_PER_SWEEP = 10;

const COMMIT_FIELDS = `
  oid
  committedDate
  messageHeadline
  url
  author { user { login } name }
  associatedPullRequests(first: 1) { totalCount }
`;

const SWEEP = `
  query($org: String!, $cursor: String, $since: GitTimestamp!) {
    organization(login: $org) {
      repositories(
        first: ${REPOS_PER_SWEEP}
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
          defaultBranchRef {
            name
            target {
              ... on Commit {
                history(first: ${PAGE}, since: $since) {
                  pageInfo { hasNextPage endCursor }
                  nodes { ${COMMIT_FIELDS} }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const MORE = `
  query($org: String!, $repo: String!, $cursor: String!, $since: GitTimestamp!) {
    repository(owner: $org, name: $repo) {
      defaultBranchRef {
        target {
          ... on Commit {
            history(first: ${PAGE}, after: $cursor, since: $since) {
              pageInfo { hasNextPage endCursor }
              nodes { ${COMMIT_FIELDS} }
            }
          }
        }
      }
    }
  }
`;

const authorOf = (c) => c.author?.user?.login ?? c.author?.name ?? null;

/**
 * A commit that didn't come through a pull request, and wasn't a bot pushing
 * generated files. History arrives newest first, so the first hit is the one.
 */
function firstDirect(nodes) {
  return nodes.find((c) => {
    if ((c.associatedPullRequests?.totalCount ?? 0) > 0) return false;
    if (!DEP_UPDATE_IGNORE_BOTS) return true;
    return !BOT_PATTERN.test(authorOf(c) ?? "");
  });
}

const daysAgo = (iso) => Math.floor((Date.now() - new Date(iso)) / DAY);

/**
 * A repo we ran out of history on. `exhausted` means we reached the lookback
 * horizon and genuinely know nothing direct happened inside it; otherwise we
 * stopped early and the floor is however far back we got.
 */
function floorRow(repo, { exhausted, oldest }) {
  return {
    ...repo,
    sha: null,
    commitUrl: null,
    committedAt: null,
    author: null,
    message: null,
    approx: true,
    daysSinceDirect:
      exhausted || !oldest ? DEP_UPDATE_LOOKBACK_DAYS : daysAgo(oldest),
  };
}

function foundRow(repo, commit) {
  return {
    ...repo,
    sha: commit.oid.slice(0, 7),
    commitUrl: commit.url,
    committedAt: commit.committedDate,
    author: authorOf(commit),
    message: commit.messageHeadline,
    approx: false,
    daysSinceDirect: daysAgo(commit.committedDate),
  };
}

export async function depUpdates() {
  const since = new Date(Date.now() - DEP_UPDATE_LOOKBACK_DAYS * DAY).toISOString();
  const cutoff =
    STALE_REPO_CUTOFF_DAYS === null ? null : Date.now() - STALE_REPO_CUTOFF_DAYS * DAY;

  const rows = [];
  const pending = [];
  let cursor = null;
  let scanned = 0;
  let hitStaleCutoff = false;

  while (!hitStaleCutoff) {
    const data = await graphql(SWEEP, { org: ORG, cursor, since });
    const page = data.organization?.repositories;
    if (!page) break;

    for (const node of page.nodes) {
      scanned++;

      // Sorted by pushedAt desc, so the first stale repo means every repo after
      // it is stale too. They're dormant, and "nobody has updated this in two
      // years" is not news about a repo nobody has touched in two years.
      if (cutoff && new Date(node.pushedAt).getTime() < cutoff) {
        hitStaleCutoff = true;
        break;
      }

      const history = node.defaultBranchRef?.target?.history;
      if (!history) continue; // empty repo, or a default branch we can't read

      const repo = {
        repo: node.name,
        repoUrl: node.url,
        isFork: node.isFork,
        defaultBranch: node.defaultBranchRef.name,
      };

      const hit = firstDirect(history.nodes);
      if (hit) {
        rows.push(foundRow(repo, hit));
        continue;
      }

      const oldest = history.nodes.at(-1)?.committedDate ?? null;
      if (!history.pageInfo.hasNextPage) {
        rows.push(floorRow(repo, { exhausted: true, oldest }));
        continue;
      }
      // Every commit on the first page came from a PR and there's more year
      // left — this one costs its own requests.
      pending.push({ repo, cursor: history.pageInfo.endCursor, oldest });
    }

    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }

  console.log(
    `  swept ${scanned} repos, ${rows.length} answered on the first page` +
      (pending.length ? `, ${pending.length} needing a deeper walk` : "")
  );

  let deepRequests = 0;
  for (const item of pending) {
    let { cursor: at, oldest } = item;
    let hit = null;
    let exhausted = false;

    for (let page = 1; page < DEP_UPDATE_MAX_PAGES && !hit; page++) {
      const data = await graphql(MORE, {
        org: ORG,
        repo: item.repo.repo,
        cursor: at,
        since,
      });
      deepRequests++;
      const history = data.repository?.defaultBranchRef?.target?.history;
      if (!history) break;

      hit = firstDirect(history.nodes);
      oldest = history.nodes.at(-1)?.committedDate ?? oldest;
      if (!history.pageInfo.hasNextPage) {
        exhausted = true;
        break;
      }
      at = history.pageInfo.endCursor;
    }

    rows.push(hit ? foundRow(item.repo, hit) : floorRow(item.repo, { exhausted, oldest }));
  }

  if (deepRequests)
    console.log(
      `  ${deepRequests} extra request${deepRequests === 1 ? "" : "s"} walking deeper history`
    );

  const kept = rows.filter((r) => r.daysSinceDirect >= DEP_UPDATE_MIN_DAYS);

  // Oldest first, which is the only order this card is ever read in. Repos
  // sitting on the same floor tie, so the least recently pushed goes first —
  // among things we can't date exactly, quietest is the better guess at worst.
  return kept.sort(
    (a, b) =>
      b.daysSinceDirect - a.daysSinceDirect ||
      Number(b.approx) - Number(a.approx) ||
      a.repo.localeCompare(b.repo)
  );
}
