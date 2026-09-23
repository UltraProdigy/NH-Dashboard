/**
 * The recompute's contract, against a real seed.
 *
 * Checks the parts that are easy to get subtly wrong and impossible to notice
 * afterwards: that a clean database is skipped rather than rebuilt, that a
 * write rebuilds only the panels reading that table, that the cached blob is
 * what the panel produced, that `version` is bumped exactly once, and that a
 * panel throwing does not take the run down and is retried on the next tick.
 *
 *   node --experimental-sqlite worker/test/recompute.test.js
 *
 * Skips if worker/seed.sql is absent, which it is in CI.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { tmpdir } from "node:os";

import { recompute, refreshInstant } from "../src/recompute.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(HERE, "..", "seed.sql");
const SCHEMA = path.join(HERE, "..", "schema.sql");

let pass = 0;
let fail = 0;

function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ok    ${name}`);
  } else {
    fail++;
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
        async run() {
          return db.prepare(sql).run(...params);
        },
      };
      return api;
    },
  };
}

function load() {
  const file = path.join(tmpdir(), `nh-recompute-${process.pid}.db`);
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

const get = (db, key) =>
  db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value;

const touch = (db, table) =>
  db
    .prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    )
    .run(`wrote:${table}`, new Date().toISOString());

const stamps = (db) =>
  new Map(
    db.prepare("SELECT name, computed_at FROM panel_cache").all()
      .map((r) => [r.name, r.computed_at]),
  );

const sameSet = (a, b) => [...a].sort().join() === [...b].sort().join();

async function main() {
  if (!existsSync(SEED)) {
    console.log("\nskipped: needs worker/seed.sql, which is not committed\n");
    return;
  }

  console.log("\nrecompute\n");
  const { db, file } = load();
  const env = { DB: d1(db) };

  console.log("an empty cache builds every panel");
  const run = await recompute(env);
  check("contributors was built", !!run.built?.contributors);
  check("analytics was built", !!run.built?.analytics);
  check("every panel was built", Object.keys(run.built ?? {}).length === 11,
        Object.keys(run.built ?? {}).join());
  check("nothing failed", Object.keys(run.failed ?? {}).length === 0, JSON.stringify(run.failed));
  for (const [name, r] of Object.entries(run.built ?? {})) {
    console.log(`        ${name}: ${(r.bytes / 1024).toFixed(0)} KB in ${r.ms}ms`);
  }
  check("version bumped to 1", get(db, "version") === "1", get(db, "version"));
  check("checked_at recorded", get(db, "checked_at") === run.at);

  const row = db.prepare("SELECT json, computed_at, ms FROM panel_cache WHERE name = 'contributors'").get();
  check("blob was cached", !!row?.json);
  const parsed = JSON.parse(row.json);
  check("blob parses and has rows", Array.isArray(parsed.rows) && parsed.rows.length > 0, `${parsed.rows?.length} rows`);
  check("blob under the 2MB row cap", row.json.length < 2_000_000, `${(row.json.length / 1024).toFixed(0)} KB`);
  console.log(`        (${(row.json.length / 1024).toFixed(0)} KB, built in ${row.ms}ms)`);

  console.log("\nnothing written since is left alone");
  const clean = await recompute(env);
  check("skipped when nothing was written", clean.skipped === "clean");
  check("version held at 1", get(db, "version") === "1", get(db, "version"));
  check("checked_at still moves", get(db, "checked_at") === clean.at);

  console.log("\nforce rebuilds a clean database");
  const forced = await recompute(env, { force: true });
  check("force ignores the stamps", !forced.skipped && Object.keys(forced.built).length === 11);
  check("version bumped again", get(db, "version") === "2", get(db, "version"));

  console.log("\na write rebuilds only the panels that read that table");
  let snap = stamps(db);
  touch(db, "workflow_runs");
  const ci = await recompute(env);
  check("a CI run rebuilds only ciHealth", sameSet(Object.keys(ci.built), ["ciHealth"]),
        Object.keys(ci.built).join());
  check("and moves nothing", ci.changed === false);
  check("version held at 2", get(db, "version") === "2", get(db, "version"));
  const now1 = stamps(db);
  check("analytics kept its old computed_at", now1.get("analytics") === snap.get("analytics"));

  touch(db, "labels");
  const labels = await recompute(env);
  check("a label rebuilds the three panels that colour by it",
        sameSet(Object.keys(labels.built), ["approvedUnmerged", "changesRequested", "byLabel"]),
        Object.keys(labels.built).join());

  touch(db, "repo_labels");
  check("a table no panel reads rebuilds nothing", (await recompute(env)).skipped === "clean");

  console.log("\na write the subjects fold from bumps even with identical blobs");
  touch(db, "issues");
  const subjects = await recompute(env);
  check("an issue rebuilds the panels that read issues",
        sameSet(Object.keys(subjects.built), ["contributors", "issues", "drilldown", "repos"]),
        Object.keys(subjects.built).join());
  check("reports a change", subjects.changed === true);
  check("version bumped to 3", get(db, "version") === "3", get(db, "version"));
  check("and only once", (await recompute(env)).skipped === "clean" && get(db, "version") === "3");

  console.log("\na quiet panel is still rebuilt once it is an hour old");
  const old = new Date(Date.now() - 2 * 3_600_000).toISOString();
  db.prepare("UPDATE panel_cache SET computed_at = ? WHERE name = 'depUpdates'").run(old);
  const aged = await recompute(env);
  check("only the old panel rebuilt", sameSet(Object.keys(aged.built), ["depUpdates"]),
        Object.keys(aged.built).join());

  console.log("\na moved blob bumps on its own");
  touch(db, "workflow_runs");
  db.prepare("UPDATE panel_cache SET json = '[]' WHERE name = 'ciHealth'").run();
  const moved = await recompute(env);
  check("reports a change", moved.changed === true);
  check("version bumped to 4", get(db, "version") === "4", get(db, "version"));

  console.log("\na failing panel does not strand the run");
  touch(db, "pull_requests");
  snap = stamps(db);
  const broken = {
    DB: {
      prepare(sql) {
        // Break only the panel's first query, leaving the meta reads and
        // writes intact — a panel bug, not a database outage.
        if (sql.includes("FROM pull_requests\n     WHERE author IS NOT NULL")) {
          throw new Error("simulated panel failure");
        }
        return d1(db).prepare(sql);
      },
    },
  };
  const afterFail = await recompute(broken);
  check("failure is reported", !!afterFail.failed?.contributors);
  check("the other panels still built", !!afterFail.built?.analytics);
  check("previous blob still served", !!db.prepare("SELECT json FROM panel_cache WHERE name='contributors'").get()?.json);
  check("and keeps its old computed_at", stamps(db).get("contributors") === snap.get("contributors"));
  const retry = await recompute(env);
  check("the next tick retries only the failed panel",
        sameSet(Object.keys(retry.built), ["contributors"]), Object.keys(retry.built).join());

  console.log("\nthe instant path rebuilds only the cheap panels");
  // The delivery path rebuilds the instant tier and leaves the rest to the
  // cron, so the thing to assert is what it does *not* touch: an analytics blob
  // that still carries its old timestamp is the evidence that the expensive
  // panel was skipped rather than quietly rebuilt on every webhook.
  const before = db
    .prepare("SELECT name, computed_at, ms FROM panel_cache ORDER BY name")
    .all();
  await new Promise((r) => setTimeout(r, 1100));
  const built = await refreshInstant(env);

  check("approvedUnmerged rebuilt", "approvedUnmerged" in built);
  check("changesRequested rebuilt", "changesRequested" in built);
  check("needsRelease rebuilt", "needsRelease" in built);
  check("analytics not rebuilt", !("analytics" in built));
  check("contributors not rebuilt", !("contributors" in built));
  check("depUpdates not rebuilt", !("depUpdates" in built));

  const after = new Map(
    db.prepare("SELECT name, computed_at FROM panel_cache").all()
      .map((r) => [r.name, r.computed_at]),
  );
  const wasAnalytics = before.find((r) => r.name === "analytics")?.computed_at;
  check("the expensive blob is untouched", after.get("analytics") === wasAnalytics);
  check(
    "the cheap blobs moved",
    after.get("approvedUnmerged") !==
      before.find((r) => r.name === "approvedUnmerged")?.computed_at,
  );

  console.log("\nan event only rebuilds the panels it can move");
  // The whole reason the events are per panel: a push must not spend the review
  // cards' ~120ms recomputing an answer it cannot have changed, and a pull
  // request must not spend needsRelease's.
  const onPush = await refreshInstant(env, "push");
  check("push rebuilds needsRelease", "needsRelease" in onPush);
  check("push leaves approvedUnmerged alone", !("approvedUnmerged" in onPush));
  check("push leaves changesRequested alone", !("changesRequested" in onPush));

  const onPr = await refreshInstant(env, "pull_request");
  check("pull_request rebuilds approvedUnmerged", "approvedUnmerged" in onPr);
  check("pull_request rebuilds changesRequested", "changesRequested" in onPr);
  check("pull_request leaves needsRelease alone", !("needsRelease" in onPr));

  check("an event no instant panel wants builds nothing",
        Object.keys(await refreshInstant(env, "workflow_run")).length === 0);

  console.log("\nthe version moves only when an answer does");
  // A bump costs every open dashboard a nine-panel overlay and discards both
  // drilldown subject caches, so a rebuild that produced the same bytes must
  // not spend one. Everything above has just rebuilt these panels against an
  // unchanging seed, so nothing can have moved.
  const versionBefore = Number(get(db, "version"));
  await refreshInstant(env, "pull_request");
  await refreshInstant(env, "push");
  check("an unchanged rebuild does not bump",
        Number(get(db, "version")) === versionBefore,
        `${versionBefore} -> ${get(db, "version")}`);

  // Now make the answer genuinely different. Merging the pull request the card
  // ranks first drops it off, which is a real change in what the panel says
  // rather than a poked blob.
  //
  // Driven through a review card rather than through `needsRelease`, which
  // would be the more pointed test and cannot be written here: `seed.sql` never
  // wrote a `repos`, `commits` or `releases` row, so that panel builds an empty
  // blob against this fixture and nothing done to the seed can move it.
  const top = JSON.parse(
    db.prepare("SELECT json FROM panel_cache WHERE name='approvedUnmerged'")
      .get().json,
  )[0];
  if (top) {
    db.prepare(
      "UPDATE pull_requests SET state = 'MERGED', merged_at = ? WHERE repo = ? AND number = ?",
      // The rendered row carries `owner/name`; the column holds the bare name.
    ).run(new Date().toISOString(), top.repo.split("/").pop(), top.number);
    await refreshInstant(env, "pull_request");
    check("a changed rebuild bumps",
          Number(get(db, "version")) === versionBefore + 1,
          `${versionBefore} -> ${get(db, "version")}`);
  } else {
    check("a changed rebuild bumps", false, "seed has no approvedUnmerged rows");
  }

  // The stamp must survive: the cron still owes the other panels a rebuild.
  touch(db, "pull_requests");
  await refreshInstant(env, "pull_request");
  const owed = await recompute(env);
  check("the cron still rebuilds the rest after an instant refresh",
        !!owed.built?.analytics && !!owed.built?.byLabel);

  const totalMs = Object.values(built).reduce((n, v) => n + v, 0);
  check(`the instant tier is inside a delivery's budget (${totalMs}ms local)`,
        totalMs < 2000, "GitHub allows 10s, and waitUntil runs after the 200");

  db.close();
  try {
    unlinkSync(file);
  } catch {}

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
