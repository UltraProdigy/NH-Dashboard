/**
 * GitHub API client — the swappable layer.
 *
 * Panels talk only to the functions exported here. Nothing above this file
 * knows about tokens, pagination, rate limits, or caching. When this project
 * moves into the org and needs private-repo access, only `getToken()` in
 * config.js changes; every panel keeps working untouched.
 *
 * Zero dependencies — Node 18+ native fetch only.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { CACHE_TTL_MINUTES, getToken } from "../config.js";

const API = "https://api.github.com";
const CACHE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".cache"
);

/** Pass --no-cache to force fresh data. */
const CACHE_ENABLED = !process.argv.includes("--no-cache");

/** Simple counters so `npm run build` can report what it cost. */
export const stats = { requests: 0, cacheHits: 0, rateLimitWaits: 0, spacingMs: 0 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Adaptive spacing between requests, in milliseconds.
 *
 * GitHub has two unrelated limits and they need opposite responses. The
 * primary quota is a budget: spend it as fast as you like, then wait for the
 * reset. The *secondary* limits are about pace — concurrent requests, points
 * per minute, and server CPU per minute — and hitting one costs a flat 60s
 * penalty no matter how small the request that tripped it was.
 *
 * Against a pace limit, going flat out is strictly worse than going steadily:
 * a walk that trips a 60s penalty every fifth request averages 12s a request,
 * where the same walk spaced a second apart may never trip one at all.
 *
 * So rather than pick a spacing up front and hope, this starts at zero and
 * climbs by a step every time a secondary limit is hit, settling wherever the
 * API is willing to be talked to. `NH_REQUEST_SPACING_MS` sets a floor for a
 * run that already knows it will be throttled — the first walk over a large
 * org — so it doesn't have to rediscover the number from scratch.
 */
let spacing = Number(process.env.NH_REQUEST_SPACING_MS) || 0;
const SPACING_STEP = 250;
const SPACING_MAX = 3000;
let lastRequestAt = 0;

async function pace() {
  if (spacing > 0) {
    const wait = lastRequestAt + spacing - Date.now();
    if (wait > 0) await sleep(wait);
  }
  lastRequestAt = Date.now();
}

/** Back off a step. Capped, because past a few seconds the walk is the problem. */
function widenSpacing() {
  if (spacing >= SPACING_MAX) return;
  spacing = Math.min(SPACING_MAX, spacing + SPACING_STEP);
  stats.spacingMs = spacing;
  console.warn(`  spacing requests ${spacing}ms apart from here on`);
}

function cachePath(key) {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return path.join(CACHE_DIR, `${hash}.json`);
}

async function readCache(key) {
  if (!CACHE_ENABLED) return null;
  try {
    const raw = await readFile(cachePath(key), "utf8");
    const { at, body } = JSON.parse(raw);
    if (Date.now() - at > CACHE_TTL_MINUTES * 60_000) return null;
    stats.cacheHits++;
    return body;
  } catch {
    return null;
  }
}

async function writeCache(key, body) {
  if (!CACHE_ENABLED) return;
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cachePath(key), JSON.stringify({ at: Date.now(), body }));
  } catch {
    /* cache is best-effort — never fail a build over it */
  }
}

/**
 * One HTTP request, with rate-limit and transient-error handling.
 *
 * GitHub has two distinct limits and they fail differently:
 *   - Primary:   403/429 with x-ratelimit-remaining: 0 → wait until reset.
 *   - Secondary: 403/429 with a retry-after header → wait that long.
 * Both are handled here so callers never think about it.
 */
async function request(url, { method = "GET", body, headers = {} } = {}, attempt = 0) {
  await pace();
  stats.requests++;

  const res = await fetch(url, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${getToken()}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "nh-dashboard",
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    throw new Error(
      "GitHub rejected the token (401). It may be expired, revoked, or missing the right scope."
    );
  }

  if ((res.status === 403 || res.status === 429) && attempt < 5) {
    const retryAfter = Number(res.headers.get("retry-after"));
    const remaining = res.headers.get("x-ratelimit-remaining");
    const reset = Number(res.headers.get("x-ratelimit-reset"));

    let waitMs = null;
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      waitMs = retryAfter * 1000;
    } else if (remaining === "0" && Number.isFinite(reset)) {
      waitMs = Math.max(0, reset * 1000 - Date.now()) + 1000;
    }

    if (waitMs !== null) {
      stats.rateLimitWaits++;
      const secs = Math.ceil(waitMs / 1000);
      // GitHub names the limit it enforced in the response body. Swallowing it
      // meant every throttle looked identical from out here, and the only way
      // to tell a quota exhaustion from a pace limit was to guess.
      const why = await res
        .json()
        .then((b) => b?.message?.replace(/\s+/g, " ").trim())
        .catch(() => null);
      const kind = Number.isFinite(retryAfter) && retryAfter > 0 ? "secondary" : "primary";
      console.warn(
        `  ${kind} rate limit — waiting ${secs}s (attempt ${attempt + 1})` +
          (remaining != null ? `, ${remaining} left in this window` : "") +
          (why ? `\n    GitHub says: ${why}` : "")
      );
      // A pace limit means we're going too fast, so slow down permanently
      // rather than resuming at exactly the speed that just got us stopped.
      if (kind === "secondary") widenSpacing();
      await sleep(waitMs);
      return request(url, { method, body, headers }, attempt + 1);
    }
  }

  // Retry 5xx with exponential backoff — these are usually transient.
  if (res.status >= 500 && attempt < 5) {
    const waitMs = 2 ** attempt * 1000;
    console.warn(`  ${res.status} from GitHub — retrying in ${waitMs / 1000}s`);
    await sleep(waitMs);
    return request(url, { method, body, headers }, attempt + 1);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub ${res.status} ${res.statusText} for ${url}\n${text.slice(0, 500)}`);
  }

  return res.json();
}

/** A single REST call. `endpoint` is a path like "/repos/o/r/compare/a...b". */
export async function rest(endpoint, options = {}) {
  const url = endpoint.startsWith("http") ? endpoint : `${API}${endpoint}`;
  const key = `rest:${options.method || "GET"}:${url}`;

  const cached = await readCache(key);
  if (cached !== null) return cached;

  const body = await request(url, options);
  await writeCache(key, body);
  return body;
}

/**
 * A GraphQL query. Far cheaper than REST for org-wide sweeps — one request
 * can return 50 repos' worth of data that would otherwise cost 50 calls.
 */
export async function graphql(query, variables = {}) {
  const key = `gql:${createHash("sha256")
    .update(query + JSON.stringify(variables))
    .digest("hex")}`;

  const cached = await readCache(key);
  if (cached !== null) return cached;

  const res = await request(`${API}/graphql`, {
    method: "POST",
    body: { query, variables },
  });

  if (res.errors?.length) {
    throw new Error(`GraphQL error: ${res.errors.map((e) => e.message).join("; ")}`);
  }

  await writeCache(key, res.data);
  return res.data;
}

/**
 * Search for issues/PRs across the org.
 *
 * The Search API caps out at 1000 results per query and 30 requests/minute,
 * neither of which any current panel comes close to. If a panel ever does,
 * that's the signal to move it to the ingestion pipeline instead.
 */
export async function searchIssues(q, { max = 1000 } = {}) {
  const items = [];
  let page = 1;
  let total = null;

  while (items.length < max) {
    const url = `${API}/search/issues?q=${encodeURIComponent(q)}&per_page=100&page=${page}`;
    const body = await rest(url);

    total = body.total_count;
    items.push(...body.items);

    if (body.items.length < 100 || items.length >= total) break;
    if (page >= 10) break; // API hard limit: 1000 results
    page++;
  }

  if (total !== null && total > 1000) {
    console.warn(`  note: query matched ${total} results, capped at 1000 — "${q}"`);
  }

  return items;
}

/** Follow REST `Link: rel="next"` pagination to the end. */
export async function paginate(endpoint, { max = Infinity } = {}) {
  const out = [];
  let url = endpoint.startsWith("http") ? endpoint : `${API}${endpoint}`;

  while (url && out.length < max) {
    const key = `rest:GET:${url}`;
    let body = await readCache(key);
    let linkHeader = null;

    if (body === null) {
      stats.requests++;
      const res = await fetch(url, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${getToken()}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "nh-dashboard",
        },
      });
      if (!res.ok) {
        throw new Error(`GitHub ${res.status} for ${url}`);
      }
      body = await res.json();
      linkHeader = res.headers.get("link");
      await writeCache(key, { body, linkHeader });
    } else {
      linkHeader = body.linkHeader;
      body = body.body;
    }

    out.push(...(Array.isArray(body) ? body : []));
    const next = /<([^>]+)>;\s*rel="next"/.exec(linkHeader || "");
    url = next ? next[1] : null;
  }

  return out;
}

/** Current rate-limit status — useful for the build summary. */
export async function rateLimit() {
  const res = await fetch(`${API}/rate_limit`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${getToken()}`,
      "user-agent": "nh-dashboard",
    },
  });
  if (!res.ok) return null;
  return res.json();
}
