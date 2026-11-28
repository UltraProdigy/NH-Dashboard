/**
 *   node --experimental-sqlite worker/test/dream-filters.test.js
 */

import { DatabaseSync } from "node:sqlite";
import { changeDreamFilter, dreamFilters } from "../src/dream-filters.js";
import { applyFilterOp, checkFilterOp, normaliseFilters } from "../../web/js/dream-filter-rules.js";

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  ok ? (pass++, console.log("  ok    " + n))
     : (fail++, console.log("  FAIL  " + n + (d ? " — " + d : "")));
};

const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
let racer = null;
const d1 = {
  prepare(sql) {
    let params = [];
    const api = {
      bind(...p) { params = p; return api; },
      async first() { return db.prepare(sql).get(...params) ?? null; },
      async run() {
        if (racer && /^UPDATE meta/.test(sql)) { const r = racer; racer = null; r(); }
        return { meta: { changes: Number(db.prepare(sql).run(...params).changes) } };
      },
    };
    return api;
  },
};
const env = { DB: d1 };

console.log("\nthe rules\n");
check("unknown panels and kinds are dropped", JSON.stringify(normaliseFilters({ x: { repos: ["a"] }, updates: { labels: ["l"], repos: ["r", "r", 5] } }).updates) === '{"repos":["r"],"labels":[]}');
check("a bad op is refused", checkFilterOp({ panel: "updates", kind: "labels", name: "x", on: true }) && checkFilterOp({ panel: "updates", kind: "repos", name: "", on: true }) && !checkFilterOp({ panel: "updates", kind: "repos", clear: true }));
check("adding twice keeps one", applyFilterOp(applyFilterOp({}, { panel: "updates", kind: "repos", name: "A", on: true }), { panel: "updates", kind: "repos", name: "A", on: true }).updates.repos.length === 1);

console.log("\nshared writes\n");
await changeDreamFilter(env, { panel: "needsRelease", kind: "repos", name: "A", on: true });
racer = () => db.prepare("UPDATE meta SET value = ? WHERE key = 'dream_filters'").run(JSON.stringify(applyFilterOp(JSON.parse(db.prepare("SELECT value FROM meta WHERE key = 'dream_filters'").get().value), { panel: "needsRelease", kind: "repos", name: "B", on: true })));
const res = await changeDreamFilter(env, { panel: "needsRelease", kind: "repos", name: "C", on: true });
check("an edit that lands mid-write isn't lost, and neither is this one", res.status === 200 && res.body.filters.needsRelease.repos.join() === "A,B,C", JSON.stringify(res.body));
check("reads agree", (await dreamFilters(env)).body.filters.needsRelease.repos.join() === "A,B,C");
db.prepare("UPDATE meta SET value = 'not json' WHERE key = 'dream_filters'").run();
check("a corrupt value reads as empty rather than breaking the page", (await dreamFilters(env)).body.filters.needsRelease.repos.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
