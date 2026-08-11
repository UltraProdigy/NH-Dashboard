/**
 * "Most grossing" — the PRs that drew the most reaction.
 *
 * Comments, 👍 and 👎 answer a different question from every other number in
 * this dashboard: not how much work happened, but what the org actually argued
 * about, liked, or hated. The repo drilldown carries three short lists of its
 * own and General Analytics carries an org-wide version, so the ranking lives
 * here rather than in either panel — both would otherwise own half of it, and
 * analytics importing it from the drilldown panel makes a needless import cycle
 * out of forty lines of sorting.
 *
 * All-time rather than per-window, in both places. A window-keyed top 5 across
 * three kinds and seven windows is 105 rows per repo — with titles attached
 * that's about 9 MB across 1,400 repos, to slice a list whose whole appeal is
 * that it's the hall of fame. Windowing would also leave the 1-month view as
 * three empty boxes on most repos, since the median PR draws no reaction at all.
 */

export const GROSSING_N = 5;

/** Only PRs that drew *something* are worth carrying to the sort. */
export const hasEngagement = (pr) =>
  (pr.comments ?? 0) > 0 || (pr.thumbsUp ?? 0) > 0 || (pr.thumbsDown ?? 0) > 0;

/**
 * Top `n` by one engagement field, dropping zeroes.
 *
 * A list padded out to five with 0-comment PRs claims a ranking that isn't
 * there — a repo where nothing was ever discussed should show an empty box and
 * say so. Ties break on PR number so the output is deterministic across builds
 * rather than reordering with whatever the store happened to yield first.
 */
export function topGrossing(entries, field, n = GROSSING_N) {
  return entries
    .filter((e) => (e[field] ?? 0) > 0)
    .sort((a, b) => b[field] - a[field] || b.number - a.number)
    .slice(0, n)
    .map((e) => ({
      ...(e.repo ? { repo: e.repo } : {}),
      number: e.number,
      title: e.title ?? "",
      author: e.author ?? null,
      count: e[field],
    }));
}

export const grossingLists = (entries, n = GROSSING_N) => ({
  commented: topGrossing(entries, "comments", n),
  liked: topGrossing(entries, "thumbsUp", n),
  disliked: topGrossing(entries, "thumbsDown", n),
});
