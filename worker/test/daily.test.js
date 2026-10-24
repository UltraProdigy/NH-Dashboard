/**
 *   node --experimental-sqlite worker/test/daily.test.js
 *
 * Releasing a daily from the Dream Panel, against a real SQLite database and a
 * stubbed GitHub that tells the two Apps apart by the JWT's issuer.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dailyStatus, releaseDaily } from "../src/daily-release.js";
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

const raw = new DatabaseSync(":memory:");
raw.exec(readFileSync("worker/schema.sql", "utf8"));
const db = {
  prepare(sql) {
    let bound = [];
    const api = {
      bind: (...args) => ((bound = args), api),
      async run() { raw.prepare(sql).run(...bound); return { success: true }; },
      async first() { return raw.prepare(sql).get(...bound) ?? null; },
      async all() { return { results: raw.prepare(sql).all(...bound) }; },
    };
    return api;
  },
};
const log = () => JSON.parse(raw.prepare("SELECT value FROM meta WHERE key = 'daily_release_log'").get()?.value ?? "[]");

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

const WF = "/repos/GTNewHorizons/DreamAssemblerXXL/actions/workflows/daily-modpack-build.yml";
let runs = [];
let dispatchStatus = 204;
let calls = [];

const issuer = (auth) => {
  const jwt = auth.replace("Bearer ", "");
  try { return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url")).iss; } catch { return null; }
};

globalThis.fetch = async (url, init = {}) => {
  const path = String(url).replace("https://api.github.com", "");
  const method = init.method ?? "GET";
  const auth = init.headers?.Authorization ?? "";
  if (path === "/orgs/GTNewHorizons/installation") {
    return Response.json({ id: issuer(auth) === "5299242" ? 2 : 1 });
  }
  const minted = path.match(/^\/app\/installations\/(\d)\/access_tokens$/);
  if (minted) {
    return Response.json({
      token: minted[1] === "2" ? "ghs_org_manager" : "ghs_dashbot",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
  }
  calls.push(`${method} ${path} ${auth.replace("Bearer ", "")}${init.body ? ` ${init.body}` : ""}`);
  if (method === "GET" && path.startsWith(`${WF}/runs`)) return Response.json({ workflow_runs: runs });
  if (method === "POST" && path === `${WF}/dispatches`) {
    return new Response(dispatchStatus === 204 ? null : "Resource not accessible by integration", { status: dispatchStatus });
  }
  return new Response("not stubbed", { status: 404 });
};

const run = (n, status, extra = {}) => ({
  run_number: n,
  status,
  conclusion: status === "completed" ? "success" : null,
  event: "schedule",
  run_started_at: "2026-10-24T03:00:00Z",
  html_url: `https://github.com/GTNewHorizons/DreamAssemblerXXL/actions/runs/${n}`,
  ...extra,
});

const T0 = Date.parse("2026-10-24T12:00:00Z");

console.log("\nreleasing with nothing running");
runs = [run(799, "completed")];
calls = [];
{
  const out = await releaseDaily(env, "admin@example.com", { now: T0 });
  check("answers 200", out.status, 200);
  check(
    "reads runs as DashBot, dispatches on master as Org-Manager",
    calls,
    [`GET ${WF}/runs?per_page=5 ghs_dashbot`, `POST ${WF}/dispatches ghs_org_manager {"ref":"master"}`],
  );
  check("logs who pressed it", log(), [{ at: "2026-10-24T12:00:00.000Z", by: "admin@example.com" }]);
}

console.log("\nthe cooldown");
calls = [];
{
  const out = await releaseDaily(env, "other@example.com", { now: T0 + 30_000 });
  check("a second press within two minutes is refused", [out.status, out.body.error], [429, "admin@example.com released one 30s ago"]);
  check("and dispatches nothing", calls.filter((c) => c.startsWith("POST")), []);
  const force = await releaseDaily(env, "other@example.com", { now: T0 + 30_000, force: true });
  check("not even with force", force.status, 429);
}

console.log("\na build already running");
runs = [run(800, "in_progress", { event: "workflow_dispatch", triggering_actor: { login: "org-manager[bot]" } }), run(799, "completed")];
calls = [];
{
  const out = await releaseDaily(env, "admin@example.com", { now: T0 + 5 * 60_000 });
  check("is a 409 naming the build", [out.status, out.body.error], [409, "build #800 is still running"]);
  check("and dispatches nothing", calls.filter((c) => c.startsWith("POST")), []);
  const force = await releaseDaily(env, "admin@example.com", { now: T0 + 5 * 60_000, force: true });
  check("goes ahead when asked to", force.status, 200);
  check("and the log says it ran alongside #800", log()[0].alongside, 800);
}

console.log("\nGitHub refusing the dispatch");
runs = [run(801, "completed")];
dispatchStatus = 403;
{
  const before = log().length;
  const out = await releaseDaily(env, "admin@example.com", { now: T0 + 20 * 60_000 });
  check("is a 502", out.status, 502);
  check("that says what to check", /Actions: Read and write/.test(out.body.error), true);
  check("and logs nothing", log().length, before);
}
dispatchStatus = 204;

console.log("\na dry run");
calls = [];
{
  const out = await releaseDaily(env, "dev@localhost", { now: T0 + 30 * 60_000, dryRun: true });
  check("answers 200 marked dry", [out.status, out.body.entry.dryRun], [200, true]);
  check("sends no dispatch", calls.filter((c) => c.startsWith("POST")), []);
  const next = await releaseDaily(env, "admin@example.com", { now: T0 + 30 * 60_000 + 1000 });
  check("and doesn't start the cooldown", next.status, 200);
}

console.log("\nwithout Org-Manager");
{
  const out = await releaseDaily({ ...env, ORG_MANAGER_PRIVATE_KEY: undefined }, "admin@example.com", { now: T0 + 60 * 60_000 });
  check("says so", [out.status, /not set/.test(out.body.error)], [503, true]);
}

console.log("\nthe status");
for (let i = 0; i < 8; i++) await releaseDaily(env, `a${i}@example.com`, { now: T0 + (2 + i) * 3_600_000 });
runs = [run(810, "queued"), run(809, "completed")];
{
  const s = await dailyStatus(env);
  check("shows the five newest presses", s.log.map((e) => e.by), ["a7@example.com", "a6@example.com", "a5@example.com", "a4@example.com", "a3@example.com"]);
  check("finds the running build", s.running.number, 810);
  check("keeps no more than twenty", log().length <= 20, true);
  check("links the workflow", s.workflowUrl, "https://github.com/GTNewHorizons/DreamAssemblerXXL/actions/workflows/daily-modpack-build.yml");
}

forgetToken();
forgetOrgManagerToken();
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
