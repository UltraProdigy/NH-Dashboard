/**
 * The SQL contributors panel must agree with the JavaScript one.
 *
 * Two implementations of the same numbers is a standing invitation to drift,
 * and the drift would be invisible: a leaderboard is plausible whatever it
 * says. So rather than trusting the port, this loads a real seed into SQLite,
 * runs the SQL panel against it, and diffs the result field by field against
 * the `dashboard.json` the Node panel produced from the same data.
 *
 *   node --experimental-sqlite worker/test/contributors.parity.test.js
 *
 * It needs `worker/seed.sql` and `data/dashboard.json`, and skips politely if
 * either is missing — neither is committed, and CI has neither.
 *
 * The clock is taken from `dashboard.json`'s own `generatedAt`. Every window
 * except all-time is relative to now, so running with today's clock against
 * yesterday's output would report differences that are just the passage of
 * time.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { tmpdir } from "node:os";

import { contributors } from "../src/panels/contributors.js";
import { byActivityThenLogin } from "../../src/shared/contributor-rules.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const SEED = path.join(HERE, "..", "seed.sql");
const SCHEMA = path.join(HERE, "..", "schema.sql");
const EXPECTED = path.join(ROOT, "data", "dashboard.json");

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

/**
 * D1's `.prepare().bind().all()` over node:sqlite, close enough for this.
 * Only the three shapes the panel actually uses are implemented.
 */
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
  const file = path.join(tmpdir(), `nh-parity-${process.pid}.db`);
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

/**
 * D1 rejects a compound SELECT with many arms — "too many terms in compound
 * SELECT" — at a threshold well below SQLite's own default of 500. Local
 * SQLite, and therefore every test in this file, accepts what D1 will refuse.
 *
 * A six-arm UNION shipped once on the strength of a green local suite and
 * failed on the first real recompute. This counts the arms in the panel sources
 * so the next one fails here instead, where it is cheap.
 */
function checkCompoundSelects() {
  const dir = path.join(HERE, "..", "src", "panels");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    const src = readFileSync(path.join(dir, file), "utf8");
    // Counted per template literal, not per file — two separate queries with
    // three UNIONs each are fine; one query with six is not.
    const worst = (src.match(/`[^`]*`/gs) ?? []).reduce(
      (n, lit) => Math.max(n, (lit.match(/\bUNION\b/gi) ?? []).length),
      0,
    );
    check(
      `${file}: no query exceeds D1's compound SELECT limit`,
      worst <= 3,
      worst > 3 ? `${worst} UNION arms in one query` : "",
    );
  }
}

async function main() {
  checkCompoundSelects();

  if (!existsSync(SEED) || !existsSync(EXPECTED)) {
    console.log(
      "\nskipped: needs worker/seed.sql and data/dashboard.json, neither committed\n",
    );
    return;
  }

  console.log("\ncontributors: SQL against JavaScript\n");

  const dash = JSON.parse(readFileSync(EXPECTED, "utf8"));
  const want = dash.panels?.contributors?.data;
  if (!want?.rows?.length) {
    console.log("skipped: dashboard.json has no contributors panel\n");
    return;
  }

  const now = Date.parse(dash.generatedAt);
  check("generatedAt parses", Number.isFinite(now), dash.generatedAt);

  const { db, file } = load();
  const got = await contributors(d1(db), now);

  check(
    "same number of contributors",
    got.rows.length === want.rows.length,
    `sql ${got.rows.length}, js ${want.rows.length}`,
  );

  const gotBy = new Map(got.rows.map((r) => [r.login, r]));
  const wantBy = new Map(want.rows.map((r) => [r.login, r]));

  const missing = [...wantBy.keys()].filter((l) => !gotBy.has(l));
  const extra = [...gotBy.keys()].filter((l) => !wantBy.has(l));
  check("no contributor missing from SQL", missing.length === 0, missing.slice(0, 5).join(", "));
  check("no contributor invented by SQL", extra.length === 0, extra.slice(0, 5).join(", "));

  const fields = ["prs", "merged", "approvals", "activeDays", "activeDenom"];
  const diffs = [];
  for (const [login, w] of wantBy) {
    const g = gotBy.get(login);
    if (!g) continue;
    for (const win of want.windows) {
      for (const f of fields) {
        if (g[win.id]?.[f] !== w[win.id]?.[f]) {
          diffs.push(`${login}.${win.id}.${f}: sql ${g[win.id]?.[f]} vs js ${w[win.id]?.[f]}`);
        }
      }
    }
    if (g.firstSeen !== w.firstSeen) diffs.push(`${login}.firstSeen: ${g.firstSeen} vs ${w.firstSeen}`);
    if (g.lastSeen !== w.lastSeen) diffs.push(`${login}.lastSeen: ${g.lastSeen} vs ${w.lastSeen}`);
  }

  check(
    "every count matches in every window",
    diffs.length === 0,
    diffs.length ? `${diffs.length} differences, first: ${diffs[0]}` : "",
  );
  if (diffs.length) {
    console.log("\n  first 25 differences:");
    for (const d of diffs.slice(0, 25)) console.log(`    ${d}`);
  }

  // Order drives the leaderboard, so it is part of the contract — but only as
  // far as the contract goes. `dashboard.json` was generated before ties were
  // broken by login, and back then 497 people shared a score of 1 in whatever
  // order the store yielded them. Asserting login-for-login against that would
  // be asserting noise. What must hold is that the *scores* descend in the same
  // sequence, and that the SQL order is fully determined by the shared
  // comparator rather than by anything incidental.
  const score = (r) => r.all.prs + r.all.approvals;
  const sameScores = got.rows.every((r, i) => score(r) === score(want.rows[i]));
  check("score sequence matches", sameScores);

  const resorted = [...got.rows].sort(byActivityThenLogin);
  check(
    "SQL order is deterministic",
    resorted.every((r, i) => r.login === got.rows[i].login),
  );

  check("totalPRs matches", got.totalPRs === want.totalPRs, `sql ${got.totalPRs}, js ${want.totalPRs}`);
  check(
    "truncated matches",
    got.truncated === want.truncated,
    `sql ${got.truncated}, js ${want.truncated}`,
  );

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
