/**
 * The permissions snapshot, in its own Durable Object for the reason the event
 * log has one: nothing here may stamp a D1 table or spend the rows-read budget.
 *
 * Stored one row per org, team and repo, so a tick only rewrites what moved.
 */

import { appReady, installationToken } from "./github.js";
import { fetchPermissions, fetchRepoInvites } from "./permissions-read.js";

export const PERMISSIONS_NAME = "permissions";

const TICKS_PER_DAY = 144;

const teamKey = (id) => `team:${id}`;
const repoKey = (id) => `repo:${id}`;

export const permissionsStub = (env) => env.PERMISSIONS.get(env.PERMISSIONS.idFromName(PERMISSIONS_NAME));

export function snapshotRows(snapshot) {
  const rows = new Map([["org", snapshot.org]]);
  for (const team of Object.values(snapshot.teams ?? {})) rows.set(teamKey(team.id), team);
  for (const repo of Object.values(snapshot.repos ?? {})) rows.set(repoKey(repo.id), repo);
  return rows;
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
  const { invitesDue, ...rest } = stored;
  return { ...rest, invitesChecked: Object.keys(results).length, invitesFailed: failed };
}

export class Permissions {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS entities (key TEXT PRIMARY KEY, json TEXT NOT NULL, patched_at TEXT)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS repo_invites (repo INTEGER PRIMARY KEY, json TEXT NOT NULL, checked_at TEXT NOT NULL)");
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

  store(snapshot, { at }) {
    const previous = this.rows();
    const baseline = previous.size === 0;
    const next = snapshotRows(snapshot);
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
    return {
      baseline,
      changed: baseline ? 0 : changed,
      members: Object.keys(snapshot.org.members).length,
      teams: Object.keys(snapshot.teams).length,
      repos: Object.keys(snapshot.repos).length,
      invitesDue: this.invitesDue(snapshot.repos),
    };
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
    const out = { org: null, teams: {}, repos: {} };
    for (const [key, { value }] of this.rows()) {
      if (key === "org") out.org = value;
      else if (key.startsWith("team:")) out.teams[value.id] = value;
      else if (key.startsWith("repo:")) out.repos[value.id] = value;
    }
    return out;
  }

  read() {
    const snapshot = this.snapshot();
    const invites = this.sql.exec("SELECT repo, json, checked_at FROM repo_invites").toArray();
    return {
      readAt: this.meta("read_at"),
      ...snapshot,
      repoInvites: Object.fromEntries(invites.map((r) => [r.repo, { checkedAt: r.checked_at, invites: JSON.parse(r.json) }])),
    };
  }
}
