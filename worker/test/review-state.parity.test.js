/**
 * The SQL "waiting on a human" cards against the search-backed ones.
 *
 *   node --experimental-sqlite worker/test/review-state.parity.test.js
 *
 * These two panels are a different parity problem from the others. The
 * JavaScript does not compute anything — it asks GitHub's search API and
 * renders the answer — so the baseline is not a second implementation, it is a
 * *snapshot of GitHub taken at a different moment*. Rows will legitimately
 * differ, and demanding an exact match would produce a test that fails for
 * being right.
 *
 * So it is split:
 *
 *   The **logic** is asserted against synthetic reviews, where the interesting
 *   cases can be constructed. Approved-then-changed, dismissed, comment-only,
 *   two verdicts in the same second — the real store contains few or none of
 *   these, so real data would validate a wrong implementation happily.
 *
 *   The **shared rows** must match field for field. Whatever both sides agree
 *   is in the list, they must describe identically.
 *
 *   The **set difference** is reported and bounded rather than required to be
 *   empty, because it is the store lagging GitHub. If it ever grows past a few
 *   PRs, that is worth knowing — but it is an ingest freshness signal, not a
 *   logic failure.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  approvedUnmerged,
  changesRequested,
} from "../src/panels/review-state.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const SEED = path.join(HERE, "..", "seed.sql");
const SCHEMA = path.join(HERE, "..", "schema.sql");
const EXPECTED = path.join(ROOT, "data", "dashboard.json");

/** How far the store may lag GitHub before it stops being routine. */
const DRIFT_BUDGET = 8;

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

const d1 = (db) => ({
  prepare(sql) {
    let params = [];
    const api = {
      bind(...p) { params = p; return api; },
      async all() { return { results: db.prepare(sql).all(...params) }; },
      async first() { return db.prepare(sql).get(...params) ?? null; },
    };
    return api;
  },
});

function blank() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(SCHEMA, "utf8"));
  return db;
}

/**
 * The cases that decide the panel, built by hand.
 *
 * Each is one pull request with a review history, and an expected verdict. The
 * store has almost none of these shapes — one reviewer, one approval, done — so
 * this is the only place the resolution is actually tested.
 */
async function checkResolution() {
  const db = blank();
  const now = Date.parse("2026-01-10T00:00:00Z");

  const pr = (n) =>
    db.exec(`INSERT INTO pull_requests (repo, number, title, author, created_at,
             updated_at, state, is_draft, labels, assignees, review_requests)
             VALUES ('r', ${n}, 't${n}', 'a', '2026-01-01T00:00:00Z',
                     '2026-01-02T00:00:00Z', 'OPEN', 0, '[]', '[]', '[]')`);

  const rev = (n, who, state, at) =>
    db.exec(`INSERT INTO reviews (repo, pr_number, author, state, submitted_at)
             VALUES ('r', ${n}, '${who}', '${state}', '${at}')`);

  // Review times are hours on one day, so "later" is obvious at a glance.
  const at = (hour) => `2026-01-05T${String(hour).padStart(2, "0")}:00:00Z`;

  const CASES = [
    [1, "a lone approval", [["x", "APPROVED", 3]], "approved"],
    [2, "approved, then the same reviewer asked for changes",
       [["x", "APPROVED", 3], ["x", "CHANGES_REQUESTED", 4]], "changes"],
    [3, "changes requested, then the same reviewer approved",
       [["x", "CHANGES_REQUESTED", 3], ["x", "APPROVED", 4]], "approved"],
    [4, "one approves, another wants changes",
       [["x", "APPROVED", 3], ["y", "CHANGES_REQUESTED", 4]], "changes"],
    [5, "a dismissed approval leaves no opinion",
       [["x", "APPROVED", 3], ["x", "DISMISSED", 4]], "neither"],
    [6, "dismissing one reviewer does not clear another",
       [["x", "APPROVED", 3], ["x", "DISMISSED", 4],
        ["y", "CHANGES_REQUESTED", 5]], "changes"],
    [7, "a later comment does not undo an earlier approval",
       [["x", "APPROVED", 3], ["x", "COMMENTED", 5]], "approved"],
    [8, "comment-only means no verdict at all",
       [["x", "COMMENTED", 3]], "neither"],
    [9, "no reviews at all", [], "neither"],
  ];

  for (const [n, , reviews] of CASES) {
    pr(n);
    for (const [who, state, hour] of reviews) rev(n, who, state, at(hour));
  }

  const approved = new Set(
    (await approvedUnmerged(d1(db), now)).map((r) => r.number),
  );
  const changes = new Set(
    (await changesRequested(d1(db), now)).map((r) => r.number),
  );

  for (const [n, label, , want] of CASES) {
    const got = approved.has(n) ? "approved" : changes.has(n) ? "changes" : "neither";
    check(`${label} → ${want}`, got === want, `got ${got}`);
  }

  db.close();
}

/**
 * The panel picks a reviewer's latest verdict by `submitted_at` alone, with no
 * tiebreak. That is only safe because the schema forbids the tie — so assert
 * the schema, rather than leaving the panel resting on an unstated assumption.
 *
 * If `idx_reviews_key` is ever relaxed this fails here, which is the cheap
 * place, instead of showing up as a card that flickers between builds.
 */
function checkTieImpossible() {
  const db = blank();
  db.exec(`INSERT INTO reviews (repo, pr_number, author, state, submitted_at)
           VALUES ('r', 1, 'x', 'APPROVED', '2026-01-05T00:00:00Z')`);

  let rejected = false;
  try {
    db.exec(`INSERT INTO reviews (repo, pr_number, author, state, submitted_at)
             VALUES ('r', 1, 'x', 'CHANGES_REQUESTED', '2026-01-05T00:00:00Z')`);
  } catch {
    rejected = true;
  }

  check(
    "the schema forbids one reviewer holding two verdicts in a second",
    rejected,
    "the panel's ordering would become non-deterministic",
  );
  db.close();
}

async function checkAgainstSearch() {
  if (!existsSync(SEED) || !existsSync(EXPECTED)) {
    console.log("\n  skip  needs worker/seed.sql and data/dashboard.json\n");
    return;
  }

  const db = blank();
  db.exec("BEGIN");
  db.exec(readFileSync(SEED, "utf8"));
  db.exec("COMMIT");

  const dash = JSON.parse(readFileSync(EXPECTED, "utf8"));
  const now = Date.parse(dash.generatedAt);

  // Split by whether the field can change between two snapshots hours apart.
  //
  // Identity cannot: a PR's repo, number, URL, author and creation time are
  // fixed for life, and `ageDays` derives from the last of those. If any of
  // these disagree, the panel is describing the wrong pull request.
  //
  // Everything else can, and does. Titles get edited, `updated_at` moves on
  // every comment, `staleDays` follows it, a draft is marked ready. Requiring
  // those to match is requiring the store to be as fresh as GitHub, which is
  // the thing this whole port exists to fix rather than a property to assert.
  const STABLE = ["repo", "number", "url", "author", "createdAt", "ageDays"];
  const MUTABLE = ["title", "updatedAt", "staleDays", "draft"];

  for (const [name, fn] of [["approvedUnmerged", approvedUnmerged],
                            ["changesRequested", changesRequested]]) {
    const got = await fn(d1(db), now);
    const want = dash.panels[name]?.data;
    if (!want) { console.log(`  skip  ${name} absent from dashboard.json`); continue; }

    const byKey = new Map(want.map((r) => [`${r.repo}#${r.number}`, r]));
    const diffs = [];
    const stale = [];
    let shared = 0;

    for (const r of got) {
      const other = byKey.get(`${r.repo}#${r.number}`);
      if (!other) continue;
      shared++;
      for (const f of STABLE) {
        if (JSON.stringify(r[f]) !== JSON.stringify(other[f])) {
          diffs.push(`${r.repo}#${r.number}.${f}: ${r[f]} vs ${other[f]}`);
        }
      }
      for (const f of MUTABLE) {
        if (JSON.stringify(r[f]) !== JSON.stringify(other[f])) {
          stale.push(`${r.repo}#${r.number}.${f}`);
        }
      }
      // Label names must match; colours cannot, and that is documented.
      const mine = r.labels.map((l) => l.name).join(",");
      const theirs = other.labels.map((l) => l.name).join(",");
      if (mine !== theirs) stale.push(`${r.repo}#${r.number}.labels`);
    }

    check(`${name}: all ${shared} shared rows identify the same PR`,
          diffs.length === 0, diffs.slice(0, 3).join("; "));
    if (stale.length) {
      console.log(`        (${stale.length} mutable fields drifted: ${stale.slice(0, 3).join(", ")}${stale.length > 3 ? " …" : ""})`);
    }

    const onlySql = got.filter((r) => !byKey.has(`${r.repo}#${r.number}`)).length;
    const gotKeys = new Set(got.map((r) => `${r.repo}#${r.number}`));
    const onlySearch = want.filter((r) => !gotKeys.has(`${r.repo}#${r.number}`)).length;
    const drift = onlySql + onlySearch;

    check(
      `${name}: store lag within budget (${drift} of ${want.length})`,
      drift <= DRIFT_BUDGET,
      `${onlySql} only in SQL, ${onlySearch} only in search — if this grows, ` +
        `the ingest is missing reviews, not the panel`,
    );
  }

  db.close();
}

async function main() {
  console.log("\nreview state: SQL against the search API\n");
  await checkResolution();
  checkTieImpossible();
  await checkAgainstSearch();
  console.log(`\n${pass} passed, ${failures.length} failed\n`);
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
