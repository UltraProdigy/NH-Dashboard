/**
 * Central config. Everything environment- or org-specific lives here so the
 * panel code stays portable when this moves into the GTNewHorizons org.
 */

import { execFileSync } from "node:child_process";

export const ORG = process.env.GITHUB_ORG || "GTNewHorizons";

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
 * Skip repos with no pushes in this many days when doing org-wide sweeps.
 * GTNH carries a lot of dormant forks; ignoring them makes the expensive
 * panels dramatically cheaper. Set to null to sweep everything.
 */
export const STALE_REPO_CUTOFF_DAYS = 365;

/** Cache TTL for API responses during local dev, in minutes. */
export const CACHE_TTL_MINUTES = 15;

/**
 * Logins matching this are excluded from contributor stats.
 * GitHub Apps show up with a "[bot]" suffix; the rest are named explicitly.
 */
export const BOT_PATTERN =
  /(\[bot\]$|^dependabot|^github-actions|^renovate|^codecov|^mergify|^stale)/i;

/**
 * Hide contributors with fewer than this many total PRs + approvals all-time.
 * Set to 0 to show everyone, including one-time drive-by contributors.
 */
export const CONTRIBUTOR_MIN_ACTIVITY = 3;

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
