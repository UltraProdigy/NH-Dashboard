/**
 * Kept in a Durable Object rather than D1 on purpose: it must never stamp a
 * table, or every delivery would set the heavy recompute running again.
 */

import { compileRules, matchesAny, parseRepoList } from "../../src/shared/repo-rules.js";
import { boxOf, DROPPED_EVENTS, KEEP_PER_BOX } from "../../web/js/log-boxes.js";

export const LOG_NAME = "github-logs";

const MAX_TEXT = 160;

const clip = (value, max = MAX_TEXT) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const words = (action) => String(action ?? "").replace(/_/g, " ");
const quoted = (name) => (name ? `“${clip(name, 60)}”` : "");
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const firstLine = (message) => clip(String(message ?? "").split("\n")[0], 80);
const refName = (ref) => String(ref ?? "").replace(/^refs\/(heads|tags)\//, "");
const changed = (changes) => {
  const keys = Object.keys(changes ?? {});
  return keys.length ? ` (${keys.map(words).join(", ")})` : "";
};

const BAD_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure", "action_required"]);
const CONCLUSION_TEXT = {
  success: "passed",
  failure: "failed",
  cancelled: "was cancelled",
  timed_out: "timed out",
  skipped: "was skipped",
  startup_failure: "failed to start",
  action_required: "is waiting for approval",
  neutral: "finished",
  stale: "went stale",
};

const ALERT_VERB = {
  created: "new",
  auto_reopened: "auto-reopened",
  auto_dismissed: "auto-dismissed",
  appeared_in_branch: "new branch for",
  closed_by_user: "closed",
  reopened_by_user: "reopened",
  assignees_changed: "reassigned",
  updated_assignment: "reassigned",
};
const ALERT_OPEN = new Set(["created", "reopened", "reintroduced", "auto_reopened", "reopened_by_user", "appeared_in_branch"]);
const alertTone = (action) => (ALERT_OPEN.has(action) ? "bad" : action === "fixed" ? "good" : "muted");
const alertVerb = (action) => ALERT_VERB[action] ?? words(action);
const repoPage = (payload, tail) => (payload.repository?.html_url ? `${payload.repository.html_url}${tail}` : null);
const shownValue = (value) => [].concat(value).join(", ");

function customPropertyValues(p) {
  const before = new Map((p.old_property_values ?? []).map((v) => [v.property_name, v.value]));
  const parts = (p.new_property_values ?? [])
    .filter((v) => JSON.stringify(v.value ?? null) !== JSON.stringify(before.get(v.property_name) ?? null))
    .map((v) => (v.value == null || v.value === "" ? `cleared ${v.property_name}` : `${v.property_name} = ${shownValue(v.value)}`));
  return {
    text: parts.length ? `set custom properties: ${clip(parts.join("; "), 140)}` : "changed custom properties",
    url: repoPage(p, "/settings/custom-properties"),
  };
}

function securityAndAnalysis(p) {
  const before = p.changes?.from?.security_and_analysis ?? {};
  const now = p.repository?.security_and_analysis ?? {};
  const parts = Object.keys(before)
    .filter((k) => now[k]?.status && before[k]?.status !== now[k].status)
    .map((k) => `${words(k)} ${now[k].status}`);
  return {
    text: parts.length ? `changed security settings: ${parts.join(", ")}` : "changed security settings",
    url: repoPage(p, "/settings/security_analysis"),
    tone: parts.some((x) => x.endsWith("disabled")) ? "warn" : null,
  };
}

function itemVerb(action, payload) {
  switch (action) {
    case "labeled":
    case "unlabeled":
      return `${action} ${quoted(payload.label?.name)} on`;
    case "assigned":
    case "unassigned":
      return `${action} ${payload.assignee?.login ?? "someone"} ${action === "assigned" ? "to" : "from"}`;
    case "review_requested":
    case "review_request_removed":
      return `${words(action)} for ${payload.requested_reviewer?.login ?? payload.requested_team?.name ?? "someone"} on`;
    case "synchronize":
      return "pushed to";
    case "ready_for_review":
      return "marked ready for review";
    case "converted_to_draft":
      return "converted to draft";
    case "milestoned":
    case "demilestoned":
      return `${action} ${quoted(payload.milestone?.title)}`;
    default:
      return words(action);
  }
}

function pullRequest(payload) {
  const pr = payload.pull_request ?? {};
  const merged = payload.action === "closed" && (pr.merged || pr.merged_at);
  const verb = merged ? "merged" : itemVerb(payload.action, payload);
  return {
    text: `${verb} PR #${pr.number}: ${clip(pr.title)}`,
    url: pr.html_url,
    tone: merged ? "good" : payload.action === "closed" ? "muted" : null,
  };
}

function review(payload) {
  const pr = payload.pull_request ?? {};
  const state = String(payload.review?.state ?? "").toLowerCase();
  let verb = "reviewed";
  let tone = null;
  if (payload.action === "dismissed") {
    verb = "dismissed a review on";
  } else if (state === "approved") {
    verb = "approved";
    tone = "good";
  } else if (state === "changes_requested") {
    verb = "requested changes on";
    tone = "bad";
  } else if (payload.action === "edited") {
    verb = "edited a review on";
  }
  return { text: `${verb} PR #${pr.number}: ${clip(pr.title)}`, url: payload.review?.html_url ?? pr.html_url, tone };
}

function issue(payload) {
  const it = payload.issue ?? {};
  const reason = payload.action === "closed" && it.state_reason ? ` as ${words(it.state_reason)}` : "";
  return {
    text: `${itemVerb(payload.action, payload)} issue #${it.number}${reason}: ${clip(it.title)}`,
    url: it.html_url,
    tone: payload.action === "closed" ? "muted" : null,
  };
}

function comment(payload) {
  const it = payload.issue ?? {};
  const kind = it.pull_request ? "PR" : "issue";
  const verb = payload.action === "created" ? "commented on" : `${words(payload.action)} a comment on`;
  return { text: `${verb} ${kind} #${it.number}: ${clip(it.title)}`, url: payload.comment?.html_url ?? it.html_url };
}

function push(payload) {
  const ref = payload.ref ?? "";
  const name = refName(ref);
  const tag = ref.startsWith("refs/tags/");
  if (payload.deleted) return { text: `deleted ${tag ? "tag" : "branch"} ${name}`, url: payload.repository?.html_url, tone: "muted" };
  if (tag) return { text: `pushed tag ${name}`, url: payload.compare };
  const n = (payload.commits ?? []).length;
  const head = payload.head_commit?.message ? `: ${firstLine(payload.head_commit.message)}` : "";
  return {
    text: `pushed ${plural(n, "commit")} to ${name}${payload.forced ? " (force-push)" : ""}${head}`,
    url: payload.compare,
    tone: payload.forced ? "warn" : null,
  };
}

function workflowRun(payload) {
  const run = payload.workflow_run ?? {};
  const branch = payload.repository?.default_branch;
  if (!branch || run.head_branch !== branch) return null;
  const name = clip(run.name ?? "workflow", 60);
  if (payload.action === "requested") return { text: `${name} queued on ${branch}`, url: run.html_url, tone: "muted" };
  if (payload.action === "in_progress") return { text: `${name} running on ${branch}`, url: run.html_url, tone: "run" };
  const conclusion = run.conclusion ?? "finished";
  const tone = conclusion === "success" ? "good" : BAD_CONCLUSIONS.has(conclusion) ? "bad" : "muted";
  return { text: `${name} ${CONCLUSION_TEXT[conclusion] ?? words(conclusion)} on ${branch}`, url: run.html_url, tone };
}

function release(payload) {
  const r = payload.release ?? {};
  return {
    text: `${words(payload.action)} release ${clip(r.name || r.tag_name, 80)}${r.prerelease ? " (pre-release)" : ""}`,
    url: r.html_url,
    tone: payload.action === "published" || payload.action === "released" ? "good" : null,
  };
}

function repository(payload) {
  const repo = payload.repository ?? {};
  const a = payload.action;
  if (a === "edited") return { text: `edited repository settings${changed(payload.changes)}`, url: repo.html_url };
  if (a === "renamed") return { text: `renamed repository from ${payload.changes?.repository?.name?.from ?? "?"}`, url: repo.html_url, tone: "warn" };
  if (a === "transferred") return { text: "transferred repository", url: repo.html_url, tone: "warn" };
  const tone = ["deleted", "archived", "publicized"].includes(a) ? "warn" : null;
  return { text: `${words(a)} repository`, url: repo.html_url, tone };
}

const org = (payload) => payload.organization?.login ?? "GTNewHorizons";
const orgUrl = (payload, tail = "") => `https://github.com/orgs/${org(payload)}${tail}`;
const settingsUrl = (payload, tail) => (payload.repository?.html_url ? `${payload.repository.html_url}/settings${tail}` : orgUrl(payload, `/settings${tail}`));

const DESCRIBE = {
  pull_request: pullRequest,
  pull_request_review: review,
  pull_request_review_comment: (p) => ({
    text: `${p.action === "created" ? "commented on the diff of" : `${words(p.action)} a diff comment on`} PR #${p.pull_request?.number}: ${clip(p.pull_request?.title)}`,
    url: p.comment?.html_url ?? p.pull_request?.html_url,
  }),
  pull_request_review_thread: (p) => ({
    text: `${words(p.action)} a review thread on PR #${p.pull_request?.number}: ${clip(p.pull_request?.title)}`,
    url: p.pull_request?.html_url,
  }),
  issues: issue,
  issue_comment: comment,
  discussion: (p) => ({
    text: `${words(p.action)} discussion #${p.discussion?.number}: ${clip(p.discussion?.title)}`,
    url: p.discussion?.html_url,
  }),
  discussion_comment: (p) => ({
    text: `${p.action === "created" ? "commented on" : `${words(p.action)} a comment on`} discussion #${p.discussion?.number}: ${clip(p.discussion?.title)}`,
    url: p.comment?.html_url ?? p.discussion?.html_url,
  }),
  push,
  create: (p) => ({ text: `created ${p.ref_type} ${p.ref}`, url: p.repository?.html_url }),
  delete: (p) => ({ text: `deleted ${p.ref_type} ${p.ref}`, url: p.repository?.html_url, tone: "muted" }),
  workflow_run: workflowRun,
  release,
  repository,
  branch_protection_rule: (p) => ({
    text: `${words(p.action)} branch protection rule ${quoted(p.rule?.name)}${p.action === "edited" ? changed(p.changes) : ""}`,
    url: settingsUrl(p, "/branches"),
    tone: p.action === "deleted" ? "warn" : null,
  }),
  branch_protection_configuration: (p) => ({
    text: `${words(p.action)} branch protections for the whole repository`,
    url: settingsUrl(p, "/branches"),
    tone: p.action === "disabled" ? "warn" : null,
  }),
  repository_ruleset: (p) => ({
    text: `${words(p.action)} ${p.repository ? "" : "org "}ruleset ${quoted(p.repository_ruleset?.name)}`,
    url: settingsUrl(p, "/rules"),
    tone: p.action === "deleted" ? "warn" : null,
  }),
  label: (p) => ({
    text: `${words(p.action)} label ${quoted(p.label?.name)}${p.changes?.name?.from ? ` (was ${quoted(p.changes.name.from)})` : ""}`,
    url: p.repository?.html_url ? `${p.repository.html_url}/labels` : null,
  }),
  member: (p) => ({
    text: `${words(p.action)} collaborator ${p.member?.login ?? "?"}${p.changes?.permission?.to ? ` (${p.changes.permission.to})` : ""}`,
    url: settingsUrl(p, "/access"),
    tone: "warn",
  }),
  membership: (p) => ({
    text: `${words(p.action)} ${p.member?.login ?? "?"} ${p.action === "removed" ? "from" : "to"} team ${p.team?.name ?? "?"}`,
    url: p.team?.html_url ?? orgUrl(p, "/teams"),
    tone: p.action === "removed" ? "warn" : null,
  }),
  team: (p) => ({
    text: `${words(p.action)} team ${p.team?.name ?? "?"}${p.action === "edited" ? changed(p.changes) : ""}`,
    url: p.team?.html_url ?? orgUrl(p, "/teams"),
    tone: p.action === "deleted" ? "warn" : null,
  }),
  team_add: (p) => ({ text: `added to team ${p.team?.name ?? "?"}`, url: p.team?.html_url ?? orgUrl(p, "/teams") }),
  organization: (p) => {
    const who = p.membership?.user?.login ?? p.invitation?.login ?? p.user?.login ?? "";
    return {
      text: `${words(p.action)}${who ? ` ${who}` : ""}`,
      url: orgUrl(p, "/people"),
      tone: p.action === "member_removed" ? "warn" : null,
    };
  },
  public: (p) => ({ text: "made the repository public", url: p.repository?.html_url, tone: "warn" }),
  deploy_key: (p) => ({ text: `${words(p.action)} deploy key ${quoted(p.key?.title)}`, url: settingsUrl(p, "/keys"), tone: "warn" }),
  custom_property_values: customPropertyValues,
  custom_property: (p) => ({
    text: `${words(p.action)} custom property ${quoted(p.definition?.property_name)}`,
    url: orgUrl(p, "/settings/custom-properties"),
    tone: p.action === "deleted" ? "warn" : null,
  }),
  installation_target: (p) => ({
    text: `renamed the account the App is installed on${p.changes?.login?.from ? ` (was ${p.changes.login.from})` : ""}`,
    url: null,
    tone: "warn",
  }),
  dependabot_alert: (p) => {
    const al = p.alert ?? {};
    const pkg = al.dependency?.package?.name ?? al.security_vulnerability?.package?.name;
    const sev = al.security_advisory?.severity ?? al.security_vulnerability?.severity;
    const summary = al.security_advisory?.summary ? `: ${clip(al.security_advisory.summary, 100)}` : "";
    return {
      text: `${alertVerb(p.action)} Dependabot alert #${al.number ?? "?"}${sev ? ` (${sev})` : ""}${pkg ? ` in ${pkg}` : ""}${summary}`,
      url: al.html_url,
      tone: alertTone(p.action),
    };
  },
  code_scanning_alert: (p) => {
    const al = p.alert ?? {};
    const sev = al.rule?.security_severity_level ?? al.rule?.severity;
    const rule = al.rule?.description ? `: ${clip(al.rule.description, 100)}` : "";
    return {
      text: `${alertVerb(p.action)} code scanning alert #${al.number ?? "?"}${sev ? ` (${sev})` : ""}${rule}`,
      url: al.html_url,
      tone: alertTone(p.action),
    };
  },
  security_and_analysis: securityAndAnalysis,
  personal_access_token_request: (p) => {
    const who = p.personal_access_token_request?.owner?.login ?? "someone";
    return {
      text: p.action === "created"
        ? "requested a fine-grained token for org repos"
        : `${words(p.action)} ${who}'s fine-grained token request`,
      url: orgUrl(p, "/settings/personal-access-token-requests"),
      tone: p.action === "approved" ? "warn" : null,
    };
  },
  org_block: (p) => ({
    text: p.action === "blocked" ? `blocked ${p.blocked_user?.login ?? "a user"} from the org` : `unblocked ${p.blocked_user?.login ?? "a user"}`,
    url: orgUrl(p, "/settings/blocked_users"),
    tone: "warn",
  }),
  workflow_dispatch: (p) => ({
    text: `ran ${clip(String(p.workflow ?? "a workflow").split("/").pop(), 60)} by hand on ${refName(p.ref)}`,
    url: repoPage(p, "/actions"),
  }),
  deployment: (p) => ({
    text: `deployed ${refName(p.deployment?.ref) || "?"} to ${p.deployment?.environment ?? "an environment"}`,
    url: repoPage(p, "/deployments"),
  }),
  milestone: (p) => ({
    text: `${words(p.action)} milestone ${quoted(p.milestone?.title)}`,
    url: p.milestone?.html_url ?? repoPage(p, "/milestones"),
    tone: p.action === "deleted" ? "muted" : null,
  }),
  sub_issues: (p) => {
    if (!String(p.action).startsWith("sub_issue_")) return null;
    const added = p.action === "sub_issue_added";
    return {
      text: `${added ? "added" : "removed"} #${p.sub_issue?.number ?? "?"} ${added ? "as a sub-issue of" : "from"} #${p.parent_issue?.number ?? "?"}: ${clip(p.parent_issue?.title)}`,
      url: p.parent_issue?.html_url,
    };
  },
  issue_dependencies: (p) => {
    if (!String(p.action).startsWith("blocked_by_")) return null;
    const other = p.blocking_issue_repo?.name && p.blocking_issue_repo.name !== p.repository?.name ? p.blocking_issue_repo.name : "";
    const blocker = `${other}#${p.blocking_issue?.number ?? "?"}`;
    return {
      text: p.action === "blocked_by_added"
        ? `marked #${p.blocked_issue?.number ?? "?"} as blocked by ${blocker}`
        : `unmarked #${p.blocked_issue?.number ?? "?"} as blocked by ${blocker}`,
      url: p.blocked_issue?.html_url,
    };
  },
  issue_relates_to: (p) => {
    const removed = p.action === "relates_to_removed";
    return {
      text: `${removed ? "unlinked" : "linked"} #${p.issue?.number ?? "?"} ${removed ? "from" : "to"} #${p.related_issue?.number ?? "?"}`,
      url: p.issue?.html_url,
    };
  },
  commit_comment: (p) => ({
    text: `${p.action === "created" || !p.action ? "commented on" : `${words(p.action)} a comment on`} commit ${String(p.comment?.commit_id ?? "").slice(0, 7)}`,
    url: p.comment?.html_url,
  }),
  registry_package: (p) => {
    const pkg = p.registry_package ?? {};
    const version = pkg.package_version?.version ? ` ${pkg.package_version.version}` : "";
    return { text: `${words(p.action)} package ${pkg.name ?? "?"}${version}`, url: pkg.html_url, tone: p.action === "published" ? "good" : null };
  },
  gollum: (p) => {
    const pages = p.pages ?? [];
    const first = pages[0] ?? {};
    const more = pages.length > 1 ? ` and ${plural(pages.length - 1, "more page")}` : "";
    return { text: `${first.action ?? "edited"} wiki page ${quoted(first.title ?? first.page_name)}${more}`, url: first.html_url };
  },
  star: (p) => ({ text: p.action === "deleted" ? "unstarred the repository" : "starred the repository", url: p.repository?.html_url, tone: p.action === "deleted" ? "muted" : null }),
  watch: (p) => ({ text: "started watching the repository", url: p.repository?.html_url }),
  fork: (p) => ({ text: `forked the repository to ${p.forkee?.full_name ?? "?"}`, url: p.forkee?.html_url }),
  installation: (p) => ({ text: `${words(p.action)} the dashboard's GitHub App installation`, url: null, tone: "warn" }),
  installation_repositories: (p) => {
    const added = (p.repositories_added ?? []).length;
    const removed = (p.repositories_removed ?? []).length;
    const parts = [added && `added ${plural(added, "repo")}`, removed && `removed ${plural(removed, "repo")}`].filter(Boolean);
    return { text: `${parts.join(", ") || "changed repos"} on the App installation`, url: null };
  },
};

const fallback = (event, payload) => ({ text: `${words(event)}${payload.action ? ` ${words(payload.action)}` : ""}`, url: payload.repository?.html_url ?? null });

/** Excluded repos are dropped here for the same reason every panel drops them. */
export function summarise(event, payload, { delivery = null, at = new Date().toISOString(), rules = [] } = {}) {
  if (event === "ping" || DROPPED_EVENTS.has(event) || !payload || typeof payload !== "object") return null;
  const repo = payload.repository?.name ?? null;
  if (repo && rules.length && matchesAny(rules, repo)) return null;

  const line = (DESCRIBE[event] ?? ((p) => fallback(event, p)))(payload);
  if (!line) return null;

  const url = typeof line.url === "string" && line.url.startsWith("https://github.com/") ? line.url : null;
  return {
    id: delivery || `${event}-${at}-${Math.random().toString(36).slice(2, 8)}`,
    at,
    box: boxOf(event, payload),
    event,
    action: payload.action ?? null,
    repo,
    actor: payload.sender?.login ?? null,
    text: clip(line.text, 240),
    url,
    tone: line.tone ?? null,
  };
}

export const excludeRules = (env) => compileRules(parseRepoList(env?.NH_INGEST_EXCLUDE));

export async function logDelivery(env, event, payload, delivery) {
  if (!env?.EVENT_LOG) return null;
  const entry = summarise(event, payload, { delivery, rules: excludeRules(env) });
  if (!entry) return null;
  const stub = env.EVENT_LOG.get(env.EVENT_LOG.idFromName(LOG_NAME));
  const res = await stub.fetch("https://event-log/record", { method: "POST", body: JSON.stringify(entry) });
  if (!res.ok) throw new Error(`event log ${res.status}`);
  return entry;
}

export class EventLog {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, box TEXT NOT NULL, entry TEXT NOT NULL)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS idx_events_box ON events (box, seq)");
    if (typeof WebSocketRequestResponsePair === "function" && ctx.setWebSocketAutoResponse) {
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/record" && request.method === "POST") {
      this.record(await request.json());
      return new Response(null, { status: 204 });
    }
    if ((request.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ type: "history", keep: KEEP_PER_BOX, events: this.history() }));
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("not found", { status: 404 });
  }

  record(entry) {
    if (!entry || typeof entry.box !== "string") return;
    this.sql.exec("INSERT INTO events (box, entry) VALUES (?, ?)", entry.box, JSON.stringify(entry));
    this.sql.exec(
      "DELETE FROM events WHERE box = ? AND seq <= (SELECT seq FROM events WHERE box = ? ORDER BY seq DESC LIMIT 1 OFFSET ?)",
      entry.box, entry.box, KEEP_PER_BOX,
    );
    const message = JSON.stringify({ type: "event", event: entry });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(message); } catch {}
    }
  }

  history() {
    return this.sql.exec("SELECT entry FROM events ORDER BY seq DESC").toArray().map((row) => JSON.parse(row.entry));
  }

  webSocketMessage(ws, message) {
    if (message === "ping") ws.send("pong");
  }

  webSocketClose(ws) {
    try { ws.close(); } catch {}
  }

  webSocketError(ws) {
    try { ws.close(); } catch {}
  }
}
