/**
 *   node --experimental-sqlite worker/test/verify.test.js
 *
 * The Dream Panel verify and the failed-delivery redeliver, against a real
 * SQLite database and a stubbed GitHub.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { verifyDreamPanel } from "../src/verify.js";
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

// --- verify -----------------------------------------------------------------

console.log("\nverifyDreamPanel");

const prNode = (over = {}) => ({
  repository: { name: "GT5-Unofficial" },
  number: 5000,
  title: "Add a thing",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-10T00:00:00Z",
  mergedAt: null,
  closedAt: null,
  state: "OPEN",
  isDraft: false,
  author: { login: "someone" },
  additions: 1, deletions: 1, changedFiles: 1,
  commits: { totalCount: 1 },
  comments: { totalCount: 0 },
  assignees: { nodes: [] },
  labels: { nodes: [] },
  reviewRequests: { nodes: [] },
  reactions: { totalCount: 0 },
  thumbsUp: { totalCount: 0 },
  thumbsDown: { totalCount: 0 },
  reviews: { totalCount: 1, nodes: [{ state: "APPROVED", submittedAt: "2026-10-09T00:00:00Z", author: { login: "rev" } }] },
  mergeCommit: null,
  ...over,
});

const insertPr = (number, state, updated, mergedAt = null) =>
  raw.prepare(
    `INSERT INTO pull_requests (repo, number, title, author, created_at, updated_at, merged_at, state, is_draft, labels)
     VALUES ('GT5-Unofficial', ?, 't', 'someone', '2026-10-01T00:00:00Z', ?, ?, ?, 0, '[]')`,
  ).run(number, updated, mergedAt, state);
const insertReview = (number, state = "APPROVED") =>
  raw.prepare(
    `INSERT INTO reviews (repo, pr_number, author, state, submitted_at)
     VALUES ('GT5-Unofficial', ?, 'rev', ?, '2026-10-09T00:00:00Z')`,
  ).run(number, state);

// 5000: correct already. 5001: merged on GitHub, stuck OPEN here.
// 5002: approved on GitHub, the approval never arrived here.
insertPr(5000, "OPEN", "2026-10-10T00:00:00Z");
insertReview(5000);
insertPr(5001, "OPEN", "2026-10-08T00:00:00Z");
insertReview(5001);
insertPr(5002, "OPEN", "2026-10-09T00:00:00Z");
raw.prepare(
  `INSERT INTO panel_cache (name, json, computed_at, ms) VALUES ('approvedUnmerged', ?, '2026-10-10T00:00:00Z', 1)`,
).run(JSON.stringify([
  { repo: "GTNewHorizons/GT5-Unofficial", number: 5000 },
  { repo: "GTNewHorizons/GT5-Unofficial", number: 5001 },
]));
raw.prepare(
  `INSERT INTO repos (name, full_name, private, archived, default_branch) VALUES ('GT5-Unofficial', 'GTNewHorizons/GT5-Unofficial', 0, 0, 'master')`,
).run();
raw.prepare(
  `INSERT INTO releases (repo, tag_name, published_at, created_at, draft, prerelease)
   VALUES ('GT5-Unofficial', '5.09.51', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', 0, 0),
          ('GT5-Unofficial', '5.09.52', NULL, '2026-10-11T00:00:00Z', 1, 0)`,
).run();

const searches = [];
routes = {
  ...tokenRoutes,
  "POST /graphql": (_, { query, variables }) => {
    if (query.includes("search(")) {
      searches.push(variables.q);
      const nodes = variables.q.includes("review:approved")
        ? [
            prNode(),
            prNode({ number: 5002, updatedAt: "2026-10-11T00:00:00Z" }),
          ]
        : [];
      return { data: { search: { pageInfo: { hasNextPage: false }, nodes } } };
    }
    if (query.includes("releases(")) {
      return {
        data: {
          organization: {
            repositories: {
              pageInfo: { hasNextPage: false },
              nodes: [
                {
                  name: "GT5-Unofficial",
                  releases: {
                    nodes: [
                      { tagName: "5.09.52", publishedAt: "2026-10-12T00:00:00Z", createdAt: "2026-10-11T00:00:00Z", isDraft: false, isPrerelease: false },
                      { tagName: "5.09.51", publishedAt: "2026-09-01T00:00:00Z", createdAt: "2026-09-01T00:00:00Z", isDraft: false, isPrerelease: false },
                    ],
                  },
                },
              ],
            },
          },
        },
      };
    }
    return {
      data: {
        p0: {
          pullRequest: prNode({
            number: 5001,
            state: "MERGED",
            mergedAt: "2026-10-12T00:00:00Z",
            closedAt: "2026-10-12T00:00:00Z",
            updatedAt: "2026-10-12T00:00:00Z",
            mergeCommit: { oid: "abc123" },
          }),
        },
      },
    };
  },
};

forgetToken();
const result = await verifyDreamPanel(env, { reason: "test" });
check("asks GitHub for both review states", searches.map((q) => q.split(" ").pop()), ["review:approved", "review:changes_requested"]);
check(
  "fixes the merged PR and adds the missing approval, and leaves the right one alone",
  result.fixed.prs.map((f) => [f.number, f.was, f.now, f.reviews]),
  [[5002, "OPEN", "OPEN", true], [5001, "OPEN", "MERGED", false]],
);
check(
  "the stuck PR is MERGED with its merge commit",
  row("SELECT state, merged_at, merge_commit_sha FROM pull_requests WHERE number = 5001"),
  { state: "MERGED", merged_at: "2026-10-12T00:00:00Z", merge_commit_sha: "abc123" },
);
check(
  "the missing approval is stored",
  row("SELECT state FROM reviews WHERE pr_number = 5002")?.state,
  "APPROVED",
);
check(
  "the release stuck as a draft is published",
  row("SELECT draft, published_at FROM releases WHERE tag_name = '5.09.52'"),
  { draft: 0, published_at: "2026-10-12T00:00:00Z" },
);
check("and only that release is reported", result.fixed.releases.map((r) => [r.tag, r.was]), [["5.09.52", "draft"]]);
check("the instant panels are rebuilt", result.rebuilt.sort(), ["approvedUnmerged", "changesRequested", "needsRelease"]);
check(
  "the cards now say what GitHub says",
  JSON.parse(row("SELECT json FROM panel_cache WHERE name = 'approvedUnmerged'").json).map((r) => r.number),
  [5000, 5002],
);
check("stamps what it wrote", !!row("SELECT value FROM meta WHERE key = 'wrote:releases'"), true);

console.log("\n  a second run finds nothing to fix");
raw.prepare("DELETE FROM meta WHERE key LIKE 'wrote:%'").run();
const again = await verifyDreamPanel(env, { reason: "test" });
check("no PR fixes", again.fixed.prs, []);
check("no release fixes", again.fixed.releases, []);
check("and stamps nothing", row("SELECT COUNT(*) n FROM meta WHERE key LIKE 'wrote:%'").n, 0);

console.log("\n  labels in another order are not a difference");
raw.prepare(`UPDATE pull_requests SET labels = '["b","a"]' WHERE number = 5000`).run();
const relabel = routes["POST /graphql"];
routes["POST /graphql"] = (u, body) => {
  const out = relabel(u, body);
  for (const n of out.data?.search?.nodes ?? []) {
    if (n.number === 5000) n.labels = { nodes: [{ name: "a" }, { name: "b" }] };
  }
  return out;
};
const reordered = await verifyDreamPanel(env, { reason: "test" });
check("not rewritten", reordered.fixed.prs, []);
routes["POST /graphql"] = relabel;

console.log("\n  a row newer than GitHub's answer is left alone");
raw.prepare("UPDATE pull_requests SET updated_at = '2026-10-13T00:00:00Z', state = 'CLOSED' WHERE number = 5000").run();
const newer = await verifyDreamPanel(env, { reason: "test" });
check("not rewritten", newer.fixed.prs, []);
check("still CLOSED", row("SELECT state FROM pull_requests WHERE number = 5000").state, "CLOSED");

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
