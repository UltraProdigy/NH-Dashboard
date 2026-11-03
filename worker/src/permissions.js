/**
 * The permissions snapshot, in its own Durable Object for the reason the event
 * log has one: nothing here may stamp a D1 table or spend the rows-read budget.
 *
 * Stored one row per org, team and repo, so a tick only rewrites what moved.
 */

import { matchesAny } from "../../src/shared/repo-rules.js";
import { KEEP_PER_BOX } from "../../web/js/log-boxes.js";
import { directTeamRepos, levelOf, rank } from "../../web/js/permissions-calc.js";
import { excludeRules, LOG_NAME, summarise } from "./event-log.js";
import { appReady, installationToken } from "./github.js";
import { fetchPermissions, fetchRepoInvites } from "./permissions-read.js";

export const PERMISSIONS_NAME = "permissions";

const TICKS_PER_DAY = 144;

const teamKey = (id) => `team:${id}`;
const repoKey = (id) => `repo:${id}`;

export const permissionsStub = (env) => env.PERMISSIONS.get(env.PERMISSIONS.idFromName(PERMISSIONS_NAME));

const VIA = "10-min check";

const lineMaker = ({ at, org }) => {
  let n = 0;
  return (fields) => ({
    id: `perm-${at}-${n++}`,
    at,
    box: "org",
    event: "permissions",
    action: fields.action,
    repo: fields.repo ?? null,
    team: fields.team ?? null,
    login: fields.login ?? null,
    actor: null,
    via: VIA,
    text: fields.text,
    url: fields.url ?? `https://github.com/orgs/${org}/people`,
    tone: fields.tone ?? null,
  });
};

const known = (a, b) => a != null && b != null;

export function diffPermissions(before, after, { at, org }) {
  const line = lineMaker({ at, org });
  const out = [];
  const teamUrl = (t) => `https://github.com/orgs/${org}/teams/${encodeURIComponent(t.slug)}`;
  const repoUrl = (r) => `https://github.com/${org}/${encodeURIComponent(r.name)}/settings/access`;
  const repoName = (id) => after.repos?.[id]?.name ?? before.repos?.[id]?.name ?? `repo ${id}`;

  if (before.org && after.org) {
    if (before.org.base !== after.org.base && known(before.org.base, after.org.base)) {
      out.push(line({ action: "base_permission", tone: "warn", url: `https://github.com/orgs/${org}/settings/member_privileges`,
        text: `changed the base permission: ${before.org.base} → ${after.org.base}` }));
    }
    const was = before.org.members ?? {};
    const now = after.org.members ?? {};
    for (const [login, role] of Object.entries(now)) {
      if (!(login in was)) out.push(line({ action: "member_added", login, text: `${login} joined the org${role === "owner" ? " as an owner" : ""}` }));
      else if (known(was[login], role) && was[login] !== role) {
        out.push(line({ action: role === "owner" ? "owner_added" : "owner_removed", login, tone: "warn",
          text: role === "owner" ? `made ${login} an owner` : `made ${login} a member instead of an owner` }));
      }
    }
    for (const login of Object.keys(was)) {
      if (!(login in now)) out.push(line({ action: "member_removed", login, tone: "warn", text: `${login} left the org` }));
    }
  }

  const directBefore = directTeamRepos(before.teams);
  const directAfter = directTeamRepos(after.teams);
  for (const [id, team] of Object.entries(after.teams ?? {})) {
    const old = before.teams?.[id];
    const url = teamUrl(team);
    const t = team.slug;
    if (!old) {
      out.push(line({ action: "team_created", team: t, url, text: `created team ${team.name}` }));
      continue;
    }
    if (old.name !== team.name) out.push(line({ action: "team_renamed", team: t, url, text: `renamed team ${old.name} to ${team.name}` }));
    if ((old.parent ?? null) !== (team.parent ?? null)) {
      const parent = team.parent != null ? after.teams[team.parent] : null;
      out.push(line({ action: "team_parent", team: t, url,
        text: parent ? `moved team ${team.name} under ${parent.name}` : `moved team ${team.name} to the top level` }));
    }
    const was = old.members ?? {};
    const now = team.members ?? {};
    for (const [login, role] of Object.entries(now)) {
      if (!(login in was)) out.push(line({ action: "team_member_added", team: t, login, url, text: `added ${login} to team ${team.name}` }));
      else if (known(was[login], role) && was[login] !== role) {
        out.push(line({ action: "team_role", team: t, login, url,
          text: role === "maintainer" ? `made ${login} a maintainer of team ${team.name}` : `made ${login} a member of team ${team.name} instead of a maintainer` }));
      }
    }
    for (const login of Object.keys(was)) {
      if (!(login in now)) out.push(line({ action: "team_member_removed", team: t, login, url, tone: "warn", text: `removed ${login} from team ${team.name}` }));
    }
    const gave = directBefore[id] ?? {};
    const has = directAfter[id] ?? {};
    for (const [repo, level] of Object.entries(has)) {
      if (!(repo in gave)) out.push(line({ action: "team_repo_added", team: t, repo: repoName(repo), url, text: `gave team ${team.name} ${level ?? "access"}` }));
      else if (known(gave[repo], level) && gave[repo] !== level) {
        out.push(line({ action: "team_repo_changed", team: t, repo: repoName(repo), url, tone: rank(level) > rank(gave[repo]) ? "warn" : null,
          text: `changed team ${team.name}: ${gave[repo]} → ${level}` }));
      }
    }
    for (const repo of Object.keys(gave)) {
      if (!(repo in has)) out.push(line({ action: "team_repo_removed", team: t, repo: repoName(repo), url, tone: "warn", text: `removed team ${team.name}` }));
    }
  }
  for (const [id, team] of Object.entries(before.teams ?? {})) {
    if (!after.teams?.[id]) out.push(line({ action: "team_deleted", team: team.slug, url: `https://github.com/orgs/${org}/teams`, tone: "warn", text: `deleted team ${team.name}` }));
  }

  for (const [id, repo] of Object.entries(after.repos ?? {})) {
    const old = before.repos?.[id];
    if (!old) continue;
    const url = repoUrl(repo);
    if (old.visibility !== repo.visibility && known(old.visibility, repo.visibility)) {
      out.push(line({ action: "visibility", repo: repo.name, url, tone: repo.visibility === "public" ? "warn" : null, text: `made the repository ${repo.visibility}` }));
    }
    if (old.archived !== repo.archived) {
      out.push(line({ action: repo.archived ? "archived" : "unarchived", repo: repo.name, url, tone: "muted", text: repo.archived ? "archived the repository" : "unarchived the repository" }));
    }
    const was = old.collaborators ?? {};
    const now = repo.collaborators ?? {};
    for (const [login, level] of Object.entries(now)) {
      if (!(login in was)) out.push(line({ action: "collaborator_added", repo: repo.name, login, url, tone: "warn", text: `added collaborator ${login}${level ? ` (${level})` : ""}` }));
      else if (known(was[login], level) && was[login] !== level) {
        out.push(line({ action: "collaborator_changed", repo: repo.name, login, url, tone: rank(level) > rank(was[login]) ? "warn" : null,
          text: `changed collaborator ${login}: ${was[login]} → ${level}` }));
      }
    }
    for (const login of Object.keys(was)) {
      if (!(login in now)) out.push(line({ action: "collaborator_removed", repo: repo.name, login, url, tone: "warn", text: `removed collaborator ${login}` }));
    }
  }
  return out;
}

const PATCHED_LINES = {
  member: null,
  membership: null,
  team: null,
  team_add: null,
  organization: new Set(["member_added", "member_removed", "member_invited"]),
  repository: new Set(["publicized", "privatized", "archived", "unarchived"]),
};

export const PERMISSION_EVENTS = new Set(Object.keys(PATCHED_LINES));

export const logsPermissionLine = (event, action) =>
  PERMISSION_EVENTS.has(event) && (PATCHED_LINES[event] === null || PATCHED_LINES[event].has(action));

function trimRepo(r) {
  if (!r) return null;
  return { id: r.id, name: r.name, html_url: r.html_url, private: r.private, visibility: r.visibility, archived: r.archived, permissions: r.permissions, owner: r.owner ? { login: r.owner.login } : null };
}

function trimTeam(t) {
  if (!t) return null;
  return { id: t.id, slug: t.slug, name: t.name, privacy: t.privacy, html_url: t.html_url, parent: t.parent ? { id: t.parent.id } : null };
}

const who = (u) => (u ? { login: u.login } : null);

export function trimPayload(p) {
  return {
    action: p.action ?? null,
    changes: p.changes ?? null,
    repository: trimRepo(p.repository),
    team: trimTeam(p.team),
    member: who(p.member),
    sender: who(p.sender),
    organization: p.organization ? { login: p.organization.login } : null,
    membership: p.membership ? { role: p.membership.role, user: who(p.membership.user) } : null,
    invitation: p.invitation ? { login: p.invitation.login ?? null, email: p.invitation.email ?? null, role: p.invitation.role ?? null,
      created_at: p.invitation.created_at ?? null, inviter: who(p.invitation.inviter) } : null,
  };
}

const collaboratorLevel = (changes) =>
  levelOf(changes?.permission?.to) ?? levelOf(changes?.role_name?.to) ?? null;

export function applyDelivery(snap, event, p) {
  const touched = new Set();
  const org = snap.org;
  const team = p.team?.id != null ? snap.teams[p.team.id] : null;
  const repo = p.repository?.id != null ? snap.repos[p.repository.id] : null;
  const touchTeam = (t) => touched.add(`team:${t.id}`);
  const touchRepo = (r) => touched.add(`repo:${r.id}`);

  if (event === "organization" && org) {
    const login = p.membership?.user?.login ?? null;
    if (p.action === "member_added" && login) {
      org.members[login] = p.membership.role === "admin" ? "owner" : "member";
      org.invites = (org.invites ?? []).filter((i) => i.login !== login);
      touched.add("org");
    } else if (p.action === "member_removed" && login) {
      delete org.members[login];
      touched.add("org");
      for (const t of Object.values(snap.teams)) if (login in t.members) { delete t.members[login]; touchTeam(t); }
    } else if (p.action === "member_invited" && p.invitation) {
      const i = p.invitation;
      const same = (x) => (i.login && x.login === i.login) || (i.email && x.email === i.email);
      if (!(org.invites ?? []).some(same)) {
        org.invites = [...(org.invites ?? []), { login: i.login, email: i.email, role: i.role, at: i.created_at, by: i.inviter?.login ?? null }];
        touched.add("org");
      }
    }
  } else if (event === "membership" && team && p.member?.login) {
    const login = p.member.login;
    if (p.action === "added" && !(login in team.members)) { team.members[login] = null; touchTeam(team); }
    if (p.action === "removed" && login in team.members) { delete team.members[login]; touchTeam(team); }
  } else if (event === "team" || event === "team_add") {
    const a = event === "team_add" ? "added_to_repository" : p.action;
    if (a === "created" && p.team && !team) {
      snap.teams[p.team.id] = { id: p.team.id, slug: p.team.slug, name: p.team.name, privacy: p.team.privacy ?? null,
        parent: p.team.parent?.id ?? null, members: {}, repos: {} };
      touched.add(`team:${p.team.id}`);
    } else if (a === "deleted" && team) {
      delete snap.teams[team.id];
      touchTeam(team);
    } else if (team) {
      if (a === "edited") {
        Object.assign(team, { slug: p.team.slug ?? team.slug, name: p.team.name ?? team.name, privacy: p.team.privacy ?? team.privacy, parent: p.team.parent?.id ?? null });
        touchTeam(team);
      }
      const repoId = p.repository?.id;
      if (repoId != null && (a === "added_to_repository" || (a === "edited" && p.changes?.repository))) {
        team.repos[repoId] = levelOf(p.repository.permissions) ?? null;
        touchTeam(team);
      } else if (repoId != null && a === "removed_from_repository") {
        delete team.repos[repoId];
        touchTeam(team);
      }
    }
  } else if (event === "member" && repo && p.member?.login) {
    const login = p.member.login;
    if (p.action === "added" || p.action === "edited") repo.collaborators[login] = collaboratorLevel(p.changes);
    else if (p.action === "removed") delete repo.collaborators[login];
    touchRepo(repo);
  } else if (event === "repository" && p.repository) {
    const r = p.repository;
    if (p.action === "created" && !repo) {
      snap.repos[r.id] = { id: r.id, name: r.name, visibility: r.visibility ?? (r.private ? "private" : "public"), archived: Boolean(r.archived), collaborators: {} };
      touched.add(`repo:${r.id}`);
    } else if (repo) {
      if (p.action === "deleted" || (p.action === "transferred" && r.owner?.login && r.owner.login !== org?.login)) delete snap.repos[repo.id];
      else if (p.action === "publicized") repo.visibility = "public";
      else if (p.action === "privatized") repo.visibility = r.visibility && r.visibility !== "public" ? r.visibility : "private";
      else if (p.action === "archived") repo.archived = true;
      else if (p.action === "unarchived") repo.archived = false;
      else if (p.action === "renamed") repo.name = r.name;
      else return touched;
      touchRepo(repo);
    }
  }
  return touched;
}

export function snapshotRows(snapshot) {
  const rows = new Map([["org", snapshot.org]]);
  for (const team of Object.values(snapshot.teams ?? {})) rows.set(teamKey(team.id), team);
  for (const repo of Object.values(snapshot.repos ?? {})) rows.set(repoKey(repo.id), repo);
  return rows;
}

export function rowsSnapshot(rows) {
  const out = { org: null, teams: {}, repos: {} };
  for (const [key, value] of rows) {
    if (key === "org") out.org = value;
    else if (key.startsWith("team:")) out.teams[value.id] = value;
    else if (key.startsWith("repo:")) out.repos[value.id] = value;
  }
  return out;
}

export function completeSnapshot(snapshot) {
  if (!snapshot?.org || typeof snapshot.org.members !== "object") return "no org";
  if (!Object.keys(snapshot.org.members).length) return "no members";
  if (!Object.keys(snapshot.repos ?? {}).length) return "no repos";
  if (typeof snapshot.teams !== "object") return "no teams";
  return null;
}

export async function checkPermissions(env, { token, query, request, now = new Date() } = {}) {
  if (!env?.PERMISSIONS) return { skipped: "PERMISSIONS not bound" };
  if (!token && !appReady(env)) return { skipped: "GH_APP_ID or GH_APP_PRIVATE_KEY not set" };
  const org = env.GITHUB_ORG ?? "GTNewHorizons";
  const t = token ?? (await installationToken(env));
  const startedAt = now.toISOString();
  const snapshot = await fetchPermissions(t, org, { ...(query && { query }), ...(request && { request }) });
  const stub = permissionsStub(env);
  const res = await stub.fetch("https://permissions/snapshot", {
    method: "POST",
    body: JSON.stringify({ at: startedAt, startedAt, snapshot }),
  });
  if (!res.ok) throw new Error(`permissions ${res.status} ${await res.text().catch(() => "")}`);
  const stored = await res.json();
  const { results, failed } = await fetchRepoInvites(t, org, stored.invitesDue ?? [], request ? { request } : {});
  if (Object.keys(results).length) {
    const saved = await stub.fetch("https://permissions/invites", {
      method: "POST",
      body: JSON.stringify({ at: startedAt, results }),
    });
    if (!saved.ok) throw new Error(`permissions invites ${saved.status}`);
  }
  const rules = excludeRules(env);
  const shown = (stored.entries ?? []).filter((e) => !(e.repo && rules.length && matchesAny(rules, e.repo)));
  if (shown.length && env.EVENT_LOG) {
    const log = await env.EVENT_LOG.get(env.EVENT_LOG.idFromName(LOG_NAME)).fetch("https://event-log/record", {
      method: "POST",
      body: JSON.stringify(shown),
    });
    if (!log.ok) throw new Error(`event log ${log.status}`);
  }
  const { invitesDue, entries, ...rest } = stored;
  return { ...rest, logged: entries?.length ?? 0, invitesChecked: Object.keys(results).length, invitesFailed: failed };
}

export async function recordPermissionDelivery(env, event, payload, delivery, at = new Date().toISOString()) {
  if (!env?.PERMISSIONS || !PERMISSION_EVENTS.has(event) || !payload) return null;
  const res = await permissionsStub(env).fetch("https://permissions/delivery", {
    method: "POST",
    body: JSON.stringify({ event, payload: trimPayload(payload), delivery, at }),
  });
  if (!res.ok) throw new Error(`permissions ${res.status}`);
  return res.json();
}

export class Permissions {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS entities (key TEXT PRIMARY KEY, json TEXT NOT NULL, patched_at TEXT)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS repo_invites (repo INTEGER PRIMARY KEY, json TEXT NOT NULL, checked_at TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, entry TEXT NOT NULL)");
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/snapshot" && request.method === "POST") {
      const body = await request.json();
      const problem = completeSnapshot(body.snapshot);
      if (problem) return Response.json({ error: `incomplete snapshot: ${problem}` }, { status: 400 });
      return Response.json(this.store(body.snapshot, body));
    }
    if (url.pathname === "/invites" && request.method === "POST") {
      const { at, results } = await request.json();
      this.storeInvites(results ?? {}, at);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/delivery" && request.method === "POST") {
      return Response.json(this.delivery(await request.json()));
    }
    if (url.pathname === "/snapshot" && request.method === "GET") {
      return Response.json(this.read());
    }
    return new Response("not found", { status: 404 });
  }

  rows() {
    return new Map(
      this.sql.exec("SELECT key, json, patched_at FROM entities").toArray()
        .map((row) => [row.key, { value: JSON.parse(row.json), json: row.json, patchedAt: row.patched_at }]),
    );
  }

  meta(key) {
    return this.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0]?.value ?? null;
  }

  setMeta(key, value) {
    this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
  }

  store(snapshot, { at, startedAt = at }) {
    const previous = this.rows();
    const baseline = previous.size === 0;
    const patchedSince = (row) => Boolean(row?.patchedAt && row.patchedAt > startedAt);
    const next = new Map();
    for (const [key, value] of snapshotRows(snapshot)) {
      next.set(key, patchedSince(previous.get(key)) ? previous.get(key).value : value);
    }
    for (const [key, row] of previous) if (!next.has(key) && patchedSince(row)) next.set(key, row.value);

    let changed = 0;
    for (const [key, value] of next) {
      const json = JSON.stringify(value);
      if (previous.get(key)?.json === json) continue;
      changed++;
      this.sql.exec(
        "INSERT INTO entities (key, json, patched_at) VALUES (?, ?, NULL) ON CONFLICT (key) DO UPDATE SET json = excluded.json, patched_at = NULL",
        key, json,
      );
    }
    for (const key of previous.keys()) {
      if (next.has(key)) continue;
      changed++;
      this.sql.exec("DELETE FROM entities WHERE key = ?", key);
    }
    this.setMeta("read_at", at);

    const before = rowsSnapshot([...previous].map(([key, row]) => [key, row.value]));
    const entries = baseline ? [] : diffPermissions(before, rowsSnapshot(next), { at, org: snapshot.org.login });
    for (const entry of entries) this.record(entry);
    return {
      baseline,
      changed: baseline ? 0 : changed,
      members: Object.keys(snapshot.org.members).length,
      teams: Object.keys(snapshot.teams).length,
      repos: Object.keys(snapshot.repos).length,
      entries,
      invitesDue: this.invitesDue(snapshot.repos),
    };
  }

  delivery({ event, payload, delivery, at }) {
    const rows = this.rows();
    const snap = rowsSnapshot([...rows].map(([key, row]) => [key, row.value]));
    const touched = rows.size ? applyDelivery(snap, event, payload) : new Set();
    const current = snapshotRows({ org: snap.org ?? {}, teams: snap.teams, repos: snap.repos });
    for (const key of touched) {
      if (current.has(key)) {
        this.sql.exec(
          "INSERT INTO entities (key, json, patched_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET json = excluded.json, patched_at = excluded.patched_at",
          key, JSON.stringify(current.get(key)), at,
        );
      } else {
        this.sql.exec("DELETE FROM entities WHERE key = ?", key);
      }
    }
    let entry = null;
    if (logsPermissionLine(event, payload.action)) {
      entry = summarise(event, payload, { delivery, at });
      if (entry) {
        entry.login = payload.member?.login ?? payload.membership?.user?.login ?? payload.invitation?.login ?? null;
        entry.team = payload.team?.slug ?? null;
        this.record(entry);
      }
    }
    return { patched: [...touched], logged: Boolean(entry) };
  }

  record(entry) {
    this.sql.exec("INSERT OR IGNORE INTO changes (id, entry) VALUES (?, ?)", String(entry.id), JSON.stringify(entry));
    this.sql.exec(
      "DELETE FROM changes WHERE seq <= (SELECT seq FROM changes ORDER BY seq DESC LIMIT 1 OFFSET ?)",
      KEEP_PER_BOX,
    );
  }

  changes() {
    return this.sql.exec("SELECT entry FROM changes ORDER BY seq DESC").toArray().map((row) => JSON.parse(row.entry));
  }

  invitesDue(repos) {
    const ids = new Set(Object.keys(repos).map(Number));
    for (const { repo } of this.sql.exec("SELECT repo FROM repo_invites").toArray()) {
      if (!ids.has(repo)) this.sql.exec("DELETE FROM repo_invites WHERE repo = ?", repo);
    }
    const checked = new Map(this.sql.exec("SELECT repo, checked_at FROM repo_invites").toArray().map((r) => [r.repo, r.checked_at]));
    const slice = Math.max(1, Math.ceil(ids.size / TICKS_PER_DAY));
    return Object.values(repos)
      .sort((a, b) => String(checked.get(a.id) ?? "").localeCompare(String(checked.get(b.id) ?? "")) || a.id - b.id)
      .slice(0, slice)
      .map(({ id, name }) => ({ id, name }));
  }

  storeInvites(results, at) {
    for (const [repo, list] of Object.entries(results)) {
      this.sql.exec(
        "INSERT INTO repo_invites (repo, json, checked_at) VALUES (?, ?, ?) ON CONFLICT (repo) DO UPDATE SET json = excluded.json, checked_at = excluded.checked_at",
        Number(repo), JSON.stringify(list), at,
      );
    }
  }

  snapshot() {
    return rowsSnapshot([...this.rows()].map(([key, row]) => [key, row.value]));
  }

  read() {
    const snapshot = this.snapshot();
    const invites = this.sql.exec("SELECT repo, json, checked_at FROM repo_invites").toArray();
    return {
      readAt: this.meta("read_at"),
      ...snapshot,
      repoInvites: Object.fromEntries(invites.map((r) => [r.repo, { checkedAt: r.checked_at, invites: JSON.parse(r.json) }])),
      changes: this.changes(),
    };
  }
}
