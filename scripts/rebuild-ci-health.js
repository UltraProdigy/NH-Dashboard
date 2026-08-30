/**
 * Rebuild only the ciHealth panel, in place, inside an existing dashboard.json.
 *
 *   npm run rebuild:ci
 *
 * A full `npm run build` is 592 seconds and 409 API requests, and it rewrites
 * every panel. When the thing that changed is one panel's arithmetic, that is
 * both slow and actively unhelpful: the other panels were reconciled against
 * the live Worker on a particular day, and moving them at the same time makes
 * any later difference impossible to attribute.
 *
 * So this touches one key. Everything else in the file — `generatedAt`
 * included — is left exactly as the build wrote it, because a rebuild stamp on
 * a file whose other panels did not rebuild would be a lie about all of them.
 *
 * The panel is rewritten in the shape `run()` produces, so a reader cannot tell
 * this from a full build's output, and a failure is recorded rather than
 * thrown — same as the build, where ciHealth is `optional: true`.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ciHealth } from "../src/panels/ciHealth.js";
import { ORG } from "../src/config.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, "..", "data", "dashboard.json");

const fmt = (n) => n.toLocaleString();

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
  const before = dashboard.panels?.ciHealth;

  console.log(`\nRebuilding CI health for ${ORG}\n`);
  const started = Date.now();

  let panel;
  try {
    const data = await ciHealth();
    panel = { ok: true, data, optional: true };
  } catch (err) {
    console.error(`  ✗ failed: ${err.message}\n`);
    panel = {
      ok: false,
      error: err.message,
      data: { repos: {}, org: null },
      optional: true,
    };
  }

  dashboard.panels.ciHealth = panel;
  await writeFile(FILE, JSON.stringify(dashboard));

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`  written in ${secs}s\n`);

  // The two figures the duration ceiling actually moves, printed against what
  // was there before. A rebuild that changed nothing is worth seeing as plainly
  // as one that changed everything.
  const org = panel.data?.org;
  const was = before?.data?.org;
  if (org && was) {
    const line = (label, now, then, unit = "") =>
      console.log(
        `  ${label.padEnd(22)} ${fmt(then)}${unit}  ->  ${fmt(now)}${unit}`,
      );
    line("sampled minutes", Math.round(org.sampledMinutes), Math.round(was.sampledMinutes));
    line("hours per month", Math.round(org.hoursPerMonth), Math.round(was.hoursPerMonth));
    line("mean run minutes", org.meanRunMinutes ?? 0, was.meanRunMinutes ?? 0);
    line("runs per month", org.runsPerMonth, was.runsPerMonth);
    console.log(
      `\n  runs per month is resampling noise, not the ceiling — it cannot ` +
        `touch that\n  figure unless a repo loses every duration it had.\n`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
