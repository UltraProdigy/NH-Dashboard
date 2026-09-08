/**
 * The recompute's contract, against a real seed.
 *
 * Checks the parts that are easy to get subtly wrong and impossible to notice
 * afterwards: that a clean database is skipped rather than rebuilt, that the
 * cached blob is what the panel produced, that `dirty` is cleared and `version`
 * bumped exactly once, and that a panel throwing does not take the run down or
 * strand `dirty` set forever.
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

const setDirty = (db, v) =>
  db.prepare("UPDATE meta SET value = ? WHERE key = 'dirty'").run(String(v));
const get = (db, key) =>
  db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value;

async function main() {
  if (!existsSync(SEED)) {
    console.log("\nskipped: needs worker/seed.sql, which is not committed\n");
    return;
  }

  console.log("\nrecompute\n");
  const { db, file } = load();
  const env = { DB: d1(db) };

  console.log("a clean database is left alone");
  setDirty(db, 0);
  const clean = await recompute(env);
  check("skipped when not dirty", clean.skipped === "clean");
  check("version not bumped", get(db, "version") === "0");
  check("nothing cached", db.prepare("SELECT COUNT(*) n FROM panel_cache").get().n === 0);

  console.log("\na dirty database rebuilds");
  setDirty(db, 1);
  const run = await recompute(env);
  check("contributors was built", !!run.built?.contributors);
  check("analytics was built", !!run.built?.analytics);
  check("nothing failed", Object.keys(run.failed ?? {}).length === 0, JSON.stringify(run.failed));
  for (const [name, r] of Object.entries(run.built ?? {})) {
    console.log(`        ${name}: ${(r.bytes / 1024).toFixed(0)} KB in ${r.ms}ms`);
  }
  check("dirty cleared", get(db, "dirty") === "0");
  check("version bumped to 1", get(db, "version") === "1", get(db, "version"));

  const row = db.prepare("SELECT json, computed_at, ms FROM panel_cache WHERE name = 'contributors'").get();
  check("blob was cached", !!row?.json);
  const parsed = JSON.parse(row.json);
  check("blob parses and has rows", Array.isArray(parsed.rows) && parsed.rows.length > 0, `${parsed.rows?.length} rows`);
  check("blob under the 2MB row cap", row.json.length < 2_000_000, `${(row.json.length / 1024).toFixed(0)} KB`);
  console.log(`        (${(row.json.length / 1024).toFixed(0)} KB, built in ${row.ms}ms)`);

  console.log("\nforce rebuilds a clean database");
  const forced = await recompute(env, { force: true });
  check("force ignores the dirty flag", !forced.skipped);
  check("version bumped again", get(db, "version") === "2", get(db, "version"));

  console.log("\na failing panel does not strand the run");
  setDirty(db, 1);
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
  // The claim in recompute.js that one panel failing does not cost the others
  // their rebuild is only assertable now that there is more than one panel.
  check("the other panels still built", !!afterFail.built?.analytics);
  check("dirty still cleared", get(db, "dirty") === "0");
  check("previous blob still served", !!db.prepare("SELECT json FROM panel_cache WHERE name='contributors'").get()?.json);

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

  // `dirty` must survive: the cron still owes the other panels a rebuild.
  setDirty(db, 1);
  await refreshInstant(env, "pull_request");
  check("dirty is left set for the cron", get(db, "dirty") === "1");

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
