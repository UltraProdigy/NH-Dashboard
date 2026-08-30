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
 * Still outside: `ciHealth`, `depUpdates`, `needsRelease` and `byLabel`. The
 * first three need facts D1 has never been told — workflow runs, commits,
 * release tags — though the webhook already receives `push`, `workflow_run` and
 * `release` and currently discards their payloads, so that is a gap in what is
 * stored rather than one in what can be known. `byLabel` needs the managed
 * label list, which lives in another repo.
 */
const PANELS = { contributors, analytics, approvedUnmerged, changesRequested };

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

  return { version: Number(version?.value ?? 0), built, failed, at };
}
