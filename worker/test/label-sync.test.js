/**
 * The labelSync panel against a small hand-built store.
 *
 *   node --experimental-sqlite worker/test/label-sync.test.js
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

import { labelSync } from "../src/panels/label-sync.js";
import { scopedDb } from "../src/scope.js";

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
      async run() { return db.prepare(sql).run(...params); },
    };
    return api;
  },
});

function store() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const label = db.prepare("INSERT INTO labels (name, color, description, position) VALUES (?, ?, ?, ?)");
  label.run("Chore", "#C5DEF5", "Housekeeping", 1);
  label.run("Bug", "d73a4a", "Something is broken", 0);

  const repo = db.prepare("INSERT INTO repos (name, full_name, archived) VALUES (?, ?, ?)");
  for (const [name, archived] of [["Synced", 0], ["Drifted", 0], ["Unread", 0], ["Old", 1], ["Label-Sync-GTNH", 0], ["Secret", 0]]) {
    repo.run(name, `GTNewHorizons/${name}`, archived);
  }

  const rl = db.prepare("INSERT INTO repo_labels (repo, name, color, description) VALUES (?, ?, ?, ?)");
  rl.run("Synced", "Bug", "d73a4a", "Something is broken");
  rl.run("Synced", "Chore", "c5def5", "Housekeeping");
  rl.run("Synced", "wip", "ededed", "");
  rl.run("Drifted", "Bug", "ff0000", "Something is broken");
  rl.run("Drifted", "Dependencies", "cccccc", null);
  rl.run("Drifted", "WIP", "ededed", "");
  rl.run("Old", "Bug", "000000", "");
  rl.run("Old", "legacy", "000000", "");
  rl.run("Label-Sync-GTNH", "Bug", "d73a4a", "Something is broken");
  rl.run("Secret", "wip", "123456", "");
  rl.run("Ghost", "wip", "ededed", "");
  rl.run("Ghost", "WIP ", "ededed", "");
  return db;
}

const db = store();
const data = await labelSync(scopedDb(d1(db), { NH_INGEST_EXCLUDE: "Secret" }));
const repo = (name) => data.repos.find((r) => r.repo === name);

console.log("managed set");
check("in position order", data.managed.map((l) => l.name).join() === "Bug,Chore", data.managed.map((l) => l.name).join());
check("colours normalised", data.managed[1].color === "c5def5", data.managed[1].color);

console.log("\nrepos");
check("a synced repo has no actions", repo("Synced")?.actions.length === 0, JSON.stringify(repo("Synced")?.actions));
const drifted = repo("Drifted")?.actions ?? [];
check("a drifted repo would fix the colour and create the missing label",
  drifted.map((a) => `${a.type}:${a.name}`).join() === "update:Bug,create:Chore",
  drifted.map((a) => `${a.type}:${a.name}`).join());
check("the update says what it changes", drifted[0]?.before.color === "ff0000" && drifted[0]?.after.color === "d73a4a");
check("custom labels are kept apart from managed ones",
  repo("Drifted")?.custom.map((l) => l.name).join() === "Dependencies,WIP", repo("Drifted")?.custom.map((l) => l.name).join());
check("a repo with no labels read is not yet read, not missing everything",
  repo("Unread")?.read === false && repo("Unread")?.actions.length === 0);
check("an archived repo is skipped", repo("Old")?.skip === "archived" && repo("Old")?.actions.length === 0);
check("the source repo is skipped", repo("Label-Sync-GTNH")?.skip === "source");
check("a repo only repo_labels knows still appears", repo("Ghost")?.read === true);
check("an excluded repo never appears", !repo("Secret") && !JSON.stringify(data).includes("Secret"));

console.log("\nunmanaged inventory");
const wip = data.unmanaged.find((u) => u.name.toLowerCase() === "wip");
check("names group across case, each repo once", wip?.repos.length === 3, JSON.stringify(wip?.repos));
check("and each variant lists a repo once", wip?.variants[0]?.repos.length === 3, JSON.stringify(wip?.variants));
check("the most common spelling is shown", wip?.name === "wip", wip?.name);
check("busiest name first", data.unmanaged[0] === wip);
check("one variant when colours agree", wip?.variants.length === 1, JSON.stringify(wip?.variants));
check("managed names are not in the inventory", !data.unmanaged.some((u) => u.name === "Bug"));
check("archived repos are left out of the inventory", !data.unmanaged.some((u) => u.name === "legacy"));

{
  const empty = new DatabaseSync(":memory:");
  empty.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  empty.prepare("INSERT INTO repo_labels (repo, name, color) VALUES ('A', 'x', '000000')").run();
  const none = await labelSync(d1(empty));
  check("with no managed set nothing is planned", none.repos[0]?.actions.length === 0 && none.managed.length === 0);
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
