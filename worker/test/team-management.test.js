/**
 *   node --experimental-sqlite worker/test/team-management.test.js
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { applyExclusionOp, changeExclusion, checkExclusionOp, readExclusions, reviewRequests, teamConfig, teamsState } from "../src/team-management.js";

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  ok ? (pass++, console.log("  ok    " + n))
     : (fail++, console.log("  FAIL  " + n + (d ? " — " + d : "")));
};

let racer = null;
const d1 = (raw) => ({
  prepare(sql) {
    let params = [];
    const api = {
      bind(...p) { params = p; return api; },
      async all() { return { results: raw.prepare(sql).all(...params) }; },
      async first() { return raw.prepare(sql).get(...params) ?? null; },
      async run() {
        if (racer && /^UPDATE meta/.test(sql)) { const r = racer; racer = null; r(); }
        return { meta: { changes: Number(raw.prepare(sql).run(...params).changes) } };
      },
    };
    return api;
  },
});

function database({ withoutMigration = false } = {}) {
  const raw = new DatabaseSync(":memory:");
  let schema = readFileSync("worker/schema.sql", "utf8");
  if (withoutMigration) schema = schema.replace("  team_review_requests TEXT NOT NULL DEFAULT '[]',\n", "");
  raw.exec(schema);
  const pr = raw.prepare(`INSERT INTO pull_requests (repo, number, title, author, created_at, updated_at, state, review_requests${withoutMigration ? "" : ", team_review_requests"})
    VALUES (?, ?, ?, 'someone', '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z', ?, ?${withoutMigration ? "" : ", ?"})`);
  const rows = [
    ["GT5-Unofficial", 1, "Waiting on rendering", "OPEN", "[]", "[501]"],
    ["GT5-Unofficial", 2, "Waiting on bob", "OPEN", '["bob"]', "[]"],
    ["GT5-Unofficial", 3, "Nobody asked", "OPEN", "[]", "[]"],
    ["GT5-Unofficial", 4, "Merged already", "MERGED", "[]", "[501]"],
    ["Secret-Thing", 5, "Hidden", "OPEN", "[]", "[501]"],
  ];
  for (const r of rows) pr.run(...(withoutMigration ? r.slice(0, 5) : r));
  return raw;
}

console.log("\nexclusions\n");
{
  check("a bad op is refused",
    checkExclusionOp({ panel: "nope", login: "a", on: true }) && checkExclusionOp({ panel: "inactive", login: "-x-", on: true }) &&
    checkExclusionOp({ panel: "inactive", login: "a", on: true, note: "x".repeat(201) }) && !checkExclusionOp({ panel: "hiatus", login: "a", on: false }));
  const once = applyExclusionOp({}, { panel: "inactive", login: "Dream-Master", on: true, note: " owner " }, { by: "UltraProdigy", at: "t1" });
  const twice = applyExclusionOp(once, { panel: "inactive", login: "dream-master", on: true }, { by: "boubou", at: "t2" });
  check("excluding someone records who, when and why", once.inactive["Dream-Master"].by === "UltraProdigy" && once.inactive["Dream-Master"].note === "owner");
  check("excluding them again under another case keeps one entry and the note",
    Object.keys(twice.inactive).length === 1 && twice.inactive["Dream-Master"].by === "boubou" && twice.inactive["Dream-Master"].note === "owner");
  check("taking them off works whatever the case", Object.keys(applyExclusionOp(twice, { panel: "inactive", login: "DREAM-MASTER", on: false }, {}).inactive).length === 0);

  const raw = new DatabaseSync(":memory:");
  raw.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
  const env = { DB: d1(raw) };
  check("nobody is excluded until someone is", JSON.stringify((await readExclusions(env)).exclusions) === '{"inactive":{},"hiatus":{}}');
  const a = await changeExclusion(env, "UltraProdigy", { panel: "inactive", login: "alice", on: true, note: "on leave" }, { now: Date.parse("2026-11-28T00:00:00Z") });
  racer = () => raw.prepare("UPDATE meta SET value = ? WHERE key = 'team_exclusions'").run(JSON.stringify({ inactive: { alice: { by: "x", at: "y", note: "" }, carol: { by: "boubou", at: "y", note: "" } } }));
  const b = await changeExclusion(env, "UltraProdigy", { panel: "hiatus", login: "bob", on: true }, { now: Date.parse("2026-11-28T00:01:00Z") });
  check("two admins changing it at once both land",
    a.status === 200 && b.status === 200 && "carol" in b.body.exclusions.inactive && "bob" in b.body.exclusions.hiatus, JSON.stringify(b.body));
  const read = await readExclusions(env);
  check("the stamp moves so open pages know", read.stamp === "2026-11-28T00:01:00.000Z");
  check("a bad change is a 400", (await changeExclusion(env, "x", { panel: "inactive", login: "", on: true })).status === 400);
}

console.log("\nreview requests\n");
{
  const env = { DB: d1(database()), NH_INGEST_EXCLUDE: "Secret-*" };
  const got = await reviewRequests(env);
  check("open pull requests waiting on a team or a person, and nothing else",
    got.teams && got.prs.map((p) => p.number).join() === "1,2", JSON.stringify(got.prs.map((p) => p.number)));
  check("teams come back as ids and people as logins", got.prs[0].teams[0] === 501 && got.prs[1].people[0] === "bob");
  const old = await reviewRequests({ DB: d1(database({ withoutMigration: true })) });
  check("without migration 013 it still answers, with people only, and says so", old.teams === false && old.prs.map((p) => p.number).join() === "2");
}

console.log("\nthe whole answer\n");
{
  const snap = {
    org: { login: "GTNewHorizons", members: { alice: "member", bob: "member" } },
    teams: { 10: { id: 10, slug: "developers", name: "Developers", members: { alice: "member", carol: "member" } } },
    repos: {},
  };
  const asked = [];
  const env = {
    DB: d1(database()),
    PERMISSIONS: { idFromName: (n) => n, get: () => ({ fetch: async (url) => {
      const p = new URL(url).pathname;
      asked.push(p);
      if (p === "/snapshot") return Response.json(snap);
      return Response.json({ historySince: "2026-11-02T00:00:00Z", history: [{ id: "h", kind: "added" }], since: { 10: { alice: "2026-11-03T00:00:00Z" } } });
    } }) },
    EVENT_LOG: { idFromName: (n) => n, get: () => ({ fetch: async (url, init) => Response.json(Object.fromEntries(JSON.parse(init.body).logins.map((l) => [l, { at: "x" }]))) }) },
  };
  const { status, body } = await teamsState(env);
  check("it answers with history, activity, last seen, requests and exclusions",
    status === 200 && body.history.length === 1 && body.since[10].alice && body.requests.prs.length === 3 && "inactive" in body.exclusions && body.problems.length === 0, JSON.stringify(body.problems));
  check("last seen is asked for every org member and every team member", Object.keys(body.seen).sort().join() === "alice,bob,carol");
  check("the team slugs default to GTNH's", body.config.developers === "developers" && body.config.hiatus === "developers-on-hiatus" && body.config.inactiveDays === 365 && body.config.returnDays === 30);
  check("and can be set per environment", teamConfig({ HIATUS_TEAM: "away", RETURN_DAYS: "14" }).hiatus === "away" && teamConfig({ RETURN_DAYS: "14" }).returnDays === 14);

  const broken = await teamsState({ ...env, EVENT_LOG: { idFromName: (n) => n, get: () => ({ fetch: async () => new Response("", { status: 500 }) }) } });
  check("one part failing still answers the rest, and names the part", broken.status === 200 && broken.body.problems[0]?.part === "seen" && broken.body.history.length === 1);
  const down = await teamsState({ ...env, PERMISSIONS: { idFromName: (n) => n, get: () => ({ fetch: async () => new Response("", { status: 500 }) }) } });
  check("without the snapshot there's nothing to show", down.status === 502);
  check("without the binding it says so", (await teamsState({ DB: env.DB })).status === 503);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
