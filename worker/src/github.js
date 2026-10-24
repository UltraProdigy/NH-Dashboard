/**
 * The GitHub App, from inside the Worker.
 *
 * `src/github/app.js` does this for the Node tooling with node:crypto, which
 * Workers do not have, so the JWT is signed with WebCrypto here instead. The key
 * must be PKCS#8 (see "The GitHub App" in documentation.md) — WebCrypto will not
 * import the PKCS#1 file GitHub hands out.
 */

const API = "https://api.github.com";
const UA = "nh-dashboard-worker";
const encoder = new TextEncoder();

let cachedToken = null;

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

function pemBody(pem) {
  const base64 = pem
    .replace(/\\n/g, "\n")
    .replace(/-----[A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

export const appReady = (env) => Boolean(env.GH_APP_ID && env.GH_APP_PRIVATE_KEY);

export async function signJwt(appId, pem, now = Date.now()) {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemBody(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  // GitHub refuses an exp more than ten minutes out; iat is backdated for skew.
  const iat = Math.floor(now / 1000) - 60;
  const head = b64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const body = b64url(
    encoder.encode(JSON.stringify({ iat, exp: iat + 540, iss: String(appId) })),
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(`${head}.${body}`),
  );
  return `${head}.${body}.${b64url(signature)}`;
}

export const appJwt = (env, now = Date.now()) => signJwt(env.GH_APP_ID, env.GH_APP_PRIVATE_KEY, now);

export async function rest(path, token, { method = "GET", body } = {}) {
  const res = await fetch(path.startsWith("http") ? path : `${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": UA,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  }
  return res;
}

export async function mintInstallationToken(jwt, org) {
  const install = await (await rest(`/orgs/${org}/installation`, jwt)).json();
  const minted = await (
    await rest(`/app/installations/${install.id}/access_tokens`, jwt, { method: "POST" })
  ).json();
  return { token: minted.token, expiresAt: Date.parse(minted.expires_at) };
}

export async function installationToken(env, now = Date.now()) {
  if (cachedToken && cachedToken.expiresAt - now > 5 * 60_000) return cachedToken.token;
  cachedToken = await mintInstallationToken(await appJwt(env, now), env.GITHUB_ORG ?? "GTNewHorizons");
  return cachedToken.token;
}

export function forgetToken() {
  cachedToken = null;
}

export async function graphql(token, query, variables = {}) {
  const res = await rest("/graphql", token, { method: "POST", body: { query, variables } });
  const out = await res.json();
  if (out.errors?.length) throw new Error(`graphql: ${out.errors[0].message}`);
  return out.data;
}

function nextPage(link) {
  const next = link?.split(",").find((part) => part.includes('rel="next"'));
  return next?.match(/<([^>]+)>/)?.[1] ?? null;
}

/**
 * Redeliver every recent delivery GitHub recorded as failed.
 *
 * GitHub never retries a delivery on its own, and before this the only retry
 * was somebody noticing a stale card and pressing Redeliver by hand. This is
 * that button on the cron.
 *
 * Deliveries are grouped by `guid`, which a redelivery keeps, so one that
 * already succeeded on a later attempt is left alone and one that keeps failing
 * stops after `MAX_ATTEMPTS` rather than being resent every ten minutes forever.
 * It can only see what GitHub was told had failed — which is why a handler that
 * throws now answers 500 instead of a 200 with `ok: false`.
 */
const MAX_ATTEMPTS = 3;

export async function redeliverFailed(
  env,
  { now = Date.now(), lookbackMs = 60 * 60_000, maxPages = 10 } = {},
) {
  if (!appReady(env)) return { skipped: "GH_APP_ID or GH_APP_PRIVATE_KEY not set" };

  const jwt = await appJwt(env, now);
  const since = now - lookbackMs;
  const byGuid = new Map();

  let url = "/app/hook/deliveries?per_page=100";
  let scanned = 0;
  for (let page = 0; url && page < maxPages; page++) {
    const res = await rest(url, jwt);
    const list = await res.json();
    let reachedEnd = false;
    for (const delivery of list) {
      if (Date.parse(delivery.delivered_at) < since) {
        reachedEnd = true;
        break;
      }
      scanned++;
      if (!byGuid.has(delivery.guid)) byGuid.set(delivery.guid, []);
      byGuid.get(delivery.guid).push(delivery);
    }
    url = reachedEnd ? null : nextPage(res.headers.get("link"));
  }

  const failing = [...byGuid.values()].filter(
    (attempts) =>
      attempts[0].event !== "ping" && !attempts.some((d) => d.status === "OK"),
  );
  const retry = failing.filter((attempts) => attempts.length < MAX_ATTEMPTS);

  const redelivered = [];
  const errors = [];
  for (const attempts of retry) {
    const { id, guid, event, action } = attempts[0];
    try {
      await rest(`/app/hook/deliveries/${id}/attempts`, jwt, { method: "POST" });
      redelivered.push({ guid, event, action, attempt: attempts.length + 1 });
    } catch (err) {
      errors.push({ guid, error: String(err) });
    }
  }

  return {
    scanned,
    failing: failing.length,
    gaveUp: failing.length - retry.length,
    redelivered,
    errors,
  };
}
