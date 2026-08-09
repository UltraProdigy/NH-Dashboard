/**
 * Build entry point. Runs every panel, writes data/*.json for the frontend.
 *
 *   node --env-file-if-exists=.env src/build.js            (uses 15min cache)
 *   node --env-file-if-exists=.env src/build.js --no-cache (forces fresh)
 */

import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { ORG } from "./config.js";
import { rateLimit, stats } from "./github/client.js";
import { approvedUnmerged, byLabel, changesRequested } from "./panels/pullRequests.js";
import { needsRelease } from "./panels/needsRelease.js";
import { contributors } from "./panels/contributors.js";

const DATA_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "data"
);

/**
 * Each panel runs isolated — one failure shouldn't sink the whole build.
 *
 * `optional: true` means a failure is reported but doesn't fail the process.
 * Used for panels that depend on locally-ingested data, which legitimately
 * isn't present in CI. Without this, a missing ingest store would turn the
 * whole workflow red and block the Pages deploy.
 */
async function run(name, fn, { empty = [], optional = false } = {}) {
  const started = Date.now();
  process.stdout.write(`▸ ${name}\n`);
  try {
    const data = await fn();
    const count = Array.isArray(data) ? data.length : Object.keys(data).length;
    console.log(`  ✓ ${count} results in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
    return { ok: true, data, optional };
  } catch (err) {
    console.error(`  ${optional ? "-" : "✗"} ${optional ? "skipped" : "failed"}: ${err.message}\n`);
    return { ok: false, error: err.message, data: empty, optional };
  }
}

async function main() {
  console.log(`\nBuilding dashboard for ${ORG}\n`);
  const started = Date.now();

  const panels = {
    approvedUnmerged: await run("Approved, not merged", approvedUnmerged),
    changesRequested: await run("Changes requested", changesRequested),
    byLabel: await run("PRs by label", byLabel, { empty: {} }),
    needsRelease: await run("Needs a release", needsRelease),
    // Reads the local ingest store, not the API. Fails gracefully with an
    // explanatory message if `npm run ingest` hasn't been run yet.
    contributors: await run("Contributor activity", contributors, {
      empty: { windows: [], rows: [] },
      optional: true,
    }),
  };

  const output = {
    generatedAt: new Date().toISOString(),
    org: ORG,
    // Derived from what byLabel actually queried, so it reflects the live
    // Label-Sync set rather than a local copy.
    trackedLabels: Object.keys(panels.byLabel.data ?? {}),
    panels: Object.fromEntries(
      Object.entries(panels).map(([k, v]) => [
        k,
        { ok: v.ok, error: v.error ?? null, data: v.data },
      ])
    ),
  };

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(
    path.join(DATA_DIR, "dashboard.json"),
    JSON.stringify(output, null, 2)
  );

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`Wrote data/dashboard.json in ${elapsed}s`);
  console.log(
    `  ${stats.requests} API requests, ${stats.cacheHits} cache hits` +
      (stats.rateLimitWaits ? `, ${stats.rateLimitWaits} rate-limit waits` : "")
  );

  const rl = await rateLimit();
  if (rl?.resources?.core) {
    const { remaining, limit } = rl.resources.core;
    console.log(`  ${remaining}/${limit} core quota remaining\n`);
  }

  const failed = Object.entries(panels).filter(([, v]) => !v.ok && !v.optional);
  if (failed.length) {
    console.error(`${failed.length} panel(s) failed — see above.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\nBuild failed: ${err.message}\n`);
  process.exit(1);
});
