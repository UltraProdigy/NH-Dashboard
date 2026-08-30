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
 * Five checks, because they catch different mistakes:
 *
 *   Every ingest module must reference `isIngestExcluded`. Crude, and it is the
 *   check that would have caught the original gap — the same reasoning as the
 *   parity test counting UNION arms in the panel sources.
 *
 *   With a store on disk, an excluded repo must not survive `readStore`. That
 *   is the behaviour the first check only approximates.
 *
 *   Every CI step that ingests or builds must be passed the variable. The
 *   workflow publishes its own build to Pages, so a clean local artefact proves
 *   nothing about the deployed one.
 *
 *   The matcher and its SQL twin must agree. The Worker reads D1 directly and
 *   cannot use the JavaScript one, and the two disagreeing would put a repo on
 *   a public page rather than raise anything.
 *
 *   A scoped handle must keep an excluded repo out of what a panel actually
 *   produces, asserted against a real seed and a repo genuinely in it. The
 *   failure worth catching is not a wrong predicate but one query out of thirty
 *   that never got one.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  compileRules,
  excludedRepoSql,
  matchesAny,
} from "../src/shared/repo-rules.js";

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

/**
 * CI must pass the exclusion to anything that ingests or builds.
 *
 * The workflow runs its own ingest and build and publishes *that* output to
 * Pages — a clean local `dashboard.json` never reaches the site. So a workflow
 * step that runs either without `NH_INGEST_EXCLUDE` in its env is a step that
 * republishes every excluded repo, and nothing about the run looks wrong.
 *
 * That is not hypothetical: this file set the variable nowhere, and an excluded
 * repo was served from public Pages as a result.
 */
function checkWorkflows() {
  const dir = path.join(ROOT, ".github", "workflows");
  if (!existsSync(dir)) return;

  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    const src = readFileSync(path.join(dir, file), "utf8");
    // Steps are `- name: … env: … run: …` blocks; split on the run lines and
    // check the block that introduced each ingest or build invocation.
    const steps = src.split(/\n\s*-\s+(?=name:|uses:)/);
    for (const step of steps) {
      const runs = /run:[\s\S]*?(src\/ingest\.js|src\/build\.js)/.exec(step);
      if (!runs) continue;
      check(
        `${file}: the step running ${runs[1]} passes NH_INGEST_EXCLUDE`,
        step.includes("NH_INGEST_EXCLUDE"),
        "CI would re-ingest and republish every excluded repo",
      );
    }
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

/**
 * The JavaScript matcher and its SQL twin must classify identically.
 *
 * Wildcards, the `!` exception, last-match-wins, and the LIKE metacharacters a
 * repo name can legitimately contain — a repo called `report_v2` must not
 * exclude `reportXv2` because `_` means "any character" to LIKE and nothing to
 * the regex.
 */
function checkMatcherTwins() {
  const names = [
    "Dupes-Exploits-GTNH", "dupes-exploits-gtnh", "GT5-Unofficial", "Angelica",
    "Horizon-QA", "Horizon-Dev", "Foo-Test", "report_v2", "reportXv2",
    "100%Cool", "GTNHLib", "Mod-A", "Mod-B",
  ];
  const sets = [
    [], ["Dupes-Exploits-GTNH"], ["*-Test"], ["Horizon-*", "!Horizon-QA"],
    ["Mod-*", "!Mod-B", "Mod-A"], ["report_v2"], ["100%Cool"], ["?TNHLib"],
    ["*"], ["*", "!Angelica"], ["DUPES-*"],
  ];

  const db = new DatabaseSync(":memory:");
  const diffs = [];
  for (const patterns of sets) {
    const rules = compileRules(patterns);
    const stmt = db.prepare(
      `SELECT ${excludedRepoSql("n", patterns)} AS x FROM (SELECT ? AS n)`,
    );
    for (const name of names) {
      const js = matchesAny(rules, name);
      const sql = stmt.get(name).x === 1;
      if (js !== sql) diffs.push(`${JSON.stringify(patterns)} vs ${name}`);
    }
  }
  db.close();
  check(
    `matcher and SQL twin agree across ${sets.length} pattern sets`,
    diffs.length === 0,
    diffs.slice(0, 3).join("; "),
  );
}

/**
 * A scoped handle must keep an excluded repo out of what a panel produces.
 *
 * Run against a real seed with a repo that is genuinely in it, because the
 * interesting failure is not "the predicate is wrong" but "one of thirty-odd
 * queries never got one". Asserting the totals move by exactly the right amount
 * is what distinguishes a filter that worked from a query that quietly
 * returned nothing.
 */
async function checkScopedPanels() {
  const SEED = path.join(ROOT, "worker", "seed.sql");
  const SCHEMA = path.join(ROOT, "worker", "schema.sql");
  if (!existsSync(SEED)) {
    console.log("  skip  scoped panels need worker/seed.sql, not committed");
    return;
  }

  const { scopedDb } = await import("../worker/src/scope.js");
  const { analytics } = await import("../worker/src/panels/analytics.js");
  const { contributors } = await import("../worker/src/panels/contributors.js");

  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(SCHEMA, "utf8"));
  db.exec("BEGIN");
  db.exec(readFileSync(SEED, "utf8"));
  db.exec("COMMIT");

  const d1 = (h) => ({
    prepare(sql) {
      let params = [];
      const api = {
        bind(...p) { params = p; return api; },
        async all() { return { results: h.prepare(sql).all(...params) }; },
        async first() { return h.prepare(sql).get(...params) ?? null; },
      };
      return api;
    },
  });

  // Whichever repo has the most pull requests, so the arithmetic is unambiguous.
  const top = db
    .prepare("SELECT repo, COUNT(*) n FROM pull_requests GROUP BY repo ORDER BY n DESC LIMIT 1")
    .get();
  if (!top) { console.log("  skip  seed has no pull requests"); db.close(); return; }

  const all = db.prepare("SELECT COUNT(*) n FROM pull_requests").get().n;
  const now = Date.now();
  const scoped = scopedDb(d1(db), { NH_INGEST_EXCLUDE: top.repo });

  const a = await analytics(scoped, now);
  const c = await contributors(scoped, now);

  check(
    `analytics drops the excluded repo's ${top.n} pull requests`,
    a.totals.prs === all - top.n,
    `${a.totals.prs}, expected ${all - top.n}`,
  );
  for (const [label, out] of [["analytics", a], ["contributors", c]]) {
    const hits = (JSON.stringify(out).match(new RegExp(top.repo, "g")) ?? []).length;
    check(`${label} never names the excluded repo`, hits === 0, `${hits} mentions`);
  }

  // An unscoped handle must be handed back untouched, so a deployment with no
  // exclusions runs byte-identical SQL to the one this was all developed on.
  const bare = scopedDb(d1(db), {});
  check("no exclusions configured leaves the handle alone", bare === d1(db) || !bare.excluded);

  db.close();
}

async function main() {
  console.log("\ningest exclusion\n");
  checkWiring();
  checkWorkflows();
  checkMatcherTwins();
  await checkStores();
  await checkScopedPanels();
  console.log(`\n${pass} passed, ${failures.length} failed\n`);
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
