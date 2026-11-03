/**
 *   node --experimental-sqlite worker/test/release-manager.test.js
 *
 * The Releases & Tags page: the tag predictor and the bumps, what it learns,
 * the releases it makes and the ones it deletes, against a real SQLite
 * database and a stubbed GitHub.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { deletePreview, deleteRun, releasePreview, releaseRun, repoList } from "../src/release-manager.js";
import { bumpTag, globToRegex, learnRule, planTag, predictDatedTag, predictTag, ruleFrom } from "../../web/js/release-tags.js";
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
check("leaves a Minecraft version alone", predictTag("2.3.92-1.7.10"), "2.3.93-1.7.10");
check("wherever it sits", predictTag("1.9.2-GTNH-1.7.10-Edition"), "1.9.3-GTNH-1.7.10-Edition");
check("but still counts a version that only looks like it", predictTag("21.7.10"), "21.7.11");
check("gives up on a tag with no number", predictTag("latest"), null);
check("follows a learned minor bump", predictTag("1.4.47", { fromEnd: 1, step: 1 }), "1.5.0");
check("falls back when a rule doesn't fit", predictTag("1.2", { fromEnd: 5, step: 1 }), "1.3");

console.log("\nthe dated modpack tags");
{
  const now = Date.parse("2026-10-24T15:00:00Z");
  const last = "2.9.0-nightly-2026-10-21";
  check("today's date after the last tag's prefix", predictDatedTag(last, new Set([last]), now), "2.9.0-nightly-2026-10-24");
  const today = new Set(["2.9.0-nightly-2026-10-24"]);
  check("a second release today is -02", predictDatedTag("2.9.0-nightly-2026-10-24", today, now), "2.9.0-nightly-2026-10-24-02");
  today.add("2.9.0-nightly-2026-10-24-02");
  check("a third is -03", predictDatedTag("2.9.0-nightly-2026-10-24-02", today, now), "2.9.0-nightly-2026-10-24-03");
  check("a tag with no date gives up", predictDatedTag("2.9.0-RC-2", today, now), null);
}

console.log("\nlearning from a correction");
check("a minor bump", learnRule("1.4.47", "1.5.0"), { fromEnd: 1, step: 1 });
check("a major bump", learnRule("1.4.47", "2.0.0"), { fromEnd: 2, step: 1 });
check("a skipped number teaches nothing", learnRule("1.4.47", "1.4.49"), null);
check("an odd jump teaches nothing", learnRule("1.4.47", "1.5.3"), null);
check("a -pre teaches nothing", learnRule("1.4.47", "1.5.0-pre"), null);
check("a format change teaches nothing", learnRule("1.4", "1.4.1"), null);
check("a suffix change teaches nothing", learnRule("1.4.47", "1.5.0-GTNH"), null);
check("a bump before a Minecraft version", learnRule("2.3.92-1.7.10", "2.4.0-1.7.10"), { fromEnd: 1, step: 1 });
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

console.log("\nbumping a chosen number");
const bumps = (tag) => ["patch", "minor", "major", "super"].map((b) => {
  const out = bumpTag(tag, b);
  return out ? `${out.tag}${out.fellBack ? "*" : ""}` : null;
});
check("four numbers", bumps("5.09.54.243"), ["5.09.54.244", "5.09.55.0", "5.10.0.0", "6.00.0.0"]);
check("keeps a suffix", bumps("1.1.71-GTNH"), ["1.1.72-GTNH", "1.2.0-GTNH", "2.0.0-GTNH", "2.0.0-GTNH*"]);
check("leaves a Minecraft version alone", bumps("2.3.92-1.7.10"), ["2.3.93-1.7.10", "2.4.0-1.7.10", "3.0.0-1.7.10", "3.0.0-1.7.10*"]);
check("never touches a number glued to letters", bumps("rv3-beta-1091-GTNH"), ["rv3-beta-1092-GTNH", "rv3-beta-1092-GTNH*", "rv3-beta-1092-GTNH*", "rv3-beta-1092-GTNH*"]);
check("but counts a v prefix", bumps("v2.3"), ["v2.4", "v3.0", "v3.0*", "v3.0*"]);
check("drops a release-candidate number", bumps("2.9.0-RC-2"), ["2.9.1", "2.10.0", "3.0.0", "3.0.0*"]);
check("from a -pre", bumps("1.4.47-pre"), ["1.4.48", "1.5.0", "2.0.0", "2.0.0*"]);
check("says which number it fell back to", [bumpTag("1.4", "super").used, bumpTag("7", "minor").used], ["minor", "patch"]);
check("gives up on a tag with no number", bumpTag("latest", "minor"), null);

console.log("\nplanning a row");
{
  const row = { repo: "GTNHLib", lastTag: "0.11.54", taken: ["0.11.54", "0.12.0", "0.11.55-pre"], learned: null, dated: false };
  check("predicted by default", planTag(row).tag, "0.11.55");
  check("a minor bump steps past a taken tag", [planTag(row, { bump: "minor" }).tag, planTag(row, { bump: "minor" }).skipped], ["0.13.0", ["0.12.0"]]);
  check("pre-release adds -pre and steps past a taken one", planTag(row, { pre: true }).tag, "0.11.56-pre");
  check("a pattern fills its tokens", planTag(row, { pattern: "{next}-freeze-{date}", now: Date.parse("2026-11-03T01:00:00Z") }).tag, "0.11.55-freeze-2026-11-03");
  check("a literal pattern that's taken is invalid", planTag(row, { pattern: "0.12.0" }).invalid, "Already tagged in this repo");
  check("a pattern with pre-release", planTag(row, { pattern: "2.8.0", pre: true }).tag, "2.8.0-pre");
  check("a pattern can't use {last} with no tag", Boolean(planTag({ ...row, lastTag: null }, { pattern: "{last}-x" }).invalid), true);
  check("a learned rule only applies when predicted", [planTag({ ...row, learned: { fromEnd: 1, step: 1 } }).tag, planTag({ ...row, learned: { fromEnd: 1, step: 1 } }, { bump: "patch" }).tag], ["0.13.0", "0.11.55"]);
  check("a one-number tag says it fell back", planTag({ ...row, lastTag: "rv3-beta-1091" }, { bump: "major" }).notes, ["Only one number, so this is a patch bump"]);
  check("no earlier tag needs typing", planTag({ ...row, lastTag: null }).invalid, "No earlier version tag to count up from. Type the tag in");
  const dated = { repo: "GT-New-Horizons-Modpack", dated: true, lastTag: "2.9.0-nightly-2026-10-21", taken: [] };
  check("a dated repo ignores the bump", planTag(dated, { bump: "major", now: Date.parse("2026-10-24T15:00:00Z") }).tag, "2.9.0-nightly-2026-10-24");
}

console.log("\ntag patterns");
check("* and ? match", ["2.8.0-pre", "2.8.0-pre2", "2.8.1-pre", "x2.8.0-pre"].filter((t) => globToRegex("2.8.?-pre*").test(t)), ["2.8.0-pre", "2.8.0-pre2", "2.8.1-pre"]);
check("dots are literal", globToRegex("1.2").test("1x2"), false);

const raw = new DatabaseSync(":memory:");
raw.exec(readFileSync("worker/schema.sql", "utf8"));
const statement = (sql) => {
  let bound = [];
  const api = {
    bind: (...args) => ((bound = args), api),
    async run() { const r = raw.prepare(sql).run(...bound); return { success: true, meta: { changes: r.changes } }; },
    async first() { return raw.prepare(sql).get(...bound) ?? null; },
    async all() { return { results: raw.prepare(sql).all(...bound) }; },
  };
  return api;
};
const db = { prepare: statement, async batch(list) { for (const s of list) await s.run(); return []; } };
const feedback = () => raw.prepare("SELECT repo, previous_tag, predicted_tag, tag, wrong, bump, released_by FROM release_tag_feedback ORDER BY id").all().map((r) => ({ ...r }));
const lock = () => JSON.parse(raw.prepare("SELECT value FROM meta WHERE key = 'release_manager_run'").get()?.value ?? "null");

const pair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
const PEM = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----\n`;

const logged = [];
const env = {
  DB: db,
  EVENT_LOG: {
    idFromName: (name) => name,
    get: () => ({ fetch: async (_url, init) => (logged.push(JSON.parse(init.body)), new Response(null, { status: 204 })) }),
  },
  GITHUB_ORG: "GTNewHorizons",
  GH_APP_ID: "4745300",
  GH_APP_PRIVATE_KEY: PEM,
  ORG_MANAGER_APP_ID: "5299242",
  ORG_MANAGER_PRIVATE_KEY: PEM,
};

const sha = (c) => c.repeat(40);
const repo = (name, { releases = [], tags = [], head = sha("a"), branches = {}, archived = false } = {}) => ({
  name,
  isArchived: archived,
  defaultBranchRef: { name: "master", target: { oid: head } },
  branches,
  releases: {
    totalCount: releases.length,
    nodes: releases.map((r) => {
      const o = typeof r === "string" ? { tagName: r } : r;
      return { isDraft: false, isPrerelease: false, databaseId: 100 + o.tagName.length, createdAt: "2026-10-01T00:00:00Z", tagCommit: { oid: o.sha ?? sha("0") }, ...o };
    }),
  },
  refs: { nodes: tags.map((n) => ({ name: n, target: { oid: sha("0"), committedDate: "2026-10-01T00:00:00Z" } })) },
});

let github = {};
let calls = [];
let refStatus = {};
let propsStatus = 200;

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
  if (path.startsWith("/orgs/GTNewHorizons/repos")) {
    calls.push(`GET repos ${token}`);
    return Response.json(Object.values(github).map((r) => ({ name: r.name, archived: r.isArchived, default_branch: "master", pushed_at: null, fork: false })));
  }
  if (path === "/orgs/GTNewHorizons/properties/schema") {
    if (propsStatus !== 200) return new Response("Resource not accessible by integration", { status: propsStatus });
    return Response.json([{ property_name: "Type", value_type: "single_select", allowed_values: ["Mod", "Tool"] }]);
  }
  if (path.startsWith("/orgs/GTNewHorizons/properties/values")) {
    if (propsStatus !== 200) return new Response("Resource not accessible by integration", { status: propsStatus });
    return Response.json([{ repository_name: "GTNHLib", properties: [{ property_name: "Type", value: "Mod" }] }]);
  }
  if (path === "/graphql") {
    const { query, variables } = JSON.parse(init.body);
    calls.push(`graphql ${token}`);
    if (query.includes("$name: String!")) {
      const r = github[variables.name];
      if (!r) return Response.json({ data: { repository: null } });
      const nodes = r.refs.nodes.filter((n) => !variables.q || n.name.includes(variables.q)).slice(0, variables.n);
      return Response.json({ data: { repository: { ...r, refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } });
    }
    const data = {};
    for (const [, alias, name] of query.matchAll(/(r\d+): repository\(owner: \$org, name: "([^"]+)"\)/g)) {
      const r = github[name];
      if (!r) { data[alias] = null; continue; }
      const b = variables[`b${alias.slice(1)}`];
      data[alias] = { ...r, branch: b ? (r.branches[b.replace("refs/heads/", "")] ? { target: { oid: r.branches[b.replace("refs/heads/", "")] } } : null) : undefined };
    }
    return Response.json({ data });
  }
  const rel = path.match(/^\/repos\/GTNewHorizons\/([^/]+)\/releases$/);
  if (rel && method === "POST") {
    calls.push(`POST ${rel[1]} ${token} ${init.body}`);
    const status = refStatus[rel[1]] ?? 201;
    if (status === 422) return new Response('{"message":"Validation Failed","errors":[{"resource":"Release","code":"already_exists","field":"tag_name"}]}', { status });
    if (status !== 201) return new Response("Resource not accessible by integration", { status });
    const tag = JSON.parse(init.body).tag_name;
    github[rel[1]]?.releases.nodes.unshift({ tagName: tag, isDraft: false, tagCommit: { oid: JSON.parse(init.body).target_commitish } });
    return Response.json({ html_url: `https://github.com/GTNewHorizons/${rel[1]}/releases/tag/${tag}` }, { status });
  }
  const byTag = path.match(/^\/repos\/GTNewHorizons\/([^/]+)\/releases\/tags\/(.+)$/);
  if (byTag) {
    calls.push(`GET release ${byTag[1]} ${decodeURIComponent(byTag[2])}`);
    const r = github[byTag[1]]?.releases.nodes.find((n) => n.tagName === decodeURIComponent(byTag[2]) && !n.isDraft);
    return r ? Response.json({ id: r.databaseId }) : new Response('{"message":"Not Found"}', { status: 404 });
  }
  const delRel = path.match(/^\/repos\/GTNewHorizons\/([^/]+)\/releases\/(\d+)$/);
  if (delRel && method === "DELETE") {
    calls.push(`DELETE release ${delRel[1]} ${delRel[2]} ${token}`);
    return new Response(null, { status: 204 });
  }
  const delRef = path.match(/^\/repos\/GTNewHorizons\/([^/]+)\/git\/refs\/tags\/(.+)$/);
  if (delRef && method === "DELETE") {
    calls.push(`DELETE tag ${delRef[1]} ${decodeURIComponent(delRef[2])} ${token}`);
    const status = refStatus[`${delRef[1]}:tag`] ?? 204;
    if (status === 422) return new Response('{"message":"Repository rule violations found\\n\\nCannot delete this protected tag."}', { status });
    if (status === 4220) return new Response('{"message":"Reference does not exist"}', { status: 422 });
    return new Response(null, { status });
  }
  return new Response("not stubbed", { status: 404 });
};

const T0 = Date.parse("2026-10-24T12:00:00Z");

console.log("\nthe repo list");
github = {
  GTNHLib: repo("GTNHLib", { releases: ["0.11.54"], tags: ["0.11.54", "0.11.53"], branches: { dev: sha("9") } }),
  Old: repo("Old", { archived: true }),
};
{
  const out = await repoList(env);
  check("answers 200 without archived repos", [out.status, out.body.repos.map((r) => r.name), out.body.archived], [200, ["GTNHLib"], 1]);
  check("with each repo's custom properties", out.body.repos[0].properties, { Type: "Mod" });
  check("and the property schema", out.body.schema, [{ name: "Type", type: "single_select", allowed: ["Mod", "Tool"], description: null }]);
  propsStatus = 403;
  const no = await repoList(env);
  check("says what permission is missing", [no.status, /Custom properties: Read/.test(no.body.propertiesError)], [200, true]);
  propsStatus = 200;
}

console.log("\nthe preview");
github = {
  GTNHLib: repo("GTNHLib", { releases: [{ tagName: "0.11.54", sha: sha("a") }], tags: ["0.11.54", "0.11.53"], branches: { dev: sha("9") } }),
  StructureLib: repo("StructureLib", { releases: ["latest", "1.4.47"], tags: ["latest", "1.4.47"] }),
  Navigator: repo("Navigator", { releases: ["1.2.0-pre"], tags: ["1.2.0-pre"] }),
  Failed: repo("Failed", { releases: ["2.0.3"], tags: ["2.0.4", "2.0.3"] }),
  NoWorkflow: repo("NoWorkflow", { releases: ["1.0.0"], tags: ["1.0.0"] }),
  "GT-New-Horizons-Modpack": repo("GT-New-Horizons-Modpack", {
    releases: ["2.9.0-nightly-2026-10-24", "2.9.0-RC-2", "2.9.0-nightly-2026-10-21"],
    tags: ["2.9.0-nightly-2026-10-24", "2.9.0-RC-2", "2.9.0-nightly-2026-10-21"],
  }),
};
calls = [];
{
  const out = await releasePreview(env, ["GTNHLib", "StructureLib", "Navigator", "Failed", "NoWorkflow", "GT-New-Horizons-Modpack", "Gone", "bad name!"], { now: Date.parse("2026-10-24T15:00:00Z") });
  const by = Object.fromEntries(out.body.repos.map((r) => [r.repo, r]));
  check("answers 200", out.status, 200);
  check("reads GitHub as NH-Dashbot", calls, ["graphql ghs_dashbot"]);
  check("drops names that aren't repo names", out.body.repos.length, 7);
  const pack = by["GT-New-Horizons-Modpack"];
  check("dates the modpack, skipping an RC", [pack.lastTag, pack.predicted, pack.dated], ["2.9.0-nightly-2026-10-24", "2.9.0-nightly-2026-10-24-02", true]);
  check("predicts from the newest release", [by.GTNHLib.lastTag, by.GTNHLib.predicted, by.GTNHLib.sha, by.GTNHLib.branch], ["0.11.54", "0.11.55", sha("a"), "master"]);
  check("says when nothing changed since the last release", [by.GTNHLib.unchanged, by.StructureLib.unchanged], [true, false]);
  check("hands over the taken tags", by.Failed.taken.sort(), ["2.0.3", "2.0.4"]);
  check("skips a release that isn't a version", [by.StructureLib.lastTag, by.StructureLib.predicted], ["1.4.47", "1.4.48"]);
  check("counts up from a -pre", [by.Navigator.predicted, by.Navigator.lastWasPre], ["1.2.1", true]);
  check("steps past a tag that already exists", by.Failed.predicted, "2.0.5");
  check("flags a repo GitHub doesn't know", Boolean(by.Gone.problem), true);
  check("no stats yet", out.body.stats, { total: 0, matched: 0, wrong: 0 });
}
{
  const out = await releasePreview(env, [{ repo: "GTNHLib", branch: "dev" }, { repo: "Navigator", branch: "dev" }]);
  const by = Object.fromEntries(out.body.repos.map((r) => [r.repo, r]));
  check("targets another branch", [by.GTNHLib.branch, by.GTNHLib.sha, by.GTNHLib.customBranch, by.GTNHLib.unchanged], ["dev", sha("9"), true, false]);
  check("and says when a repo doesn't have it", [by.Navigator.problem, by.Navigator.sha], ["No dev branch", null]);
}
for (const [name, list] of [["an empty list", []], ["a bad branch", [{ repo: "GTNHLib", branch: "../x" }]]]) {
  const out = await releasePreview(env, list);
  check(`${name} is a 400`, out.status, 400);
}

console.log("\nreleasing");
calls = [];
{
  const out = await releaseRun(env, "admin@example.com", {
    run: "run-aaaaaaaa", last: false, items: [
      { repo: "GTNHLib", tag: "0.11.55", sha: sha("a"), previous: "0.11.54", predicted: "0.11.55", bump: "predicted", wrong: true },
      { repo: "StructureLib", tag: "1.5.0", sha: sha("b"), previous: "1.4.47", predicted: "1.4.48", bump: "predicted", wrong: true },
    ],
  }, { now: T0, pace: 0 });
  check("answers 200", out.status, 200);
  check(
    "rechecks, then creates each release at its pinned commit, as Org-Manager",
    calls.filter((c) => c.startsWith("POST")),
    [
      `POST GTNHLib ghs_org_manager {"tag_name":"0.11.55","target_commitish":"${sha("a")}","name":"0.11.55","generate_release_notes":true}`,
      `POST StructureLib ghs_org_manager {"tag_name":"1.5.0","target_commitish":"${sha("b")}","name":"1.5.0","generate_release_notes":true}`,
    ],
  );
  check("holds the run open between batches", [lock()?.run, lock()?.made], ["run-aaaaaaaa", 2]);
  check("posts nothing to GitHub Logs yet", logged.length, 0);
}
{
  const other = await releaseRun(env, "other@example.com", { run: "run-bbbbbbbb", last: true, items: [{ repo: "NoWorkflow", tag: "1.0.1", sha: sha("e") }] }, { now: T0 + 20_000, pace: 0 });
  check("a second run meanwhile is refused", [other.status, other.body.error], [409, "admin@example.com is releasing right now (last batch 20s ago). Wait for it to finish"]);
}
calls = [];
{
  const out = await releaseRun(env, "admin@example.com", {
    run: "run-aaaaaaaa", last: true, items: [
      { repo: "Navigator", tag: "2.0.0", sha: sha("c"), previous: "1.2.0-pre", predicted: "1.2.1", bump: "major" },
      { repo: "NoWorkflow", tag: "1.0.1-freeze", sha: sha("e"), previous: "1.0.0", predicted: "1.0.1", bump: "pattern", wrong: true },
    ],
  }, { now: T0 + 30_000, pace: 0 });
  check("the same run carries on", out.status, 200);
  check(
    "keeps every release, with how its tag was chosen, and only a predicted one as wrong",
    feedback().map((r) => [r.repo, r.tag, r.wrong, r.bump]),
    [["GTNHLib", "0.11.55", 0, "predicted"], ["StructureLib", "1.5.0", 1, "predicted"], ["Navigator", "2.0.0", 0, "major"], ["NoWorkflow", "1.0.1-freeze", 0, "pattern"]],
  );
  check("lets the run go at the end", lock(), null);
  check(
    "and posts one line for the whole run",
    [logged.length, logged.at(-1).box, logged.at(-1).actor, logged.at(-1).text, logged.at(-1).tone],
    [1, "releases", "admin@example.com", "ran Releases & Tags: GTNHLib 0.11.55, StructureLib 1.5.0, Navigator 2.0.0, NoWorkflow 1.0.1-freeze", "good"],
  );
}

console.log("\na release made since the preview");
calls = [];
{
  const out = await releaseRun(env, "other@example.com", {
    run: "run-cccccccc", last: true, items: [
      { repo: "GTNHLib", tag: "0.11.56", sha: sha("a"), previous: "0.11.54", predicted: "0.11.55" },
      { repo: "Failed", tag: "2.0.5", sha: sha("d"), previous: "2.0.3", predicted: "2.0.5" },
    ],
  }, { now: T0 + 60_000, pace: 0 });
  const by = Object.fromEntries(out.body.results.map((r) => [r.repo, r]));
  check("is refused for that repo, saying who and when", by.GTNHLib.error, "0.11.55 was released 60s ago by admin@example.com since the preview. Open the preview again");
  check("and the rest still go", [by.Failed.ok, calls.filter((c) => c.startsWith("POST")).length], [true, 1]);
}

console.log("\nwhat it learned");
github.StructureLib = repo("StructureLib", { releases: ["1.5.0"], tags: ["1.5.0", "1.4.47"] });
{
  const out = await releasePreview(env, ["StructureLib", "Navigator"]);
  const by = Object.fromEntries(out.body.repos.map((r) => [r.repo, r]));
  check("a ticked correction changes that repo's next prediction", [by.StructureLib.predicted, by.StructureLib.learned], ["1.6.0", { fromEnd: 1, step: 1 }]);
  check("a chosen bump doesn't", by.Navigator.learned, null);
  check("the stats count predicted releases only", out.body.stats, { total: 3, matched: 2, wrong: 1 });
}

console.log("\nGitHub refusing some releases");
github.Failed = repo("Failed", { releases: ["2.0.5"], tags: ["2.0.5"] });
refStatus = { Failed: 422, NoWorkflow: 403 };
{
  const out = await releaseRun(env, "admin@example.com", {
    run: "run-dddddddd", last: true, items: [
      { repo: "Failed", tag: "2.0.6", sha: sha("d"), previous: "2.0.5", predicted: "2.0.6" },
      { repo: "NoWorkflow", tag: "1.0.2", sha: sha("e"), previous: "1.0.1-freeze", predicted: "1.0.2" },
    ],
  }, { now: T0 + 10 * 60_000, pace: 0 });
  const by = Object.fromEntries(out.body.results.map((r) => [r.repo, r]));
  check("all failing is a 502", out.status, 502);
  check("explains an existing tag", by.Failed.error, "that tag or release already exists");
  check("explains a missing permission", /Contents: Read and write/.test(by.NoWorkflow.error), true);
  check("and says so in GitHub Logs", [logged.at(-1).text, logged.at(-1).tone], ["ran Releases & Tags, and all 2 failed", "warn"]);
}
refStatus = {};

console.log("\nrefusing bad input");
for (const [name, body] of [
  ["no run id", { items: [{ repo: "GTNHLib", tag: "1.0.0", sha: sha("a") }] }],
  ["no items", { run: "run-eeeeeeee", items: [] }],
  ["a bad tag", { run: "run-eeeeeeee", items: [{ repo: "GTNHLib", tag: "../../x", sha: sha("a") }] }],
  ["a short SHA", { run: "run-eeeeeeee", items: [{ repo: "GTNHLib", tag: "1.0.0", sha: "abc" }] }],
  ["the same repo twice", { run: "run-eeeeeeee", items: [{ repo: "GTNHLib", tag: "1.0.0", sha: sha("a") }, { repo: "GTNHLib", tag: "1.0.1", sha: sha("a") }] }],
]) {
  const out = await releaseRun(env, "admin@example.com", body, { now: T0 + 60 * 60_000, pace: 0 });
  check(`${name} is a 400`, out.status, 400);
}

console.log("\na dry run");
calls = [];
{
  const before = feedback().length;
  const out = await releaseRun(env, "dev@localhost", { run: "run-ffffffff", last: true, items: [{ repo: "GTNHLib", tag: "0.11.57", sha: sha("a") }] }, { now: T0 + 2 * 3_600_000, dryRun: true });
  check("answers 200 marked dry", [out.status, out.body.dryRun], [200, true]);
  check("sends nothing to GitHub", calls, []);
  check("teaches nothing and holds nothing", [feedback().length, lock()], [before, null]);
}

console.log("\nwithout Org-Manager");
{
  const out = await releaseRun({ ...env, ORG_MANAGER_PRIVATE_KEY: undefined }, "admin@example.com", { run: "run-gggggggg", items: [{ repo: "GTNHLib", tag: "0.11.58", sha: sha("a") }] }, { now: T0 + 5 * 3_600_000 });
  check("says so", [out.status, /not set/.test(out.body.error)], [503, true]);
}

console.log("\nfinding what to delete");
github = {
  GTNHLib: repo("GTNHLib", {
    releases: [{ tagName: "2.8.0-pre", databaseId: 11 }, { tagName: "2.7.9", databaseId: 10 }, { tagName: "2.8.0-pre-draft", databaseId: 12, isDraft: true }],
    tags: ["2.8.0-pre", "2.8.0-pre2", "2.7.9"],
  }),
  Navigator: repo("Navigator", { releases: [{ tagName: "1.0.0", databaseId: 21 }], tags: ["1.0.0"] }),
  Old: repo("Old", { archived: true }),
};
{
  const out = await deletePreview(env, { repos: ["GTNHLib", "Navigator", "Old", "Gone"], pattern: "2.8.0-pre*" });
  const by = Object.fromEntries(out.body.repos.map((r) => [r.repo, r]));
  check("answers 200", out.status, 200);
  check(
    "matches tags and releases by pattern, drafts too",
    by.GTNHLib.matches.map((m) => [m.tag, m.release?.id ?? null, m.release?.draft ?? null, m.tagged]).sort(),
    [["2.8.0-pre", 11, false, true], ["2.8.0-pre-draft", 12, true, false], ["2.8.0-pre2", null, null, true]],
  );
  check("a repo with no match has none", by.Navigator.matches, []);
  check("archived and unknown repos say why", [Boolean(by.Old.problem), Boolean(by.Gone.problem)], [true, true]);
  const latest = await deletePreview(env, { repos: ["Navigator"], latest: true });
  check("or takes each repo's newest release", latest.body.repos[0].matches.map((m) => [m.tag, m.release.id]), [["1.0.0", 21]]);
  for (const [name, b] of [["only wildcards", { repos: ["GTNHLib"], pattern: "**" }], ["no repos", { repos: [], pattern: "x*" }]]) {
    check(`${name} is a 400`, (await deletePreview(env, b)).status, 400);
  }
}

console.log("\ndeleting");
calls = [];
logged.length = 0;
refStatus = { "Navigator:tag": 422 };
{
  const out = await deleteRun(env, "admin@example.com", {
    run: "run-hhhhhhhh", last: true, pattern: "2.8.0-pre*", items: [
      { repo: "GTNHLib", tag: "2.8.0-pre", releaseId: 11, release: true, deleteTag: true },
      { repo: "GTNHLib", tag: "2.8.0-pre2", releaseId: null, release: true, deleteTag: true },
      { repo: "GTNHLib", tag: "2.8.0-pre-draft", releaseId: 12, release: true, deleteTag: false },
      { repo: "Navigator", tag: "1.0.0", releaseId: 21, release: false, deleteTag: true },
    ],
  }, { now: T0 + 6 * 3_600_000, pace: 0 });
  const r = out.body.results;
  check("answers 200", out.status, 200);
  check(
    "deletes the release, then the tag, as Org-Manager, looking a release up when it wasn't listed",
    calls.filter((c) => !c.startsWith("graphql")),
    [
      "DELETE release GTNHLib 11 ghs_org_manager",
      "DELETE tag GTNHLib 2.8.0-pre ghs_org_manager",
      "GET release GTNHLib 2.8.0-pre2",
      "DELETE tag GTNHLib 2.8.0-pre2 ghs_org_manager",
      "DELETE release GTNHLib 12 ghs_org_manager",
      "DELETE tag Navigator 1.0.0 ghs_org_manager",
    ],
  );
  check("says what went", r.map((x) => [x.tag, x.release, x.tagDeleted, x.ok]), [["2.8.0-pre", true, true, true], ["2.8.0-pre2", false, true, true], ["2.8.0-pre-draft", true, false, true], ["1.0.0", false, false, false]]);
  check("explains a protected tag", r[3].error, "protected by a ruleset on the repo");
  check("and posts one line", [logged.at(-1).text, logged.at(-1).tone], ["deleted 2 releases and 2 tags matching 2.8.0-pre* (1 failed)", "warn"]);
}
refStatus = { "GTNHLib:tag": 4220 };
{
  const out = await deleteRun(env, "admin@example.com", { run: "run-iiiiiiii", last: true, pattern: "x", items: [{ repo: "GTNHLib", tag: "gone", release: false, deleteTag: true }] }, { now: T0 + 7 * 3_600_000, pace: 0 });
  check("a tag that's already gone counts as done", [out.status, out.body.results[0].ok], [200, true]);
}
refStatus = {};
{
  const out = await deleteRun(env, "admin@example.com", { run: "run-jjjjjjjj", items: [{ repo: "GTNHLib", tag: "x", release: false, deleteTag: false }] }, { now: T0 + 8 * 3_600_000, pace: 0 });
  check("an item deleting nothing is a 400", out.status, 400);
}

forgetToken();
forgetOrgManagerToken();
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
