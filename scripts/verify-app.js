import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const APP_ID = process.env.GH_APP_ID;
const KEY_PATH = process.env.GH_APP_KEY_PATH;
const ORG = process.env.GITHUB_ORG || "GTNewHorizons";
const PAT = process.env.GITHUB_TOKEN;

if (!APP_ID || !KEY_PATH) {
  console.error("Set GH_APP_ID and GH_APP_KEY_PATH.");
  process.exit(1);
}

const UA = "nh-dashboard-verify";

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

function mintJwt(appId, pem) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(pem, "base64url")}`;
}

async function gh(path, token, accept = "application/vnd.github+json") {
  const headers = {
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": UA,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com${path}`, { headers });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      `${path} -> ${res.status} ${res.statusText}: ${JSON.stringify(body)}`,
    );
  }
  return { body, res };
}

async function ghPost(path, token) {
  const res = await fetch(`https://api.github.com${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": UA,
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      `${path} -> ${res.status} ${res.statusText}: ${JSON.stringify(body)}`,
    );
  }
  return body;
}

async function collectRepos(token, path) {
  const names = new Set();
  let page = 1;
  for (;;) {
    const sep = path.includes("?") ? "&" : "?";
    const { body } = await gh(`${path}${sep}per_page=100&page=${page}`, token);
    const list = Array.isArray(body) ? body : body.repositories;
    if (!list || list.length === 0) break;
    for (const r of list) names.add(r.full_name ?? r.name);
    if (list.length < 100) break;
    page += 1;
  }
  return names;
}

const pem = readFileSync(KEY_PATH, "utf8");

console.log("1. minting app JWT");
const jwt = mintJwt(APP_ID, pem);

console.log("2. reading app identity");
const { body: app } = await gh("/app", jwt);
console.log(`   ${app.name} (slug ${app.slug}, id ${app.id})`);

console.log(`3. deriving installation for ${ORG}`);
const { body: install } = await gh(`/orgs/${ORG}/installation`, jwt);
console.log(
  `   installation ${install.id}, repos: ${install.repository_selection}`,
);

console.log("4. granted permissions");
const perms = Object.entries(install.permissions).sort();
for (const [k, v] of perms) console.log(`   ${k}: ${v}`);
console.log(`   events: ${install.events.join(", ") || "(none)"}`);

const REQUESTED = [
  "metadata",
  "actions",
  "administration",
  "checks",
  "statuses",
  "contents",
  "discussions",
  "issues",
  "pull_requests",
  "repository_projects",
  "organization_administration",
  "members",
  "organization_projects",
];
const missing = REQUESTED.filter((p) => !(p in install.permissions));
if (missing.length) console.log(`   MISSING: ${missing.join(", ")}`);

console.log("5. exchanging for an installation token");
const tokenBody = await ghPost(
  `/app/installations/${install.id}/access_tokens`,
  jwt,
);
const instToken = tokenBody.token;
console.log(`   ok, expires ${tokenBody.expires_at}`);

console.log("6. counting repos visible to the app");
const appRepos = await collectRepos(instToken, "/installation/repositories");
console.log(`   app sees ${appRepos.size}`);

// Unauthenticated sees exactly the public repos, which is what the old
// public_repo-scoped token saw. Same delta, no credential needed.
const publicRepos = await collectRepos(PAT || null, `/orgs/${ORG}/repos?type=all`);
console.log(`   ${PAT ? "pat" : "public"} sees ${publicRepos.size}`);
const delta = [...appRepos].filter((r) => !publicRepos.has(r)).sort();
console.log(`   private backlog: ${delta.length}`);
for (const r of delta) console.log(`     ${r}`);

if (install.permissions.administration === "read") {
  const sample = [...appRepos][0];
  console.log(`7. traffic probe against ${sample}`);
  try {
    const { body: views } = await gh(`/repos/${sample}/traffic/views`, instToken);
    console.log(
      `   ${views.count} views / ${views.uniques} uniques, ${views.views.length} days retained`,
    );
  } catch (err) {
    console.log(`   FAILED: ${err.message}`);
  }
} else {
  console.log("7. traffic probe skipped — no administration:read");
}
