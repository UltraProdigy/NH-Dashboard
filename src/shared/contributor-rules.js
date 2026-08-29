/**
 * Rules that decide who counts as a contributor and over what periods.
 *
 * Dependency-free on purpose. The build imports it through `config.js`, the
 * panels import it directly, and the Worker bundles it — a Worker cannot pull
 * in anything that touches `node:fs` or resolves a token, which is what kept
 * these definitions from living in `config.js` alone.
 *
 * The point of one copy is that the two implementations of a panel cannot
 * disagree about who is a bot. They compute the same numbers in different
 * languages; if they also each decided that question, a login excluded in one
 * and counted in the other would show up as a leaderboard that contradicts its
 * own drilldown, with nothing to say which half was wrong.
 */

/**
 * `short` is for the segmented control on the drilldowns, `label` for prose
 * ("last 3 months") and table headers.
 *
 * All-time leads because it's the drilldowns' default and the answer you
 * usually want first about a single subject. Order here drives the control,
 * the dropdown, and the column order of the all-window comparison tables.
 */
export const WINDOWS = [
  { id: "all", label: "All time", short: "All", days: null },
  { id: "m1", label: "1 month", short: "1m", days: 30 },
  { id: "m3", label: "3 months", short: "3m", days: 90 },
  { id: "m6", label: "6 months", short: "6m", days: 180 },
  { id: "y1", label: "1 year", short: "1y", days: 365 },
  { id: "y2", label: "2 years", short: "2y", days: 730 },
  { id: "y5", label: "5 years", short: "5y", days: 1825 },
];

/**
 * Logins matching this are excluded from contributor stats.
 * GitHub Apps show up with a "[bot]" suffix; the rest are named explicitly.
 */
export const BOT_PATTERN =
  /(\[bot\]$|^dependabot|^github-actions|^renovate|^codecov|^mergify|^stale)/i;

/** A missing login is not a person either — deleted accounts land here. */
export const isBot = (login) => !login || BOT_PATTERN.test(login);

/**
 * Leaderboard order: activity descending, login ascending to break ties.
 *
 * The tiebreak is not decoration. 497 of the 1,214 people on this org share a
 * score of 1, and without it their order is whatever order they came out of the
 * store — so the bottom two-thirds of the leaderboard reshuffled on every
 * build, and the same person moved a hundred places because somebody else
 * opened a pull request.
 *
 * Compared with `<` rather than `localeCompare`, so that two runtimes in two
 * locales cannot disagree about the answer.
 */
export function byActivityThenLogin(a, b) {
  const diff = b.all.prs + b.all.approvals - (a.all.prs + a.all.approvals);
  if (diff !== 0) return diff;
  return a.login < b.login ? -1 : a.login > b.login ? 1 : 0;
}
