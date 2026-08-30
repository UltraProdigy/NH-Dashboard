/**
 * What a commit means to the release cards, in both languages.
 *
 * `needsRelease` and `depUpdates` rest on one question — did this commit arrive
 * through a pull request — and they read the answer in opposite directions.
 * `needsRelease` wants at least one commit that did; `depUpdates` wants the
 * newest one that did not. A rule that disagrees with itself across the two
 * implementations moves both cards, in opposite directions, from one cause.
 *
 * The GraphQL build reads `associatedPullRequests.totalCount`, which is
 * GitHub's own answer. **The webhook cannot.** A `push` payload's commits carry
 * exactly `id, tree_id, distinct, message, timestamp, url, author, committer,
 * added, removed, modified` — there is no pull-request field, and no amount of
 * reading the payload differently produces one. The earlier handoff claimed
 * otherwise and both panels were scoped on that claim.
 *
 * So the two sources answer with different confidence, and the schema says so:
 * `commits.via_pr` is 0 or 1 when the build wrote it and NULL when a delivery
 * did. NULL is resolved at read time against `pull_requests.merge_commit_sha`,
 * which the `pull_request` payload does carry. That match is exact for squash
 * merges and for merge commits, and misses a rebase merge's commits, which
 * GitHub replays under fresh SHAs that no PR row names.
 *
 * The residual error is one-directional and worth stating plainly, because it
 * is the failure the reader will meet: a PR commit that the fallback misses
 * looks *direct*. On `depUpdates` that makes a repo read younger than it is —
 * staleness hidden, not invented. On `needsRelease` it can only add a repo that
 * should not be there, never drop one that should. The daily build overwrites
 * NULL with the real answer on its next pass, so the error is also temporary.
 *
 * Dependency-free, because a Worker bundles it.
 */

import { isBot, isBotSql } from "./contributor-rules.js";

/**
 * Timestamps, normalised to the form every comparison in this store assumes.
 *
 * A push payload's commit timestamp carries the committer's offset —
 * `2026-08-30T12:34:56+02:00` — while everything already in D1 is Z-normalised
 * whole seconds. Mixing the two silently breaks the one property the queries
 * are built on: that lexical order is chronological order. `+02:00` sorts
 * before `Z`, so an unnormalised commit sinks below every commit that shares
 * its date and `MAX(committed_at)` stops meaning "newest".
 *
 * Milliseconds are dropped rather than kept for the same reason `isoBound`
 * exists — fixed width is what makes a string compare legal, and a value with
 * milliseconds and one without do not compare as their instants do.
 */
export const utcSeconds = (value) => {
  if (value === null || value === undefined) return null;
  const ms =
    typeof value === "number"
      ? value
      : value instanceof Date
        ? value.getTime()
        : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
};

/** The build's reading: GitHub answered directly. */
export const viaPullRequest = (commit) =>
  (commit?.associatedPullRequests?.totalCount ?? 0) > 0;

/**
 * The store's reading, as SQL over a `commits` row aliased `c` and a
 * `pull_requests` row aliased `p`.
 *
 * Written as a LEFT JOIN test rather than a correlated EXISTS on purpose: both
 * panels already need the join for other columns, and a second lookup per
 * commit is the kind of cost that only shows up on D1, at 2.2× the local
 * replica, after a deploy.
 */
export const viaPullRequestSql = (commit = "c", pr = "p") =>
  `COALESCE(${commit}.via_pr, CASE WHEN ${pr}.number IS NOT NULL THEN 1 ELSE 0 END)`;

/**
 * A commit that did not come through a pull request and was not a bot pushing
 * generated files — `depUpdates`' definition of a dependency bump.
 *
 * The bot half is `isBot`'s, not a second copy: a login is a login whether it
 * authored a commit or a pull request, and the contributor parity test already
 * runs both readings of it over every author in the seed.
 */
export const isDirectCommit = (commit, { ignoreBots = true } = {}) => {
  if (viaPullRequest(commit)) return false;
  return ignoreBots ? !isBot(commitAuthor(commit)) : true;
};

export const isDirectCommitSql = (
  { commit = "c", pr = "p", ignoreBots = true } = {},
) => {
  const direct = `${viaPullRequestSql(commit, pr)} = 0`;
  return ignoreBots ? `(${direct} AND NOT ${isBotSql(`${commit}.author`)})` : `(${direct})`;
};

/**
 * The login to credit a commit to.
 *
 * GraphQL nests it under `author.user.login` and falls back to the raw git
 * `author.name`, which is not a GitHub account and can be anything. A push
 * payload spells the account `author.username` instead. Both shapes land here
 * so the column holds one kind of value.
 */
export function commitAuthor(commit) {
  return (
    commit?.author?.user?.login ??
    commit?.author?.username ??
    commit?.author?.name ??
    null
  );
}

/** The first line of a commit message. GraphQL calls this `messageHeadline`. */
export const headline = (message) =>
  (message ?? "").split("\n", 1)[0].trim() || null;
