/**
 * The SQL CI-health panel, against `summarizeRuns`.
 *
 *   node --experimental-sqlite worker/test/ci-health.parity.test.js
 *
 * Written before the panel, which is the rule this repo has learned the hard
 * way five times over.
 *
 * This one can be a *true* parity test, which none of the others could. The
 * release cards compare a live GraphQL sweep against a half-filled store, so
 * their baseline had to be synthetic rules rather than the Node panel itself.
 * Here the Node arithmetic is `summarizeRuns(runs)` — a pure function over an
 * array of run objects — and the store holds those same runs as rows. So the
 * fixture is built once, handed to both implementations, and every field of the
 * output is compared. Same input, two readings, no room for "the data differed".
 *
 * That is worth having because the arithmetic is where this panel is most
 * likely to drift and least likely to look wrong. A median off by one position,
 * a denominator counting runs instead of timed runs, a span of zero where the
 * answer is null — each of those produces a plausible number.
 *
 * The fixtures are chosen for the cases the real store contains few of and the
 * ones a wrong implementation passes happily:
 *
 *   - a run whose `updated_at` GitHub bumped a year later
 *   - a repo whose entire sample is undecided (all cancelled)
 *   - a repo with exactly one run, which has no span
 *   - more runs than the sample takes, so the cap has to bite in both
 *   - an even and an odd count, because a median picks differently
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { summarizeOrg, summarizeRuns } from "../../src/panels/ciHealth.js";
import { CI_RUN_SAMPLE } from "../../src/config.js";
import {
  CI_MAX_RUN_MINUTES,
  runMinutes,
  runMinutesSql,
  spanBetween,
} from "../../src/shared/ci-rules.js";
import { ciHealth } from "../src/panels/ci-health.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = path.join(HERE, "..", "schema.sql");

const MINUTE = 60_000;
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
 * A D1 shim whose `bind` returns a *new* statement, as D1's does.
 *
 * Worth spelling out rather than mutating a shared object: the handlers shim
 * did the latter and every test chained `prepare().bind().run()` immediately,
 * so 31 assertions passed while the one caller that binds per row and batches
 * would have written the last row's parameters N times.
 */
const d1 = (db) => ({
  prepare(sql) {
    const at = (params) => ({
      bind: (...p) => at(p),
      async all() { return { results: db.prepare(sql).all(...params) }; },
      async first() { return db.prepare(sql).get(...params) ?? null; },
    });
    return at([]);
  },
});

function blank() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(SCHEMA, "utf8"));
  return db;
}

const NOW = Date.parse("2026-08-30T12:00:00Z");
const iso = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
const ago = (days) => iso(NOW - days * 86_400_000);

function addRepo(db, name, extra = {}) {
  db.prepare(
    `INSERT INTO repos (name, full_name, private, archived, default_branch, pushed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    name,
    `GTNewHorizons/${name}`,
    extra.private ? 1 : 0,
    extra.archived ? 1 : 0,
    extra.defaultBranch ?? "master",
    ago(1),
    ago(1),
  );
}

/**
 * One run, in both forms at once — inserted as a row and returned as the object
 * the API would have handed the Node panel. Returning both from one call is
 * what makes the two sides provably the same input rather than two fixtures
 * that were meant to match.
 */
let runCounter = 0;
function addRun(db, repo, { daysAgo, minutes, conclusion = "success", branch = "master", event = "push", name = "Build and test", updatedAt }) {
  const id = ++runCounter;
  const started = NOW - daysAgo * 86_400_000;
  const startedIso = iso(started);
  const updatedIso = updatedAt ?? iso(started + minutes * MINUTE);
  const url = `https://github.com/GTNewHorizons/${repo}/actions/runs/${id}`;

  db.prepare(
    `INSERT INTO workflow_runs (repo, run_id, name, head_branch, event, conclusion,
                                run_started_at, updated_at, html_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(repo, id, name, branch, event, conclusion, startedIso, updatedIso, url);

  return {
    id,
    name,
    head_branch: branch,
    event,
    conclusion,
    run_started_at: startedIso,
    updated_at: updatedIso,
    html_url: url,
  };
}

/** Compare one repo's SQL entry against summarizeRuns over the same runs. */
function compareRepo(label, sqlEntry, runs, branch = "master") {
  const want = { repo: sqlEntry?.repo, defaultBranch: branch, ...summarizeRuns(runs) };
  const fields = [
    "runs", "decisive", "failures", "passRate", "medianMinutes",
    "totalMinutes", "timedRuns", "sampleSpanDays", "defaultBranch",
  ];
  const diffs = fields.filter((f) => JSON.stringify(sqlEntry?.[f]) !== JSON.stringify(want[f]));
  check(
    `${label}: every field matches summarizeRuns`,
    diffs.length === 0,
    diffs.map((f) => `${f} sql=${JSON.stringify(sqlEntry?.[f])} js=${JSON.stringify(want[f])}`).join("; "),
  );
  const latestDiff =
    JSON.stringify(sqlEntry?.latest) !== JSON.stringify(want.latest);
  check(
    `${label}: latest run matches`,
    !latestDiff,
    `${JSON.stringify(sqlEntry?.latest)} vs ${JSON.stringify(want.latest)}`,
  );
  return want;
}

// ------------------------------------------------------------- the duration rule

console.log("\nthe duration ceiling, in both languages");

{
  const db = blank();
  addRepo(db, "Rule");

  // Spread across and around the ceiling, plus the two real artefacts measured
  // in production: a ~403-day gap from a bumped updated_at, and the exact
  // 24-hour mark where GitHub terminates a queued job.
  const cases = [0, 1, 4.5, 44.5, 359, 360, 360.5, 720, 1440, 580751];
  cases.forEach((m, i) => addRun(db, "Rule", { daysAgo: 300 - i, minutes: m }));

  const rows = db
    .prepare(
      `SELECT run_id, ${runMinutesSql("r")} AS mins FROM workflow_runs r
        WHERE repo = 'Rule' ORDER BY run_id`,
    )
    .all();

  const jsSaid = cases.map((m, i) =>
    runMinutes({
      run_started_at: iso(NOW - (300 - i) * 86_400_000),
      updated_at: iso(NOW - (300 - i) * 86_400_000 + m * MINUTE),
    }),
  );

  const disagreed = rows
    .map((r, i) => ({ mins: cases[i], sql: r.mins, js: jsSaid[i] }))
    .filter((x) => JSON.stringify(x.sql) !== JSON.stringify(x.js));

  check(
    `both readings agree on all ${cases.length} durations`,
    disagreed.length === 0,
    JSON.stringify(disagreed),
  );

  check(
    "the ceiling is inclusive on both sides",
    rows[cases.indexOf(360)].mins === 360 && rows[cases.indexOf(360.5)].mins === null,
    `360 -> ${rows[cases.indexOf(360)].mins}, 360.5 -> ${rows[cases.indexOf(360.5)].mins}`,
  );

  check(
    "the 24-hour queue artefact is discarded",
    rows[cases.indexOf(1440)].mins === null,
  );

  check(
    "a bumped updated_at is discarded rather than clamped",
    rows[cases.indexOf(580751)].mins === null,
    "clamping would invent a number and hide that it did",
  );

  check(
    `the ceiling is ${CI_MAX_RUN_MINUTES} minutes`,
    CI_MAX_RUN_MINUTES === 360,
  );

  db.close();
}

// ----------------------------------------------------------------- the panel

console.log("\nthe panel, against summarizeRuns on identical input");

{
  const db = blank();
  const runs = {};

  // An ordinary repo: an odd count, a mix of verdicts, one stale updated_at.
  addRepo(db, "Ordinary");
  runs.Ordinary = [
    addRun(db, "Ordinary", { daysAgo: 1, minutes: 5 }),
    addRun(db, "Ordinary", { daysAgo: 3, minutes: 11, conclusion: "failure" }),
    addRun(db, "Ordinary", { daysAgo: 9, minutes: 4 }),
    addRun(db, "Ordinary", { daysAgo: 20, minutes: 7, conclusion: "cancelled" }),
    // Started 400 days ago, touched yesterday. The artefact, in situ.
    addRun(db, "Ordinary", { daysAgo: 400, minutes: 0, updatedAt: ago(1) }),
  ];

  // An even count, so the median picks the upper of the middle pair.
  addRepo(db, "EvenCount");
  runs.EvenCount = [
    addRun(db, "EvenCount", { daysAgo: 2, minutes: 2 }),
    addRun(db, "EvenCount", { daysAgo: 4, minutes: 4 }),
    addRun(db, "EvenCount", { daysAgo: 6, minutes: 6 }),
    addRun(db, "EvenCount", { daysAgo: 8, minutes: 8 }),
  ];

  // Nothing decisive. passRate must be null rather than 0 — "no verdict" and
  // "all red" are opposite readings that must not render the same.
  addRepo(db, "NoVerdict");
  runs.NoVerdict = [
    addRun(db, "NoVerdict", { daysAgo: 1, minutes: 3, conclusion: "cancelled" }),
    addRun(db, "NoVerdict", { daysAgo: 2, minutes: 3, conclusion: "skipped" }),
    addRun(db, "NoVerdict", { daysAgo: 3, minutes: 3, conclusion: "action_required" }),
  ];

  // One run: no span, so no projection. Dividing by a zero span would report an
  // infinite run rate for the quietest repos in the org.
  addRepo(db, "SingleRun");
  runs.SingleRun = [addRun(db, "SingleRun", { daysAgo: 5, minutes: 6 })];

  // Every duration unbelievable: runs counted, timedRuns zero, totals null.
  addRepo(db, "AllStale");
  runs.AllStale = [
    addRun(db, "AllStale", { daysAgo: 500, minutes: 0, updatedAt: ago(2) }),
    addRun(db, "AllStale", { daysAgo: 520, minutes: 0, updatedAt: ago(3) }),
  ];

  // A repo that renamed its default branch. Runs on the old name are not this
  // repo's CI any more and must not be sampled.
  addRepo(db, "Renamed", { defaultBranch: "main" });
  runs.Renamed = [
    addRun(db, "Renamed", { daysAgo: 1, minutes: 5, branch: "main" }),
    addRun(db, "Renamed", { daysAgo: 2, minutes: 5, branch: "main" }),
  ];
  addRun(db, "Renamed", { daysAgo: 3, minutes: 99, branch: "master" });

  const got = await ciHealth(d1(db), NOW);

  const wants = {};
  for (const [repo, list] of Object.entries(runs)) {
    wants[repo] = compareRepo(repo, got.repos[repo], list, repo === "Renamed" ? "main" : "master");
  }

  check(
    "passRate is null with no decisive run, not zero",
    got.repos.NoVerdict?.passRate === null,
    String(got.repos.NoVerdict?.passRate),
  );
  check(
    "a single run has no span",
    got.repos.SingleRun?.sampleSpanDays === null,
    String(got.repos.SingleRun?.sampleSpanDays),
  );
  check(
    "an all-stale repo counts its runs and times none of them",
    got.repos.AllStale?.runs === 2 &&
      got.repos.AllStale?.timedRuns === 0 &&
      got.repos.AllStale?.totalMinutes === null &&
      got.repos.AllStale?.medianMinutes === null,
    JSON.stringify(got.repos.AllStale),
  );
  check(
    "runs on a former default branch are not sampled",
    got.repos.Renamed?.runs === 2,
    String(got.repos.Renamed?.runs),
  );

  db.close();

  // ------------------------------------------------------------ the roll-up

  console.log("\nthe org roll-up");

  const orgWant = summarizeOrg(wants);
  const diffs = Object.keys(orgWant).filter(
    (k) => JSON.stringify(got.org[k]) !== JSON.stringify(orgWant[k]),
  );
  check(
    "every org field matches summarizeOrg",
    diffs.length === 0,
    diffs.map((k) => `${k} sql=${JSON.stringify(got.org[k])} js=${JSON.stringify(orgWant[k])}`).join("; "),
  );
}

// ------------------------------------------------------------ the sample cap

console.log("\nthe sample cap");

{
  const db = blank();
  addRepo(db, "Busy");

  // Thirty runs of increasing duration, newest last. The cap must take the
  // newest CI_RUN_SAMPLE and both sides must take the same ones — a cap applied
  // to a differently-ordered set produces a plausible median from wrong rows.
  const all = [];
  for (let i = 30; i >= 1; i--) {
    all.push(addRun(db, "Busy", { daysAgo: i, minutes: i }));
  }
  const newest = [...all]
    .sort((a, b) => Date.parse(b.run_started_at) - Date.parse(a.run_started_at))
    .slice(0, CI_RUN_SAMPLE);

  const got = await ciHealth(d1(db), NOW);

  check(
    `the sample is capped at ${CI_RUN_SAMPLE}`,
    got.repos.Busy?.runs === CI_RUN_SAMPLE,
    String(got.repos.Busy?.runs),
  );
  compareRepo("Busy", got.repos.Busy, newest);
  check(
    "the newest run is the latest, not the oldest",
    got.repos.Busy?.latest?.url === newest[0].html_url,
  );

  db.close();
}

// ---------------------------------------------------- what must not appear

console.log("\nrepos that must not appear");

{
  const db = blank();

  // No runs at all. The Node panel skips these outright — `if (!runs.length)
  // continue` — and a zero-run entry here would show as a repo with no verdict
  // rather than a repo with no CI.
  addRepo(db, "NoRuns");

  // Archived, with runs. Every other panel drops archived repos.
  addRepo(db, "Archived", { archived: true });
  addRun(db, "Archived", { daysAgo: 1, minutes: 5 });

  // A repo with runs but no row in `repos`. The store cannot know its default
  // branch, so it cannot know which runs count.
  addRun(db, "Unknown", { daysAgo: 1, minutes: 5 });

  const got = await ciHealth(d1(db), NOW);

  check("a repo with no runs is absent", !got.repos.NoRuns);
  check("an archived repo is absent", !got.repos.Archived);
  check("a repo with no repos row is absent", !got.repos.Unknown);
  check(
    "an empty panel still carries an org roll-up",
    got.org && got.org.repos === 0,
    JSON.stringify(got.org),
  );

  db.close();
}

// ----------------------------------------------------------------- the span

console.log("\nspan arithmetic");

check(
  "a span is measured oldest to newest",
  spanBetween("2026-08-01T00:00:00Z", "2026-08-31T00:00:00Z") === 30,
);
check(
  "a zero-width span is null, not zero",
  spanBetween("2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z") === null,
  "zero is the value that divides",
);
check(
  "a reversed span is null rather than negative",
  spanBetween("2026-08-31T00:00:00Z", "2026-08-01T00:00:00Z") === null,
);

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
