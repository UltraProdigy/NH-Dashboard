/**
 * Rebuild the cached panels from D1 and bump the version the browser polls.
 *
 * Runs on a cron trigger rather than on the delivery path. A webhook handler
 * has ten seconds before GitHub calls it failed, and rebuilding a panel per
 * delivery would both blow that and rebuild the same panel three hundred times
 * an hour. Handlers set `dirty`; this clears it.
 *
 * The debounce is `dirty` itself. If nothing has arrived since the last run
 * there is nothing to rebuild, and the whole invocation is one read.
 */

import { analytics } from "./panels/analytics.js";
import { contributors } from "./panels/contributors.js";
import {
  approvedUnmerged,
  changesRequested,
} from "./panels/review-state.js";
import { byLabel } from "./panels/by-label.js";
import { depUpdates, needsRelease } from "./panels/releases.js";
import { ciHealth, pruneWorkflowRuns } from "./panels/ci-health.js";
import { issues } from "./panels/issues.js";
import { drilldown } from "./panels/drilldown.js";
import { scopedDb } from "./scope.js";

/**
 * Panels served from `panel_cache`, by name.
 *
 * Only the ones whose inputs are entirely in D1 can live here.
 *
 * That list is larger than it first looked. `approvedUnmerged` and
 * `changesRequested` were assumed to need GitHub because they *ask* it — the
 * search API answers `review:approved` in one query, which was convenient for a
 * build-time panel. Every fact they need is in `pull_requests` and `reviews`.
 *
 * `needsRelease` and `depUpdates` joined once `push` and `release` stopped
 * being discarded. They carry a caveat the others do not: the webhook only
 * captures forward, so both are only as good as how far back `commits` and
 * `releases` have been filled. Until the daily build has backfilled them, these
 * answer from a partial history — a repo whose release predates the capture
 * window has no row and simply does not appear, which reads as "up to date".
 *
 * `byLabel` joined once the `labels` table gave the managed label set somewhere
 * to live. It was the only one of the five Dream Panel cards blocked on data
 * that genuinely could not be reached rather than on a wrong assumption about
 * what a panel needed — Label-Sync-GTNH is a file in another repo, and no
 * webhook fires when it changes.
 *
 * `ciHealth` joined last, once `workflow_run` stopped being discarded. It
 * carries the same caveat the release panels do and more sharply: the webhook
 * captures forward only, and this panel's sample is the newest twenty runs per
 * repo, so until the backfill has run a repo reads as having however few runs
 * have arrived since the Worker went live. That is why it is registered here
 * before it is listed in `LIVE_PANELS` — the cache can be built and inspected
 * without the card claiming to be current.
 *
 * `issues` joined last and is the largest — fifteen keys, 655 KB cached, ~4.2s
 * projected on D1, which makes it the most expensive entry here. It is
 * registered before it is listed in `LIVE_PANELS` for the same reason `ciHealth`
 * was: every key reconciles against the build on the *seed*, and the seed is not
 * production. Building the cache is what makes `/api/panel/issues` answerable,
 * and answering is what lets it be diffed against `data/dashboard.json` before
 * any card claims to be current.
 *
 * `drilldown` is here as *half* a panel, and the half that is missing is the
 * point. What this entry builds is the two picker indexes and the schema keys —
 * 16 queries, 475 KB, ~344ms projected. The 7,047 per-subject payloads are
 * deliberately not here: building them all in one invocation fails on the
 * isolate's memory ceiling, on D1's 1,000 queries per invocation, and on the
 * monthly write allowance, independently. They are a read-through cache keyed
 * on `version`, computed one subject at a time on the request. `handoff.md`
 * carries the measurements.
 *
 * Still outside: `issueMetrics` and `activeDays`, neither blocked on data.
 */
const PANELS = {
  contributors,
  analytics,
  approvedUnmerged,
  changesRequested,
  needsRelease,
  depUpdates,
  byLabel,
  ciHealth,
  issues,
  drilldown,
};

/**
 * Panels cheap enough to rebuild on the delivery path itself.
 *
 * The ten-minute cron is a debounce, and the reason for it is `analytics` at
 * ~2.6 seconds on D1 — rebuilding that per delivery would redo the same work
 * three hundred times an hour for an answer nobody is watching that closely.
 *
 * That reasoning was then applied to every panel, which was wrong. These two
 * measure ~68ms and ~55ms: about 120ms together, against the ten seconds GitHub
 * allows before it calls a delivery failed. They are the cards an admin is
 * actually looking at when they press Merge, and making them wait out a cron
 * tick for a number the database already knows was never a real constraint.
 *
 * So they rebuild immediately and the expensive ones stay on the cron. `dirty`
 * is deliberately *not* cleared here — the cron still owes the others a rebuild.
 */
const INSTANT = { approvedUnmerged, changesRequested };

/**
 * How fresh a panel can be, as the Worker's own statement about itself.
 *
 * The frontend tints each card by this, and the temptation is to keep the list
 * in the frontend where the rendering is. That would be a second copy of the
 * split above, and it would be wrong the first time a panel is promoted from
 * the cron to the delivery path — the card would keep claiming ten minutes
 * while the data arrived in one second, or worse, the reverse.
 *
 * So the Worker answers it. `/api/panel/:name` carries the tier in a header,
 * because the thing that knows how a panel is rebuilt is the code that rebuilds
 * it.
 */
export const refreshTier = (name) =>
  name in INSTANT ? "instant" : name in PANELS ? "cron" : "build";

/**
 * Rebuild the cheap panels now, for one delivery.
 *
 * Called from `ctx.waitUntil`, so it runs after the 200 has already gone back
 * to GitHub. Nothing it does can slow a delivery down or fail one — which
 * matters more than the freshness, because a webhook that keeps failing gets
 * disabled and that failure is silent.
 */
export async function refreshInstant(env) {
  const now = Date.now();
  const at = new Date(now).toISOString();
  const db = scopedDb(env.DB, env);
  const built = {};

  for (const [name, fn] of Object.entries(INSTANT)) {
    const started = Date.now();
    try {
      const json = JSON.stringify(await fn(db, now));
      await env.DB.prepare(
        `INSERT INTO panel_cache (name, json, computed_at, ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           json = excluded.json,
           computed_at = excluded.computed_at,
           ms = excluded.ms`,
      )
        .bind(name, json, at, Date.now() - started)
        .run();
      built[name] = Date.now() - started;
    } catch (err) {
      console.error(JSON.stringify({ instant: name, error: String(err) }));
    }
  }

  // Bump the version so a browser polling `/api/version` picks these up within
  // its next minute rather than at the next cron tick.
  await env.DB.prepare(
    "UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'version'",
  ).run();

  return built;
}

export async function recompute(env, { force = false } = {}) {
  const dirty = await env.DB.prepare(
    "SELECT value FROM meta WHERE key = 'dirty'",
  ).first();

  if (!force && dirty?.value !== "1") {
    return { skipped: "clean" };
  }

  const now = Date.now();
  const at = new Date(now).toISOString();
  const built = {};
  const failed = {};

  // Panels never see the raw handle. Excluded repos stay in D1 and are filtered
  // out of everything served, and doing it here rather than in each panel means
  // a new panel cannot forget. See scope.js.
  const db = scopedDb(env.DB, env);

  for (const [name, fn] of Object.entries(PANELS)) {
    const started = Date.now();
    try {
      const data = await fn(db, now);
      const json = JSON.stringify(data);
      const ms = Date.now() - started;

      await env.DB.prepare(
        `INSERT INTO panel_cache (name, json, computed_at, ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           json = excluded.json,
           computed_at = excluded.computed_at,
           ms = excluded.ms`,
      )
        .bind(name, json, at, ms)
        .run();

      built[name] = { bytes: json.length, ms };
    } catch (err) {
      // One panel failing must not cost the others their rebuild, nor leave
      // `dirty` set forever — the previous cached copy stays served, which is
      // stale rather than absent, and the next run tries again.
      failed[name] = String(err);
    }
  }

  // Bound the one table that grows without limit. After the rebuild rather than
  // before it, so a run that would have been trimmed still contributed to the
  // panel it was trimmed for — and on the raw handle, because `scope.js`
  // rewrites `FROM workflow_runs` and `DELETE FROM (SELECT …)` is not SQL.
  let pruned = 0;
  try {
    ({ pruned } = await pruneWorkflowRuns(env.DB));
  } catch (err) {
    failed.pruneWorkflowRuns = String(err);
  }

  // Clear first, bump second. A delivery landing between the two sets `dirty`
  // again and gets picked up next run. The reverse order could clear a flag set
  // by work this run did not see.
  await env.DB.prepare("UPDATE meta SET value = '0' WHERE key = 'dirty'").run();
  await env.DB.prepare(
    "UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'version'",
  ).run();

  const version = await env.DB.prepare(
    "SELECT value FROM meta WHERE key = 'version'",
  ).first();

  return { version: Number(version?.value ?? 0), built, failed, pruned, at };
}
