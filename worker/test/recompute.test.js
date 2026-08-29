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

import { recompute } from "../src/recompute.js";

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
