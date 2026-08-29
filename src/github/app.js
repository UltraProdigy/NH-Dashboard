/**
 * GitHub App authentication.
 *
 * The App exists because a personal token cannot see the org's private repos,
 * and because an App is also what delivers webhooks later. Both halves of the
 * "going live" plan need this same object.
 *
 * Only the private key is secret. The App ID is public (it's in the App's own
 * URL) and the installation ID is derived at runtime rather than stored —
 * reinstalling the App mints a new one, so anything hardcoded silently breaks
 * the day an owner reinstalls.
 */

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { ORG } from "../config.js";

const API = "https://api.github.com";
const UA = "nh-dashboard";

let cached = null;

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

function readKey() {
  const inline = process.env.GH_APP_PRIVATE_KEY;
  if (inline) return inline.includes("\\n") ? inline.replace(/\\n/g, "\n") : inline;

  const path = process.env.GH_APP_KEY_PATH;
  if (path) return readFileSync(path, "utf8");

  return null;
}

/** True when the environment carries enough to authenticate as the App. */
export function appConfigured() {
  return Boolean(process.env.GH_APP_ID && readKey());
}

/**
 * JWTs authenticate as the App itself, which can only read App metadata and
 * mint installation tokens. GitHub rejects anything over 10 minutes; 9 leaves
 * room for clock skew, and backdating iat absorbs skew the other way.
 */
function mintJwt() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: process.env.GH_APP_ID }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(readKey(), "base64url")}`;
}

async function call(path, token, method = "GET") {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": UA,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${method} ${path} -> ${res.status} ${res.statusText} ${body}`);
  }
  return res.json();
}

/**
 * An installation token, valid an hour. Cached until five minutes before it
 * expires so a long ingest never fails mid-run on a token that aged out.
 */
export async function getInstallationToken() {
  if (cached && cached.expiresAt - Date.now() > 5 * 60 * 1000) return cached.token;

  if (!appConfigured()) {
    throw new Error(
      "GitHub App not configured. Set GH_APP_ID and one of:\n" +
        "  GH_APP_KEY_PATH=/path/to/key-pk8.pem   (local)\n" +
        "  GH_APP_PRIVATE_KEY=<pem contents>      (CI secret)",
    );
  }

  const jwt = mintJwt();
  const installation = await call(`/orgs/${ORG}/installation`, jwt);
  const issued = await call(
    `/app/installations/${installation.id}/access_tokens`,
    jwt,
    "POST",
  );

  cached = { token: issued.token, expiresAt: Date.parse(issued.expires_at) };
  return cached.token;
}

export async function appRequest(path, { accept } = {}) {
  const token = await getInstallationToken();
  const res = await fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: accept || "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": UA,
    },
  });
  if (res.status === 403 || res.status === 404) return { ok: false, status: res.status };
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${path} -> ${res.status} ${res.statusText} ${body}`);
  }
  return { ok: true, status: res.status, body: await res.json() };
}

/** Every repo the installation can see, private included. */
export async function listRepos() {
  const out = [];
  let page = 1;
  for (;;) {
    const { body } = await appRequest(
      `/installation/repositories?per_page=100&page=${page}`,
    );
    if (!body?.repositories?.length) break;
    for (const r of body.repositories) {
      out.push({ name: r.name, fullName: r.full_name, private: r.private });
    }
    if (body.repositories.length < 100) break;
    page += 1;
  }
  return out;
}
