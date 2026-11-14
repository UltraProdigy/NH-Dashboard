import { verifySignature } from "./signature.js";
import { summarise } from "./event-log.js";
import { factsOf, RELAY_NAME } from "./relay-rules.js";
import { DiscordRelay } from "./discord-relay.js";

export { DiscordRelay };

const MAX_WAIT_MS = 4000;

const json = (body, status = 200) => Response.json(body, { status });

export function discordTarget(base) {
  if (!base) return null;
  try {
    const url = new URL(base);
    url.pathname = url.pathname.replace(/\/+$/, "");
    if (!url.pathname.endsWith("/github")) url.pathname += "/github";
    return url.toString();
  } catch {
    return null;
  }
}

function retryAfterMs(res, body) {
  const header = Number(res.headers.get("retry-after"));
  const seconds = Number.isFinite(body?.retry_after) ? body.retry_after : Number.isFinite(header) ? header : null;
  return seconds === null ? null : Math.ceil(seconds * 1000);
}

export async function forward(env, { event, delivery, userAgent, raw }, { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const target = discordTarget(env.DISCORD_WEBHOOK_URL);
  if (!target) return { ok: false, discord: "no url", detail: "DISCORD_WEBHOOK_URL is not set" };
  const headers = { "content-type": "application/json", "x-github-event": event };
  if (delivery) headers["x-github-delivery"] = delivery;
  if (userAgent) headers["user-agent"] = userAgent;

  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetchImpl(target, { method: "POST", headers, body: raw });
    } catch (err) {
      return { ok: false, discord: "error", detail: String(err) };
    }
    if (res.ok) return { ok: true, discord: res.status };
    const text = await res.text().catch(() => "");
    let body = null;
    try { body = JSON.parse(text); } catch {}
    const wait = res.status === 429 ? retryAfterMs(res, body) : null;
    if (attempt === 1 && wait !== null && wait <= MAX_WAIT_MS) {
      await sleep(wait);
      continue;
    }
    return { ok: false, discord: res.status, detail: body?.message ?? text.slice(0, 200) };
  }
}

function describe(event, payload) {
  let line = null;
  try {
    line = summarise(event, payload);
  } catch {}
  return {
    text: line?.text ?? `${event.replace(/_/g, " ")}${payload.action ? ` ${String(payload.action).replace(/_/g, " ")}` : ""}`,
    url: line?.url ?? (typeof payload.repository?.html_url === "string" ? payload.repository.html_url : null),
  };
}

export async function handleRelay(request, env, ctx, opts = {}) {
  const url = new URL(request.url);
  if (url.pathname !== "/") return json({ error: "not found" }, 404);
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  if (!env.GITHUB_WEBHOOK_SECRET) return json({ error: "webhook secret not configured" }, 500);

  const raw = await request.text();
  if (!(await verifySignature(env.GITHUB_WEBHOOK_SECRET, request.headers.get("x-hub-signature-256"), raw))) {
    return json({ error: "bad signature" }, 401);
  }

  const event = request.headers.get("x-github-event") ?? "unknown";
  const delivery = request.headers.get("x-github-delivery") ?? "";
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json({ error: "unparseable payload" }, 400);
  }
  const stub = env.RELAY?.get(env.RELAY.idFromName(RELAY_NAME));
  const hookId = request.headers.get("x-github-hook-id") ?? payload.hook_id ?? null;

  if (event === "ping") {
    if (stub && Array.isArray(payload.hook?.events)) {
      const record = stub
        .fetch("https://relay/hook", {
          method: "PUT",
          body: JSON.stringify({ id: hookId, events: payload.hook.events, active: payload.hook.active, source: "ping", readAt: new Date().toISOString(), error: null }),
        })
        .catch((err) => console.error(JSON.stringify({ at: "ping", error: String(err) })));
      if (ctx?.waitUntil) ctx.waitUntil(record);
    }
    return json({ ok: true, pong: payload.zen ?? null });
  }

  const facts = factsOf(event, payload);
  // Fail open: if the rules can't be read, Discord gets everything, as it did before the relay.
  let decision = { send: true, reason: "rules unavailable", logged: false };
  if (stub) {
    try {
      const res = await stub.fetch("https://relay/decide", {
        method: "POST",
        body: JSON.stringify({ id: delivery, hookId, at: new Date().toISOString(), facts, ...describe(event, payload) }),
      });
      if (res.ok) decision = await res.json();
      else console.error(JSON.stringify({ at: "decide", delivery, status: res.status }));
    } catch (err) {
      console.error(JSON.stringify({ at: "decide", delivery, error: String(err) }));
    }
  }

  if (!decision.send) {
    console.log(JSON.stringify({ event, action: facts.action, repo: facts.repo, delivery, sent: false, reason: decision.reason }));
    return json({ ok: true, sent: false, reason: decision.reason });
  }

  const out = await forward(env, { event, delivery, userAgent: request.headers.get("user-agent"), raw }, opts);
  const log = out.ok ? console.log : console.error;
  log(JSON.stringify({ event, action: facts.action, repo: facts.repo, delivery, sent: out.ok, discord: out.discord, detail: out.detail }));

  if (stub && decision.logged) {
    const record = stub
      .fetch("https://relay/outcome", { method: "POST", body: JSON.stringify({ id: decision.id, discord: out.discord, detail: out.detail }) })
      .catch((err) => console.error(JSON.stringify({ at: "outcome", delivery, error: String(err) })));
    if (ctx?.waitUntil) ctx.waitUntil(record);
  }

  if (!out.ok) return json({ ok: false, sent: false, discord: out.discord, detail: out.detail ?? null }, 502);
  return json({ ok: true, sent: true, discord: out.discord, reason: decision.reason ?? null });
}

export default {
  fetch: (request, env, ctx) => handleRelay(request, env, ctx),
};
