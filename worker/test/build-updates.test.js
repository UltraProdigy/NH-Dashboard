/**
 *   node --experimental-sqlite worker/test/build-updates.test.js
 *
 * The Updates card: the file parsers, the comparison, and the scan against a
 * stubbed GitHub GraphQL endpoint and a real SQLite meta table.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { runUpdatesScan, setPin, updatesStatus } from "../src/build-updates.js";
import { forgetToken } from "../src/github.js";
import {
  latestTag, parseDeps, parseLegacyHeader, parseSettings, parseWrapper, summarize, targets,
} from "../../web/js/updates-calc.js";

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

const GROOVY_SETTINGS = `
pluginManagement {
    repositories {
        maven {
            url "https://nexus.gtnewhorizons.com/repository/public/"
            mavenContent { includeGroupByRegex("com\\\\.gtnewhorizons\\\\..+") }
        }
    }
}
plugins {
    id 'com.gtnewhorizons.gtnhsettingsconvention' version '2.0.34'
}
rootProject.name = "NotEnoughItems"
`;
const KTS_SETTINGS = `plugins {\n    id("com.gtnewhorizons.gtnhsettingsconvention") version("2.0.33")\n}\n`;
const OLD_SETTINGS = `plugins {\n    id 'com.diffplug.blowdryerSetup' version '1.6.0'\n}\n`;
const WRAPPER = (v) => `distributionBase=GRADLE_USER_HOME\ndistributionUrl=https\\://services.gradle.org/distributions/gradle-${v}-bin.zip\nnetworkTimeout=10000\n`;
const DEPS = `/*
 *  - api("g:n:v:c"): com.github.GTNewHorizons:Nope:0.0.1 in a comment
 */
dependencies {
    api("com.github.GTNewHorizons:StructureLib:1.4.40:dev")
    api("net.industrial-craft:industrialcraft-2:2.2.828-experimental:dev")
    implementation('com.github.GTNewHorizons:NotEnoughItems:2.8.160-GTNH:dev')
    // compileOnly("com.github.GTNewHorizons:Commented:1.0.0")
    compileOnly("com.github.GTNewHorizons:GTNHLib:\${gtnhlibVersion}")
    runtimeOnlyNonPublishable("com.github.GTNewHorizons:StructureLib:1.4.40:dev")
}
`;

console.log("\nparsers\n");
check("groovy settings convention version", parseSettings(GROOVY_SETTINGS), "2.0.34");
check("kotlin settings convention version", parseSettings(KTS_SETTINGS), "2.0.33");
check("a settings file without the convention has no version", parseSettings(OLD_SETTINGS), null);
check("a commented-out plugin line doesn't count", parseSettings(`// id 'com.gtnewhorizons.gtnhsettingsconvention' version '9.9.9'`), null);
check("the legacy buildscript header", parseLegacyHeader("//version: 1707058017\n\nplugins {}"), "1707058017");
check("no header past the first line", parseLegacyHeader("plugins {}\n//version: 1707058017"), null);
check("gradle wrapper version", parseWrapper(WRAPPER("9.7.1")), "9.7.1");
check("gradle wrapper with the all distribution", parseWrapper(WRAPPER("8.14.3").replace("-bin", "-all")), "8.14.3");
check("dependencies: GTNH only, deduped, comments skipped", parseDeps(DEPS), [
  ["StructureLib", "1.4.40"], ["NotEnoughItems", "2.8.160-GTNH"], ["GTNHLib", "${gtnhlibVersion}"],
]);
check("latest tag skips pre-releases and sorts by version, not date", latestTag(["1.4.47-pre", "1.4.45", "1.4.46", "nightly"]), "1.4.46");
check("an old tag scheme can't outrank the current one", latestTag(["1.13.10-GTNH", "1.13.9-GTNH", "r1.8-321"]), "1.13.10-GTNH");

console.log("\ncomparison\n");
const scan = {
  repos: [
    { name: "A", buildscript: { kind: "plugin", version: "2.0.34" }, gradle: "9.7.1", deps: [["B", "1.0.0"]] },
    { name: "B", buildscript: { kind: "plugin", version: "2.0.33" }, gradle: "9.7.1", deps: [] },
    { name: "C", buildscript: { kind: "legacy", version: "1707058017" }, gradle: "8.14.3", deps: [["A", "3.0.0"], ["Nobody", "1.0"]] },
    { name: "D", buildscript: { kind: "plugin", version: "2.1.0-pre" }, gradle: "9.8.0-rc-1", deps: [] },
    { name: "E", buildscript: null, gradle: null, deps: [["B", "1.1.0"]] },
  ],
  tags: { a: "3.0.0", b: "1.1.0" },
};
check("targets are the highest stable versions across the org", targets(scan.repos), {
  buildscript: { kind: "plugin", version: "2.0.34" }, gradle: "9.7.1",
});
const s = summarize(scan);
const by = Object.fromEntries(s.rows.map((r) => [r.name, r]));
check("on the newest everything is in sync", [by.A.bsStatus, by.A.gradleStatus, by.A.outOfSync], ["ok", "ok", false]);
check("an older plugin is behind", [by.B.bsStatus, by.B.reasons], ["behind", ["buildscript"]]);
check("the legacy buildscript is behind any plugin, and old gradle too", by.C.reasons, ["buildscript", "gradle"]);
check("a pre-release ahead of the target isn't flagged", by.D.outOfSync, false);
check("no buildscript or wrapper isn't flagged for them", [by.E.bsStatus, by.E.gradleStatus, by.E.outOfSync], ["none", "none", false]);
check("deps are compared with the dependency repo's latest tag", by.A.depRows.map((d) => d.status), ["behind"]);
check("an unknown dependency is never behind", by.C.depRows.map((d) => d.status), ["ok", "unknown"]);
check("deps don't put a repo out of sync unless asked", by.A.outOfSync, false);
const counted = summarize(scan, { countDeps: true }).rows.find((r) => r.name === "A");
check("…and do when they are", counted.reasons, ["dependencies"]);
const pinned = summarize(scan, { countDeps: true, pins: [{ repo: "A", dep: "b" }] }).rows.find((r) => r.name === "A");
check("a pinned dep stops counting", [pinned.depRows[0].status, pinned.outOfSync], ["pinned", false]);
check("counts", s.counts, { repos: 5, outOfSync: 2, buildscript: 2, gradle: 1, dependencies: 1 });

console.log("\nscan\n");
const raw = new DatabaseSync(":memory:");
raw.exec(readFileSync("worker/schema.sql", "utf8"));
const db = {
  prepare(sql) {
    let bound = [];
    const api = {
      bind: (...args) => ((bound = args), api),
      async run() { const r = raw.prepare(sql).run(...bound); return { success: true, meta: { changes: r.changes } }; },
      async first() { return raw.prepare(sql).get(...bound) ?? null; },
      async all() { return { results: raw.prepare(sql).all(...bound) }; },
    };
    return api;
  },
};

const pair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
const PEM = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----\n`;
const env = { DB: db, GITHUB_ORG: "GTNewHorizons", GH_APP_ID: "4745300", GH_APP_PRIVATE_KEY: PEM, NH_INGEST_EXCLUDE: "Secret-*" };

const text = (t) => (t == null ? null : { text: t });
const node = (name, files = {}, extra = {}) => ({
  name, isArchived: false, isPrivate: false, isFork: false, defaultBranchRef: { name: "master" },
  settings: text(files.settings), settingsKts: text(files.settingsKts), wrapper: text(files.wrapper),
  deps: text(files.deps), depsKts: null, tags: { nodes: (files.tags ?? []).map((n) => ({ name: n })) }, ...extra,
});
const ORG = [
  node("GTNHLib", { settings: GROOVY_SETTINGS, wrapper: WRAPPER("9.7.1"), tags: ["0.11.52"] }),
  node("NotEnoughItems", { settingsKts: KTS_SETTINGS, wrapper: WRAPPER("9.7.1"), deps: DEPS, tags: ["2.8.161-GTNH", "2.8.160-GTNH"] }),
  node("OldMod", { settings: OLD_SETTINGS, wrapper: WRAPPER("8.14.3"), tags: ["1.0.0"] }),
  node("StructureLib", { settings: GROOVY_SETTINGS, wrapper: WRAPPER("9.7.1"), tags: ["1.4.46"] }),
  node("Archived", { settings: GROOVY_SETTINGS }, { isArchived: true }),
  node("Secret-Thing", { settings: GROOVY_SETTINGS }),
  node("Website", {}),
];

let pageSizes = [];
let failNext = 0;
let legacyQueries = 0;

globalThis.fetch = async (url, init = {}) => {
  const path = String(url).replace("https://api.github.com", "");
  if (path === "/orgs/GTNewHorizons/installation") return Response.json({ id: 1 });
  if (path === "/app/installations/1/access_tokens") {
    return Response.json({ token: "ghs_dashbot", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
  }
  if (path === "/graphql") {
    const { query, variables } = JSON.parse(init.body);
    if (query.includes("organization(login")) {
      pageSizes.push(variables.n);
      if (failNext > 0) { failNext--; return Response.json({ errors: [{ message: "timeout" }] }); }
      const start = variables.after ? Number(variables.after) : 0;
      const nodes = ORG.slice(start, start + variables.n);
      const end = start + nodes.length;
      return Response.json({ data: { organization: { repositories: {
        pageInfo: { hasNextPage: end < ORG.length, endCursor: String(end) }, nodes,
      } } } });
    }
    legacyQueries++;
    const data = {};
    for (const m of query.matchAll(/(r\d+): repository\(owner: \$org, name: "([^"]+)"\)/g)) {
      data[m[1]] = m[2] === "OldMod" ? { groovy: { text: "//version: 1707058017\nplugins {}" }, kts: null } : { groovy: null, kts: null };
    }
    return Response.json({ data });
  }
  return new Response("not found", { status: 404 });
};

forgetToken();
const empty = await updatesStatus(env);
check("before any scan there is nothing cached", [empty.status, empty.body.scan, empty.body.pins], [200, null, []]);

failNext = 1;
const first = await runUpdatesScan(env, "admin@example.com");
check("the scan answers", first.status, 200);
check("a timed-out page is retried smaller", pageSizes.slice(0, 2), [25, 13]);
const names = first.body.scan.repos.map((r) => r.name);
check("archived, excluded and non-gradle repos are left out", names, ["GTNHLib", "NotEnoughItems", "OldMod", "StructureLib"]);
check("and counted", first.body.scan.skipped, { archived: 1, excluded: 1, noGradle: 1 });
check("only repos without the settings plugin get their build.gradle read", legacyQueries, 1);
const old = first.body.scan.repos.find((r) => r.name === "OldMod");
check("a legacy repo carries its header", old.buildscript, { kind: "legacy", version: "1707058017" });
check("the latest tags are kept per repo", first.body.scan.tags, {
  gtnhlib: "0.11.52", notenoughitems: "2.8.161-GTNH", oldmod: "1.0.0", structurelib: "1.4.46",
});
const sum = summarize(first.body.scan);
const nei = sum.rows.find((r) => r.name === "NotEnoughItems");
check("NEI's buildscript is behind, its gradle isn't", [nei.bsStatus, nei.gradleStatus], ["behind", "ok"]);
check("NEI's deps: StructureLib behind, its own entry fine, a variable unknown", nei.depRows.map((d) => `${d.name}:${d.status}`), [
  "StructureLib:behind", "NotEnoughItems:behind", "GTNHLib:unknown",
]);
check("the scan is cached with who ran it", (await updatesStatus(env)).body.scan.by, "admin@example.com");
const stampAfterScan = raw.prepare("SELECT value FROM meta WHERE key = 'build_updates_at'").get()?.value;
check("the scan stamps build_updates_at for open pages to notice", Boolean(stampAfterScan) && first.body.stamp === stampAfterScan, true);
check("and the status hands the stamp back", (await updatesStatus(env)).body.stamp, stampAfterScan);
check("and the lock is released", raw.prepare("SELECT COUNT(*) AS n FROM meta WHERE key = 'build_updates_lock'").get().n, 0);

raw.prepare("INSERT INTO meta (key, value) VALUES ('build_updates_lock', ?)").run(JSON.stringify({ at: new Date().toISOString(), by: "other@example.com" }));
const busy = await runUpdatesScan(env, "admin@example.com");
check("a second scan while one runs is refused", [busy.status, /other@example.com/.test(busy.body.error)], [409, true]);
check("and the status says one is running", (await updatesStatus(env)).body.scanning?.by, "other@example.com");
raw.prepare("UPDATE meta SET value = ? WHERE key = 'build_updates_lock'").run(JSON.stringify({ at: new Date(Date.now() - 10 * 60_000).toISOString(), by: "other@example.com" }));
check("a stale lock doesn't block", (await runUpdatesScan(env, "admin@example.com")).status, 200);
const racing = await Promise.all([runUpdatesScan(env, "one@example.com"), runUpdatesScan(env, "two@example.com")]);
check("two presses at once run one scan", racing.map((r) => r.status).sort(), [200, 409]);

console.log("\npins\n");
const p1 = await setPin(env, "admin@example.com", { repo: "NotEnoughItems", dep: "StructureLib", pinned: true });
check("pinning saves it", p1.body.pins.map((p) => `${p.repo}:${p.dep}`), ["NotEnoughItems:StructureLib"]);
check("and stamps it too", raw.prepare("SELECT value FROM meta WHERE key = 'build_updates_at'").get()?.value, p1.body.stamp);
await setPin(env, "admin@example.com", { repo: "NotEnoughItems", dep: "structurelib", pinned: true });
check("pinning twice keeps one", (await updatesStatus(env)).body.pins.length, 1);
const pinnedSum = summarize((await updatesStatus(env)).body.scan, { pins: (await updatesStatus(env)).body.pins, countDeps: true });
check("the pin shows on the row", pinnedSum.rows.find((r) => r.name === "NotEnoughItems").depRows[0].status, "pinned");
await setPin(env, "admin@example.com", { repo: "NotEnoughItems", dep: "StructureLib", pinned: false });
check("unpinning removes it", (await updatesStatus(env)).body.pins, []);
check("a bad dep name is refused", (await setPin(env, "a", { repo: "X", dep: "a b", pinned: true })).status, 400);

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
