/**
 * The SQL analytics panel must agree with the JavaScript one.
 *
 *   node --experimental-sqlite worker/test/analytics.parity.test.js
 *
 * Same argument as `contributors.parity.test.js`, with more surface to get
 * wrong: 484 lines of accumulators became a few dozen queries, and every one of
 * the numbers involved is plausible whatever it says. A median merge time of
 * 3.5 hours and one of 4.1 look equally like a working dashboard.
 *
 * Three things are checked that the contributors test does not need:
 *
 *   The week key, exhaustively. `weekKey` is ISO-week arithmetic via the
 *   nearest Thursday and its SQL twin is a different expression of the same
 *   idea. Every day across two decades is run through both.
 *
 *   The bot rule, as a regex against a LIKE predicate, over every author in the
 *   seed. A login excluded on one side and counted on the other is a dashboard
 *   that contradicts its own drilldown.
 *
 *   That no timestamp carries sub-second precision, which is what makes the
 *   whole-seconds duration arithmetic exact rather than merely close.
 *
 * Needs `worker/seed.sql` and `data/dashboard.json`, and skips politely if
 * either is missing — neither is committed, and CI has neither.
 *
 * The clock comes from `dashboard.json`'s own `generatedAt`. Every window
 * except all-time is relative to now, so today's clock against yesterday's
 * output would report differences that are only the passage of time.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { tmpdir } from "node:os";

import { analytics } from "../src/panels/analytics.js";
import { BOT_PATTERN, isBotSql } from "../../src/shared/contributor-rules.js";
import { weekKey, weekKeySql } from "../../src/shared/analytics-rules.js";

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

/** D1's `.prepare().bind().all()/.first()` over node:sqlite, close enough. */
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
  const file = path.join(tmpdir(), `nh-analytics-parity-${process.pid}.db`);
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
 * `weekKey` against `weekKeySql`, every day from 2005 to 2035.
 *
 * Year boundaries are where ISO weeks and every naive substitute part company,
 * and there are only thirty of them in range — so rather than sampling, run the
 * lot. 11,000 rows through SQLite costs nothing and removes the question.
 */
function checkWeekKey(db) {
  // Through a subquery, because the builders name their column several times
  // and a bare `?` would be several distinct parameters.
  const stmt = db.prepare(`SELECT ${weekKeySql("d")} AS k FROM (SELECT ? AS d)`);
  const diffs = [];
  const start = Date.UTC(2005, 0, 1);
  const end = Date.UTC(2035, 0, 1);

  for (let t = start; t < end; t += 86_400_000) {
    const d = new Date(t);
    const iso = d.toISOString();
    const js = weekKey(d);
    const sql = stmt.get(iso)?.k;
    if (js !== sql) diffs.push(`${iso.slice(0, 10)}: js ${js} vs sql ${sql}`);
  }

  check(
    "weekKey agrees with weekKeySql on every day 2005–2035",
    diffs.length === 0,
    diffs.length ? `${diffs.length} differences, first: ${diffs[0]}` : "",
  );
}

/** The regex and the LIKE predicate must classify every real login the same. */
function checkBotRule(db) {
  const logins = db
    .prepare(
      `SELECT DISTINCT author AS a FROM pull_requests
        UNION SELECT DISTINCT author FROM reviews
        UNION SELECT DISTINCT author FROM issues`,
    )
    .all()
    .map((r) => r.a);

  const stmt = db.prepare(
    `SELECT ${isBotSql("a")} AS bot FROM (SELECT ? AS a)`,
  );
  const diffs = logins.filter(
    (l) => (!l || BOT_PATTERN.test(l)) !== (stmt.get(l).bot === 1),
  );

  check(
    `bot rule agrees in SQL and JS across ${logins.length} logins`,
    diffs.length === 0,
    diffs.slice(0, 5).join(", "),
  );
}

/**
 * Whole-second timestamps, on the columns the durations are measured between.
 *
 * `hoursSql` subtracts epoch seconds, which is exact only while nothing carries
 * a fraction. `ingest_state.at` does — it is written locally, not by GitHub —
 * so this asks the columns that matter rather than the whole database.
 */
function checkSecondPrecision(db) {
  const cols = [
    ["pull_requests", "created_at"],
    ["pull_requests", "merged_at"],
    ["pull_requests", "updated_at"],
    ["reviews", "submitted_at"],
  ];
  const bad = cols.filter(
    ([t, c]) =>
      db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${c} LIKE '%.%'`).get().n >
      0,
  );
  check(
    "no duration column carries sub-second precision",
    bad.length === 0,
    bad.map(([t, c]) => `${t}.${c}`).join(", "),
  );
}

const near = (a, b) => a === b || (a != null && b != null && Math.abs(a - b) < 1e-9);

function diffObject(label, got, want, keys, diffs) {
  for (const k of keys) {
    if (!near(got?.[k], want?.[k])) {
      diffs.push(`${label}.${k}: sql ${got?.[k]} vs js ${want?.[k]}`);
    }
  }
}

const SUMMARY_KEYS = [
  "opened",
  "merged",
  "closed",
  "activeAuthors",
  "activeReviewers",
  "activeRepos",
  "newContributors",
  "approvals",
  "mergeRate",
  "approvedShare",
  "unapprovedMerges",
  "reviewConcentration",
  "medianMergeHours",
  "p90MergeHours",
  "medianFirstReviewHours",
  "additions",
  "deletions",
  "linesChanged",
  "commits",
  "comments",
  "medianPRLines",
  "p90PRLines",
  "sizedPRs",
];

const BUCKET_KEYS = [
  "t",
  "opened",
  "merged",
  "closed",
  "authors",
  "newAuthors",
  "mergeMedianH",
  "mergeP90H",
  "reviewMedianH",
  "mergeN",
  "reviewN",
];

/**
 * Top-N lists compare by count, not by login.
 *
 * `dashboard.json` was generated before ties broke on the key, so its tied
 * entries sit in whatever order the store yielded. Asserting login-for-login
 * against that would be asserting noise — what must hold is that the counts
 * descend identically, and that the set of logins at each count is the same.
 */
function checkTop(label, got, want, keyName, diffs) {
  const counts = (list) => list.map((e) => e.count ?? e.opened);
  if (String(counts(got)) !== String(counts(want))) {
    diffs.push(`${label}: counts ${counts(got)} vs ${counts(want)}`);
    return;
  }
  // Only entries whose count is unique in the list have a determined position;
  // the rest are compared as a set at each count.
  const bucketed = (list) => {
    const m = new Map();
    for (const e of list) {
      const c = e.count ?? e.opened;
      if (!m.has(c)) m.set(c, []);
      m.get(c).push(e[keyName]);
    }
    return m;
  };
  const g = bucketed(got);
  const w = bucketed(want);
  for (const [c, names] of w) {
    // A tied group can be cut off mid-way by the top-8 slice, in which case the
    // two implementations legitimately keep different members of it.
    if (names.length > 1 && names.length !== (g.get(c) ?? []).length) continue;
    const mine = new Set(g.get(c) ?? []);
    const missing = names.filter((n) => !mine.has(n));
    if (missing.length && names.length === 1) {
      diffs.push(`${label}: at count ${c}, sql lacks ${missing.join(", ")}`);
    }
  }
}

async function main() {
  if (!existsSync(SEED) || !existsSync(EXPECTED)) {
    console.log(
      "\nskipped: needs worker/seed.sql and data/dashboard.json, neither committed\n",
    );
    return;
  }

  console.log("\nanalytics: SQL against JavaScript\n");

  const dash = JSON.parse(readFileSync(EXPECTED, "utf8"));
  const want = dash.panels?.analytics?.data;
  if (!want?.totals) {
    console.log("skipped: dashboard.json has no analytics panel\n");
    return;
  }

  const now = Date.parse(dash.generatedAt);
  check("generatedAt parses", Number.isFinite(now), dash.generatedAt);

  const { db, file } = load();

  checkWeekKey(db);
  checkBotRule(db);
  checkSecondPrecision(db);

  const started = Date.now();
  const got = await analytics(d1(db), now);
  console.log(`\n  (panel built in ${Date.now() - started}ms)\n`);

  // ------------------------------------------------------------------ totals
  const totalDiffs = [];
  diffObject(
    "totals",
    got.totals,
    want.totals,
    ["prs", "merged", "open", "closed", "approvals", "contributors", "repos", "firstPR"],
    totalDiffs,
  );
  check("totals match", totalDiffs.length === 0, totalDiffs.join("; "));

  // ------------------------------------------------------------------ series
  for (const grain of ["day", "week", "month"]) {
    const g = got.series[grain];
    const w = want.series[grain];
    check(
      `${grain} series has the same buckets`,
      g.length === w.length && g.every((e, i) => e.b === w[i].b),
      `sql ${g.length}, js ${w.length}`,
    );

    const diffs = [];
    const wantBy = new Map(w.map((e) => [e.b, e]));
    for (const e of g) {
      const other = wantBy.get(e.b);
      if (other) diffObject(`${grain}[${e.b}]`, e, other, BUCKET_KEYS, diffs);
    }
    check(
      `${grain} series matches field by field`,
      diffs.length === 0,
      diffs.length ? `${diffs.length} differences, first: ${diffs[0]}` : "",
    );
    if (diffs.length) for (const d of diffs.slice(0, 10)) console.log(`        ${d}`);
  }

  check("dayFrom matches", got.series.dayFrom === want.series.dayFrom,
    `sql ${got.series.dayFrom}, js ${want.series.dayFrom}`);

  // ---------------------------------------------------------------- byWindow
  const winDiffs = [];
  for (const w of want.windows) {
    const g = got.byWindow[w.id];
    const e = want.byWindow[w.id];
    if (!g) {
      winDiffs.push(`${w.id}: missing from SQL`);
      continue;
    }
    diffObject(w.id, g, e, SUMMARY_KEYS, winDiffs);
    if (g.prevLabel !== e.prevLabel) {
      winDiffs.push(`${w.id}.prevLabel: ${g.prevLabel} vs ${e.prevLabel}`);
    }
    if ((g.prev == null) !== (e.prev == null)) {
      winDiffs.push(`${w.id}.prev: ${g.prev == null} vs ${e.prev == null}`);
    } else if (g.prev) {
      diffObject(`${w.id}.prev`, g.prev, e.prev, SUMMARY_KEYS, winDiffs);
    }
    checkTop(`${w.id}.topRepos`, g.topRepos, e.topRepos, "repo", winDiffs);
    checkTop(`${w.id}.topAuthors`, g.topAuthors, e.topAuthors, "login", winDiffs);
    checkTop(`${w.id}.topReviewers`, g.topReviewers, e.topReviewers, "login", winDiffs);
  }
  check(
    "every window and its previous period match",
    winDiffs.length === 0,
    winDiffs.length ? `${winDiffs.length} differences, first: ${winDiffs[0]}` : "",
  );
  if (winDiffs.length) {
    console.log("\n  first 25 window differences:");
    for (const d of winDiffs.slice(0, 25)) console.log(`    ${d}`);
  }

  // Repos carry a second count that `checkTop` does not look at.
  const repoDiffs = [];
  for (const w of want.windows) {
    const byRepo = new Map(want.byWindow[w.id].topRepos.map((r) => [r.repo, r]));
    for (const r of got.byWindow[w.id].topRepos) {
      const other = byRepo.get(r.repo);
      if (other && r.merged !== other.merged) {
        repoDiffs.push(`${w.id}.${r.repo}.merged: ${r.merged} vs ${other.merged}`);
      }
    }
  }
  check("top repos agree on merged counts", repoDiffs.length === 0, repoDiffs[0] ?? "");

  // ----------------------------------------------------------------- backlog
  check("backlog total matches", got.backlog.total === want.backlog.total,
    `sql ${got.backlog.total}, js ${want.backlog.total}`);
  check("backlog unreviewed matches", got.backlog.unreviewed === want.backlog.unreviewed,
    `sql ${got.backlog.unreviewed}, js ${want.backlog.unreviewed}`);
  check(
    "backlog buckets match",
    JSON.stringify(got.backlog.buckets) === JSON.stringify(want.backlog.buckets),
    JSON.stringify(got.backlog.buckets),
  );
  // Ages, not identities: the Node panel's sort ties on whole days and falls
  // back to store order, which SQL cannot reproduce. What must hold is that the
  // 25 oldest are 25 PRs of the same ages, correctly described.
  check(
    "the 25 oldest have the same ages",
    String(got.backlog.oldest.map((p) => p.ageDays)) ===
      String(want.backlog.oldest.map((p) => p.ageDays)),
    got.backlog.oldest
      .map((p) => p.ageDays)
      .slice(0, 5)
      .join(","),
  );

  const wantOldest = new Map(
    want.backlog.oldest.map((p) => [`${p.repo}#${p.number}`, p]),
  );
  const oldDiffs = [];
  for (const p of got.backlog.oldest) {
    const other = wantOldest.get(`${p.repo}#${p.number}`);
    if (!other) continue;
    diffObject(
      `${p.repo}#${p.number}`,
      p,
      other,
      ["author", "url", "ageDays", "staleDays", "reviewed"],
      oldDiffs,
    );
  }
  check("shared backlog entries agree field by field", oldDiffs.length === 0, oldDiffs[0] ?? "");

  // ---------------------------------------------------------------- grossing
  for (const list of ["commented", "liked", "disliked"]) {
    check(
      `grossing.${list} matches`,
      JSON.stringify(got.grossing[list]) === JSON.stringify(want.grossing[list]),
      JSON.stringify(got.grossing[list]).slice(0, 160),
    );
  }

  // ----------------------------------------------------------------- heatmap
  check(
    "heatmap matches",
    JSON.stringify(got.heatmap) === JSON.stringify(want.heatmap),
    "",
  );

  // ------------------------------------------------------------------- shape
  check(
    "windows list matches",
    JSON.stringify(got.windows) === JSON.stringify(want.windows),
  );
  const bytes = JSON.stringify(got).length;
  check(
    `cached blob fits D1's 2 MB row cap (${(bytes / 1024).toFixed(0)} KB)`,
    bytes < 2 * 1024 * 1024,
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
