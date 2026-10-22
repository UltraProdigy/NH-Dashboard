/**
 * Webhook receiver and the cron recompute.
 *
 * This Worker is not behind Cloudflare Access, because GitHub cannot log in to
 * deliver a webhook, so it serves no dashboard data. The pages and the read API
 * are the app Worker's (app.js), which is. /api/health returns row counts only,
 * for the deploy check.
 *
 * GitHub gives a delivery ten seconds before it counts as failed, and a failing
 * endpoint eventually gets its subscription disabled. So the handler verifies,
 * writes, and returns.
 *
 * The cheap panels this delivery can move are then rebuilt through
 * `ctx.waitUntil`, which runs after the response has already gone back — so
 * they cost the delivery nothing and cannot fail one. Everything expensive
 * stays on the debounced cron. The line is drawn by measurement rather than by
 * category: ~68ms, ~55ms and ~12ms for the three of them against ~2.6 seconds
 * for analytics alone.
 */

import { handleEvent } from "./handlers.js";
import { INSTANT_EVENTS, markWritten, recompute, refreshInstant, TABLES } from "./recompute.js";
import { handleHealth, json } from "./reads.js";
import { redeliverFailed } from "./github.js";
import { verifyDreamPanel } from "./verify.js";
import { EventLog, logDelivery } from "./event-log.js";

export { EventLog };

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

// Cloudflare documents these D1 errors as transient and safe to retry. Every
// handler is an upsert, so running one twice writes the same rows.
const TRANSIENT = /network connection lost|storage caused object to be reset|reset because its code was updated|overloaded|internal error/i;

export async function withRetry(fn, attempts = 3, wait = (n) => 150 * n) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !TRANSIENT.test(String(err))) throw err;
      await new Promise((resolve) => setTimeout(resolve, wait(attempt)));
    }
  }
}

async function handleWebhook(request, env, ctx) {
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

  if (ctx && env.EVENT_LOG) {
    ctx.waitUntil(
      logDelivery(env, event, payload, delivery).catch((err) =>
        console.error(JSON.stringify({ at: "eventLog", delivery, error: String(err) })),
      ),
    );
  }

  const repo = payload.repository?.name ?? null;
  const action = payload.action ?? null;

  let result;
  let failure = null;
  try {
    result = await withRetry(() => handleEvent(env.DB, event, payload));
  } catch (err) {
    failure = String(err);
  }

  // A handler that threw partway may have written any of its tables, so a
  // failure stamps all of them. A skipped or ignored delivery only refreshed its
  // repo row, and the columns panels read there move through `repository`
  // deliveries. Letting those through kept the full recompute running on
  // nearly every cron tick.
  const wrote = failure !== null || !(result?.skipped || result?.ignored);

  if (wrote) {
    const tables = failure !== null ? TABLES : [result?.table ?? "repos"];
    await markWritten(env.DB, tables).catch((err) =>
      console.error(
        JSON.stringify({ at: "markWritten", delivery, error: String(err) }),
      ),
    );
  }

  if (failure) {
    // A 500, so GitHub records the delivery as failed. It used to be a 200, which
    // showed green on the App's delivery page while the row stayed wrong, and
    // nothing ever looked at it again. GitHub does not retry on its own;
    // `redeliverFailed` in the cron does, and it can only find what GitHub was
    // told had failed.
    console.error(
      JSON.stringify({ event, action, repo, delivery, error: failure }),
    );
    return json({ ok: false, event, error: "handler failed" }, 500);
  }

  console.log(JSON.stringify({ event, action, repo, delivery, result }));

  // The cards an admin watches while merging cost tens of milliseconds each, so
  // they are rebuilt now rather than at the next cron tick. `waitUntil` runs it
  // after this response has gone back to GitHub, so it cannot delay the
  // delivery or fail it — a webhook that keeps failing gets disabled, and
  // silently.
  //
  // The event is passed through rather than only gating on it: `refreshInstant`
  // rebuilds the panels this event can move and leaves the rest alone. A
  // `workflow_run` fires constantly and moves none of them.
  if (ctx && wrote && INSTANT_EVENTS.has(event)) {
    ctx.waitUntil(
      refreshInstant(env, event, delivery).catch((err) =>
        console.error(
          JSON.stringify({ instant: "failed", delivery, error: String(err) }),
        ),
      ),
    );
  }

  return json({ ok: true, event, action, repo, result });
}

// Each step runs whatever the one before it did, so a GitHub outage that stops
// the first two still leaves the panels being rebuilt.
export async function runCron(env) {
  const step = async (name, fn) => {
    try {
      const result = await fn();
      const log = result?.gaveUp ? console.error : console.log;
      log(JSON.stringify({ cron: name, result }));
    } catch (err) {
      console.error(JSON.stringify({ cron: name, error: String(err) }));
    }
  };
  await step("redeliver", () => redeliverFailed(env));
  await step("verify", () => verifyDreamPanel(env));
  await step("recompute", () => recompute(env));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/webhook") {
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      return handleWebhook(request, env, ctx);
    }

    if (url.pathname === "/api/health") return handleHealth(env);

    return json({ error: "not found" }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env));
  },
};
