import {
  API_LEVEL, expectKeys, KINDS, keyOf, MAX_CHANGES, needsOwner, NOTIFY_API, validLogin, validTeamName, validValue,
} from "../../web/js/permission-changes.js";
import { levelOf } from "../../web/js/permissions-calc.js";
import { forgetOrgManagerToken, orgManagerToken } from "./org-manager.js";
import { directLevel } from "./permissions-read.js";
import { PERMISSIONS_NAME } from "./permissions.js";

export const JOBS_NAME = "permission-jobs";

// GitHub's secondary limits are about 80 writes a minute and 500 an hour, and it
// asks for a second between writes.
const GAP_MS = 1000;
const PER_MINUTE = 70;
const PER_HOUR = 480;
const MAX_TRIES = 5;
const EXPECT_MS = 30 * 60_000;

const API = "https://api.github.com";

export const jobsStub = (env) => env.PERMISSION_JOBS.get(env.PERMISSION_JOBS.idFromName(JOBS_NAME));

const intId = (v) => (Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

function descends(teams, id, ancestor) {
  const seen = new Set();
  for (let at = teams[id]; at && !seen.has(at.id); at = teams[at.parent]) {
    if (String(at.id) === String(ancestor)) return true;
    seen.add(at.id);
  }
  return false;
}

// Teams and repos are rebuilt from the snapshot by id, whatever slug or name was sent.
export function normaliseBatch(sent, snapshot, { adminTeam = "admin", owner = false } = {}) {
  if (!Array.isArray(sent) || !sent.length) return { error: "nothing to apply" };
  if (sent.length > MAX_CHANGES) return { error: `at most ${MAX_CHANGES} changes at a time` };
  const teams = snapshot?.teams ?? {};
  const repos = snapshot?.repos ?? {};
  const members = snapshot?.org?.members ?? {};
  const adminId = Object.values(teams).find((t) => t.slug === adminTeam)?.id ?? null;
  const problems = [];
  const out = new Map();

  sent.forEach((raw, n) => {
    const bad = (why) => problems.push({ n, kind: raw?.kind ?? null, error: why });
    if (!raw || !KINDS.includes(raw.kind)) return bad("unknown kind");
    const c = { kind: raw.kind };
    const needTeam = ["team_member", "team_repo", "team_rename", "team_parent", "team_delete", "team_description", "team_privacy", "team_notifications"].includes(c.kind);
    const needRepo = ["team_repo", "collaborator", "visibility", "archived"].includes(c.kind);
    const needLogin = ["team_member", "collaborator", "owner"].includes(c.kind);

    if (needTeam) {
      const t = teams[intId(raw.team?.id)];
      if (!t) return bad("that team isn't in the snapshot");
      c.team = { id: t.id, slug: t.slug, name: t.name };
    }
    if (needRepo) {
      const r = repos[intId(raw.repo?.id)];
      if (!r) return bad("that repo isn't in the snapshot");
      c.repo = { id: r.id, name: r.name };
    }
    if (needLogin) {
      if (!validLogin(raw.login)) return bad("not a GitHub login");
      c.login = raw.login;
    }

    if (c.kind === "team_create") {
      if (!validTeamName(raw.name)) return bad("a team needs a name");
      c.name = raw.name.trim();
      if (Object.values(teams).some((t) => t.name.toLowerCase() === c.name.toLowerCase())) return bad("there's already a team with that name");
      c.parent = raw.parent == null ? null : intId(raw.parent);
      if (raw.parent != null && !teams[c.parent]) return bad("the parent team isn't in the snapshot");
      c.from = null;
      c.to = "created";
    } else if (c.kind === "team_rename") {
      if (!validTeamName(raw.to)) return bad("a team needs a name");
      c.from = String(raw.from ?? "");
      c.to = raw.to.trim();
    } else if (c.kind === "team_parent") {
      c.from = raw.from == null ? null : intId(raw.from);
      c.to = raw.to == null ? null : intId(raw.to);
      if (raw.to != null && !teams[c.to]) return bad("the new parent isn't in the snapshot");
      if (c.to != null && descends(teams, c.to, c.team.id)) return bad("a team can't go under itself or one of its own children");
      if (c.to != null && (teams[c.team.id].privacy === "secret" || teams[c.to].privacy === "secret")) return bad("secret teams can't be nested");
    } else if (c.kind === "team_description") {
      c.from = String(raw.from ?? "");
      c.to = typeof raw.to === "string" ? raw.to.trim() : "";
      if (!validValue(c.kind, c.to)) return bad("that description is too long");
    } else if (c.kind === "team_privacy" || c.kind === "team_notifications") {
      if (!validValue(c.kind, raw.to)) return bad("bad new value");
      c.from = raw.from ?? null;
      c.to = raw.to;
      const t = teams[c.team.id];
      if (c.to === "secret" && (t.parent != null || Object.values(teams).some((k) => String(k.parent) === String(t.id)))) {
        return bad("a team with a parent or child teams can't be secret");
      }
    } else if (c.kind === "team_delete") {
      c.from = "exists";
      c.to = null;
    } else if (c.kind === "owner") {
      if (!(c.login in members)) return bad("only org members can be made owners");
      if (!validValue("owner", raw.to)) return bad("bad role");
      c.from = members[c.login];
      c.to = raw.to;
    } else {
      const unknownOk = ["team_member", "team_repo", "collaborator"].includes(c.kind) && raw.from === "unknown";
      if (!unknownOk && !validValue(c.kind, raw.from ?? (c.kind === "archived" ? undefined : null))) return bad("bad starting value");
      if (!validValue(c.kind, raw.to ?? (c.kind === "archived" ? undefined : null))) return bad("bad new value");
      c.from = raw.from ?? null;
      c.to = raw.to ?? null;
    }

    if (c.from === c.to) return;
    if (!owner && needsOwner(c, adminId)) return bad("only an org owner can make this change");
    out.set(keyOf(c), c);
  });

  if (problems.length) return { error: "some changes can't be applied", problems };
  if (!out.size) return { error: "nothing to apply" };
  return { changes: [...out.values()] };
}

class RateLimited extends Error {
  constructor(wait) {
    super(`GitHub asked to wait ${Math.ceil(wait / 1000)}s`);
    this.wait = wait;
  }
}

export async function ghFetch(token, path, { method = "GET", body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "nh-dashboard-worker",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text().catch(() => "");
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, ok: res.ok, headers: res.headers, json, text };
}

export function rateWait(res, now = Date.now()) {
  if (res.status !== 403 && res.status !== 429) return null;
  const after = Number(res.headers?.get?.("retry-after"));
  if (after > 0) return after * 1000;
  if (res.headers?.get?.("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
    if (reset) return Math.max(1000, reset - now);
  }
  if (/rate limit|abuse/i.test(res.text ?? "")) return 60_000;
  return null;
}

const failure = (res) => new Error(`GitHub said ${res.status}${res.json?.message ? `: ${res.json.message}` : ""}`);

const seg = encodeURIComponent;

const COLLABORATOR = `query($org: String!, $name: String!, $login: String!) {
  repository(owner: $org, name: $name) { collaborators(affiliation: DIRECT, login: $login, first: 1) {
    edges { permission permissionSources { roleName permission source { __typename } } node { login } } } }
}`;

export const slugOf = (name) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export async function currentValue(c, { org, call }) {
  const team = c.team ? `/orgs/${seg(org)}/teams/${seg(c.team.slug)}` : null;
  const repo = c.repo ? `/repos/${seg(org)}/${seg(c.repo.name)}` : null;
  switch (c.kind) {
    case "team_member": {
      const r = await call(`${team}/memberships/${seg(c.login)}`, { allow: [404] });
      if (r.status === 404) return null;
      return r.json?.state === "pending" ? "pending" : r.json?.role ?? null;
    }
    case "team_repo": {
      for (let page = 1; page <= 20; page++) {
        const r = await call(`${repo}/teams?per_page=100&page=${page}`);
        const hit = (r.json ?? []).find((t) => String(t.id) === String(c.team.id));
        if (hit) return levelOf(hit.role_name) ?? levelOf(hit.permission) ?? levelOf(hit.permissions);
        if ((r.json ?? []).length < 100) return null;
      }
      return null;
    }
    case "collaborator": {
      const r = await call("/graphql", { method: "POST", body: { query: COLLABORATOR, variables: { org, name: c.repo.name, login: c.login } } });
      if (r.json?.errors?.length) throw new Error(`graphql: ${r.json.errors[0].message}`);
      const edge = r.json?.data?.repository?.collaborators?.edges?.find((e) => e.node.login.toLowerCase() === c.login.toLowerCase());
      return edge ? directLevel(edge) : null;
    }
    case "visibility": return (await call(repo)).json?.visibility ?? null;
    case "archived": return Boolean((await call(repo)).json?.archived);
    case "team_create": {
      const r = await call(`/orgs/${seg(org)}/teams/${seg(slugOf(c.name))}`, { allow: [404] });
      return r.status === 404 ? null : "created";
    }
    case "team_rename": {
      const r = await call(team, { allow: [404] });
      return r.status === 404 ? null : r.json?.name ?? null;
    }
    case "team_parent": {
      const r = await call(team, { allow: [404] });
      if (r.status === 404) throw new Error("the team is gone");
      return r.json?.parent?.id ?? null;
    }
    case "team_delete": {
      const r = await call(team, { allow: [404] });
      return r.status === 404 ? null : "exists";
    }
    case "owner": {
      const r = await call(`/orgs/${seg(org)}/memberships/${seg(c.login)}`, { allow: [404] });
      if (r.status === 404) return null;
      if (r.json?.state === "pending") return "pending";
      return r.json?.role === "admin" ? "owner" : "member";
    }
    case "team_description":
    case "team_privacy":
    case "team_notifications": {
      const r = await call(team, { allow: [404] });
      if (r.status === 404) throw new Error("the team is gone");
      if (c.kind === "team_description") return r.json?.description ?? "";
      if (c.kind === "team_privacy") return r.json?.privacy ?? null;
      return r.json?.notification_setting === NOTIFY_API.disabled ? "disabled" : "enabled";
    }
    default: throw new Error(`unknown kind ${c.kind}`);
  }
}

export async function makeChange(c, { org, call }) {
  const team = c.team ? `/orgs/${seg(org)}/teams/${seg(c.team.slug)}` : null;
  const repo = c.repo ? `/repos/${seg(org)}/${seg(c.repo.name)}` : null;
  const w = (path, method, body) => call(path, { method, body, write: true });
  switch (c.kind) {
    case "team_member": {
      if (c.to == null) { await w(`${team}/memberships/${seg(c.login)}`, "DELETE"); return {}; }
      const r = await w(`${team}/memberships/${seg(c.login)}`, "PUT", { role: c.to });
      return { invited: r.json?.state === "pending" };
    }
    case "team_repo":
      if (c.to == null) await w(`${team}/repos/${seg(org)}/${seg(c.repo.name)}`, "DELETE");
      else await w(`${team}/repos/${seg(org)}/${seg(c.repo.name)}`, "PUT", { permission: API_LEVEL[c.to] });
      return {};
    case "collaborator": {
      if (c.to == null) { await w(`${repo}/collaborators/${seg(c.login)}`, "DELETE"); return {}; }
      const r = await w(`${repo}/collaborators/${seg(c.login)}`, "PUT", { permission: API_LEVEL[c.to] });
      return { invited: r.status === 201 };
    }
    case "visibility": await w(repo, "PATCH", { visibility: c.to }); return {};
    case "archived": await w(repo, "PATCH", { archived: c.to }); return {};
    case "team_create": {
      const r = await w(`/orgs/${seg(org)}/teams`, "POST", { name: c.name, privacy: "closed", ...(c.parent != null ? { parent_team_id: c.parent } : {}) });
      return { team: { id: r.json?.id, slug: r.json?.slug, name: r.json?.name ?? c.name, parent: r.json?.parent?.id ?? c.parent ?? null } };
    }
    case "team_rename": {
      const r = await w(team, "PATCH", { name: c.to });
      return { slug: r.json?.slug ?? null };
    }
    case "team_parent": await w(team, "PATCH", { parent_team_id: c.to }); return {};
    case "team_delete": await w(team, "DELETE"); return {};
    case "owner": await w(`/orgs/${seg(org)}/memberships/${seg(c.login)}`, "PUT", { role: c.to === "owner" ? "admin" : "member" }); return {};
    case "team_description": await w(team, "PATCH", { description: c.to }); return {};
    case "team_privacy": await w(team, "PATCH", { privacy: c.to }); return {};
    case "team_notifications": await w(team, "PATCH", { notification_setting: NOTIFY_API[c.to] }); return {};
    default: throw new Error(`unknown kind ${c.kind}`);
  }
}

function startedFrom(c, cur) {
  if (c.from === "unknown") return cur != null && cur !== "pending";
  return cur === c.from;
}

const show = (v) => (v == null ? "none" : v === true ? "archived" : v === false ? "not archived" : String(v));

export class PermissionJobs {
  constructor(ctx, env, deps = {}) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.request = deps.request ?? ghFetch;
    this.now = deps.now ?? (() => Date.now());
    this.token = deps.token ?? ((fresh) => (fresh && forgetOrgManagerToken(), orgManagerToken(env)));
    this.permissions = deps.permissions ?? (() => env.PERMISSIONS?.get(env.PERMISSIONS.idFromName(PERMISSIONS_NAME)));
    this.sql.exec(`CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, by TEXT NOT NULL, state TEXT NOT NULL,
      dry INTEGER NOT NULL, cancel INTEGER NOT NULL DEFAULT 0, cancelled_by TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
      slugs TEXT NOT NULL DEFAULT '{}', wait_until TEXT, wait_note TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS items (job TEXT NOT NULL, i INTEGER NOT NULL, change TEXT NOT NULL, status TEXT NOT NULL,
      note TEXT, attempts INTEGER NOT NULL DEFAULT 0, at TEXT, PRIMARY KEY (job, i))`);
    this.sql.exec("CREATE TABLE IF NOT EXISTS writes (at INTEGER NOT NULL)");
    if (typeof WebSocketRequestResponsePair === "function" && ctx.setWebSocketAutoResponse) {
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if ((request.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ type: "state", ...this.state() }));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === "/submit" && request.method === "POST") return Response.json(await this.submit(await request.json()));
    if (url.pathname === "/cancel" && request.method === "POST") return Response.json(await this.cancel(await request.json()));
    if (url.pathname === "/state" && request.method === "GET") return Response.json(this.state());
    return new Response("not found", { status: 404 });
  }

  rows(q, ...b) {
    return this.sql.exec(q, ...b).toArray();
  }

  async submit({ by, changes, dry = false }) {
    const now = new Date(this.now()).toISOString();
    const seq = (this.rows("SELECT MAX(seq) AS n FROM jobs")[0]?.n ?? 0) + 1;
    const id = `job-${this.now().toString(36)}-${seq}`;
    this.sql.exec("INSERT INTO jobs (id, seq, by, state, dry, created_at) VALUES (?, ?, ?, 'queued', ?, ?)", id, seq, by, dry ? 1 : 0, now);
    changes.forEach((c, i) => this.sql.exec("INSERT INTO items (job, i, change, status) VALUES (?, ?, ?, 'pending')", id, i, JSON.stringify(c)));
    const ahead = this.rows("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('queued', 'running') AND id != ?", id)[0].n;
    if (!ahead) await this.ctx.storage.setAlarm(this.now());
    this.broadcast({ type: "state", ...this.state() });
    return { job: id, ahead, total: changes.length };
  }

  async cancel({ job, by }) {
    const target = job
      ? this.rows("SELECT id, state FROM jobs WHERE id = ?", job)[0]
      : this.rows("SELECT id, state FROM jobs WHERE state = 'running'")[0];
    if (!target || !["queued", "running"].includes(target.state)) return { ok: false, error: "nothing to cancel" };
    if (target.state === "queued") {
      this.sql.exec("UPDATE items SET status = 'cancelled' WHERE job = ? AND status = 'pending'", target.id);
      this.sql.exec("UPDATE jobs SET state = 'cancelled', cancelled_by = ?, finished_at = ? WHERE id = ?", by ?? null, new Date(this.now()).toISOString(), target.id);
    } else {
      this.sql.exec("UPDATE jobs SET cancel = 1, cancelled_by = ? WHERE id = ?", by ?? null, target.id);
      await this.ctx.storage.setAlarm(this.now());
    }
    this.broadcast({ type: "state", ...this.state() });
    return { ok: true, job: target.id };
  }

  summary(job) {
    const counts = Object.fromEntries(this.rows("SELECT status, COUNT(*) AS n FROM items WHERE job = ? GROUP BY status", job.id).map((r) => [r.status, r.n]));
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    return {
      id: job.id, by: job.by, state: job.state, dry: Boolean(job.dry), cancelling: Boolean(job.cancel), cancelledBy: job.cancelled_by ?? null,
      createdAt: job.created_at, startedAt: job.started_at, finishedAt: job.finished_at,
      waitUntil: job.wait_until, waitNote: job.wait_note, counts, total,
    };
  }

  items(id) {
    return this.rows("SELECT i, change, status, note, at FROM items WHERE job = ? ORDER BY i", id)
      .map((r) => ({ i: r.i, change: JSON.parse(r.change), status: r.status, note: r.note, at: r.at }));
  }

  state() {
    const jobs = this.rows("SELECT * FROM jobs ORDER BY seq");
    const focus = jobs.find((j) => j.state === "running") ?? [...jobs].reverse().find((j) => j.state !== "queued") ?? null;
    return {
      jobs: jobs.map((j) => this.summary(j)),
      focus: focus ? { ...this.summary(focus), items: this.items(focus.id) } : null,
    };
  }

  broadcast(message) {
    const text = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets?.() ?? []) {
      try { ws.send(text); } catch {}
    }
  }

  paceWait(now) {
    this.sql.exec("DELETE FROM writes WHERE at < ?", now - 3_600_000);
    const hour = this.rows("SELECT at FROM writes ORDER BY at").map((r) => r.at);
    const minute = hour.filter((t) => t > now - 60_000);
    let wait = hour.length ? hour[hour.length - 1] + GAP_MS - now : 0;
    if (minute.length >= PER_MINUTE) wait = Math.max(wait, minute[minute.length - PER_MINUTE] + 60_000 - now);
    if (hour.length >= PER_HOUR) wait = Math.max(wait, hour[hour.length - PER_HOUR] + 3_600_000 - now);
    return Math.max(0, wait);
  }

  async finish(job, state) {
    this.sql.exec("UPDATE items SET status = 'cancelled' WHERE job = ? AND status = 'pending'", job.id);
    this.sql.exec("UPDATE jobs SET state = ?, finished_at = ?, wait_until = NULL, wait_note = NULL WHERE id = ?", state, new Date(this.now()).toISOString(), job.id);
    const final = this.summary({ ...job, state });
    console.log(JSON.stringify({ at: "permission-jobs", job: job.id, by: job.by, state, counts: final.counts }));
    if (this.rows("SELECT 1 FROM jobs WHERE state = 'queued' LIMIT 1").length) await this.ctx.storage.setAlarm(this.now());
    this.broadcast({ type: "state", ...this.state() });
  }

  async alarm() {
    await this.step();
  }

  async step() {
    const now = this.now();
    let job = this.rows("SELECT * FROM jobs WHERE state = 'running'")[0];
    if (!job) {
      const next = this.rows("SELECT * FROM jobs WHERE state = 'queued' ORDER BY seq LIMIT 1")[0];
      if (!next) return;
      for (const old of this.rows("SELECT id FROM jobs WHERE state NOT IN ('queued', 'running')")) {
        this.sql.exec("DELETE FROM items WHERE job = ?", old.id);
        this.sql.exec("DELETE FROM jobs WHERE id = ?", old.id);
      }
      this.sql.exec("UPDATE jobs SET state = 'running', started_at = ? WHERE id = ?", new Date(now).toISOString(), next.id);
      job = { ...next, state: "running", started_at: new Date(now).toISOString() };
      this.broadcast({ type: "state", ...this.state() });
    }
    if (job.cancel) return this.finish(job, "cancelled");

    const row = this.rows("SELECT * FROM items WHERE job = ? AND status = 'pending' ORDER BY i LIMIT 1", job.id)[0];
    if (!row) return this.finish(job, "done");

    if (!job.dry) {
      const wait = this.paceWait(now);
      if (wait > 0) return this.ctx.storage.setAlarm(now + wait);
    }

    const change = JSON.parse(row.change);
    const slugs = JSON.parse(job.slugs || "{}");
    if (change.team && slugs[change.team.id]) change.team.slug = slugs[change.team.id];

    let outcome;
    try {
      outcome = job.dry ? { status: "done", note: "dry run, nothing sent" } : await this.run(job, change, slugs);
    } catch (err) {
      if (err instanceof RateLimited && row.attempts + 1 < MAX_TRIES) {
        const until = now + err.wait;
        this.sql.exec("UPDATE items SET attempts = attempts + 1 WHERE job = ? AND i = ?", job.id, row.i);
        this.sql.exec("UPDATE jobs SET wait_until = ?, wait_note = ? WHERE id = ?", new Date(until).toISOString(), err.message, job.id);
        this.broadcast({ type: "state", ...this.state() });
        return this.ctx.storage.setAlarm(until);
      }
      outcome = { status: "failed", note: String(err.message ?? err).slice(0, 300) };
    }

    const at = new Date(this.now()).toISOString();
    this.sql.exec("UPDATE items SET status = ?, note = ?, at = ? WHERE job = ? AND i = ?", outcome.status, outcome.note ?? null, at, job.id, row.i);
    this.sql.exec("UPDATE jobs SET slugs = ?, wait_until = NULL, wait_note = NULL WHERE id = ?", JSON.stringify(slugs), job.id);
    const fresh = this.rows("SELECT * FROM jobs WHERE id = ?", job.id)[0];
    this.broadcast({ type: "item", job: this.summary(fresh), item: { i: row.i, change, status: outcome.status, note: outcome.note ?? null, at } });
    await this.ctx.storage.setAlarm(this.now() + (job.dry ? 250 : GAP_MS));
  }

  async call(token, path, { method = "GET", body, write = false, allow = [] } = {}) {
    let res = await this.request(token.value, path, { method, body });
    if (res.status === 401) {
      token.value = await this.token(true);
      res = await this.request(token.value, path, { method, body });
    }
    if (write) this.sql.exec("INSERT INTO writes (at) VALUES (?)", this.now());
    const wait = rateWait(res, this.now());
    if (wait != null) throw new RateLimited(wait);
    if (!res.ok && !allow.includes(res.status)) throw failure(res);
    return res;
  }

  async tellPermissions(path, body) {
    try {
      const stub = this.permissions();
      if (!stub) return;
      const res = await stub.fetch(`https://permissions${path}`, { method: "POST", body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`${res.status}`);
    } catch (err) {
      console.error(JSON.stringify({ at: "permission-jobs", path, error: String(err) }));
    }
  }

  async run(job, change, slugs) {
    const org = this.env.GITHUB_ORG ?? "GTNewHorizons";
    const token = { value: await this.token(false) };
    const call = (path, opts) => this.call(token, path, opts);

    const cur = await currentValue(change, { org, call });
    if (change.kind === "team_create" && cur) return { status: "skipped", note: "a team with that name is already on GitHub" };
    if (change.kind !== "team_create" && cur === (change.to ?? null)) return { status: "skipped", note: "already like that on GitHub" };
    if (!startedFrom(change, cur)) return { status: "skipped", note: `changed since it was staged: GitHub shows ${show(cur)}, not ${show(change.from)}` };

    const at = new Date(this.now()).toISOString();
    await this.tellPermissions("/expect", {
      keys: expectKeys(change, { member: change.kind !== "team_member" || change.to == null }),
      by: job.by,
      until: new Date(this.now() + EXPECT_MS).toISOString(),
    });
    const result = await makeChange(change, { org, call });
    if (change.kind === "team_rename" && result.slug) slugs[change.team.id] = result.slug;
    await this.tellPermissions("/applied", { change, by: job.by, at, result });
    return result.invited ? { status: "invited", note: "GitHub sent an invite" } : { status: "done" };
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
