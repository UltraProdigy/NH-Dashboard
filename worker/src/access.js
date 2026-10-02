/**
 * Verifies the Cloudflare Access token on a private request.
 *
 * Access sits in front of /api/private/* and only forwards requests from
 * Admin team members, but the Worker checks the token itself rather than
 * trusting that every request came through Access. A workers.dev URL, a
 * preview deployment or a misconfigured application would otherwise skip the
 * login entirely.
 *
 * With ACCESS_TEAM_DOMAIN or ACCESS_AUD unset, every private request is
 * refused.
 */

const LEEWAY_S = 60;
const JWKS_TTL_MS = 60 * 60 * 1000;
const REFETCH_MS = 60 * 1000;

let jwks = { domain: null, at: 0, keys: new Map() };

const b64url = (s) => {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
};

const decodePart = (s) => JSON.parse(new TextDecoder().decode(b64url(s)));

async function loadKeys(domain, fetchImpl) {
  const res = await fetchImpl(`https://${domain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`certs ${res.status}`);
  const { keys = [] } = await res.json();
  const out = new Map();
  for (const jwk of keys) {
    if (jwk.kty !== "RSA" || !jwk.kid) continue;
    out.set(
      jwk.kid,
      await crypto.subtle.importKey(
        "jwk",
        { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      ),
    );
  }
  jwks = { domain, at: Date.now(), keys: out };
}

async function keyFor(domain, kid, fetchImpl) {
  const age = jwks.domain === domain ? Date.now() - jwks.at : Infinity;
  if (age < JWKS_TTL_MS && jwks.keys.has(kid)) return jwks.keys.get(kid);
  if (age < REFETCH_MS) return null;
  await loadKeys(domain, fetchImpl);
  return jwks.keys.get(kid) ?? null;
}

export function resetAccessKeys() {
  jwks = { domain: null, at: 0, keys: new Map() };
}

/**
 * Resolves to `{ ok: true, identity }` or `{ ok: false, status, reason }`.
 * 401 means no token was presented, 403 means one was and it failed.
 */
export async function verifyAccess(request, env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const domain = env?.ACCESS_TEAM_DOMAIN?.trim();
  const aud = env?.ACCESS_AUD?.trim();
  if (!domain || !aud) return { ok: false, status: 403, reason: "access not configured" };

  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return { ok: false, status: 401, reason: "no access token" };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, status: 403, reason: "malformed token" };

  let header, claims;
  try {
    header = decodePart(parts[0]);
    claims = decodePart(parts[1]);
  } catch {
    return { ok: false, status: 403, reason: "malformed token" };
  }

  if (header.alg !== "RS256" || !header.kid) return { ok: false, status: 403, reason: "bad algorithm" };

  let key;
  try {
    key = await keyFor(domain, header.kid, fetchImpl);
  } catch {
    return { ok: false, status: 403, reason: "keys unavailable" };
  }
  if (!key) return { ok: false, status: 403, reason: "unknown key" };

  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64url(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {}
  if (!valid) return { ok: false, status: 403, reason: "bad signature" };

  const seconds = Math.floor(now / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(aud)) return { ok: false, status: 403, reason: "wrong audience" };
  if (claims.iss !== `https://${domain}`) return { ok: false, status: 403, reason: "wrong issuer" };
  if (typeof claims.exp !== "number" || claims.exp + LEEWAY_S < seconds)
    return { ok: false, status: 403, reason: "expired" };
  if (typeof claims.nbf === "number" && claims.nbf - LEEWAY_S > seconds)
    return { ok: false, status: 403, reason: "not yet valid" };
  if (!claims.email && !claims.sub) return { ok: false, status: 403, reason: "no identity" };

  return { ok: true, identity: { email: claims.email ?? null, sub: claims.sub ?? null, exp: claims.exp } };
}
