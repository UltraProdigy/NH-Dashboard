/**
 * The SQL repo activity panel must agree with the JavaScript one.
 *
 *   node --experimental-sqlite worker/test/repos.parity.test.js
 *
 * It needs `worker/seed.sql` and the ingest stores under `data/`, and skips
 * politely if either is missing — none of them is committed, and CI has none.
 *
 * The expected side is `data/dashboard.json` where that build carries a repos
 * panel, exactly as its four siblings do, and the Node panel computed from the
 * stores where it does not — which is the case on the day the panel is written,
 * and after any change to it that predates the next build. Both are the same
 * function; the difference is only whether its output is being read back or
 * recomputed.
 *
 * `--seed <path>` points at a seed other than `worker/seed.sql`, which is what
 * makes the recomputed mode usable: `node worker/seed.js --out /tmp/fresh.sql`
 * builds one from the store on disk, and the two sides are then the same
 * vintage by construction.
 *
 * What it shares with its siblings either way is the clock. Every window except
 * all-time is relative to now, so both sides are handed the same `now` rather
 * than each calling `Date.now()` a few milliseconds apart and disagreeing about
 * a boundary.
 *
 * Whichever side is used must be the same vintage as the seed. That is checked
 * first and the run stops if it is not, because a vintage gap reports as three
 * hundred plausible mismatches and none of them is the bug.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { tmpdir } from "node:os";

import { repos as sqlRepos } from "../src/panels/repos.js";
import { repos as jsRepos } from "../../src/panels/repos.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const seedArg = process.argv.indexOf("--seed");
const SEED =
  seedArg > -1 && process.argv[seedArg + 1]
    ? path.resolve(process.argv[seedArg + 1])
    : path.join(HERE, "..", "seed.sql");
const SCHEMA = path.join(HERE, "..", "schema.sql");
const PR_STORE = path.join(ROOT, "data", "ingest", "prs.ndjson");
const BUILT = path.join(ROOT, "data", "dashboard.json");

let pass = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ok    ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function d1(db) {
  return {
    prepare(sql) {
      let params = [];
      const api = {
        bind(...p) {
          params = p;
          return api;
        },
        async all() {
          return { results: db.prepare(sql).all(...params) };
        },
        async first() {
          return db.prepare(sql).get(...params) ?? null;
        },
      };
      return api;
    },
  };
}

function load() {
  const file = path.join(tmpdir(), `nh-repos-parity-${process.pid}.db`);
  try {
    unlinkSync(file);
  } catch {}
  const db = new DatabaseSync(file);
  db.exec(readFileSync(SCHEMA, "utf8"));
  db.exec("BEGIN");
  db.exec(readFileSync(SEED, "utf8"));
  db.exec("COMMIT");
  return { db, file };
}

async function main() {
  if (!existsSync(SEED) || !existsSync(PR_STORE)) {
    console.log("  skip  needs worker/seed.sql and data/ingest — neither is committed\n");
    return;
  }

  const { db, file } = load();

  // A build's panel has to be read against the clock that produced it; a
  // recomputed one against any clock, so long as both sides get the same.
  const built = existsSync(BUILT) ? JSON.parse(readFileSync(BUILT, "utf8")) : null;
  const fromBuild = built?.panels?.repos?.ok ? built.panels.repos.data : null;
  const now = fromBuild ? Date.parse(built.generatedAt) : Date.now();

  const [want, got] = await Promise.all([
    fromBuild ?? jsRepos(now),
    sqlRepos(d1(db), now),
  ]);
  console.log(`  note  expected side: ${fromBuild ? "data/dashboard.json" : "recomputed from data/ingest"}`);
  console.log(`  note  seed: ${path.relative(ROOT, SEED)}\n`);

  const seeded = db.prepare("SELECT COUNT(*) n FROM pull_requests").get().n;
  const stored = want.rows.reduce((n, r) => n + r.totalPRs, 0);
  if (seeded !== stored) {
    console.log(
      `  skip  seed and expected side are different vintages — ${seeded} pull requests ` +
        `in the seed against ${stored} on the other side. Regenerate one of them ` +
        `(node worker/seed.js --out <path>) before trusting a diff.\n`,
    );
    db.close();
    try {
      unlinkSync(file);
    } catch {}
    return;
  }

  check("row count matches", got.rows.length === want.rows.length,
    `sql ${got.rows.length}, js ${want.rows.length}`);
  check("windowFields match",
    JSON.stringify(got.windowFields) === JSON.stringify(want.windowFields));
  check("SQL order is deterministic",
    got.rows.every((r, i) => r.repo === want.rows[i].repo),
    "row order diverges from the JS panel");

  const byRepo = new Map(got.rows.map((r) => [r.repo, r]));
  const SCALARS = [
    "totalPRs", "totalIssues", "openPRs", "staleOpenPRs", "unreviewedOpenPRs",
    "openIssues", "unansweredIssues", "first", "last", "idleDays", "lifecycle",
  ];

  const bad = { scalars: [], windows: [] };
  for (const w of want.rows) {
    const g = byRepo.get(w.repo);
    if (!g) {
      bad.scalars.push(`${w.repo}: missing from SQL`);
      continue;
    }
    for (const key of SCALARS) {
      if (g[key] !== w[key]) bad.scalars.push(`${w.repo}.${key}: sql ${g[key]}, js ${w[key]}`);
    }
    for (const win of want.windows) {
      const a = g[win.id];
      const b = w[win.id];
      for (let i = 0; i < b.length; i++) {
        if (a[i] !== b[i])
          bad.windows.push(`${w.repo}.${win.id}.${want.windowFields[i]}: sql ${a[i]}, js ${b[i]}`);
      }
    }
  }

  check(`every row's scalars match across ${want.rows.length} repos`,
    bad.scalars.length === 0,
    bad.scalars.slice(0, 4).join("; ") + (bad.scalars.length > 4 ? ` (+${bad.scalars.length - 4} more)` : ""));
  check(
    `every window's ${want.windowFields.length} metrics match across ${want.rows.length} repos ` +
      `(${want.rows.length * want.windows.length * want.windowFields.length} figures)`,
    bad.windows.length === 0,
    bad.windows.slice(0, 4).join("; ") + (bad.windows.length > 4 ? ` (+${bad.windows.length - 4} more)` : ""));

  for (const key of ["repos", "openPRs", "staleOpenPRs", "openIssues", "unansweredIssues"]) {
    check(`org.${key} matches`, got.org[key] === want.org[key],
      `sql ${got.org[key]}, js ${want.org[key]}`);
  }
  check("org.byLifecycle matches",
    JSON.stringify(got.org.byLifecycle) === JSON.stringify(want.org.byLifecycle),
    JSON.stringify(got.org.byLifecycle));
  check("org.byWindow matches",
    JSON.stringify(got.org.byWindow) === JSON.stringify(want.org.byWindow));

  // The cache is one D1 row, and D1 caps a row at 2 MB. Worth asserting rather
  // than discovering when a recompute starts failing in production.
  const size = JSON.stringify(got).length;
  check(`cached blob fits D1's 2 MB row cap (${Math.round(size / 1024)} KB)`, size < 2_000_000);

  db.close();
  try {
    unlinkSync(file);
  } catch {}

  console.log(`\n${pass} passed, ${failures.length} failed\n`);
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
