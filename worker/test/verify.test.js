/**
 *   node --experimental-sqlite worker/test/verify.test.js
 *
 * The failed-delivery redeliver, against a stubbed GitHub.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { appJwt, forgetToken, redeliverFailed } from "../src/github.js";

class Shim {
  constructor(db) {
    this.db = db;
  }
  prepare(sql, bound = []) {
    const db = this.db;
    const shim = this;
    return {
      sql,
      bound,
      bind: (...args) => shim.prepare(sql, args),
      async run() {
        db.prepare(sql).run(...bound);
        return { success: true };
      },
      async first() {
        return db.prepare(sql).get(...bound) ?? null;
      },
      async all() {
        return { results: db.prepare(sql).all(...bound) };
      },
    };
  }
  async batch(statements) {
    for (const s of statements) this.db.prepare(s.sql).run(...s.bound);
    return statements.map(() => ({ success: true }));
  }
}

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failed++;
  console.log(
    `  ${ok ? "ok  " : "FAIL"}  ${name}` +
      (ok ? "" : `\n          expected ${JSON.stringify(expected)}\n          got      ${JSON.stringify(actual)}`),
  );
}

const pair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
const PEM = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----\n`;

const raw = new DatabaseSync(":memory:");
raw.exec(readFileSync("worker/schema.sql", "utf8"));
const db = new Shim(raw);
const row = (sql, ...args) => raw.prepare(sql).get(...args);
const env = { DB: db, GH_APP_ID: "4745300", GH_APP_PRIVATE_KEY: PEM, GITHUB_ORG: "GTNewHorizons" };

console.log("\nthe App JWT");
const jwt = await appJwt(env, Date.parse("2026-10-14T00:00:00Z"));
const [head, body, sig] = jwt.split(".");
const claims = JSON.parse(Buffer.from(body, "base64url").toString());
check("is issued by the App", claims.iss, "4745300");
check("expires inside GitHub's ten minutes", claims.exp - claims.iat <= 600, true);
check(
  "verifies against the key that signed it",
  await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    pair.publicKey,
    Buffer.from(sig, "base64url"),
    new TextEncoder().encode(`${head}.${body}`),
  ),
  true,
);
check(
  "accepts a key whose newlines were pasted as \\n",
  (await appJwt({ ...env, GH_APP_PRIVATE_KEY: PEM.replace(/\n/g, "\\n") })).split(".").length,
  3,
);

// --- a stubbed GitHub -------------------------------------------------------

let calls = [];
let routes = {};
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = init.method ?? "GET";
  calls.push(`${method} ${u.replace("https://api.github.com", "")}`);
  for (const [pattern, handler] of Object.entries(routes)) {
    const [m, p] = pattern.split(" ");
    if (m === method && u.includes(p)) {
      const out = await handler(u, init.body ? JSON.parse(init.body) : null);
      return new Response(JSON.stringify(out.body ?? out), {
        status: out.status ?? 200,
        headers: out.headers ?? {},
      });
    }
  }
  return new Response("not stubbed", { status: 404 });
};

const tokenRoutes = {
  "GET /orgs/GTNewHorizons/installation": () => ({ id: 99 }),
  "POST /app/installations/99/access_tokens": () => ({
    token: "ghs_test",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  }),
};

// --- redeliver --------------------------------------------------------------

console.log("\nredeliverFailed");
const NOW = Date.parse("2026-10-14T12:00:00Z");
const at = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const deliveries = [
  { id: 1, guid: "ok-1", status: "OK", event: "pull_request", delivered_at: at(1) },
  { id: 2, guid: "bad-1", status: "Invalid HTTP Response: 500", event: "pull_request", action: "closed", delivered_at: at(2) },
  { id: 3, guid: "retried", status: "OK", event: "release", delivered_at: at(3) },
  { id: 4, guid: "retried", status: "timed out", event: "release", delivered_at: at(8) },
  { id: 5, guid: "hopeless", status: "Invalid HTTP Response: 500", event: "push", delivered_at: at(4) },
  { id: 6, guid: "hopeless", status: "Invalid HTTP Response: 500", event: "push", delivered_at: at(14) },
  { id: 7, guid: "hopeless", status: "Invalid HTTP Response: 500", event: "push", delivered_at: at(24) },
  { id: 8, guid: "ping", status: "Invalid HTTP Response: 500", event: "ping", delivered_at: at(30) },
  { id: 9, guid: "bad-2", status: "Invalid HTTP Response: 500", event: "release", delivered_at: at(50) },
];
const page2 = [
  { id: 10, guid: "too-old", status: "Invalid HTTP Response: 500", event: "push", delivered_at: at(90) },
];
calls = [];
routes = {
  "GET cursor=next": () => ({ body: page2 }),
  "GET /app/hook/deliveries": () => ({
    body: deliveries,
    headers: { link: '<https://api.github.com/app/hook/deliveries?per_page=100&cursor=next>; rel="next"' },
  }),
  "POST /attempts": () => ({ status: 202, body: {} }),
};
const redelivery = await redeliverFailed(env, { now: NOW });
check(
  "redelivers each failed delivery once, and nothing that later succeeded",
  redelivery.redelivered.map((r) => r.guid),
  ["bad-1", "bad-2"],
);
check(
  "uses the original delivery's id",
  calls.filter((c) => c.startsWith("POST")),
  ["POST /app/hook/deliveries/2/attempts", "POST /app/hook/deliveries/9/attempts"],
);
check("gives up after three attempts", redelivery.gaveUp, 1);
check("follows the next page and stops at the window", redelivery.scanned, 9);
check("skips cleanly with no key", await redeliverFailed({ DB: db }), { skipped: "GH_APP_ID or GH_APP_PRIVATE_KEY not set" });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
