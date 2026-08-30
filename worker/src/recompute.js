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
import { scopedDb } from "./scope.js";

/**
 * Panels served from `panel_cache`, by name.
 *
 * Only the ones whose inputs are entirely in D1 can live here. `ciHealth`,
 * `depUpdates`, `needsRelease` and the pull-request panels each need a live
 * GitHub call, so they stay in the Node build and reach the frontend the old
 * way. That split is expected to persist, not a migration half-done.
 */
const PANELS = { contributors, analytics };

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
