/**
 * What a workflow run means to the CI card, in both languages.
 *
 * Three questions decide every number on this panel: did the run reach a
 * verdict, was that verdict a pass, and how long did it take. The first two are
 * a set membership test and translate directly. The third does not, and it is
 * the reason this file exists.
 *
 * Dependency-free apart from `round1`, because a Worker bundles it.
 */

import { round1 } from "./analytics-rules.js";

/**
 * Conclusions that represent a real pass/fail verdict.
 *
 * `cancelled`, `skipped` and `action_required` say something about the humans,
 * not the code — counting them as failures would make every repo where someone
 * cancels a slow run look broken.
 */
export const PASS = new Set(["success"]);
export const FAIL = new Set(["failure", "timed_out", "startup_failure"]);

const quoted = (set) => [...set].map((c) => `'${c}'`).join(", ");

export const isPass = (run) => PASS.has(run?.conclusion);
export const isDecisive = (run) =>
  PASS.has(run?.conclusion) || FAIL.has(run?.conclusion);

export const isPassSql = (run = "r") => `${run}.conclusion IN (${quoted(PASS)})`;
export const isDecisiveSql = (run = "r") =>
  `${run}.conclusion IN (${quoted(new Set([...PASS, ...FAIL]))})`;

/**
 * Longest run duration that can be believed, in minutes.
 *
 * A run's length has to be inferred as `updated_at - run_started_at`. The runs
 * endpoint carries no end timestamp, and the only one that does is
 * `/actions/runs/{id}/timing` at one request per run — roughly 5,000 a build,
 * which would cost more than every other panel combined.
 *
 * That inference is sound for a recent run and worthless for an old one,
 * because **GitHub bumps `updated_at` long after a run finishes** — log expiry,
 * artifact cleanup, one job re-run. The row then reads as having taken however
 * long ago it started.
 *
 * This is not a rounding error, and it was the largest number on the dashboard.
 * Three EnderStorage runs started in July 2025 carry an `updated_at` in August
 * 2026 and read as ~580,000 minutes each against a real duration of about five;
 * those three alone were 99.99% of that repo's reported Actions time. Org-wide
 * the panel claimed 22.6 million sampled minutes and ~33,654 wall-clock hours a
 * month, essentially all of it this artefact rather than CI anyone ran.
 *
 * The ceiling is 360 because that is GitHub's own per-job execution limit, and
 * because a sample of 201 runs across 14 repos puts it inside an empty band
 * rather than through a distribution:
 *
 *     longest believable duration measured      44.5 minutes
 *     shortest unbelievable one              1,440 minutes
 *
 * Nothing at all falls between the two, so this can move a long way in either
 * direction without changing a single verdict. The 1,440 cluster is its own
 * tell: it is exactly 24 hours, the point at which GitHub terminates a job that
 * has sat queued, so those runs are measuring queue time rather than compute
 * and do not belong in the total under any ceiling.
 *
 * **Over the ceiling the duration is discarded, not clamped.** A clamp invents
 * a number and hides that it did. Dropping leaves the run counted in `runs` and
 * absent from `timedRuns`, which is a denominator the panel already reports and
 * already handles being smaller than the sample.
 *
 * Measured org-wide on the first corrected build: **53 of 3,156 sampled runs
 * discarded, 1.7%, across 29 of 252 repos, and no repo lost all of its
 * durations.** Those 53 runs carried 22,619,370 of the 22,630,939 minutes the
 * panel used to report — 99.95% of the total from 1.7% of the runs, which is
 * the shape of the whole problem in one line.
 *
 * The failure direction is worth naming because it is the opposite of every
 * other defect this port has produced. Those all made the org look healthier
 * than it was; this one made it look busier and more expensive. Both are the
 * same underlying fault — a number nobody could check from the panel's own
 * output — which is the argument for the second implementation rather than for
 * any particular direction of error.
 */
export const CI_MAX_RUN_MINUTES = 360;

/** When a run started. `run_started_at` is absent on very old runs. */
export const runStart = (run) => run?.run_started_at ?? run?.created_at ?? null;

/**
 * A run's length in minutes, or null when it cannot be believed.
 *
 * Null covers three cases the caller must not tell apart: a missing timestamp,
 * a negative span, and one over the ceiling above. All three mean "this run
 * contributes no time", and `timedRuns` is what records how often that happened.
 */
export function runMinutes(run) {
  const start = Date.parse(runStart(run));
  const end = Date.parse(run?.updated_at);
  const mins = (end - start) / 60_000;
  if (!Number.isFinite(mins) || mins < 0) return null;
  return mins > CI_MAX_RUN_MINUTES ? null : mins;
}

/**
 * The same reading as SQL over a `workflow_runs` row.
 *
 * `strftime` is used here where the rest of this repo refuses it, and the
 * distinction is worth keeping straight: elsewhere it appears in *window
 * comparisons*, where a string compare answers the same question for a sixth of
 * the cost and a missing CAST makes the comparison constant rather than merely
 * slow. A duration is arithmetic on two timestamps, which a string compare
 * cannot do at all.
 *
 * The CAST is still mandatory. `strftime('%s', …)` returns TEXT, SQLite orders
 * every TEXT value above every number, and an uncast subtraction would coerce
 * in ways that depend on the values. The cost is bounded by the sample rather
 * than the table: 20 rows per repo, ~5,000 in total, against the 29,091 rows
 * that made this expensive in `analytics`.
 */
export const runMinutesSql = (run = "r") => `
  CASE
    WHEN ${run}.run_started_at IS NULL OR ${run}.updated_at IS NULL THEN NULL
    WHEN (CAST(strftime('%s', ${run}.updated_at) AS INTEGER)
          - CAST(strftime('%s', ${run}.run_started_at) AS INTEGER)) < 0 THEN NULL
    WHEN (CAST(strftime('%s', ${run}.updated_at) AS INTEGER)
          - CAST(strftime('%s', ${run}.run_started_at) AS INTEGER)) > ${CI_MAX_RUN_MINUTES * 60}
      THEN NULL
    ELSE (CAST(strftime('%s', ${run}.updated_at) AS INTEGER)
          - CAST(strftime('%s', ${run}.run_started_at) AS INTEGER)) / 60.0
  END`;

/** Median of a list of numbers, upper of the two on an even count. */
export function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * Days between two run timestamps, or null if that is not a usable width.
 *
 * Split out from `spanDays` because the two implementations reach it from
 * opposite directions: the build has the whole ordered sample in hand, while
 * the store knows only `MIN` and `MAX`. Both end at the same arithmetic, and
 * one copy of it is the point.
 */
export function spanBetween(oldest, newest) {
  const span = (Date.parse(newest) - Date.parse(oldest)) / 86_400_000;
  return Number.isFinite(span) && span > 0 ? round1(span) : null;
}

/**
 * Days between the oldest and newest run in a sample, or null if it has no
 * width.
 *
 * The sample is "the last N completed runs", so the span it covers is not a
 * fixed period — a busy repo's 20 runs might be two days and a quiet one's two
 * years. Recording the span is what lets the org-wide estimate turn a sample
 * into a rate.
 *
 * Null on a single run: one timestamp has no span, and dividing by zero days
 * would report an infinite rate for the least active repos in the org. The
 * store's reading has to reproduce that explicitly — `MAX - MIN` over one row
 * is 0, not null, and 0 is the value that divides.
 */
export function spanDays(ordered) {
  if (ordered.length < 2) return null;
  return spanBetween(runStart(ordered[ordered.length - 1]), runStart(ordered[0]));
}

/**
 * Project the sampled runs onto the whole org, per 30 days.
 *
 * Nothing here costs a request: every repo's sample was already fetched for the
 * pass rate and the median duration. Each repo contributes a rate — runs in the
 * sample divided by the days that sample covers — and the org figure is the sum
 * of those rates over a 30-day month.
 *
 * The honest caveats, which the panel repeats rather than hiding:
 *
 *   - It's an *estimate from a recent sample*. A repo that ran CI hard last
 *     week and has been quiet since projects a month that won't happen.
 *   - Only default-branch runs are sampled, which is what leaves PR-triggered
 *     runs out. On most repos those are the majority of all CI activity, so
 *     this is a floor, not a total. (`exclude_pull_requests=true` does *not*
 *     do this, whatever its name suggests: measured against the API it returns
 *     a byte-identical set of runs and merely empties each one's
 *     `pull_requests` array. The branch filter is the whole of the exclusion.)
 *   - Minutes are wall-clock, not GitHub's billable minutes — a matrix of
 *     eight parallel jobs bills roughly eight times what it took on the clock,
 *     and macOS bills 10x. See the note on `totalMinutes` above.
 *   - There is no job count anywhere in this data. `/actions/runs` returns
 *     runs, not jobs; jobs need one more request per run (~1,500 a build), so
 *     the panel reports runs and says plainly that it can't report jobs.
 */
export function summarizeOrg(perRepo) {
  const repos = Object.values(perRepo);

  let runsPerMonth = 0;
  let minutesPerMonth = 0;
  let projected = 0; // repos whose sample had enough width to extrapolate from

  let sampledRuns = 0;
  let sampledMinutes = 0;
  let decisive = 0;
  let passes = 0;

  for (const r of repos) {
    sampledRuns += r.runs;
    sampledMinutes += r.totalMinutes ?? 0;
    decisive += r.decisive;
    passes += r.decisive - r.failures;

    if (!r.sampleSpanDays || !r.timedRuns) continue;
    const perDay = r.runs / r.sampleSpanDays;
    const meanMinutes = (r.totalMinutes ?? 0) / r.timedRuns;
    runsPerMonth += perDay * 30;
    minutesPerMonth += perDay * 30 * meanMinutes;
    projected++;
  }

  return {
    repos: repos.length,
    projectedFrom: projected,
    // Whole numbers: the precision implied by "4,138.7 runs a month" is not
    // there, and printing it invites the figure to be trusted more than it
    // deserves.
    runsPerMonth: Math.round(runsPerMonth),
    minutesPerMonth: Math.round(minutesPerMonth),
    hoursPerMonth: round1(minutesPerMonth / 60),
    // What the estimate is actually built on, so the panel can show its work.
    sampledRuns,
    sampledMinutes: round1(sampledMinutes),
    meanRunMinutes: sampledRuns ? round1(sampledMinutes / sampledRuns) : null,
    passRate: decisive ? passes / decisive : null,
    decisive,
    failures: decisive - passes,
  };
}
