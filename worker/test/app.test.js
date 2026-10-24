/**
 * The app Worker must refuse every /api/ request without a valid Access token,
 * give admins and members the right data, and never answer with CORS headers.
 *
 *   node --experimental-sqlite worker/test/app.test.js
 *
 * Tokens are signed with a key generated here and served from a stubbed certs
 * endpoint; the identity endpoint is stubbed too, so no network is needed.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { handleApp } from "../src/app.js";
import { resetAccessKeys } from "../src/access.js";
import { isAdminTeam, resetRoles } from "../src/roles.js";
import { ADMIN_PANELS, LIVE_PANELS } from "../../web/js/roles.js";

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  ok ? (pass++, console.log("  ok    " + n))
     : (fail++, console.log("  FAIL  " + n + (d ? " — " + d : "")));
};

const DOMAIN = "nh-dashboard.cloudflareaccess.com";
const AUD = "test-audience-tag";

const db = new DatabaseSync(":memory:");
db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
const put = db.prepare("INSERT INTO panel_cache (name, json, computed_at) VALUES (?, ?, ?)");
for (const name of LIVE_PANELS.filter((n) => n !== "issues")) {
  put.run(name, JSON.stringify(name === "byLabel" ? { bug: [], "needs review": [] } : { panel: name }), "2026-10-14T12:00:00Z");
}
db.prepare("INSERT INTO meta (key, value) VALUES ('checked_at', '2026-10-14T12:05:00Z')").run();

const d1 = {
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
};

const assetHits = [];
const ENV = {
  ACCESS_TEAM_DOMAIN: DOMAIN,
  ACCESS_AUD: AUD,
  GITHUB_ORG: "GTNewHorizons",
  ADMIN_TEAM: "admin",
  DB: d1,
  ASSETS: { fetch: async (req) => (assetHits.push(new URL(req.url).pathname), new Response("asset")) },
};

const alg = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
const good = await crypto.subtle.generateKey(alg, true, ["sign", "verify"]);
const rogue = await crypto.subtle.generateKey(alg, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", good.publicKey)), kid: "k1" };

const GTNH = { id: 12788076, name: "GTNewHorizons" };
const OTHER = { id: 5, name: "SomeOtherOrg" };
const IDENTITIES = {
  "admin-user": {
    idp: { type: "github" },
    orgs: [GTNH],
    teams: [{ name: "Admin", org_id: GTNH.id }, { name: "Developers", org_id: GTNH.id }, { name: "Triage team", org_id: GTNH.id }],
  },
  "member-user": { idp: { type: "github" }, orgs: [GTNH], teams: [{ name: "Developers", org_id: GTNH.id }] },
  "other-admin": { idp: { type: "github" }, orgs: [GTNH, OTHER], teams: [{ name: "Admin", org_id: OTHER.id }] },
  "groups-admin": { groups: [{ name: "GTNewHorizons:admin" }] },
};
let identityFetches = 0;
const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

const fetchImpl = async (url, init = {}) => {
  url = String(url);
  if (url === `https://${DOMAIN}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
  if (url === `https://${DOMAIN}/cdn-cgi/access/get-identity`) {
    identityFetches++;
    const token = (init.headers?.cookie ?? "").replace("CF_Authorization=", "");
    const sub = JSON.parse(Buffer.from(token.split(".")[1], "base64url")).sub;
    if (sub === "broken") return new Response("", { status: 500 });
    return Response.json({ email: `${sub}@example.com`, ...(IDENTITIES[sub] ?? {}) });
  }
  return new Response("", { status: 404 });
};

const now = () => Math.floor(Date.now() / 1000);
async function token(sub = "admin-user", claims = {}, key = good.privateKey) {
  const h = enc({ alg: "RS256", kid: "k1", typ: "JWT" });
  const p = enc({ aud: [AUD], iss: `https://${DOMAIN}`, email: `${sub}@example.com`, sub, iat: now(), nbf: now(), exp: now() + 3600, ...claims });
  const sig = Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${h}.${p}`)));
  return `${h}.${p}.${sig.toString("base64url")}`;
}

async function call(path, { sub, jwt, method = "GET", env = ENV, host = "nh-dashboard-app.gtnh.workers.dev", headers = {} } = {}) {
  const h = { ...headers };
  const t = jwt ?? (sub ? await token(sub) : null);
  if (t) h["cf-access-jwt-assertion"] = t;
  const res = await handleApp(new Request(`https://${host}${path}`, { method, headers: h }), env, { waitUntil() {} }, { fetchImpl });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, headers: res.headers, body, text };
}

const noCors = (r) => !r.headers.has("access-control-allow-origin");

console.log("\nlogin\n");
for (const path of ["/api/whoami", "/api/dashboard", "/api/version", "/api/panel/analytics", "/api/search?q=x", "/api/repo/x", "/api/nothing"]) {
  const r = await call(path);
  check(`${path} without a token is a 401`, r.status === 401 && noCors(r), r.status);
}
{
  const r = await call("/api/whoami", { jwt: await token("admin-user", {}, rogue.privateKey) });
  check("a token signed by another key is a 403", r.status === 403, r.status);
  const r2 = await call("/api/whoami", { jwt: await token("admin-user", { aud: ["other"] }) });
  check("a token for another application is a 403", r2.status === 403, r2.status);
  const r3 = await call("/api/whoami", { jwt: await token("admin-user", { exp: now() - 600 }) });
  check("an expired token is a 403", r3.status === 403, r3.status);
  const r4 = await call("/api/whoami", { sub: "admin-user", env: { ...ENV, ACCESS_AUD: undefined } });
  check("without ACCESS_AUD set, everything is refused", r4.status === 403, r4.status);
}

console.log("\nstatic files\n");
{
  const r = await call("/");
  check("pages come from the assets, not the API", r.text === "asset" && assetHits.includes("/"));
  const r2 = await call("/repo-drilldown/GT5-Unofficial");
  check("deep links go to the assets too", r2.text === "asset");
}

console.log("\nroles\n");
{
  resetRoles();
  const a = await call("/api/whoami", { sub: "admin-user" });
  check("an admin team member is an admin", a.body?.role === "admin", JSON.stringify(a.body));
  check("whoami shows the teams Access reported", a.body?.groups?.includes("GTNewHorizons:Admin"), JSON.stringify(a.body?.groups));
  check("whoami carries no CORS header and isn't cached", noCors(a) && a.headers.get("cache-control") === "private, no-store");
  const m = await call("/api/whoami", { sub: "member-user" });
  check("an org member is a member", m.body?.role === "member", JSON.stringify(m.body));
  const o = await call("/api/whoami", { sub: "other-admin" });
  check("another org's admin team doesn't count", o.body?.role === "member");
  const g = await call("/api/whoami", { sub: "groups-admin" });
  check("an admin reported through groups still counts", g.body?.role === "admin");
  const b = await call("/api/whoami", { sub: "broken" });
  check("a failed identity lookup falls back to member", b.status === 200 && b.body?.role === "member");

  const before = identityFetches;
  for (let i = 0; i < 3; i++) await call("/api/version", { sub: "admin-user" });
  check("the role is cached between requests", identityFetches === before, `${identityFetches - before} lookups`);
}

console.log("\nadmin-only data\n");
for (const name of ADMIN_PANELS) {
  const m = await call(`/api/panel/${name}`, { sub: "member-user" });
  check(`a member is refused ${name}`, m.status === 403, m.status);
  const a = await call(`/api/panel/${name}`, { sub: "admin-user" });
  check(`an admin gets ${name}`, a.status === 200 && a.body?.panel === name, a.status);
}
{
  const m = await call("/api/panel/needsRelease", { sub: "member-user" });
  check("a member still gets the panels member pages use", m.status === 200);
  const r = await call("/api/recompute", { sub: "member-user", method: "POST", headers: { origin: "https://nh-dashboard-app.gtnh.workers.dev" } });
  check("a member can't trigger a recompute", r.status === 403, r.status);
  const r2 = await call("/api/recompute", { sub: "admin-user", method: "POST", headers: { origin: "https://evil.example" } });
  check("a recompute from another origin is refused", r2.status === 403, r2.status);
  const v = await call("/api/verify", { sub: "member-user", method: "POST", headers: { origin: "https://nh-dashboard-app.gtnh.workers.dev" } });
  check("a member can't run the verify", v.status === 403, v.status);
  const v2 = await call("/api/verify", { sub: "admin-user", method: "POST", headers: { origin: "https://evil.example" } });
  check("a verify from another origin is refused", v2.status === 403, v2.status);
  const v3 = await call("/api/verify", { sub: "admin-user" });
  check("the verify is POST only", v3.status === 405, v3.status);
  const v4 = await call("/api/verify", { sub: "admin-user", method: "POST", headers: { origin: "https://nh-dashboard-app.gtnh.workers.dev" } });
  check("without the App key the verify says so rather than failing", v4.status === 200 && /not set/.test(v4.body?.skipped), JSON.stringify(v4.body));
  const origin = { origin: "https://nh-dashboard-app.gtnh.workers.dev" };
  const d1 = await call("/api/daily", { sub: "member-user" });
  check("a member can't see the daily status", d1.status === 403, d1.status);
  const d2 = await call("/api/daily", { sub: "member-user", method: "POST", headers: origin });
  check("a member can't release a daily", d2.status === 403, d2.status);
  const d3 = await call("/api/daily", { sub: "admin-user", method: "POST", headers: { origin: "https://evil.example" } });
  check("a release from another origin is refused", d3.status === 403, d3.status);
  const d4 = await call("/api/daily", { sub: "admin-user", method: "POST", headers: origin });
  check("without Org-Manager's key the release says so", d4.status === 503 && /not set/.test(d4.body?.error), JSON.stringify(d4.body));
  const d5 = await call("/api/daily", { sub: "admin-user" });
  check("an admin can read the daily status", d5.status === 200 && d5.body?.ready === false, JSON.stringify(d5.body));
  const r3 = await call("/api/panel/analytics", { sub: "admin-user", method: "POST" });
  check("reads are GET only", r3.status === 405, r3.status);
}

console.log("\nGitHub Logs\n");
{
  const forwarded = [];
  const withLog = {
    ...ENV,
    EVENT_LOG: {
      idFromName: (n) => `id:${n}`,
      get: (id) => ({ fetch: async (req) => (forwarded.push({ id, path: new URL(req.url).pathname }), new Response("socket")) }),
    },
  };
  const ws = { upgrade: "websocket", origin: "https://nh-dashboard-app.gtnh.workers.dev" };
  const none = await call("/api/logs", { env: withLog, headers: ws });
  check("the log needs a login", none.status === 401, none.status);
  const m = await call("/api/logs", { sub: "member-user", env: withLog, headers: ws });
  check("a member is refused the log", m.status === 403 && forwarded.length === 0, m.status);
  const plain = await call("/api/logs", { sub: "admin-user", env: withLog });
  check("a plain GET is told it needs a WebSocket", plain.status === 426, plain.status);
  const evil = await call("/api/logs", { sub: "admin-user", env: withLog, headers: { ...ws, origin: "https://evil.example" } });
  check("a socket opened from another origin is refused", evil.status === 403 && forwarded.length === 0, evil.status);
  const a = await call("/api/logs", { sub: "admin-user", env: withLog, headers: ws });
  check("an admin's socket goes to the one named log", a.text === "socket" && forwarded.length === 1 && forwarded[0].id === "id:github-logs", a.status);
  const unbound = await call("/api/logs", { sub: "admin-user", headers: ws });
  check("without the binding it says so", unbound.status === 503, unbound.status);
}

console.log("\ndashboard\n");
{
  const a = await call("/api/dashboard", { sub: "admin-user" });
  const names = Object.keys(a.body?.panels ?? {});
  check("the admin dashboard has every panel", LIVE_PANELS.every((n) => names.includes(n)), names.join(","));
  check("cached panel data is passed through whole", a.body?.panels?.analytics?.data?.panel === "analytics");
  check("each panel says when it was computed and how it refreshes",
    a.body?.panels?.analytics?.computedAt === "2026-10-14T12:00:00Z" && typeof a.body?.panels?.analytics?.refresh === "string");
  check("a panel never computed is marked down with an empty shape",
    a.body?.panels?.issues?.ok === false && a.body.panels.issues.down === true && Array.isArray(a.body.panels.issues.data?.labels));
  check("tracked labels come from byLabel", JSON.stringify(a.body?.trackedLabels) === JSON.stringify(["bug", "needs review"]));
  check("generatedAt is the last recompute check", a.body?.generatedAt === "2026-10-14T12:05:00Z");
  check("the drilldown entry is there for the lazy fetch", a.body?.panels?.drilldown?.ok === true);

  const m = await call("/api/dashboard", { sub: "member-user" });
  const mNames = Object.keys(m.body?.panels ?? {});
  check("the member dashboard leaves out admin-only panels", ADMIN_PANELS.every((n) => !mNames.includes(n)), mNames.join(","));
  check("and keeps the rest", mNames.includes("analytics") && mNames.includes("byLabel"));
  check("admin-only panel data appears nowhere in a member's dashboard",
    ADMIN_PANELS.every((n) => !m.text.includes(`"panel":"${n}"`)));
}

console.log("\nlocal development\n");
{
  const env = { ...ENV, DEV_ROLE: "member" };
  const r = await call("/api/whoami", { env, host: "localhost:8787" });
  check("DEV_ROLE works on localhost", r.status === 200 && r.body?.role === "member");
  const r2 = await call("/api/whoami", { env });
  check("DEV_ROLE is ignored anywhere else", r2.status === 401, r2.status);
}

console.log("\ngroup matching\n");
{
  const yes = [
    { groups: ["GTNewHorizons:admin"] },
    { groups: ["gtnewhorizons/admin"] },
    { groups: [{ name: "GTNewHorizons:admin" }] },
    { groups: [{ organization: "GTNewHorizons", slug: "admin" }] },
  ];
  const github = (teams, orgs = [GTNH]) => ({ orgs, teams });
  yes.push(
    github([{ name: "Admin", org_id: GTNH.id }]),
    github([{ name: "admin", org_id: GTNH.id }]),
  );
  const no = [
    {},
    github([{ name: "Admin", org_id: OTHER.id }], [GTNH, OTHER]),
    github([{ name: "Admin", org_id: 999 }]),
    github([{ name: "Administrators", org_id: GTNH.id }]),
    github([{ name: "Developers", org_id: GTNH.id }]),
    github([{ name: "Admin", org_id: GTNH.id }], []),
    { groups: ["admin"] },
    { groups: [{ name: "admin" }] },
    { groups: ["GTNewHorizons:administrators"] },
    { groups: [{ organization: "Other", slug: "admin" }] },
  ];
  check("org-qualified admin team names match", yes.every((i) => isAdminTeam(i, "GTNewHorizons", "admin")));
  check("a bare or foreign admin team doesn't", no.every((i) => !isAdminTeam(i, "GTNewHorizons", "admin")));
}

console.log("\nthe webhook Worker serves no data\n");
{
  const { default: hook } = await import("../src/index.js");
  for (const path of ["/api/dashboard", "/api/version", "/api/panel/analytics", "/api/search?q=x", "/api/repo/x", "/api/whoami"]) {
    const res = await hook.fetch(new Request(`https://nh-dashboard.gtnh.workers.dev${path}`), ENV, { waitUntil() {} });
    check(`${path} is a 404 there`, res.status === 404 && !res.headers.has("access-control-allow-origin"), res.status);
  }
  const res = await hook.fetch(new Request("https://nh-dashboard.gtnh.workers.dev/api/recompute", { method: "POST" }), ENV, { waitUntil() {} });
  check("and can't be made to recompute", res.status === 404, res.status);
  const vres = await hook.fetch(new Request("https://nh-dashboard.gtnh.workers.dev/api/verify", { method: "POST" }), ENV, { waitUntil() {} });
  check("or to verify", vres.status === 404, vres.status);
}

resetAccessKeys();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
