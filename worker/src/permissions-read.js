/**
 * Everything the Permissions page shows, read with NH-Dashbot in one pass.
 *
 * Team repo lists come back with whatever a team inherits from its parent
 * already folded in; the snapshot keeps them as GitHub reports them.
 * A collaborator edge's `permission` is their overall level, so the direct
 * grant is taken from the Repository entries in `permissionSources`, by
 * `roleName`: their `permission` field only has read, write and admin.
 */

import { graphql, nextPage, rest } from "./github.js";
import { higher, levelOf } from "../../web/js/permissions-calc.js";

const PAGE = "pageInfo { hasNextPage endCursor }";
const MEMBER_EDGES = `members(membership: IMMEDIATE, first: 100, after: $members) { ${PAGE} edges { role node { login } } }`;
const REPO_EDGES = `repositories(first: 100, after: $repos) { ${PAGE} edges { permission node { databaseId } } }`;
const COLLABORATORS = `collaborators(affiliation: DIRECT, first: 100, after: $collaborators) { ${PAGE} edges { permission permissionSources { roleName permission source { __typename } } node { login } } }`;

const MEMBERS = `query($org: String!, $after: String) {
  organization(login: $org) { membersWithRole(first: 100, after: $after) { ${PAGE} edges { role node { login } } } }
}`;

const TEAMS = `query($org: String!, $after: String, $members: String, $repos: String) {
  organization(login: $org) { teams(first: 25, after: $after) { ${PAGE}
    nodes { databaseId slug name privacy parentTeam { databaseId } ${MEMBER_EDGES} ${REPO_EDGES} } } }
}`;

const TEAM_MORE = `query($org: String!, $slug: String!, $members: String, $repos: String, $withMembers: Boolean!, $withRepos: Boolean!) {
  organization(login: $org) { team(slug: $slug) {
    members(membership: IMMEDIATE, first: 100, after: $members) @include(if: $withMembers) { ${PAGE} edges { role node { login } } }
    repositories(first: 100, after: $repos) @include(if: $withRepos) { ${PAGE} edges { permission node { databaseId } } }
  } }
}`;

const REPOS = `query($org: String!, $after: String, $collaborators: String) {
  organization(login: $org) { repositories(first: 100, after: $after) { ${PAGE}
    nodes { databaseId name visibility isArchived ${COLLABORATORS} } } }
}`;

const REPO_MORE = `query($org: String!, $name: String!, $collaborators: String) {
  repository(owner: $org, name: $name) { ${COLLABORATORS} }
}`;

export async function getAll(path, token, { request = rest, maxPages = 50 } = {}) {
  const out = [];
  let url = path;
  for (let page = 0; url; page++) {
    if (page >= maxPages) throw new Error(`more than ${maxPages} pages of ${path}`);
    const res = await request(url, token);
    out.push(...(await res.json()));
    url = nextPage(res.headers.get("link"));
  }
  return out;
}

async function pages(fetchPage, take, maxPages) {
  let after = null;
  for (let page = 0; page < maxPages; page++) {
    const conn = await fetchPage(after);
    take(conn);
    if (!conn.pageInfo.hasNextPage) return;
    after = conn.pageInfo.endCursor;
  }
  throw new Error(`more than ${maxPages} pages`);
}

export function directLevel(edge) {
  const own = (edge.permissionSources ?? []).filter((s) => s.source?.__typename === "Repository");
  const levels = own.map((s) => levelOf(s.roleName) ?? levelOf(s.permission)).filter(Boolean);
  if (levels.length) return levels.reduce(higher);
  return levelOf(edge.permission);
}

const teamRole = (role) => (role === "MAINTAINER" ? "maintainer" : "member");

function takeMembers(team, conn) {
  for (const e of conn.edges) team.members[e.node.login] = teamRole(e.role);
}

function takeRepos(team, conn) {
  for (const e of conn.edges) team.repos[e.node.databaseId] = levelOf(e.permission);
}

function takeCollaborators(repo, conn) {
  for (const e of conn.edges) repo.collaborators[e.node.login] = directLevel(e);
}

export async function fetchPermissions(token, org, { query = graphql, request = rest, maxPages = 20 } = {}) {
  const q = (text, vars) => query(token, text, { org, ...vars });

  const members = {};
  await pages(
    async (after) => (await q(MEMBERS, { after })).organization.membersWithRole,
    (conn) => { for (const e of conn.edges) members[e.node.login] = e.role === "ADMIN" ? "owner" : "member"; },
    maxPages,
  );

  const teams = {};
  const unfinished = [];
  await pages(
    async (after) => (await q(TEAMS, { after })).organization.teams,
    (conn) => {
      for (const n of conn.nodes) {
        const team = { id: n.databaseId, slug: n.slug, name: n.name, privacy: String(n.privacy ?? "").toLowerCase() || null,
          parent: n.parentTeam?.databaseId ?? null, members: {}, repos: {} };
        takeMembers(team, n.members);
        takeRepos(team, n.repositories);
        teams[team.id] = team;
        if (n.members.pageInfo.hasNextPage || n.repositories.pageInfo.hasNextPage)
          unfinished.push({ team, members: n.members.pageInfo, repos: n.repositories.pageInfo });
      }
    },
    maxPages,
  );
  for (const { team, members: m, repos: r } of unfinished) {
    let cursors = { members: m.hasNextPage ? m.endCursor : null, repos: r.hasNextPage ? r.endCursor : null };
    for (let page = 0; cursors.members || cursors.repos; page++) {
      if (page >= maxPages) throw new Error(`more than ${maxPages} pages of team ${team.slug}`);
      const got = (await q(TEAM_MORE, {
        slug: team.slug, members: cursors.members, repos: cursors.repos,
        withMembers: Boolean(cursors.members), withRepos: Boolean(cursors.repos),
      })).organization.team;
      if (!got) throw new Error(`team ${team.slug} vanished mid-read`);
      const next = { members: null, repos: null };
      if (cursors.members) {
        takeMembers(team, got.members);
        if (got.members.pageInfo.hasNextPage) next.members = got.members.pageInfo.endCursor;
      }
      if (cursors.repos) {
        takeRepos(team, got.repositories);
        if (got.repositories.pageInfo.hasNextPage) next.repos = got.repositories.pageInfo.endCursor;
      }
      cursors = next;
    }
  }

  const repos = {};
  const crowded = [];
  await pages(
    async (after) => (await q(REPOS, { after })).organization.repositories,
    (conn) => {
      for (const n of conn.nodes) {
        const repo = { id: n.databaseId, name: n.name, visibility: String(n.visibility).toLowerCase(), archived: Boolean(n.isArchived), collaborators: {} };
        takeCollaborators(repo, n.collaborators);
        repos[repo.id] = repo;
        if (n.collaborators.pageInfo.hasNextPage) crowded.push({ repo, after: n.collaborators.pageInfo.endCursor });
      }
    },
    maxPages,
  );
  for (const { repo, after } of crowded) {
    let cursor = after;
    await pages(
      async () => (await q(REPO_MORE, { name: repo.name, collaborators: cursor })).repository.collaborators,
      (conn) => { takeCollaborators(repo, conn); cursor = conn.pageInfo.endCursor; },
      maxPages,
    );
  }

  const info = await (await request(`/orgs/${org}`, token)).json();
  const invitations = await getAll(`/orgs/${org}/invitations?per_page=100`, token, { request });
  const { roles, rolesError } = await fetchRoles(token, org, { request });

  return {
    org: {
      login: org,
      base: info.default_repository_permission ?? null,
      members,
      roles,
      rolesError,
      invites: invitations.map((i) => ({
        login: i.login ?? null,
        email: i.email ?? null,
        role: i.role ?? null,
        at: i.created_at ?? null,
        by: i.inviter?.login ?? null,
      })),
    },
    teams,
    repos,
  };
}

const ROLE_LEVEL = /^all[\s_-]*repo(?:sitory)?[\s_-]*(read|triage|write|maintain|admin)$/i;

export const roleLevel = (role) => levelOf(role.base_role) ?? levelOf(String(role.name ?? "").match(ROLE_LEVEL)?.[1]);

export const roleLabel = (name) => {
  const m = String(name ?? "").match(ROLE_LEVEL);
  return m ? `All-repository ${m[1].toLowerCase()}` : String(name ?? "");
};

// Listing roles needs "Custom organization roles: Read" on the App. Without it the
// snapshot still stores, just without roles, and the page says why.
export async function fetchRoles(token, org, { request = rest } = {}) {
  let list;
  try {
    list = (await (await request(`/orgs/${org}/organization-roles`, token)).json()).roles ?? [];
  } catch (err) {
    return { roles: null, rolesError: /-> 40[34]/.test(String(err)) ? "no access" : String(err).slice(0, 200) };
  }
  const roles = {};
  for (const r of list) {
    const teams = await getAll(`/orgs/${org}/organization-roles/${r.id}/teams?per_page=100`, token, { request });
    const users = await getAll(`/orgs/${org}/organization-roles/${r.id}/users?per_page=100`, token, { request });
    if (!teams.length && !users.length) continue;
    roles[r.id] = {
      id: r.id,
      name: r.name,
      label: roleLabel(r.name),
      level: roleLevel(r),
      teams: teams.map((t) => t.id),
      users: Object.fromEntries(users.map((u) => [u.login, {
        direct: u.assignment ? u.assignment !== "indirect" : !(u.inherited_from ?? []).length,
        via: (u.inherited_from ?? []).map((t) => t.id).filter((id) => id != null),
      }])),
    };
  }
  return { roles, rolesError: null };
}

export async function fetchRepoInvites(token, org, due, { request = rest } = {}) {
  const results = {};
  const failed = [];
  for (const { id, name } of due) {
    try {
      const list = await getAll(`/repos/${org}/${encodeURIComponent(name)}/invitations?per_page=100`, token, { request });
      results[id] = list.map((i) => ({
        login: i.invitee?.login ?? null,
        level: levelOf(i.permissions),
        at: i.created_at ?? null,
        by: i.inviter?.login ?? null,
        expired: Boolean(i.expired),
      }));
    } catch (err) {
      failed.push({ name, error: String(err).slice(0, 200) });
    }
  }
  return { results, failed };
}
