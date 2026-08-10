/**
 * Default-branch CI health, from the Actions API.
 *
 * This is the one panel that reaches for data the ingest store can't hold —
 * everything else in the drilldowns is derived from PRs and reviews. Workflow
 * runs aren't attached to pull requests in any way the ingest walks, so the
 * only way to answer "is this repo's CI green, and how flaky is it" is to ask.
 *
 * Two stages, same shape as needsRelease:
 *
 *   1. A GraphQL sweep for repo names and default branches, 50 per request,
 *      stopping at the staleness cutoff. Dormant repos never cost anything.
 *   2. One REST call per surviving repo for its most recent completed runs.
 *
 * Stage 2 is the whole cost: one request per active repo. Repos with no
 * workflows return an empty list and drop out.
 */

import { graphql, rest } from "../github/client.js";
import { CI_RUN_SAMPLE, ORG, STALE_REPO_CUTOFF_DAYS } from "../config.js";

const DAY = 86_400_000;
const MINUTE = 60_000;

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
          pushedAt
          defaultBranchRef { name }
        }
      }
    }
  }
`;

/**
 * Conclusions that represent a real pass/fail verdict.
 *
 * `cancelled`, `skipped` and `action_required` say something about the humans,
 * not the code — counting them as failures would make every repo where someone
 * cancels a slow run look broken.
 */
const PASS = new Set(["success"]);
const FAIL = new Set(["failure", "timed_out", "startup_failure"]);

const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * Reduce a repo's recent runs to the numbers the Health tab shows.
 *
 * Pure and exported so the arithmetic can be tested against fixtures without
 * a token or a network.
 */
export function summarizeRuns(runs) {
  // The API returns newest first; don't rely on it, since one out-of-order
  // response would silently mislabel "latest".
  const ordered = [...runs].sort(
    (a, b) => new Date(b.run_started_at ?? b.created_at) - new Date(a.run_started_at ?? a.created_at)
  );

  const decisive = ordered.filter(
    (r) => PASS.has(r.conclusion) || FAIL.has(r.conclusion)
  );

  const durations = ordered
    .map((r) => {
      const start = new Date(r.run_started_at ?? r.created_at).getTime();
      const end = new Date(r.updated_at).getTime();
      const mins = (end - start) / MINUTE;
      return Number.isFinite(mins) && mins >= 0 ? mins : null;
    })
    .filter((m) => m != null);

  const latest = ordered[0] ?? null;
  const passes = decisive.filter((r) => PASS.has(r.conclusion)).length;

  return {
    // What the badge shows. Null when the only runs were cancelled/skipped.
    latest: latest
      ? {
          conclusion: latest.conclusion,
          at: latest.updated_at ?? latest.created_at,
          url: latest.html_url,
          workflow: latest.name ?? null,
        }
      : null,
    runs: ordered.length,
    decisive: decisive.length,
    failures: decisive.length - passes,
    // Null rather than 0 when nothing was decisive — "no verdict" and "all
    // red" are very different and shouldn't render the same.
    passRate: decisive.length ? passes / decisive.length : null,
    medianMinutes: round1(median(durations)),

    /* ---- how much Actions time this repo is spending ----
       Wall-clock, summed across the sampled runs. This is deliberately *not*
       GitHub's billable minutes, and the frontend says so:

       - Billable minutes are per *job*, and a matrix of eight jobs running in
         parallel bills eight times what the run took on the clock.
       - macOS bills 10x and Windows 2x, which a duration can't know about.
       - The only endpoint that gives the real number is
         /actions/runs/{id}/timing, which is one request per run — ~20 per
         active repo, or roughly 4,000 per build on top of what this panel
         already costs. That would dominate the rate-limit budget for a figure
         nobody is going to reconcile against an invoice.

       Summed over a known run count it's still the useful comparison: it says
       which repos are the expensive ones, which is the question being asked.

       `timedRuns` rather than `runs` as the denominator, because a run missing
       a usable timestamp contributes nothing to the total and would otherwise
       drag the average down. */
    totalMinutes: durations.length
      ? round1(durations.reduce((n, m) => n + m, 0))
      : null,
    timedRuns: durations.length,
  };
}

export async function ciHealth() {
  const cutoff =
    STALE_REPO_CUTOFF_DAYS === null ? null : Date.now() - STALE_REPO_CUTOFF_DAYS * DAY;

  // Stage 1 — sweep.
  const active = [];
  let cursor = null;
  let hitStaleCutoff = false;

  while (!hitStaleCutoff) {
    const data = await graphql(SWEEP, { org: ORG, cursor });
    const page = data.organization?.repositories;
    if (!page) break;

    for (const repo of page.nodes) {
      // Sorted by pushedAt desc, so the first stale repo means the rest are
      // stale too.
      if (cutoff && new Date(repo.pushedAt).getTime() < cutoff) {
        hitStaleCutoff = true;
        break;
      }
      if (!repo.defaultBranchRef) continue; // empty repo
      active.push({ repo: repo.name, branch: repo.defaultBranchRef.name });
    }

    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }

  // Stage 2 — recent completed runs per repo.
  const out = {};
  let withCI = 0;
  let failed = 0;

  for (const { repo, branch } of active) {
    try {
      const body = await rest(
        `/repos/${ORG}/${repo}/actions/runs` +
          `?branch=${encodeURIComponent(branch)}` +
          `&status=completed&per_page=${CI_RUN_SAMPLE}&exclude_pull_requests=true`
      );

      const runs = body.workflow_runs ?? [];
      if (!runs.length) continue; // no Actions here, or none on this branch

      withCI++;
      out[repo] = { repo, defaultBranch: branch, ...summarizeRuns(runs) };
    } catch (err) {
      // A repo with Actions disabled 404s, which is normal and not worth a
      // line of output. Anything else is worth knowing about.
      if (!/\b404\b/.test(err.message)) {
        failed++;
        console.warn(`  ${repo}: ${err.message.split("\n")[0]}`);
      }
    }
  }

  console.log(
    `  ${active.length} active repos, ${withCI} with runs on their default branch` +
      (failed ? `, ${failed} errored` : "")
  );

  return out;
}
