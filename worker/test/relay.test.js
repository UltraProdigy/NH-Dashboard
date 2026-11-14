/**
 *   node --experimental-sqlite worker/test/relay.test.js
 */

import { DatabaseSync } from "node:sqlite";
import { decider, EMPTY_RULES, factsOf, normalizeRules, RELAY_NAME } from "../src/relay-rules.js";
import { DiscordRelay, KEEP_DELIVERIES } from "../src/discord-relay.js";
import { discordTarget, forward, handleRelay } from "../src/relay.js";
import { handleApp } from "../src/app.js";
import { HOOK_TTL_MS, readHook, webhookState } from "../src/webhook-admin.js";

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  ok ? (pass++, console.log("  ok    " + n))
     : (fail++, console.log("  FAIL  " + n + (d ? " — " + d : "")));
};

const REPO = { name: "GT5-Unofficial", private: false, default_branch: "master", html_url: "https://github.com/GTNewHorizons/GT5-Unofficial" };
const HUMAN = { login: "Dream-Master", type: "User" };
const pr = (action, extra = {}) => ({ action, repository: REPO, sender: HUMAN, pull_request: { number: 1, title: "Fix", html_url: "https://github.com/x/1", ...extra } });

console.log("\nrules\n");
{
  const n = normalizeRules({
    repos: [" Foo-Bar ", "", "foo-bar", "Not a repo!", "Angelica"],
    senders: ["Renovate[bot]", "renovate[bot]", " "],
    skipPrivate: true,
    skipBots: "yes",
    pushBranches: "nonsense",
    events: { push: { off: true }, pull_request: { drop: ["labeled", "labeled", "BAD ACTION", "edited"] }, "Not An Event": { off: true }, issues: { drop: [] } },
    repoEvents: { Angelica: { events: { release: { off: true }, issues: { drop: ["labeled"] } } }, angelica: { events: {} }, "bad name!": { events: {} }, Empty: {} },
  });
  check("excluded repos are trimmed, deduped regardless of case, and must be repo names", JSON.stringify(n.repos) === JSON.stringify(["Foo-Bar", "Angelica"]), JSON.stringify(n.repos));
  check("senders are deduped regardless of case", n.senders.length === 1, JSON.stringify(n.senders));
  check("only a real true turns a switch on", n.skipBots === false);
  check("the private-repo switch is gone", !("skipPrivate" in n));
  check("an unknown push setting falls back to all branches", n.pushBranches === "all");
  check("bad event and action names are dropped", !("Not An Event" in n.events) && JSON.stringify(n.events.pull_request.drop) === JSON.stringify(["edited", "labeled"]));
  check("an event with nothing dropped isn't stored", !("issues" in n.events));
  check("a repo's own events are normalised the same way", JSON.stringify(n.repoEvents.Angelica) === JSON.stringify({ events: { issues: { drop: ["labeled"] }, release: { off: true } } }), JSON.stringify(n.repoEvents));
  check("one override per repo, whatever the case, and only for real repo names", Object.keys(n.repoEvents).join() === "Angelica,Empty", Object.keys(n.repoEvents).join());
  check("an override with no changes is kept, so the repo can be left on its own list", JSON.stringify(n.repoEvents.Empty) === JSON.stringify({ events: {} }));
  check("junk normalises to the empty rules", JSON.stringify(normalizeRules("junk")) === JSON.stringify(normalizeRules(EMPTY_RULES)));
}

console.log("\nfacts\n");
{
  check("a merged PR is action merged", factsOf("pull_request", pr("closed", { merged: true })).action === "merged");
  check("a closed unmerged PR stays closed", factsOf("pull_request", pr("closed", { merged: false })).action === "closed");
  check("an App sender is a bot", factsOf("issues", { action: "opened", repository: REPO, sender: { login: "nh-org-manager[bot]", type: "Bot" } }).bot);
  check("renovate is a bot by name", factsOf("issues", { action: "opened", repository: REPO, sender: { login: "renovate", type: "User" } }).bot);
  check("a person isn't", !factsOf("issues", { action: "opened", repository: REPO, sender: HUMAN }).bot);
  const p = factsOf("push", { ref: "refs/heads/feature", repository: REPO, sender: HUMAN });
  check("a push carries its ref and the default branch", p.ref === "refs/heads/feature" && p.defaultBranch === "master" && p.action === null);
  check("a private repo is flagged", factsOf("push", { ref: "refs/heads/master", repository: { ...REPO, private: true } }).private);
}

console.log("\ndecisions\n");
{
  const f = (event, payload) => factsOf(event, payload);
  const everything = decider(EMPTY_RULES);
  check("with no rules everything is sent", everything(f("pull_request", pr("labeled"))).send && everything(f("watch", { action: "started", repository: REPO })).send);

  const d = decider({
    repos: ["Foo-Bar"],
    skipBots: true,
    senders: ["Some-Spammer"],
    pushBranches: "default",
    events: { watch: { off: true }, pull_request: { drop: ["labeled", "closed"] } },
    repoEvents: { Angelica: { events: { issues: { off: true } } }, "Quiet-Repo": { events: { pull_request: { drop: ["opened"] } } } },
  });
  const reason = (event, payload) => d(f(event, payload)).reason;
  const at = (name) => ({ ...REPO, name });
  check("an event turned off is dropped", reason("watch", { action: "started", repository: REPO, sender: HUMAN }) === "event off");
  check("a dropped action is dropped", reason("pull_request", pr("labeled")) === "action off");
  check("dropping closed doesn't drop merges", d(f("pull_request", pr("closed", { merged: true }))).send);
  check("an unmentioned action is sent", d(f("pull_request", pr("opened"))).send);
  check("an unticked repo is dropped", reason("issues", { action: "opened", repository: at("Foo-Bar"), sender: HUMAN }) === "repo excluded");
  check("repo names ignore case", reason("issues", { action: "opened", repository: at("foo-bar"), sender: HUMAN }) === "repo excluded");
  check("an unticked repo name is matched exactly, not as a prefix", d(f("issues", { action: "opened", repository: at("Foo-Bar-Two"), sender: HUMAN })).send);
  check("a repo with its own events uses them", reason("issues", { action: "opened", repository: at("Angelica"), sender: HUMAN }) === "event off for repo");
  check("its own list replaces the default one", d(f("watch", { action: "started", repository: at("Angelica"), sender: HUMAN })).send && d(f("pull_request", { ...pr("labeled"), repository: at("Angelica") })).send);
  check("an action off for one repo", reason("pull_request", { ...pr("opened"), repository: at("quiet-repo") }) === "action off for repo");
  check("other repos still use the default", d(f("issues", { action: "opened", repository: REPO, sender: HUMAN })).send);
  check("a private repo isn't dropped for being private", d(f("issues", { action: "opened", repository: { ...REPO, private: true }, sender: HUMAN })).send);
  check("a listed sender is dropped, whatever the case", reason("issues", { action: "opened", repository: REPO, sender: { login: "some-spammer" } }) === "sender excluded");
  check("a bot is dropped", reason("issues", { action: "opened", repository: REPO, sender: { login: "dependabot[bot]", type: "Bot" } }) === "bot");
  check("a push to another branch is dropped", reason("push", { ref: "refs/heads/feature", repository: REPO, sender: HUMAN }) === "not the default branch");
  check("a push to the default branch is sent", d(f("push", { ref: "refs/heads/master", repository: REPO, sender: HUMAN })).send);
  check("a tag push is sent", d(f("push", { ref: "refs/tags/2.8.0", repository: REPO, sender: HUMAN })).send);
  check("an event with no repo isn't dropped by repo rules", d(f("organization", { action: "member_added", sender: HUMAN })).send);
  check("an event nobody listed is sent", d(f("sponsorship", { action: "created", repository: REPO, sender: HUMAN })).send);
}

function fakeRelay() {
  const db = new DatabaseSync(":memory:");
  const ctx = {
    storage: {
      sql: {
        exec(q, ...b) {
          const st = db.prepare(q);
          if (/^\s*SELECT/i.test(q)) { const rows = st.all(...b); return { toArray: () => rows }; }
          st.run(...b);
          return { toArray: () => [] };
        },
      },
    },
  };
  return new DiscordRelay(ctx, {});
}

const stubFor = (obj) => ({ fetch: (url, init) => obj.fetch(new Request(url, init)) });

const call = (obj, path, method = "GET", body) =>
  obj.fetch(new Request(`https://relay${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }));

console.log("\nthe Durable Object\n");
{
  const obj = fakeRelay();
  let state = await (await call(obj, "/state")).json();
  check("it starts with no rules and nothing logged", state.updatedAt === null && state.deliveries.length === 0 && JSON.stringify(state.rules) === JSON.stringify(normalizeRules(EMPTY_RULES)));

  const facts = factsOf("pull_request", pr("labeled"));
  let res = await (await call(obj, "/decide", "POST", { id: "d1", at: "2026-11-14T12:00:00Z", facts, text: "labeled PR #1", url: "https://github.com/x/1" })).json();
  check("with no rules it says send", res.send === true && res.logged === true && res.id === "d1");

  const saved = await call(obj, "/rules", "PUT", { rules: { events: { pull_request: { drop: ["labeled"] } } }, base: null, by: "admin@example.com", at: "2026-11-14T12:01:00Z" });
  state = await saved.json();
  check("saving returns the new rules and who saved them", saved.status === 200 && state.updatedBy === "admin@example.com" && state.rules.events.pull_request.drop[0] === "labeled");

  const stale = await call(obj, "/rules", "PUT", { rules: {}, base: null, by: "someone-else" });
  const staleBody = await stale.json();
  check("saving over someone else's change is refused", stale.status === 409 && staleBody.updatedBy === "admin@example.com");

  res = await (await call(obj, "/decide", "POST", { id: "d2", facts })).json();
  check("a saved rule applies to the very next delivery", res.send === false && res.reason === "action off");

  await call(obj, "/outcome", "POST", { id: "d1", discord: 429, detail: "You are being rate limited." });
  state = await (await call(obj, "/state")).json();
  const d1 = state.deliveries.find((d) => d.id === "d1");
  check("deliveries come back newest first", state.deliveries[0].id === "d2");
  check("Discord's answer is recorded on the delivery", d1.discord === 429 && d1.detail === "You are being rate limited.");
  check("a dropped delivery has no Discord answer", state.deliveries[0].discord === null && state.deliveries[0].reason === "action off");
  check("the entry keeps the facts the preview needs", d1.event === "pull_request" && d1.action === "labeled" && d1.repo === "GT5-Unofficial" && d1.text === "labeled PR #1");

  for (let i = 0; i < KEEP_DELIVERIES + 20; i++) await call(obj, "/decide", "POST", { id: `bulk-${i}`, facts });
  state = await (await call(obj, "/state")).json();
  check(`only the last ${KEEP_DELIVERIES} are kept`, state.deliveries.length === KEEP_DELIVERIES && state.deliveries[0].id === `bulk-${KEEP_DELIVERIES + 19}`);

  res = await (await call(obj, "/decide", "POST", { facts: null })).json();
  check("a malformed decide request still says send", res.send === true && res.logged === false);
}

console.log("\nDiscord\n");
{
  check("/github is added to the URL", discordTarget("https://discord.com/api/webhooks/1/abc") === "https://discord.com/api/webhooks/1/abc/github");
  check("an URL that already ends in /github is left alone", discordTarget("https://discord.com/api/webhooks/1/abc/github/") === "https://discord.com/api/webhooks/1/abc/github");
  check("a thread id survives", discordTarget("https://discord.com/api/webhooks/1/abc?thread_id=9") === "https://discord.com/api/webhooks/1/abc/github?thread_id=9");
  check("no URL is no target", discordTarget("") === null && discordTarget("not a url") === null);

  const env = { DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/abc" };
  let calls = [];
  let slept = 0;
  const responses = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return responses.shift() ?? new Response(null, { status: 204 });
  };
  const sleep = async (ms) => { slept += ms; };

  responses.push(Response.json({ message: "You are being rate limited.", retry_after: 1.2 }, { status: 429 }));
  let out = await forward(env, { event: "push", delivery: "x", raw: "{}" }, { fetchImpl, sleep });
  check("a short rate limit is waited out and retried once", out.ok && calls.length === 2 && slept === 1200, JSON.stringify(out));

  calls = []; slept = 0;
  responses.push(Response.json({ message: "slow down", retry_after: 30 }, { status: 429 }));
  out = await forward(env, { event: "push", delivery: "x", raw: "{}" }, { fetchImpl, sleep });
  check("a long rate limit is reported instead of waited out", !out.ok && out.discord === 429 && calls.length === 1 && slept === 0);

  calls = [];
  responses.push(Response.json({ message: "slow down", retry_after: 1 }, { status: 429 }), Response.json({ message: "still" , retry_after: 1 }, { status: 429 }));
  out = await forward(env, { event: "push", delivery: "x", raw: "{}" }, { fetchImpl, sleep });
  check("it only retries once", !out.ok && calls.length === 2);

  out = await forward({}, { event: "push", raw: "{}" }, { fetchImpl, sleep });
  check("without a Discord URL it says so", !out.ok && out.discord === "no url");
}

const SECRET = "relay-secret";
async function sign(body) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return "sha256=" + [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function relayEnv(obj, extra = {}) {
  return {
    GITHUB_WEBHOOK_SECRET: SECRET,
    DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/abc",
    RELAY: obj && { idFromName: (n) => n, get: (id) => (id === RELAY_NAME ? stubFor(obj) : null) },
    ...extra,
  };
}

async function deliver(env, event, payload, { signature, fetchImpl, path = "/" } = {}) {
  const raw = JSON.stringify(payload);
  const waits = [];
  const req = new Request(`https://nh-discord-relay.gtnh.workers.dev${path}`, {
    method: "POST",
    headers: { "x-github-event": event, "x-github-delivery": `del-${Math.random()}`, "x-hub-signature-256": signature ?? (await sign(raw)), "user-agent": "GitHub-Hookshot/abc123" },
    body: raw,
  });
  const res = await handleRelay(req, env, { waitUntil: (p) => waits.push(p) }, { fetchImpl, sleep: async () => {} });
  await Promise.all(waits);
  return { status: res.status, body: await res.json(), raw };
}

console.log("\nthe relay Worker\n");
{
  const obj = fakeRelay();
  await call(obj, "/rules", "PUT", { rules: { events: { watch: { off: true } } }, base: null, by: "a" });
  let sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, init }); return new Response(null, { status: 204 }); };
  const env = relayEnv(obj);

  let r = await deliver(env, "issues", { action: "opened", repository: REPO, sender: HUMAN, issue: { number: 3, title: "Crash" } }, { signature: "sha256=" + "0".repeat(64), fetchImpl });
  check("a bad signature is a 401 and nothing is sent", r.status === 401 && sent.length === 0);

  r = await deliver(env, "ping", { zen: "Keep it logically awesome.", hook_id: 4242, hook: { events: ["push", "pull_request", "issues"], active: true } }, { fetchImpl });
  check("a ping is answered and not forwarded", r.status === 200 && r.body.pong && sent.length === 0);
  let hookState = (await (await call(obj, "/state")).json()).hook;
  check("the ping's event list is kept as the webhook's events", hookState?.source === "ping" && hookState.id === "4242" && hookState.events.join() === "push,pull_request,issues", JSON.stringify(hookState));

  r = await deliver(env, "watch", { action: "started", repository: REPO, sender: HUMAN }, { fetchImpl });
  check("a dropped event never reaches Discord", r.status === 200 && r.body.sent === false && r.body.reason === "event off" && sent.length === 0);

  r = await deliver(env, "issues", { action: "opened", repository: REPO, sender: HUMAN, issue: { number: 3, title: "Crash", html_url: "https://github.com/GTNewHorizons/GT5-Unofficial/issues/3" } }, { fetchImpl });
  const hit = sent[0];
  check("an allowed event is forwarded to /github", r.status === 200 && r.body.sent && hit?.url === "https://discord.com/api/webhooks/1/abc/github");
  check("the body is GitHub's bytes, untouched", hit?.init.body === r.raw);
  check("the event and user agent headers go with it", hit?.init.headers["x-github-event"] === "issues" && hit?.init.headers["user-agent"] === "GitHub-Hookshot/abc123");

  const state = await (await call(obj, "/state")).json();
  const top = state.deliveries[0];
  check("the delivery is logged with Discord's answer", top.event === "issues" && top.send && top.discord === 204);
  check("and with a readable summary", /opened issue #3/.test(top.text ?? ""), top.text);

  r = await deliver(env, "issues", { action: "opened", repository: REPO, sender: HUMAN }, { fetchImpl: async () => new Response("bad", { status: 400 }) });
  check("a Discord failure is a failure for GitHub too", r.status === 502 && r.body.discord === 400);

  sent = [];
  const broken = { fetch: async () => { throw new Error("object reset"); } };
  r = await deliver(relayEnv(broken), "watch", { action: "started", repository: REPO, sender: HUMAN }, { fetchImpl });
  check("if the rules can't be read, the delivery is sent anyway", r.status === 200 && r.body.sent && r.body.reason === "rules unavailable" && sent.length === 1);

  sent = [];
  r = await deliver(relayEnv(null), "watch", { action: "started", repository: REPO, sender: HUMAN }, { fetchImpl });
  check("and the same without the binding", r.status === 200 && sent.length === 1);

  r = await deliver(env, "issues", { action: "opened", repository: REPO }, { fetchImpl, path: "/other" });
  check("only / is served", r.status === 404);

  const res = await handleRelay(new Request("https://nh-discord-relay.gtnh.workers.dev/"), env, {});
  check("GET is refused", res.status === 405);
  const noSecret = await deliver(relayEnv(obj, { GITHUB_WEBHOOK_SECRET: "" }), "issues", { action: "opened" }, { fetchImpl });
  check("without a secret nothing is accepted", noSecret.status === 500);
}

console.log("\nthe dashboard's API\n");
{
  const obj = fakeRelay();
  await call(obj, "/decide", "POST", { id: "a", facts: factsOf("pull_request", pr("labeled")) });
  await call(obj, "/decide", "POST", { id: "b", facts: factsOf("issues", { action: "opened", repository: REPO, sender: HUMAN }) });
  const ns = { idFromName: (n) => n, get: () => stubFor(obj) };
  const env = (role, extra = {}) => ({ DEV_ROLE: role, DISCORD_RELAY: ns, ...extra });
  const app = async (path, { role = "admin", method = "GET", body, origin = "http://localhost:8787", e } = {}) => {
    const headers = { origin };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await handleApp(new Request(`http://localhost:8787${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), e ?? env(role), { waitUntil() {} });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  check("a member can't read the webhook rules", (await app("/api/webhook", { role: "member" })).status === 403);
  check("a member can't save them", (await app("/api/webhook/rules", { role: "member", method: "POST", body: { rules: {} } })).status === 403);
  const got = await app("/api/webhook");
  check("an admin gets the rules and the log", got.status === 200 && got.body.deliveries.length === 2 && got.body.rules.pushBranches === "all");
  check("and is told why the webhook's events couldn't be read", /GH_APP_PRIVATE_KEY/.test(got.body.hook?.error ?? ""), JSON.stringify(got.body.hook));
  check("re-reading the webhook is POST only", (await app("/api/webhook/hook")).status === 405);
  check("an admin can ask for a re-read", (await app("/api/webhook/hook", { method: "POST" })).status === 200);

  const pv = await app("/api/webhook/preview", { method: "POST", body: { rules: { events: { pull_request: { drop: ["labeled"] } } } } });
  check("the preview re-decides the log against unsaved rules", pv.status === 200 && pv.body.decisions.a.send === false && pv.body.decisions.b.send === true);
  const after = await app("/api/webhook");
  check("and saves nothing", after.body.updatedAt === null);

  check("a save from another origin is refused", (await app("/api/webhook/rules", { method: "POST", body: { rules: {} }, origin: "https://evil.example" })).status === 403);
  check("saving is POST only", (await app("/api/webhook/rules", { method: "PUT", body: { rules: {} } })).status === 405);
  const saved = await app("/api/webhook/rules", { method: "POST", body: { rules: { skipBots: true }, base: null } });
  check("an admin can save, and the save is signed", saved.status === 200 && saved.body.rules.skipBots === true && saved.body.updatedBy === "dev@localhost");
  const again = await app("/api/webhook/rules", { method: "POST", body: { rules: { skipBots: false }, base: null } });
  check("a save on stale rules is a 409", again.status === 409);
  check("an empty save is a 400", (await app("/api/webhook/rules", { method: "POST", body: {} })).status === 400);
  check("without the binding the API says so", (await app("/api/webhook", { e: { DEV_ROLE: "admin" } })).status === 503);
  check("an unknown webhook path is a 404", (await app("/api/webhook/nope", { method: "POST", body: {} })).status === 404);
}

console.log("\nreading the webhook's events\n");
{
  const obj = fakeRelay();
  await call(obj, "/decide", "POST", { id: "x", hookId: 777, facts: factsOf("push", { ref: "refs/heads/master", repository: REPO }) });
  let hook = (await (await call(obj, "/state")).json()).hook;
  check("a delivery's hook id is remembered", hook?.id === "777" && hook.events === null, JSON.stringify(hook));

  const HOOK = { id: 777, active: true, events: ["push", "release"], config: { url: "https://nh-discord-relay.gtnh.workers.dev/" } };
  const calls = [];
  const github = (routes) => async (url, init) => {
    calls.push(url);
    for (const [pattern, res] of routes) if (url.includes(pattern)) return typeof res === "function" ? res() : res;
    return new Response("", { status: 404 });
  };
  const env = { GITHUB_ORG: "GTNewHorizons", DISCORD_RELAY: { idFromName: (n) => n, get: () => stubFor(obj) } };

  let read = await readHook(env, "777", { token: "t", fetchImpl: github([["/hooks/777", () => Response.json(HOOK)]]) });
  check("the hook is read by id when one is known", read.source === "github" && read.events.join() === "push,release" && read.id === "777");

  calls.length = 0;
  read = await readHook(env, null, { token: "t", fetchImpl: github([["/hooks?", () => Response.json([{ id: 1, config: { url: "https://discord.com/api/webhooks/1/x/github" }, events: ["*"] }, HOOK])]]) });
  check("without an id it finds the hook pointing at the relay", read.id === "777" && calls.length === 1);

  read = await readHook(env, null, { token: "t", fetchImpl: github([["/hooks?", () => Response.json([{ id: 1, config: { url: "https://discord.com/x" } }])]]) });
  check("no hook pointing at the relay says so", /No org webhook points/.test(read.error ?? ""));

  read = await readHook(env, "777", { token: "t", fetchImpl: github([["/hooks", () => new Response("{}", { status: 403 })]]) });
  check("a 403 names the permission DashBot needs", /Webhooks: Read-only/.test(read.error ?? ""), read.error);

  read = await readHook(env, null);
  check("without the App key it says so", /GH_APP_PRIVATE_KEY/.test(read.error ?? ""));

  const t0 = new Date("2026-11-14T12:00:00Z");
  calls.length = 0;
  const ok = github([["/hooks/777", () => Response.json(HOOK)]]);
  let st = await webhookState(env, { token: "t", fetchImpl: ok, now: t0 });
  check("the first page load reads the hook and stores it", st.body.hook.source === "github" && st.body.hook.events.join() === "push,release" && st.body.hook.readAt === t0.toISOString() && calls.length === 1);
  st = await webhookState(env, { token: "t", fetchImpl: ok, now: new Date(t0.getTime() + 60_000) });
  check("a page load within ten minutes doesn't call GitHub again", calls.length === 1 && st.body.hook.events.length === 2);
  st = await webhookState(env, { token: "t", fetchImpl: github([["/hooks", () => new Response("{}", { status: 403 })]]), now: new Date(t0.getTime() + HOOK_TTL_MS + 1) });
  check("a failed re-read keeps the last known events and shows the error", st.body.hook.events.join() === "push,release" && /Webhooks/.test(st.body.hook.error ?? ""));
  st = await webhookState(env, { token: "t", fetchImpl: ok, forceHook: true, now: new Date(t0.getTime() + HOOK_TTL_MS + 2) });
  check("a forced re-read clears the error", st.body.hook.error === null && st.body.hook.source === "github");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
