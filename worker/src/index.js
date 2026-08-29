/**
 * Webhook receiver and read API.
 *
 * Two jobs, deliberately kept apart: accept deliveries from GitHub as fast as
 * possible, and answer the dashboard's queries. Neither should be able to make
 * the other slow.
 *
 * GitHub gives a delivery ten seconds before it counts as failed, and a failing
 * endpoint eventually gets its subscription disabled. So the handler verifies,
 * writes, and returns — anything expensive belongs in the debounced recompute,
 * not here.
 */

import { handleEvent } from "./handlers.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function hexToBytes(hex) {
  if (hex.length % 2) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.substr(i * 2, 2), 16);
    if (Number.isNaN(byte)) return null;
    out[i] = byte;
  }
  return out;
}

/**
 * Verify X-Hub-Signature-256 over the raw body.
 *
 * `crypto.subtle.verify` is used rather than recomputing the digest and
 * comparing strings: a plain `===` on hex leaks how many leading characters
 * matched, which is enough to forge a signature one byte at a time. Verify is
 * constant-time by construction.
 *
 * The body must be the exact bytes GitHub signed, so it is read as text and
 * parsed only after the signature checks out — never `await request.json()`
 * first and re-serialize, which would reorder keys and change the digest.
 */
async function verifySignature(secret, header, rawBody) {
  if (!header || !header.startsWith("sha256=")) return false;

  const signature = hexToBytes(header.slice(7));
  if (!signature || signature.length !== 32) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  return crypto.subtle.verify("HMAC", key, signature, encoder.encode(rawBody));
}

/**
 * Mark the aggregates stale. The recompute job clears this.
 *
 * Cheap on purpose — one write per delivery, no reads. Whether anything
 * actually needs rebuilding is the recompute's problem, not the receiver's.
 */
async function markDirty(db) {
  await db
    .prepare("UPDATE meta SET value = '1' WHERE key = 'dirty'")
    .run();
}

async function handleWebhook(request, env) {
  const secret = env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return json({ error: "webhook secret not configured" }, 500);

  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  if (!(await verifySignature(secret, signature, rawBody))) {
    return json({ error: "bad signature" }, 401);
  }

  const event = request.headers.get("x-github-event") ?? "unknown";
  const delivery = request.headers.get("x-github-delivery") ?? "";

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: "unparseable payload" }, 400);
  }

  // The ping GitHub sends when a webhook is first configured. Answering it is
  // how the App's settings page shows a green tick.
  if (event === "ping") {
    return json({ ok: true, pong: payload.zen ?? null });
  }

  const repo = payload.repository?.name ?? null;
  const action = payload.action ?? null;

  let result;
  try {
    result = await handleEvent(env.DB, event, payload);
    await markDirty(env.DB);
  } catch (err) {
    // Still a 200. GitHub retries nothing and disables a webhook that keeps
    // failing, so a handler bug must not cost the subscription — the delivery
    // is logged and the reconcile sweep will correct whatever was missed.
    console.error(
      JSON.stringify({ event, action, repo, delivery, error: String(err) }),
    );
    return json({ ok: false, event, error: "handler failed" });
  }

  console.log(JSON.stringify({ event, action, repo, delivery, result }));

  return json({ ok: true, event, action, repo, result });
}

async function handleVersion(env) {
  const row = await env.DB.prepare(
    "SELECT value FROM meta WHERE key = 'version'",
  ).first();

  return json({ version: Number(row?.value ?? 0) });
}

async function handleHealth(env) {
  const counts = {};
  for (const table of ["pull_requests", "reviews", "issues", "traffic_daily"]) {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM ${table}`,
    ).first();
    counts[table] = row?.n ?? 0;
  }
  return json({ ok: true, counts });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/webhook") {
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      return handleWebhook(request, env);
    }

    if (url.pathname === "/api/version") return handleVersion(env);
    if (url.pathname === "/api/health") return handleHealth(env);

    return json({ error: "not found" }, 404);
  },
};
