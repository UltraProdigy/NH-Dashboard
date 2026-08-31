/**
 * Rebuild only the issues panel, in place, inside an existing dashboard.json.
 *
 *   npm run rebuild:issues
 *
 * Same reasoning as `rebuild-ci-health.js`, and cheaper: the issues panel makes
 * no API calls at all. It reads the ingest store and aggregates, so this needs
 * no token and takes seconds rather than the full build's 592.
 *
 * It exists because the SQL port needs an oracle it can trust to be current.
 * When a rule in `src/shared/issue-rules.js` changes, the shipped
 * `dashboard.json` becomes a stale baseline for the panel that reads it, and a
 * parity test comparing against a stale baseline reports a regression that is
 * really a fix — which has already cost this project one investigation, on
 * `contributors`.
 *
 * One key is touched. `generatedAt` is left exactly as the build wrote it: a
 * rebuild stamp on a file whose other panels did not rebuild would be a lie
 * about all of them, and this panel's day counts are measured from it.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { issues } from "../src/panels/issues.js";
import { ORG } from "../src/config.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, "..", "data", "dashboard.json");

async function main() {
  const raw = await readFile(FILE, "utf8").catch(() => null);
  if (!raw) {
    console.error(
      `No ${path.relative(process.cwd(), FILE)}. Run npm run build first — this ` +
        `script patches a dashboard, it does not create one.`,
    );
    process.exit(1);
  }

  const dashboard = JSON.parse(raw);
  const before = dashboard.panels?.issues?.data;

  // Pinned to the file's own `generatedAt`, not to wall-clock now. Half this
  // panel is measured from that instant — ages, staleness, every window bound —
  // so rebuilding it at the current time drops a panel counting from today into
  // a file whose other fourteen panels count from the build. Every list sorted
  // by age then differs from its neighbours by however long ago the build ran,
  // which looks exactly like a port that got the arithmetic wrong.
  const now = Date.parse(dashboard.generatedAt);
  if (!Number.isFinite(now)) {
    console.error(`  ✗ no usable generatedAt in ${path.basename(FILE)}\n`);
    process.exit(1);
  }

  console.log(`\nRebuilding issue analytics for ${ORG}`);
  console.log(`  as at ${dashboard.generatedAt}\n`);
  const started = Date.now();

  const data = await issues(now);
  dashboard.panels.issues = { ok: true, error: null, data };
  await writeFile(FILE, JSON.stringify(dashboard));

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`  written in ${secs}s\n`);

  // Which top-level keys moved, and by how many leaves. A rebuild that changed
  // nothing is worth seeing as plainly as one that changed everything — the
  // point of running this is usually to find out which of the two happened.
  if (before) {
    for (const key of Object.keys(data)) {
      const n = countDiffs(before[key], data[key]);
      console.log(`  ${key.padEnd(16)} ${n ? `${n} leaf changes` : "unchanged"}`);
    }
    console.log();
  }
}

function countDiffs(a, b, seen = { n: 0 }) {
  if (seen.n > 999) return seen.n;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      seen.n++;
      return seen.n;
    }
    for (let i = 0; i < a.length; i++) countDiffs(a[i], b[i], seen);
    return seen.n;
  }
  if (a && typeof a === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b ?? {})]))
      countDiffs(a[k], b?.[k], seen);
    return seen.n;
  }
  if ((a ?? null) !== (b ?? null)) seen.n++;
  return seen.n;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
