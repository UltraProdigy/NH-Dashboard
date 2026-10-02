/**
 * The private namespace must refuse everything that isn't a valid Access
 * token for this application, and must never answer with CORS headers.
 *
 *   node worker/test/private.test.js
 *
 * Runs the real router in index.js. Tokens are signed with a key generated
 * here and served from a stubbed certs endpoint, so no network is needed.
 */

import worker from "../src/index.js";
import { resetAccessKeys } from "../src/access.js";

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  ok ? (pass++, console.log("  ok    " + n))
     : (fail++, console.log("  FAIL  " + n + (d ? " — " + d : "")));
};

const DOMAIN = "gtnh.cloudflareaccess.com";
const AUD = "test-audience-tag";
const ENV = { ACCESS_TEAM_DOMAIN: DOMAIN, ACCESS_AUD: AUD };

const alg = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
const good = await crypto.subtle.generateKey(alg, true, ["sign", "verify"]);
const rogue = await crypto.subtle.generateKey(alg, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", good.publicKey)), kid: "k1" };

let certFetches = 0;
globalThis.fetch = async (url) => {
  certFetches++;
  if (String(url) !== `https://${DOMAIN}/cdn-cgi/access/certs`) return new Response("", { status: 404 });
  return Response.json({ keys: [jwk] });
};

const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);

async function token(claims = {}, { key = good.privateKey, header = {} } = {}) {
  const h = enc({ alg: "RS256", kid: "k1", typ: "JWT", ...header });
  const p = enc({
    aud: [AUD], iss: `https://${DOMAIN}`, email: "admin@example.com", sub: "user-1",
    iat: now(), nbf: now(), exp: now() + 3600, ...claims,
  });
  const sig = Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${h}.${p}`)));
  return `${h}.${p}.${sig.toString("base64url")}`;
}

async function call(path, { jwt, method = "GET", env = ENV } = {}) {
  const headers = jwt ? { "cf-access-jwt-assertion": jwt } : {};
  const res = await worker.fetch(new Request(`https://dash.example${path}`, { method, headers }), env, {
    waitUntil() {},
  });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
}

const noCors = (r) => !r.headers.has("access-control-allow-origin");

{
  const r = await call("/api/private/whoami");
  check("no token is a 401", r.status === 401, r.status);
  check("a refusal carries no CORS header", noCors(r));
  check("a refusal is not cached", r.headers.get("cache-control") === "private, no-store");
}

{
  const r = await call("/api/private/whoami", { jwt: await token() });
  check("a valid token reaches whoami", r.status === 200 && r.body?.email === "admin@example.com", JSON.stringify(r.body));
  check("a private answer carries no CORS header", noCors(r));
  check("a private answer is not cached", r.headers.get("cache-control") === "private, no-store");
}

const refused = [
  ["a token signed by another key", () => token({}, { key: rogue.privateKey })],
  ["a token for another application", () => token({ aud: ["someone-else"] })],
  ["a token from another team domain", () => token({ iss: "https://other.cloudflareaccess.com" })],
  ["an expired token", () => token({ exp: now() - 600 })],
  ["a token that is not valid yet", () => token({ nbf: now() + 600 })],
  ["a token with no expiry", () => token({ exp: undefined })],
  ["an unsigned token", async () => (await token({}, { header: { alg: "none" } })).replace(/[^.]+$/, "")],
  ["a token with an unknown key id", () => token({}, { header: { kid: "k9" } })],
  ["a malformed token", async () => "not.a.token"],
  ["a token with its payload swapped", async () => {
    const [h, , s] = (await token()).split(".");
    return `${h}.${enc({ aud: [AUD], iss: `https://${DOMAIN}`, email: "x@example.com", exp: now() + 3600 })}.${s}`;
  }],
];
for (const [name, make] of refused) {
  const r = await call("/api/private/whoami", { jwt: await make() });
  check(`${name} is refused`, r.status === 403, `${r.status} ${JSON.stringify(r.body)}`);
}

{
  const jwt = await token();
  const r = await call("/api/private/whoami", { jwt, env: {} });
  check("an unconfigured Worker refuses even a valid token", r.status === 403, r.status);
  const r2 = await call("/api/private/whoami", { jwt, env: { ACCESS_TEAM_DOMAIN: DOMAIN } });
  check("a missing audience refuses too", r2.status === 403, r2.status);
}

{
  const r = await call("/api/private/nothing-here");
  check("an unknown private route without a token is a 401, not a 404", r.status === 401, r.status);
  const r2 = await call("/api/private/nothing-here", { jwt: await token() });
  check("an unknown private route with a token is a 404", r2.status === 404, r2.status);
  const r3 = await call("/api/private/__proto__", { jwt: await token() });
  check("prototype names are not routes", r3.status === 404, r3.status);
  const r4 = await call("/api/private", { jwt: await token() });
  check("the bare prefix is guarded", r4.status === 404 && noCors(r4), r4.status);
  const r5 = await call("/api/private");
  check("the bare prefix needs a token", r5.status === 401, r5.status);
}

{
  const r = await call("/api/private/whoami", { method: "OPTIONS" });
  check("a preflight gets no CORS approval", r.status === 401 && noCors(r), r.status);
  const r2 = await call("/api/private/whoami", { method: "POST", jwt: await token() });
  check("only GET is answered", r2.status === 405 && noCors(r2), r2.status);
}

{
  const before = certFetches;
  for (let i = 0; i < 3; i++) await call("/api/private/whoami", { jwt: await token() });
  check("the signing keys are cached between requests", certFetches === before, `${certFetches - before} fetches`);
  for (let i = 0; i < 3; i++) await call("/api/private/whoami", { jwt: await token({}, { header: { kid: "k9" } }) });
  check("unknown key ids don't refetch the keys on every request", certFetches === before, `${certFetches - before} fetches`);
  resetAccessKeys();
  await call("/api/private/whoami", { jwt: await token() });
  check("and fetched again after a reset", certFetches === before + 1);
}

{
  const r = await call("/api/nothing");
  check("public routes still answer with CORS", r.headers.get("access-control-allow-origin") === "*");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
