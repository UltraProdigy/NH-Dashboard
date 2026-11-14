import { BOT_PATTERN } from "../../src/shared/contributor-rules.js";

export const RELAY_NAME = "discord-relay";

export const EMPTY_RULES = Object.freeze({
  repos: [],
  skipBots: false,
  senders: [],
  pushBranches: "all",
  events: {},
  repoEvents: {},
});

const NAME = /^[a-z][a-z0-9_]{0,59}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_LIST = 2000;

const strings = (value) =>
  (Array.isArray(value) ? value : [])
    .map((s) => String(s ?? "").trim())
    .filter((s) => s && s.length <= 100)
    .slice(0, MAX_LIST);

const unique = (list) => {
  const seen = new Set();
  return list.filter((s) => {
    const key = s.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export function normalizeEvents(raw) {
  const events = {};
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  for (const name of Object.keys(source).sort()) {
    const rule = source[name];
    if (!NAME.test(name) || !rule || typeof rule !== "object") continue;
    if (rule.off === true) {
      events[name] = { off: true };
      continue;
    }
    const drop = unique(strings(rule.drop).filter((a) => NAME.test(a))).sort();
    if (drop.length) events[name] = { drop };
  }
  return events;
}

export function normalizeRules(raw) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const repoEvents = {};
  const overrides = r.repoEvents && typeof r.repoEvents === "object" && !Array.isArray(r.repoEvents) ? r.repoEvents : {};
  const kept = unique(Object.keys(overrides).filter((repo) => REPO.test(repo))).slice(0, MAX_LIST);
  for (const repo of kept.sort((a, b) => a.localeCompare(b))) {
    repoEvents[repo] = { events: normalizeEvents(overrides[repo]?.events) };
  }
  return {
    repos: unique(strings(r.repos).filter((name) => REPO.test(name))),
    skipBots: r.skipBots === true,
    senders: unique(strings(r.senders)),
    pushBranches: r.pushBranches === "default" ? "default" : "all",
    events: normalizeEvents(r.events),
    repoEvents,
  };
}

export function factsOf(event, payload = {}) {
  const repo = payload?.repository ?? {};
  const sender = payload?.sender ?? {};
  const pr = payload?.pull_request;
  let action = typeof payload?.action === "string" ? payload.action : null;
  if (event === "pull_request" && action === "closed" && (pr?.merged || pr?.merged_at)) action = "merged";
  const ref = event === "push" && typeof payload?.ref === "string" ? payload.ref : null;
  return {
    event,
    action,
    repo: repo.name ?? null,
    private: repo.private === true,
    sender: sender.login ?? null,
    bot: sender.type === "Bot" || (sender.login ? BOT_PATTERN.test(sender.login) : false),
    ref,
    defaultBranch: ref ? repo.default_branch ?? null : null,
  };
}

const SEND = Object.freeze({ send: true, reason: null });
const drop = (reason) => ({ send: false, reason });

export function decider(raw) {
  const rules = normalizeRules(raw);
  const excluded = new Set(rules.repos.map((r) => r.toLowerCase()));
  const senders = new Set(rules.senders.map((s) => s.toLowerCase()));
  const overrides = new Map(Object.entries(rules.repoEvents).map(([repo, o]) => [repo.toLowerCase(), o.events]));
  return (facts) => {
    const repo = facts.repo?.toLowerCase();
    if (repo && excluded.has(repo)) return drop("repo excluded");
    const custom = repo ? overrides.get(repo) : undefined;
    const event = (custom ?? rules.events)[facts.event];
    const suffix = custom ? " for repo" : "";
    if (event?.off) return drop(`event off${suffix}`);
    if (facts.action && event?.drop?.includes(facts.action)) return drop(`action off${suffix}`);
    if (facts.sender && senders.has(facts.sender.toLowerCase())) return drop("sender excluded");
    if (rules.skipBots && facts.bot) return drop("bot");
    if (
      rules.pushBranches === "default" &&
      facts.event === "push" &&
      facts.ref?.startsWith("refs/heads/") &&
      facts.defaultBranch &&
      facts.ref !== `refs/heads/${facts.defaultBranch}`
    ) return drop("not the default branch");
    return SEND;
  };
}

export function normalizeHook(raw) {
  if (!raw || typeof raw !== "object") return null;
  const events = Array.isArray(raw.events) ? unique(raw.events.map(String).filter((e) => e === "*" || NAME.test(e))) : null;
  return {
    id: raw.id == null ? null : String(raw.id).slice(0, 30),
    events,
    active: typeof raw.active === "boolean" ? raw.active : null,
    source: raw.source === "github" || raw.source === "ping" ? raw.source : null,
    readAt: typeof raw.readAt === "string" ? raw.readAt : null,
    error: raw.error ? String(raw.error).slice(0, 300) : null,
  };
}
