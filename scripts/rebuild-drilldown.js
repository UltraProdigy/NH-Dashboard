/**
 * Rebuild data/drilldown.json from the ingest store.
 *
 *   npm run rebuild:drilldown
 *
 * Same reasoning as `rebuild-issues.js`: the SQL port needs an oracle it can
 * trust to be current, and this panel makes no API calls, so it needs no token.
 *
 * `now` is pinned to the *dashboard's* `generatedAt` rather than to wall clock,
 * because half of what this file contains is measured from an instant — every
 * `ageDays`, every `staleDays`, every window bound, and the month the series
 * ends on. Rebuilt at the current time it would count from today while
 * `dashboard.json` beside it counts from the build, and every list sorted by
 * age would differ from its neighbour by however long ago that was. That looks
 * exactly like a port that got the arithmetic wrong, and it has already cost
 * this project two investigations under the other name.
 *
 * Unlike `rebuild-issues.js` this writes the whole file, because the whole file
 * is one panel.
 */

import { readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { drilldown, serializeDrilldown } from "../src/panels/drilldown.js";
import { ORG } from "../src/config.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, "..", "data");
const DASHBOARD = path.join(DATA, "dashboard.json");
const FILE = path.join(DATA, "drilldown.json");

async function main() {
  const raw = await readFile(DASHBOARD, "utf8").catch(() => null);
  if (!raw) {
    console.error(
      `No data/dashboard.json. This script pins its clock to that file's ` +
        `generatedAt so the two agree; run npm run build first.`,
    );
    process.exit(1);
  }

  const stamp = JSON.parse(raw).generatedAt;
  const now = Date.parse(stamp);
  if (!Number.isFinite(now)) {
    console.error(`  ✗ no usable generatedAt in dashboard.json\n`);
    process.exit(1);
  }

  console.log(`\nRebuilding the drilldown for ${ORG}`);
  console.log(`  as at ${stamp}\n`);
  const started = Date.now();

  const data = await drilldown(now);
  await writeFile(FILE, serializeDrilldown(data));

  const { size } = await stat(FILE);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `  ${Object.keys(data.contributors).length} contributors, ` +
      `${Object.keys(data.repos).length} repos\n` +
      `  wrote ${(size / 1e6).toFixed(1)} MB in ${secs}s\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
