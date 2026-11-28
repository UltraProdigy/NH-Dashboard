/**
 *   node --experimental-sqlite worker/test/update-prs.test.js
 *
 * Update PRs against an in-memory GitHub. Nothing here reaches the network.
 */

import { DatabaseSync } from "node:sqlite";
import { BRANCH_PREFIX, buildRequest, prBody, prTitle, UpdatePrJobs } from "../src/update-prs.js";
import { bumpDeps, bumpSettings, bumpWrapper, gradleSource, maskComments, planUpdates } from "../../web/js/updates-calc.js";

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  ok ? (pass++, console.log("  ok    " + n))
     : (fail++, console.log("  FAIL  " + n + (d ? " — " + d : "")));
};

const ORG = "GTNewHorizons";
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const settings = (v) => `plugins {\n    id 'com.gtnewhorizons.gtnhsettingsconvention' version '${v}'\n}\n`;
const wrapper = (v, sha = null) => `distributionBase=GRADLE_USER_HOME\n${sha ? `distributionSha256Sum=${sha}\n` : ""}distributionUrl=https\\://services.gradle.org/distributions/gradle-${v}-bin.zip\nnetworkTimeout=10000\n`;
const deps = (pairs) => `dependencies {\n${pairs.map(([n, v]) => `    api("com.github.GTNewHorizons:${n}:${v}:dev")`).join("\n")}\n}\n`;

console.log("\nfile edits\n");
{
  check("a settings bump changes only the version", bumpSettings(settings("2.0.30"), "2.0.34") === settings("2.0.34"));
  check("a settings file already there is left alone", bumpSettings(settings("2.0.34"), "2.0.34") === null);
  check("a newer settings file is never downgraded", bumpSettings(settings("2.1.0"), "2.0.34") === null);
  check("a kotlin settings file bumps too",
    bumpSettings(`plugins {\n    id("com.gtnewhorizons.gtnhsettingsconvention") version("2.0.33")\n}\n`, "2.0.34")?.includes('version("2.0.34")'));
  check("a commented-out plugin line is not touched",
    bumpSettings(`// id 'com.gtnewhorizons.gtnhsettingsconvention' version '1.0.0'\n${settings("2.0.30")}`, "2.0.34").startsWith("// id 'com.gtnewhorizons.gtnhsettingsconvention' version '1.0.0'"));
  check("comment masking keeps every offset", maskComments("a /* x\ny */ b // c\n").length === "a /* x\ny */ b // c\n".length);

  check("the wrapper's URL moves to the new version", bumpWrapper(wrapper("8.10"), "8.14.3") === wrapper("8.14.3"));
  check("a checksum is taken from the source when it matches", bumpWrapper(wrapper("8.10", "old"), "8.14.3", wrapper("8.14.3", "new")) === wrapper("8.14.3", "new"));
  check("and dropped when it can't be", bumpWrapper(wrapper("8.10", "old"), "8.14.3", wrapper("8.14.3")) === wrapper("8.14.3"));
  check("a wrapper already there is left alone", bumpWrapper(wrapper("8.14.3"), "8.14.3") === null);

  const d = bumpDeps(`${deps([["StructureLib", "1.4.40"], ["GTNHLib", "0.6.1"]])}// api("com.github.GTNewHorizons:StructureLib:1.0.0")\n` +
    `    compileOnly("com.github.GTNewHorizons:Dyn:\${v}")\n`, { structurelib: "1.4.45", gtnhlib: "0.6.0", Dyn: "9" });
  check("only deps behind their bump move", d.text.includes("StructureLib:1.4.45:dev") && d.text.includes("GTNHLib:0.6.1:dev"));
  check("commented deps and dynamic versions are untouched", d.text.includes("StructureLib:1.0.0") && d.text.includes("Dyn:${v}"));
  check("the changes are listed once", d.changed.length === 1 && d.changed[0].from === "1.4.40" && d.changed[0].to === "1.4.45", JSON.stringify(d.changed));
  check("a file with nothing to bump comes back null", bumpDeps(deps([["A", "1.0"]]), { b: "2" }).text === null);
}

const SCAN = {
  org: ORG,
  scannedAt: "2026-11-27T12:00:00.000Z",
  tags: { structurelib: "1.4.45", gtnhlib: "0.6.1", angelica: "1.0.0" },
  repos: [
    { name: "ExampleMod1.7.10", fork: false, buildscript: { kind: "plugin", version: "2.0.34" }, gradle: "8.14.3", deps: [] },
    { name: "Behind", fork: false, buildscript: { kind: "plugin", version: "2.0.30" }, gradle: "8.10", deps: [["StructureLib", "1.4.40"], ["GTNHLib", "0.6.1"]] },
    { name: "DepsOnly", fork: false, buildscript: { kind: "plugin", version: "2.0.34" }, gradle: "8.14.3", deps: [["StructureLib", "1.4.40"], ["Angelica", "0.9.0"]] },
    { name: "Legacy", fork: false, buildscript: { kind: "legacy", version: "1700000000" }, gradle: "8.14.3", deps: [] },
    { name: "Current", fork: false, buildscript: { kind: "plugin", version: "2.0.34" }, gradle: "8.14.3", deps: [["GTNHLib", "0.6.1"]] },
  ],
};
const ALL = { buildscript: true, gradle: true, dependencies: true };

console.log("\nplanning\n");
{
  const p = planUpdates(SCAN, { repos: ["Behind", "DepsOnly", "Legacy", "Current", "Nope"], kinds: ALL, pins: [{ repo: "DepsOnly", dep: "Angelica" }] });
  check("repos with something to do become items", p.items.map((i) => i.repo).join() === "Behind,DepsOnly", p.items.map((i) => i.repo).join());
  const behind = p.items.find((i) => i.repo === "Behind");
  check("an item carries each part it needs", behind.buildscript?.to === "2.0.34" && behind.gradle?.to === "8.14.3" && behind.dependencies?.length === 1);
  check("a pinned dep is left out", p.items.find((i) => i.repo === "DepsOnly").dependencies.map((d) => d.name).join() === "StructureLib");
  check("the rest are skipped with a reason",
    p.skipped.find((s) => s.repo === "Legacy")?.why.includes("legacy") && p.skipped.find((s) => s.repo === "Current") && p.skipped.find((s) => s.repo === "Nope")?.why === "not in the last scan",
    JSON.stringify(p.skipped));
  check("ExampleMod is the preferred wrapper source", p.source === "ExampleMod1.7.10");
  check("without ExampleMod, any repo already there", gradleSource([{ name: "Z", gradle: "8.14.3", bsStatus: "ok" }, { name: "F", gradle: "8.14.3", fork: true }], "8.14.3") === "Z");

  const only = planUpdates(SCAN, { repos: ["Behind"], kinds: { gradle: true } });
  check("unticked parts aren't planned", only.items[0].gradle && !only.items[0].buildscript && !only.items[0].dependencies);

  check("a request without a scan is refused", buildRequest({ repos: ["Behind"], kinds: ALL }, null, []).error);
  check("a request without parts is refused", buildRequest({ repos: ["Behind"], kinds: {} }, SCAN, []).error);
  check("a bad repo name is ignored", buildRequest({ repos: ["../x"], kinds: ALL }, SCAN, []).error === "pick at least one repo");
  check("a request with nothing to do is refused with the reasons", buildRequest({ repos: ["Current"], kinds: ALL }, SCAN, []).skipped?.length === 1);

  check("titles name what changed", prTitle({ gradle: 1 }) === "Update Gradle" && prTitle({ buildscript: 1, gradle: 1, dependencies: 1 }) === "Update buildscript, Gradle and dependencies");
  const body = prBody({ gradle: { from: "8.10", to: "8.14.3" }, dependencies: [{ name: "X", from: "1", to: "2" }] }, { by: "someone", scanAt: SCAN.scannedAt });
  check("the body lists every bump and who asked", body.includes("`8.10` → `8.14.3`") && body.includes("X: `1` → `2`") && body.includes("for someone") && !body.includes("@"));
}

function fakeGitHub(repos) {
  const calls = [];
  let n = 0;
  const id = () => `sha${++n}`;
  const objects = new Map();
  const request = async (token, path, { method = "GET", body } = {}) => {
    calls.push({ method, path, body });
    const u = new URL(`https://api.github.com${path}`);
    const parts = u.pathname.split("/").map(decodeURIComponent);
    const repo = repos[parts[3]];
    const res = (status, json) => ({ status, ok: status < 300, json, text: JSON.stringify(json ?? ""), headers: new Map() });
    if (!repo) return res(404, { message: "Not Found" });
    const rest = parts.slice(4).join("/");
    if (!rest && method === "GET") return res(200, { default_branch: repo.branch ?? "master", archived: Boolean(repo.archived) });
    if (rest === "pulls" && method === "GET") return res(200, repo.pulls ?? []);
    if (rest.startsWith("git/ref/heads/")) return res(200, { object: { sha: "head" } });
    if (rest === "git/commits/head") return res(200, { sha: "head", tree: { sha: "tree0" } });
    if (rest.startsWith("contents/")) {
      const file = repo.files[rest.slice("contents/".length)];
      if (file == null) return res(404, { message: "Not Found" });
      return res(200, { type: "file", sha: `blob:${file}`.slice(0, 40), content: b64(file) });
    }
    if (rest === "git/blobs" && method === "POST") { const s = id(); objects.set(s, body); return res(201, { sha: s }); }
    if (rest === "git/trees" && method === "POST") { const s = id(); objects.set(s, body); return res(201, { sha: s }); }
    if (rest === "git/commits" && method === "POST") { const s = id(); objects.set(s, body); return res(201, { sha: s }); }
    if (rest === "git/refs" && method === "POST") {
      if (repo.refs?.includes(body.ref)) return res(422, { message: "Reference already exists" });
      return res(201, { ref: body.ref });
    }
    if (rest.startsWith("git/refs/heads/") && method === "PATCH") return res(200, {});
    if (rest === "pulls" && method === "POST") return res(201, { number: 42, html_url: `https://github.com/${ORG}/${parts[3]}/pull/42` });
    return res(500, { message: `unhandled ${method} ${rest}` });
  };
  return { request, calls, objects };
}

function fakeCtx() {
  const db = new DatabaseSync(":memory:");
  const ctx = {
    alarms: [],
    storage: {
      sql: {
        exec(q, ...b) {
          const st = db.prepare(q);
          if (/^\s*SELECT/i.test(q)) { const rows = st.all(...b); return { toArray: () => rows }; }
          st.run(...b);
          return { toArray: () => [] };
        },
      },
      setAlarm: async (t) => { ctx.alarms.push(t); },
    },
  };
  return ctx;
}

function jobsWith(repos) {
  const gh = fakeGitHub(repos);
  const ctx = fakeCtx();
  const now = { t: 1_000_000 };
  const slept = [];
  const obj = new UpdatePrJobs(ctx, { GITHUB_ORG: ORG }, {
    request: gh.request,
    now: () => now.t,
    sleep: async (ms) => { slept.push(ms); now.t += ms; },
    token: async () => "tok",
  });
  const runAll = async (max = 50) => {
    for (let i = 0; i < max; i++) {
      const before = ctx.alarms.length;
      now.t += 5_000;
      await obj.alarm();
      if (ctx.alarms.length === before) break;
    }
  };
  return { obj, gh, ctx, now, slept, runAll };
}

const post = (obj, path, body) => obj.fetch(new Request(`https://jobs${path}`, { method: "POST", body: JSON.stringify(body) })).then((r) => r.json());
const state = (obj) => obj.fetch(new Request("https://jobs/state")).then((r) => r.json());

const JAR_NEW = "new-jar-bytes";
const repoFiles = () => ({
  "ExampleMod1.7.10": { files: {
    "gradle/wrapper/gradle-wrapper.properties": wrapper("8.14.3", "srcsha"),
    "gradle/wrapper/gradle-wrapper.jar": JAR_NEW, gradlew: "#!/bin/sh new", "gradlew.bat": "@rem same",
  } },
  Behind: { files: {
    "settings.gradle": settings("2.0.30"),
    "gradle/wrapper/gradle-wrapper.properties": wrapper("8.10", "oldsha"),
    "gradle/wrapper/gradle-wrapper.jar": "old-jar-bytes", gradlew: "#!/bin/sh old", "gradlew.bat": "@rem same",
    "dependencies.gradle": deps([["StructureLib", "1.4.40"], ["GTNHLib", "0.6.1"]]),
  } },
  DepsOnly: { files: { "dependencies.gradle": deps([["StructureLib", "1.4.40"]]) }, refs: [] },
  Open: { files: { "dependencies.gradle": deps([["StructureLib", "1.4.40"]]) },
    pulls: [{ number: 7, html_url: "https://github.com/x/Open/pull/7", head: { ref: `${BRANCH_PREFIX}-abc`, repo: { full_name: `${ORG}/Open` } } }] },
  Gone: { archived: true, files: {} },
});

console.log("\nthe job\n");
{
  const { obj, gh, runAll, slept } = jobsWith(repoFiles());
  const plan = planUpdates(SCAN, { repos: ["Behind", "DepsOnly"], kinds: ALL });
  const items = [...plan.items, { repo: "Open", dependencies: [{ name: "StructureLib", from: "1.4.40", to: "1.4.45" }] }, { repo: "Gone", gradle: { from: "1", to: "2" } }];
  const sub = await post(obj, "/submit", { by: "a@b.c", login: "UltraProdigy", items, source: plan.source, scanAt: SCAN.scannedAt });
  check("a job is queued with every item", sub.total === 4 && sub.ahead === 0, JSON.stringify(sub));
  await runAll();
  const st = await state(obj);
  const by = Object.fromEntries(st.focus.items.map((i) => [i.repo, i]));
  check("the job finishes", st.focus.state === "done", st.focus.state);
  check("a behind repo gets a PR", by.Behind.status === "done" && by.Behind.url?.endsWith("/pull/42"), JSON.stringify(by.Behind));
  check("a repo with an open update PR is skipped and linked", by.Open.status === "skipped" && by.Open.url === "https://github.com/x/Open/pull/7");
  check("an archived repo is skipped", by.Gone.status === "skipped");

  const behindCalls = gh.calls.filter((c) => c.path.startsWith(`/repos/${ORG}/Behind/`));
  const commits = behindCalls.filter((c) => c.method === "POST" && c.path.endsWith("/git/commits")).map((c) => c.body.message.split("\n")[0]);
  check("one commit per part, in order", commits.join(" | ") === "Update buildscript to 2.0.34 | Update Gradle to 8.14.3 | Update dependencies", commits.join(" | "));
  const parents = behindCalls.filter((c) => c.method === "POST" && c.path.endsWith("/git/commits")).map((c) => c.body.parents[0]);
  check("each commit builds on the last", parents[0] === "head" && parents[1] !== "head" && parents[2] !== parents[1]);
  const trees = behindCalls.filter((c) => c.method === "POST" && c.path.endsWith("/git/trees")).map((c) => c.body);
  const gradleTree = trees[1].tree;
  check("the wrapper commit copies the jar and gradlew, not an identical gradlew.bat",
    gradleTree.map((t) => t.path).sort().join() === "gradle/wrapper/gradle-wrapper.jar,gradle/wrapper/gradle-wrapper.properties,gradlew", gradleTree.map((t) => t.path).join());
  check("gradlew stays executable", gradleTree.find((t) => t.path === "gradlew").mode === "100755");
  check("the properties carry the source's checksum", gradleTree.find((t) => t.path.endsWith(".properties")).content === wrapper("8.14.3", "srcsha"));
  const blobs = behindCalls.filter((c) => c.method === "POST" && c.path.endsWith("/git/blobs"));
  check("binary files go up as base64 blobs", blobs.some((b) => Buffer.from(b.body.content, "base64").toString() === JAR_NEW) && blobs.every((b) => b.body.encoding === "base64"));
  check("the deps commit only bumps what's behind", trees[2].tree[0].content.includes("StructureLib:1.4.45") && trees[2].tree[0].content.includes("GTNHLib:0.6.1"));
  const pr = behindCalls.find((c) => c.method === "POST" && c.path.endsWith("/pulls"));
  check("the PR targets the default branch from the job's branch",
    pr.body.base === "master" && pr.body.head.startsWith(BRANCH_PREFIX) && pr.body.title === "Update buildscript, Gradle and dependencies");
  check("the PR body credits the GitHub login, not the email", pr.body.body.includes("UltraProdigy") && !pr.body.body.includes("a@b.c"));
  check("writes are spaced a second apart", slept.length > 0 && slept.every((ms) => ms <= 1000));
  check("nothing is ever written to the source repo",
    !gh.calls.some((c) => c.method !== "GET" && c.path.includes("ExampleMod")));
  check("the wrapper source is read once for the whole job",
    gh.calls.filter((c) => c.path.includes("ExampleMod") && c.path.includes("gradle-wrapper.jar")).length === 1);
}

console.log("\ndry runs\n");
{
  const { obj, gh, runAll } = jobsWith(repoFiles());
  const plan = planUpdates(SCAN, { repos: ["Behind"], kinds: ALL });
  await post(obj, "/submit", { by: "a@b.c", items: plan.items, dry: true, source: plan.source });
  await runAll();
  const st = await state(obj);
  check("a dry run reads but never writes", gh.calls.length > 0 && gh.calls.every((c) => c.method === "GET"));
  check("and says what it would have done", st.focus.items[0].status === "done" && /would open a PR for buildscript 2\.0\.34, Gradle 8\.14\.3, 1 dep/.test(st.focus.items[0].note), st.focus.items[0].note);
  check("the job is marked dry", st.focus.dry === true);
}
{
  const { obj, gh, runAll } = jobsWith(repoFiles());
  await post(obj, "/submit", { by: "dev", items: [{ repo: "Behind", gradle: { from: "8.10", to: "8.14.3" } }], dry: true, offline: true });
  await runAll();
  check("an offline dry run doesn't contact GitHub at all", gh.calls.length === 0 && (await state(obj)).focus.items[0].note.includes("wasn't contacted"));
}

console.log("\nretries and cancelling\n");
{
  const repos = repoFiles();
  repos.DepsOnly.refs = [`refs/heads/${BRANCH_PREFIX}-${(1_000_000).toString(36)}`];
  const { obj, gh, runAll } = jobsWith(repos);
  await post(obj, "/submit", { by: "a", items: [{ repo: "DepsOnly", dependencies: [{ name: "StructureLib", from: "1.4.40", to: "1.4.45" }] }] });
  await runAll();
  check("a branch left behind by an earlier attempt is moved, not refused",
    gh.calls.some((c) => c.method === "PATCH" && c.body.force === true) && (await state(obj)).focus.items[0].status === "done");
}
{
  const repos = repoFiles();
  const { obj, gh, ctx, runAll, now } = jobsWith(repos);
  let limited = 1;
  const inner = gh.request;
  obj.request = async (t, path, o) => {
    if (o?.method === "POST" && path.endsWith("/git/trees") && limited-- > 0) {
      return { status: 403, ok: false, json: { message: "secondary rate limit" }, text: "secondary rate limit", headers: new Map([["retry-after", "30"]]) };
    }
    return inner(t, path, o);
  };
  await post(obj, "/submit", { by: "a", items: [{ repo: "DepsOnly", dependencies: [{ name: "StructureLib", from: "1.4.40", to: "1.4.45" }] }] });
  now.t += 1;
  await obj.alarm();
  const waiting = (await state(obj)).focus;
  check("a rate limit waits instead of failing", waiting.state === "running" && waiting.waitNote?.includes("30s") && ctx.alarms.at(-1) >= now.t + 30_000);
  await runAll();
  check("and the repo goes through afterwards", (await state(obj)).focus.items[0].status === "done");
}
{
  const { obj, gh, runAll } = jobsWith(repoFiles());
  const sub = await post(obj, "/submit", { by: "a", items: [{ repo: "DepsOnly", dependencies: [{ name: "StructureLib", from: "1.4.40", to: "1.4.45" }] }, { repo: "Behind", gradle: { from: "8.10", to: "8.14.3" } }] });
  const c = await post(obj, "/cancel", { job: sub.job, by: "b" });
  await runAll();
  const st = await state(obj);
  check("cancelling stops the job before the next repo", c.ok && st.focus.state === "cancelled" && st.focus.items.every((i) => i.status === "cancelled") && gh.calls.length === 0);
  check("nothing to cancel says so", (await post(obj, "/cancel", {})).ok === false);
}
{
  const { obj, gh, runAll, now } = jobsWith(repoFiles());
  const dep = (repo) => ({ repo, dependencies: [{ name: "StructureLib", from: "1.4.40", to: "1.4.45" }] });
  await post(obj, "/submit", { by: "a", items: [dep("DepsOnly"), dep("Open"), dep("Behind")] });
  now.t += 1;
  await obj.alarm();
  const c = await post(obj, "/cancel", { by: "b" });
  await runAll();
  const st = await state(obj);
  check("cancelling a running job keeps what's done and stops the rest",
    c.ok && st.focus.state === "cancelled" && st.focus.cancelledBy === "b" && st.focus.counts.done === 1 && st.focus.counts.cancelled === 2,
    JSON.stringify(st.focus.counts));
}
{
  const { obj } = jobsWith(repoFiles());
  for (let i = 0; i < 65; i++) obj.sql.exec("INSERT INTO writes (at) VALUES (?)", 1_000_000 - 1000);
  check("a repo waits when its writes would go over the minute's budget", obj.paceWait(1_000_000) > 0 && obj.paceWait(1_000_000 + 60_000) === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
