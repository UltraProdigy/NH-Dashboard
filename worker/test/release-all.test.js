/**
 *   node --experimental-sqlite worker/test/release-all.test.js
 *
 * Release All from the Dream Panel: the tag predictor, what it learns, and the
 * tags it makes, against a real SQLite database and a stubbed GitHub.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { releaseAll, releaseAllPreview } from "../src/release-all.js";
import { learnRule, predictTag, ruleFrom } from "../src/release-tags.js";
import { forgetToken } from "../src/github.js";
import { forgetOrgManagerToken } from "../src/org-manager.js";

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(
    `  ${ok ? "ok  " : "FAIL"}  ${name}` +
      (ok ? "" : `\n          expected ${JSON.stringify(expected)}\n          got      ${JSON.stringify(actual)}`),
  );
}

console.log("\npredicting a tag");
check("bumps the last number", predictTag("2.7.5"), "2.7.6");
check("counts up from a -pre and drops it", predictTag("2.7.5-pre"), "2.7.6");
check("keeps leading zeros and long versions", predictTag("5.09.54.243"), "5.09.54.244");
check("keeps a v prefix", predictTag("v1.2.9"), "v1.2.10");
check("pads a zero-padded last number", predictTag("1.07"), "1.08");
check("keeps a suffix", predictTag("1.1.71-GTNH"), "1.1.72-GTNH");
check("bumps the last number when words come first", predictTag("rv3-beta-1091-GTNH"), "rv3-beta-1092-GTNH");
check("a -pre after a suffix", predictTag("1.1.71-GTNH-pre"), "1.1.72-GTNH");
check("gives up on a tag with no number", predictTag("latest"), null);
check("follows a learned minor bump", predictTag("1.4.47", { fromEnd: 1, step: 1 }), "1.5.0");
check("falls back when a rule doesn't fit", predictTag("1.2", { fromEnd: 5, step: 1 }), "1.3");

console.log("\nlearning from a correction");
check("a minor bump", learnRule("1.4.47", "1.5.0"), { fromEnd: 1, step: 1 });
check("a major bump", learnRule("1.4.47", "2.0.0"), { fromEnd: 2, step: 1 });
check("a skipped number teaches nothing", learnRule("1.4.47", "1.4.49"), null);
check("an odd jump teaches nothing", learnRule("1.4.47", "1.5.3"), null);
check("a -pre teaches nothing", learnRule("1.4.47", "1.5.0-pre"), null);
check("a format change teaches nothing", learnRule("1.4", "1.4.1"), null);
check("a suffix change teaches nothing", learnRule("1.4.47", "1.5.0-GTNH"), null);
check("a bump under a suffix", learnRule("1.1.71-GTNH", "1.2.0-GTNH"), { fromEnd: 1, step: 1 });
check(
  "the newest learnable correction wins",
  ruleFrom([
    { previous_tag: "1.5.0", tag: "1.5.9" },
    { previous_tag: "1.4.47", tag: "1.5.0" },
    { previous_tag: "1.3.2", tag: "2.0.0" },
  ]),
  { fromEnd: 1, step: 1 },
);

const raw = new DatabaseSync(":memory:");
raw.exec(readFileSync("worker/schema.sql", "utf8"));
const statement = (sql) => {
  let bound = [];
  const api = {
    bind: (...args) => ((bound = args), api),
    async run() { raw.prepare(sql).run(...bound); return { success: true }; },
    async first() { return raw.prepare(sql).get(...bound) ?? null; },
    async all() { return { results: raw.prepare(sql).all(...bound) }; },
  };
  return api;
};
const db = { prepare: statement, async batch(list) { for (const s of list) await s.run(); return []; } };
const feedback = () => raw.prepare("SELECT repo, previous_tag, predicted_tag, tag, wrong, released_by FROM release_tag_feedback ORDER BY id").all().map((r) => ({ ...r }));
const log = () => JSON.parse(raw.prepare("SELECT value FROM meta WHERE key = 'release_all_log'").get()?.value ?? "[]");

const pair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
const PEM = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----\n`;

const env = {
  DB: db,
  GITHUB_ORG: "GTNewHorizons",
  GH_APP_ID: "4745300",
  GH_APP_PRIVATE_KEY: PEM,
  ORG_MANAGER_APP_ID: "5299242",
  ORG_MANAGER_PRIVATE_KEY: PEM,
};

const CALLER = "jobs:\n  release-tags:\n    uses: GTNewHorizons/GTNH-Actions-Workflows/.github/workflows/release-tags.yml@master\n";
const sha = (c) => c.repeat(40);
const repo = (name, { releases = [], tags = [], caller = CALLER, head = sha("a") } = {}) => ({
  name,
  defaultBranchRef: { name: "master", target: { oid: head } },
  releases: { nodes: releases.map((tagName) => ({ tagName, isDraft: false })) },
  refs: { nodes: tags.map((n) => ({ name: n })) },
  caller: caller ? { text: caller } : null,
});

let github = {};
let calls = [];
let refStatus = {};

const issuer = (auth) => {
  try { return JSON.parse(Buffer.from(auth.replace("Bearer ", "").split(".")[1], "base64url")).iss; } catch { return null; }
};

globalThis.fetch = async (url, init = {}) => {
  const path = String(url).replace("https://api.github.com", "");
  const method = init.method ?? "GET";
  const auth = init.headers?.Authorization ?? "";
  if (path === "/orgs/GTNewHorizons/installation") return Response.json({ id: issuer(auth) === "5299242" ? 2 : 1 });
  const minted = path.match(/^\/app\/installations\/(\d)\/access_tokens$/);
  if (minted) {
    return Response.json({
      token: minted[1] === "2" ? "ghs_org_manager" : "ghs_dashbot",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
  }
  const token = auth.replace("Bearer ", "");
  if (path === "/graphql") {
    const { query } = JSON.parse(init.body);
    calls.push(`graphql ${token}`);
    const data = {};
    for (const [, alias, name] of query.matchAll(/(r\d+): repository\(owner: \$org, name: "([^"]+)"\)/g)) {
      data[alias] = github[name] ?? null;
    }
    return Response.json({ data });
  }
  const ref = path.match(/^\/repos\/GTNewHorizons\/([^/]+)\/git\/refs$/);
  if (ref && method === "POST") {
    calls.push(`POST ${ref[1]} ${token} ${init.body}`);
    const status = refStatus[ref[1]] ?? 201;
    if (status === 422) return new Response('{"message":"Reference already exists"}', { status });
    return new Response(status === 201 ? "{}" : "Resource not accessible by integration", { status });
  }
  return new Response("not stubbed", { status: 404 });
};

const T0 = Date.parse("2026-10-24T12:00:00Z");

console.log("\nthe preview");
github = {
  GTNHLib: repo("GTNHLib", { releases: ["0.11.54"], tags: ["0.11.54", "0.11.53"] }),
  StructureLib: repo("StructureLib", { releases: ["latest", "1.4.47"], tags: ["latest", "1.4.47"] }),
  Navigator: repo("Navigator", { releases: ["1.2.0-pre"], tags: ["1.2.0-pre"] }),
  Failed: repo("Failed", { releases: ["2.0.3"], tags: ["2.0.4", "2.0.3"] }),
  NoWorkflow: repo("NoWorkflow", { releases: ["1.0.0"], tags: ["1.0.0"], caller: null }),
};
calls = [];
{
  const out = await releaseAllPreview(env, ["GTNHLib", "StructureLib", "Navigator", "Failed", "NoWorkflow", "Gone", "bad name!"]);
  const by = Object.fromEntries(out.body.repos.map((r) => [r.repo, r]));
  check("answers 200", out.status, 200);
  check("reads GitHub as NH-Dashbot", calls, ["graphql ghs_dashbot"]);
  check("drops names that aren't repo names", out.body.repos.length, 6);
  check("predicts from the newest release", [by.GTNHLib.lastTag, by.GTNHLib.predicted, by.GTNHLib.sha], ["0.11.54", "0.11.55", sha("a")]);
  check("skips a release that isn't a version", [by.StructureLib.lastTag, by.StructureLib.predicted], ["1.4.47", "1.4.48"]);
  check("counts up from a -pre", [by.Navigator.predicted, by.Navigator.lastWasPre], ["1.2.1", true]);
  check("steps past a tag that already exists", [by.Failed.predicted, by.Failed.skipped], ["2.0.5", ["2.0.4"]]);
  check("flags a repo with no release workflow", [by.NoWorkflow.workflow, by.NoWorkflow.notes.length], [false, 1]);
  check("flags a repo GitHub doesn't know", Boolean(by.Gone.problem), true);
  check("no stats yet", out.body.stats, { total: 0, matched: 0, wrong: 0 });
}
{
  const out = await releaseAllPreview(env, []);
  check("an empty list is a 400", out.status, 400);
}

console.log("\nreleasing");
calls = [];
{
  const out = await releaseAll(env, "admin@example.com", [
    { repo: "GTNHLib", tag: "0.11.55", sha: sha("a"), previous: "0.11.54", predicted: "0.11.55", wrong: true },
    { repo: "StructureLib", tag: "1.5.0", sha: sha("b"), previous: "1.4.47", predicted: "1.4.48", wrong: true },
    { repo: "Navigator", tag: "2.0.0", sha: sha("c"), previous: "1.2.0-pre", predicted: "1.2.1", wrong: false },
  ], { now: T0 });
  check("answers 200", out.status, 200);
  check(
    "creates each tag at its pinned commit, as Org-Manager",
    calls,
    [
      `POST GTNHLib ghs_org_manager {"ref":"refs/tags/0.11.55","sha":"${sha("a")}"}`,
      `POST StructureLib ghs_org_manager {"ref":"refs/tags/1.5.0","sha":"${sha("b")}"}`,
      `POST Navigator ghs_org_manager {"ref":"refs/tags/2.0.0","sha":"${sha("c")}"}`,
    ],
  );
  check(
    "keeps every release, but only a changed and ticked one as wrong",
    feedback().map((r) => [r.repo, r.tag, r.wrong]),
    [["GTNHLib", "0.11.55", 0], ["StructureLib", "1.5.0", 1], ["Navigator", "2.0.0", 0]],
  );
  check("logs who pressed it", log()[0], { at: "2026-10-24T12:00:00.000Z", by: "admin@example.com", created: 3, failed: 0 });
}

console.log("\nthe cooldown");
calls = [];
{
  const out = await releaseAll(env, "other@example.com", [{ repo: "GTNHLib", tag: "0.11.56", sha: sha("a") }], { now: T0 + 30_000 });
  check("a second run within two minutes is refused", [out.status, out.body.error], [429, "admin@example.com ran Release All 30s ago"]);
  check("and tags nothing", calls, []);
}

console.log("\nwhat it learned");
github.StructureLib = repo("StructureLib", { releases: ["1.5.0"], tags: ["1.5.0", "1.4.47"] });
{
  const out = await releaseAllPreview(env, ["StructureLib", "Navigator"]);
  const by = Object.fromEntries(out.body.repos.map((r) => [r.repo, r]));
  check("a ticked correction changes that repo's next prediction", [by.StructureLib.predicted, by.StructureLib.learned], ["1.6.0", { fromEnd: 1, step: 1 }]);
  check("an unticked one doesn't", [by.Navigator.predicted, by.Navigator.learned], ["1.2.1", null]);
  check("the stats count what was kept", out.body.stats, { total: 3, matched: 1, wrong: 1 });
}

console.log("\nGitHub refusing some tags");
refStatus = { Failed: 422, NoWorkflow: 403 };
calls = [];
{
  const out = await releaseAll(env, "admin@example.com", [
    { repo: "GTNHLib", tag: "0.11.56", sha: sha("a"), previous: "0.11.55", predicted: "0.11.56" },
    { repo: "Failed", tag: "2.0.4", sha: sha("d"), previous: "2.0.3", predicted: "2.0.5" },
    { repo: "NoWorkflow", tag: "1.0.1", sha: sha("e"), previous: "1.0.0", predicted: "1.0.1" },
  ], { now: T0 + 10 * 60_000 });
  const by = Object.fromEntries(out.body.results.map((r) => [r.repo, r]));
  check("still answers 200 for the one that worked", [out.status, by.GTNHLib.ok], [200, true]);
  check("explains an existing tag", by.Failed.error, "that tag already exists");
  check("explains a missing permission", /Contents: Read and write/.test(by.NoWorkflow.error), true);
  check("keeps feedback only for the tag that was made", feedback().length, 4);
  check("logs the failures", [log()[0].created, log()[0].failed], [1, 2]);
}
refStatus = {};

console.log("\nrefusing bad input");
for (const [name, items] of [
  ["no items", []],
  ["a bad tag", [{ repo: "GTNHLib", tag: "../../x", sha: sha("a") }]],
  ["a short SHA", [{ repo: "GTNHLib", tag: "1.0.0", sha: "abc" }]],
  ["the same repo twice", [{ repo: "GTNHLib", tag: "1.0.0", sha: sha("a") }, { repo: "GTNHLib", tag: "1.0.1", sha: sha("a") }]],
]) {
  const out = await releaseAll(env, "admin@example.com", items, { now: T0 + 60 * 60_000 });
  check(`${name} is a 400`, out.status, 400);
}

console.log("\na dry run");
calls = [];
{
  const before = feedback().length;
  const out = await releaseAll(env, "dev@localhost", [{ repo: "GTNHLib", tag: "0.11.57", sha: sha("a"), predicted: "0.11.57" }], { now: T0 + 2 * 3_600_000, dryRun: true });
  check("answers 200 marked dry", [out.status, out.body.entry.dryRun], [200, true]);
  check("sends nothing to GitHub", calls, []);
  check("teaches nothing", feedback().length, before);
  const next = await releaseAll(env, "admin@example.com", [{ repo: "GTNHLib", tag: "0.11.57", sha: sha("a") }], { now: T0 + 2 * 3_600_000 + 1000 });
  check("and doesn't start the cooldown", next.status, 200);
}

console.log("\nwithout Org-Manager");
{
  const out = await releaseAll({ ...env, ORG_MANAGER_PRIVATE_KEY: undefined }, "admin@example.com", [{ repo: "GTNHLib", tag: "0.11.58", sha: sha("a") }], { now: T0 + 5 * 3_600_000 });
  check("says so", [out.status, /not set/.test(out.body.error)], [503, true]);
}

forgetToken();
forgetOrgManagerToken();
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
