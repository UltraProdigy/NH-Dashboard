/**
 * How many rows D1 reads for the recompute and the routes that were once the
 * bill, measured with the `meta.rows_read` that local D1 reports, and failed
 * when any of them goes over its budget.
 *
 *   node worker/test/rows-read.test.js
 *
 * Skips if worker/seed.sql is absent, which it is in CI. When a change makes
 * something cheaper, lower its budget here so it cannot drift back.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { tmpdir } from "node:os";

import { recompute, refreshInstant } from "../src/recompute.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, "..");
const SEED = path.join(WORKER, "seed.sql");

const BUDGET = {
  fullBuild: 13_000_000,
  cleanTick: 100,
  instantPullRequest: 5_000,
  facets: 10,
};

let pass = 0;
let fail = 0;

function check(name, rows, budget) {
  const ok = rows <= budget;
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}: ${rows.toLocaleString()} rows (budget ${budget.toLocaleString()})`);
}

function counting(db) {
  const log = [];
  const note = (sql, meta) => log.push({ sql, rows: meta?.rows_read ?? 0 });
  const wrap = (sql, stmt) => ({
    bind: (...p) => wrap(sql, stmt.bind(...p)),
    async all() {
      const r = await stmt.all();
      note(sql, r.meta);
      return r;
    },
    async first(col) {
      const r = await stmt.all();
      note(sql, r.meta);
      const row = r.results[0] ?? null;
      return col ? (row?.[col] ?? null) : row;
    },
    async run() {
      const r = await stmt.run();
      note(sql, r.meta);
      return r;
    },
  });
  return {
    prepare: (sql) => wrap(sql, db.prepare(sql)),
    batch: (...a) => db.batch(...a),
    exec: (...a) => db.exec(...a),
    log,
    take() {
      const rows = log.reduce((n, q) => n + q.rows, 0);
      const top = [...log].sort((a, b) => b.rows - a.rows).slice(0, 5);
      log.length = 0;
      return { rows, top };
    },
  };
}

const statements = (file) =>
  readFileSync(path.join(WORKER, file), "utf8")
    .replace(/^\s*--.*$/gm, "")
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);

function showTop(top) {
  for (const q of top) {
    const first = q.sql.replace(/\s+/g, " ").trim().slice(0, 90);
    console.log(`          ${q.rows.toLocaleString().padStart(10)}  ${first}`);
  }
}

async function main() {
  if (!existsSync(SEED)) {
    console.log("\nskipped: needs worker/seed.sql, which is not committed\n");
    return;
  }

  const { getPlatformProxy } = await import("wrangler");
  const dir = mkdtempSync(path.join(tmpdir(), "nh-rows-read-"));
  const proxy = await getPlatformProxy({
    configPath: path.join(WORKER, "wrangler.toml"),
    persist: { path: dir },
  });

  try {
    const d1 = proxy.env.DB;
    const all = [...statements("schema.sql"), ...statements("seed.sql")];
    for (let i = 0; i < all.length; i += 50) {
      await d1.batch(all.slice(i, i + 50).map((s) => d1.prepare(s)));
    }

    const db = counting(d1);
    const env = { DB: db };

    console.log("\nrows read\n");

    await recompute(env, { force: true });
    const full = db.take();
    check("a full build", full.rows, BUDGET.fullBuild);
    showTop(full.top);

    const clean = await recompute(env);
    const tick = db.take();
    check(`a clean tick (${clean.skipped ?? "not skipped"})`, tick.rows, BUDGET.cleanTick);

    await refreshInstant(env, "pull_request");
    const instant = db.take();
    check("the instant refresh for a pull_request delivery", instant.rows, BUDGET.instantPullRequest);
    showTop(instant.top);

    const { default: worker } = await import("../src/index.js");
    const res = await worker.fetch(
      new Request("https://worker.test/api/search/facets"),
      env,
      { waitUntil() {} },
    );
    await res.text();
    check(`/api/search/facets (${res.status})`, db.take().rows, BUDGET.facets);
  } finally {
    await proxy.dispose();
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
