/**
 * The ingest exclusion must actually be applied.
 *
 *   node test/exclusion.test.js
 *
 * `NH_INGEST_EXCLUDE` names repos that must never reach `data/` or the deployed
 * site. It was wired into the traffic ingest and into neither of the other two,
 * so 352 issues from an excluded repo sat in the store, in the seeded D1
 * database, and in the `dashboard.json` served from public Pages — under a
 * config comment promising that "excluded repos are never fetched, so nothing
 * about them reaches data/ or the deployed site".
 *
 * Nothing failed, because a filter that is never called cannot fail. That is
 * what makes this worth a test rather than care: the exclusion has no output of
 * its own to look wrong, and the only symptom is data quietly present.
 *
 * Two checks, because they catch different mistakes:
 *
 *   Every ingest module must reference `isIngestExcluded`. Crude, and it is the
 *   check that would have caught the original gap — the same reasoning as the
 *   parity test counting UNION arms in the panel sources.
 *
 *   With a store on disk, an excluded repo must not survive `readStore`. That
 *   is the behaviour the first check only approximates.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const INGEST = path.join(ROOT, "src", "ingest");

let pass = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ok    ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * Modules that fetch from GitHub or read a store back must consult the list.
 *
 * `issuesBulk` is exempt: it loads into the same store through `issues.js`,
 * which filters on the way in and on the way out.
 */
const MUST_FILTER = ["issues.js", "pullRequests.js", "traffic.js"];

function checkWiring() {
  const present = readdirSync(INGEST).filter((f) => f.endsWith(".js"));

  for (const file of MUST_FILTER) {
    check(`${file} exists`, present.includes(file));
    if (!present.includes(file)) continue;

    const src = readFileSync(path.join(INGEST, file), "utf8");
    const calls = (src.match(/isIngestExcluded\s*\(/g) ?? []).length;
    check(
      `${file} applies the ingest exclusion`,
      calls > 0,
      "imports it but never calls it, or does neither",
    );
  }

  // A store reader that does not filter is the case that bit: the repo list can
  // be filtered perfectly and a store written before the exclusion existed
  // still feeds every panel.
  for (const file of ["issues.js", "pullRequests.js"]) {
    const src = readFileSync(path.join(INGEST, file), "utf8");
    const reader = src.slice(src.indexOf("export async function readStore"));
    check(
      `${file}: readStore filters excluded repos`,
      reader.includes("isIngestExcluded"),
      "an already-polluted store would still reach every panel",
    );
  }
}

async function checkStores() {
  const excluded = (process.env.NH_INGEST_EXCLUDE ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!excluded.length) {
    console.log(
      "\n  (no NH_INGEST_EXCLUDE set — wiring checked, behaviour not)\n",
    );
    return;
  }

  const { isIngestExcluded } = await import("../src/config.js");

  for (const [file, label] of [
    ["issues.js", "issue"],
    ["pullRequests.js", "pull request"],
  ]) {
    const store = path.join(ROOT, "data", "ingest",
      label === "issue" ? "issues.ndjson" : "prs.ndjson");
    if (!existsSync(store)) {
      console.log(`  skip  ${label} store absent`);
      continue;
    }
    const { readStore } = await import(`../src/ingest/${file}`);
    const rows = await readStore();
    const leaked = rows.filter((r) => isIngestExcluded(r.repo));
    check(
      `no excluded repo survives the ${label} store read`,
      leaked.length === 0,
      leaked.length
        ? `${leaked.length} rows from ${[...new Set(leaked.map((r) => r.repo))].join(", ")}`
        : "",
    );
  }
}

async function main() {
  console.log("\ningest exclusion\n");
  checkWiring();
  await checkStores();
  console.log(`\n${pass} passed, ${failures.length} failed\n`);
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
