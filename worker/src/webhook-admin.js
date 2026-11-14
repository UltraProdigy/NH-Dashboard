import { decider, normalizeRules, RELAY_NAME } from "./relay-rules.js";
import { appReady, installationToken } from "./github.js";

export const HOOK_TTL_MS = 10 * 60_000;
const PERMISSION = "NH-Dashbot can't read the org's webhooks. Give it Organization permissions → Webhooks: Read-only.";

const stubOf = (env) => env.DISCORD_RELAY.get(env.DISCORD_RELAY.idFromName(RELAY_NAME));

async function relayState(env) {
  const res = await stubOf(env).fetch("https://relay/state");
  if (!res.ok) throw new Error(`relay ${res.status}`);
  return res.json();
}

const isRelayHook = (hook) => /nh-discord-relay/i.test(hook?.config?.url ?? "");

export async function readHook(env, hookId, { token, fetchImpl = fetch } = {}) {
  if (!token && !appReady(env)) return { error: "GH_APP_PRIVATE_KEY isn't set on the app Worker, so the webhook's events can't be read." };
  const org = env.GITHUB_ORG ?? "GTNewHorizons";
  let auth;
  try {
    auth = token ?? (await installationToken(env));
  } catch (err) {
    return { error: `NH-Dashbot couldn't sign in: ${String(err).slice(0, 160)}` };
  }
  const get = (path) =>
    fetchImpl(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${auth}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "nh-dashboard",
      },
    });

  let hook = null;
  if (hookId) {
    const res = await get(`/orgs/${org}/hooks/${encodeURIComponent(hookId)}`);
    if (res.status === 403) return { error: PERMISSION };
    if (res.ok) hook = await res.json();
  }
  if (!hook) {
    const res = await get(`/orgs/${org}/hooks?per_page=100`);
    if (res.status === 403 || res.status === 404) return { error: PERMISSION };
    if (!res.ok) return { error: `GitHub answered ${res.status} for the org's webhooks.` };
    const hooks = await res.json();
    hook = (Array.isArray(hooks) ? hooks : []).find(isRelayHook) ?? null;
    if (!hook) return { error: "No org webhook points at nh-discord-relay yet." };
  }
  return { id: String(hook.id), events: Array.isArray(hook.events) ? hook.events : [], active: hook.active ?? null, source: "github", error: null };
}

export async function refreshHook(env, state, opts = {}) {
  const now = opts.now ?? new Date();
  let read;
  try {
    read = await readHook(env, state?.hook?.id ?? null, opts);
  } catch (err) {
    read = { error: `The webhook couldn't be read: ${String(err).slice(0, 160)}` };
  }
  const res = await stubOf(env).fetch("https://relay/hook", {
    method: "PUT",
    body: JSON.stringify({ ...read, readAt: now.toISOString() }),
  });
  return res.ok ? res.json() : state?.hook ?? null;
}

const hookDue = (hook, now) => !hook?.readAt || now - new Date(hook.readAt).getTime() > HOOK_TTL_MS;

export async function webhookState(env, opts = {}) {
  let state;
  try {
    state = await relayState(env);
  } catch (err) {
    console.error(JSON.stringify({ at: "webhookState", error: String(err) }));
    return { status: 502, body: { error: "The relay couldn't be reached. Is nh-discord-relay deployed?" } };
  }
  if (opts.forceHook || hookDue(state.hook, (opts.now ?? new Date()).getTime())) {
    state.hook = await refreshHook(env, state, opts);
  }
  return { status: 200, body: state };
}

export async function saveWebhookRules(env, by, sent) {
  if (!sent?.rules || typeof sent.rules !== "object") return { status: 400, body: { error: "no rules sent" } };
  const res = await stubOf(env).fetch("https://relay/rules", {
    method: "PUT",
    body: JSON.stringify({ rules: normalizeRules(sent.rules), base: sent.base ?? null, by }),
  });
  const body = await res.json().catch(() => ({ error: `relay ${res.status}` }));
  return { status: res.status, body };
}

export async function previewWebhookRules(env, sent) {
  if (!sent?.rules || typeof sent.rules !== "object") return { status: 400, body: { error: "no rules sent" } };
  let state;
  try {
    state = await relayState(env);
  } catch {
    return { status: 502, body: { error: "The relay couldn't be reached." } };
  }
  const rules = normalizeRules(sent.rules);
  const decide = decider(rules);
  const decisions = {};
  for (const entry of state.deliveries ?? []) {
    const { send, reason } = decide(entry);
    decisions[entry.id] = { send, reason };
  }
  return { status: 200, body: { rules, decisions } };
}
