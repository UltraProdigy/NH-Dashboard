/**
 * Central config. Everything environment- or org-specific lives here so the
 * panel code stays portable when this moves into the GTNewHorizons org.
 */

import { execFileSync } from "node:child_process";

import { DEFAULT_ORG } from "./shared/analytics-rules.js";
import {
  compileRules,
  matchesAny,
  parseRepoList,
} from "./shared/repo-rules.js";

// The default lives in `shared/` because the Worker builds the same PR links
// and cannot read `process.env` — this file resolves tokens and shells out, so
// nothing bundled into a Worker can import it.
export const ORG = process.env.GITHUB_ORG || DEFAULT_ORG;

/**
 * Where the org's managed label set lives.
 *
 * Label-Sync-GTNH is the source of truth — it syncs this list out to every
 * repo in the org — so the dashboard reads it on each build rather than
 * keeping its own copy that would drift.
 */
export const LABEL_SOURCE = {
  owner: "GTNewHorizons",
  repo: "Label-Sync-GTNH",
  path: "config/labels.jsonc",
};

/**
 * Used only if Label-Sync-GTNH can't be read. Each label costs one search
 * request per build, so if the managed set grows large, cap it here.
 */
export const TRACKED_LABELS_FALLBACK = [
  "bug",
  "enhancement",
  "help wanted",
];

/**
 * Cap on how many labels get their own search query, to bound build cost.
 * Set to null for no limit.
 */
export const MAX_TRACKED_LABELS = 40;

/**
 * "Needs a release" tuning.
 *
 * Repos that auto-release on merge would otherwise flap in and out of this
 * panel constantly. Requiring N commits ahead of the last release tag cuts
 * most of that noise. Set to 1 to see everything.
 */
export const RELEASE_COMMIT_THRESHOLD = 1;

/**
 * Repos that never want a release, and so shouldn't clutter the panel.
 *
 * Some repos legitimately sit ahead of their last tag forever — the modpack
 * itself, anything released out-of-band, tooling that only tags on demand.
 * Listing them here is cheaper than explaining the same false positive to
 * every admin who looks at the dashboard.
 *
 * Entries are repo names without the org prefix. `*` and `?` wildcards work,
 * matching is case-insensitive, and a leading `!` re-includes something an
 * earlier pattern excluded:
 *
 *   "GT-New-Horizons-Modpack"   exact
 *   "*-Test"                    every repo ending in -Test
 *   "Horizon-*", "!Horizon-QA"  the whole prefix except that one
 *
 * NH_RELEASE_EXCLUDE=a,b in the environment adds to this list rather than
 * replacing it, so CI can suppress something without a commit.
 */
export const RELEASE_EXCLUDED_REPOS = [
  // "GT-New-Horizons-Modpack",
];

const releaseRules = compileRules([
  ...RELEASE_EXCLUDED_REPOS,
  ...(process.env.NH_RELEASE_EXCLUDE ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
]);

/** Later rules win, so a `!` entry can carve an exception out of a wildcard. */
export function isReleaseExcluded(repoName) {
  return matchesAny(releaseRules, repoName);
}

/**
 * Repos that never enter the store at all.
 *
 * Different in kind from RELEASE_EXCLUDED_REPOS above, which only suppresses a
 * repo from one panel. This one is applied at ingest, in two places per store:
 * the repo list is filtered before anything is walked, and `readStore` filters
 * again on the way out. So nothing about an excluded repo reaches data/ or the
 * deployed site, and a new panel that forgets to filter cannot leak them.
 *
 * The second layer is not redundancy. The list can grow after a repo is already
 * in the store, and re-walking all-time history to honour it costs an hour —
 * filtering on read makes the next build clean without one.
 *
 * This comment previously described all of that as fact while the exclusion was
 * wired into the traffic ingest alone, and 352 issues from an excluded repo
 * reached the public site. `npm run test:exclusion` now asserts every claim
 * made here, because a filter that is never called cannot fail on its own.
 *
 * Deliberately env-only, with nothing listed in committed source. For most
 * repos a name in a config file is harmless, but the existence of some private
 * repos is itself the sensitive part — writing one here would publish exactly
 * the fact the exclusion exists to hide. Set it in .env locally and as a repo
 * secret in CI. Same wildcard syntax as the release list.
 *
 * Losing traffic data for an excluded repo is permanent, unlike PRs and issues
 * which GitHub retains and a future private view could backfill.
 */
const ingestRules = compileRules(
  parseRepoList(process.env.NH_INGEST_EXCLUDE),
);

export function isIngestExcluded(repoName) {
  return matchesAny(ingestRules, repoName);
}



/**
 * "Dep updates" tuning.
 *
 * The panel estimates how long it's been since a repo's dependencies were
 * touched by finding the newest commit on its default branch that did *not*
 * arrive through a pull request. In this org almost nothing else is ever
 * pushed straight to the branch, and dependency bumps almost always are — so
 * "last direct commit" and "last dep update" are close enough to be useful and
 * far cheaper than reading every commit's file list, which GraphQL won't give
 * us without a REST call per commit.
 *
 * A year is the horizon: past that the answer stops being a number anybody
 * acts on, and every repo that ran out of history reads the same "≥ 1 yr"
 * rather than a floor that means something different per repo.
 */
export const DEP_UPDATE_LOOKBACK_DAYS = 365;

/**
 * Pages of 100 commits one repo may cost before we stop looking and report a
 * floor. Only bites on a repo whose last thousand commits all came from PRs.
 */
export const DEP_UPDATE_MAX_PAGES = 10;

/**
 * Skip direct commits made by bots when deciding what the last one was.
 *
 * Some repos have a workflow pushing generated files — translation syncs,
 * regenerated assets — straight to the default branch every night. Counting
 * those makes the repo read as freshly updated forever, which is the one
 * answer the panel exists to avoid. Off means any direct commit counts.
 */
export const DEP_UPDATE_IGNORE_BOTS = true;

/**
 * Drop repos whose last direct commit is newer than this many days.
 *
 * Zero keeps everything and lets the sort do the work — the card is ordered
 * oldest first, so recent repos are already at the bottom where nobody reads
 * them. Raise it only if the payload gets uncomfortable.
 */
export const DEP_UPDATE_MIN_DAYS = 0;

/**
 * How long an open issue has to sit untouched before Issue Analytics calls it
 * stale.
 *
 * Defined in `shared/issue-rules.js` and re-exported here, because this file
 * imports `node:child_process` and the drilldown fold that reads it has to be
 * importable by the Worker.
 */
export { ISSUE_STALE_DAYS } from "./shared/issue-rules.js";

/**
 * The repo whose labels the Label mix card opens on, and the only one that
 * gets per-label monthly trends.
 *
 * Labels are a per-tracker taxonomy, not an org-wide one — the modpack sorts
 * issues by mod across 174 `Mod:` labels, while a library repo has four. The
 * other repos' label counts are still there behind the picker; only the trend
 * series is scoped, because that is the part whose size scales with labels
 * times months.
 */
export const ISSUE_LABEL_REPO = "GT-New-Horizons-Modpack";

/**
 * Skip repos with no pushes in this many days when doing org-wide sweeps.
 * GTNH carries a lot of dormant forks; ignoring them makes the expensive
 * panels dramatically cheaper. Set to null to sweep everything.
 */
export const STALE_REPO_CUTOFF_DAYS = 365;

/** Cache TTL for API responses during local dev, in minutes. */
export const CACHE_TTL_MINUTES = 15;

/**
 * How many recent completed default-branch runs the CI health panel samples
 * per repo.
 *
 * One REST request per active repo regardless of this number, so raising it is
 * free in requests — it only widens the window the pass rate and median
 * duration are computed over. Above 100 the API starts paginating, which would
 * make it cost real requests.
 */
export const CI_RUN_SAMPLE = 20;

// Defined in shared/ because the Worker needs it too and cannot import this
// file — token resolution below reaches for node:fs. Re-exported rather than
// moved so existing importers keep working.
export { BOT_PATTERN } from "./shared/contributor-rules.js";

/**
 * Hard floor on contributors written to the dashboard data.
 *
 * Keep this at 0. The useful filtering happens in the browser, where it's a
 * slider you can move — filtering here instead would discard data before it
 * ever reaches the frontend, and you'd need a rebuild to change your mind.
 * Only raise it if the output file gets uncomfortably large.
 */
export const CONTRIBUTOR_MIN_ACTIVITY = 0;

let cachedToken = null;

/**
 * Resolve a GitHub token, in order of preference:
 *
 *   1. GITHUB_TOKEN env var — how CI supplies it (from an Actions secret),
 *      and how you'd supply it ad hoc: GITHUB_TOKEN=$(gh auth token) npm run build
 *   2. The GitHub CLI's stored credential — no token on disk, nothing to
 *      rotate, nothing to accidentally commit. Preferred for local dev.
 *   3. .env, loaded by --env-file-if-exists in package.json.
 *
 * Note that Actions' built-in secrets.GITHUB_TOKEN is scoped to *this* repo
 * only, so it cannot read GTNewHorizons org data — the scheduled build needs
 * a PAT stored as a repo secret regardless.
 */
export function getToken() {
  if (cachedToken) return cachedToken;

  if (process.env.GITHUB_TOKEN) {
    cachedToken = process.env.GITHUB_TOKEN;
    return cachedToken;
  }

  // Fall back to the gh CLI if it's installed and authenticated.
  try {
    const out = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out) {
      cachedToken = out;
      return cachedToken;
    }
  } catch {
    /* gh not installed, or not logged in — fall through to the error below */
  }

  throw new Error(
    "No GitHub token available. Pick one:\n" +
      "  a) gh auth login                       (recommended — no token on disk)\n" +
      "  b) GITHUB_TOKEN=ghp_... npm run build  (one-off)\n" +
      "  c) cp .env.example .env, then edit it  (persistent, gitignored)\n" +
      "Without a token you get 60 requests/hour instead of 5000."
  );
}
