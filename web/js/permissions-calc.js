/**
 * Permission levels and effective access, shared by the webhook Worker, the app
 * Worker and the Permissions page so the three can't disagree about who can do
 * what. How effective access is worked out is in docs/Calculations.md.
 */

export const LEVELS = ["read", "triage", "write", "maintain", "admin"];

const RANK = new Map(LEVELS.map((level, i) => [level, i + 1]));

export const rank = (level) => RANK.get(level) ?? 0;

const REST_KEYS = [["admin", "admin"], ["maintain", "maintain"], ["push", "write"], ["triage", "triage"], ["pull", "read"]];

export function levelOf(value) {
  if (value == null) return null;
  if (typeof value === "object") {
    const hit = REST_KEYS.find(([key]) => value[key] === true);
    return hit ? hit[1] : null;
  }
  const text = String(value).toLowerCase();
  if (text === "push") return "write";
  if (text === "pull") return "read";
  return RANK.has(text) ? text : null;
}

export const higher = (a, b) => (rank(b) > rank(a) ? b : a);

export function directTeamRepos(teams) {
  const out = {};
  for (const team of Object.values(teams ?? {})) {
    const parent = team.parent != null ? teams[team.parent] : null;
    out[team.id] = {};
    for (const [repo, level] of Object.entries(team.repos ?? {})) {
      const inherited = parent && repo in (parent.repos ?? {}) && rank(parent.repos[repo]) >= rank(level);
      if (!inherited) out[team.id][repo] = level;
    }
  }
  return out;
}

export function teamAncestors(teams, id) {
  const out = [];
  const seen = new Set([String(id)]);
  let next = teams[id]?.parent;
  while (next != null && teams[next] && !seen.has(String(next))) {
    out.push(teams[next]);
    seen.add(String(next));
    next = teams[next].parent;
  }
  return out;
}

export function indexSnapshot(snap) {
  const teamsOf = new Map();
  for (const team of Object.values(snap.teams ?? {})) {
    for (const [login, role] of Object.entries(team.members ?? {})) {
      if (!teamsOf.has(login)) teamsOf.set(login, []);
      teamsOf.get(login).push({ id: team.id, role });
    }
  }
  const people = new Set([...Object.keys(snap.org?.members ?? {}), ...teamsOf.keys()]);
  for (const repo of Object.values(snap.repos ?? {})) for (const login of Object.keys(repo.collaborators ?? {})) people.add(login);
  return { teamsOf, direct: directTeamRepos(snap.teams), people: [...people].sort((a, b) => a.localeCompare(b)) };
}

export function grantedBy(snap, idx, teamId, repoId) {
  const level = snap.teams[teamId]?.repos?.[repoId];
  if (idx.direct[teamId] && repoId in idx.direct[teamId]) return snap.teams[teamId];
  for (const up of teamAncestors(snap.teams, teamId)) {
    if (repoId in (idx.direct[up.id] ?? {}) && rank(idx.direct[up.id][repoId]) >= rank(level)) return up;
  }
  return snap.teams[teamId];
}

const isMember = (snap, login) => login in (snap.org?.members ?? {});
const isOwner = (snap, login) => snap.org?.members?.[login] === "owner";
const baseLevel = (snap) => levelOf(snap.org?.base);

export function accessOn(snap, idx, login, repoId) {
  const repo = snap.repos[repoId];
  if (!repo) return null;
  const sources = [];
  if (isOwner(snap, login)) sources.push({ kind: "owner", level: "admin" });
  if (isMember(snap, login) && baseLevel(snap)) sources.push({ kind: "base", level: baseLevel(snap) });
  for (const { id } of idx.teamsOf.get(login) ?? []) {
    const team = snap.teams[id];
    if (!(repoId in (team.repos ?? {}))) continue;
    const from = grantedBy(snap, idx, id, repoId);
    sources.push({ kind: "team", team: id, level: team.repos[repoId], from: from.id !== team.id ? from.id : null });
  }
  if (login in (repo.collaborators ?? {})) sources.push({ kind: "direct", level: repo.collaborators[login] });
  if (!sources.length) return null;
  const level = sources.map((s) => s.level).filter(Boolean).reduce(higher, null);
  return { repo: repo.id, level, sources };
}

const shown = (repo, archived) => archived || !repo.archived;

function candidateRepos(snap, idx, login) {
  if (isOwner(snap, login) || (isMember(snap, login) && baseLevel(snap))) return Object.keys(snap.repos);
  const ids = new Set();
  for (const { id } of idx.teamsOf.get(login) ?? []) for (const repo of Object.keys(snap.teams[id].repos ?? {})) ids.add(repo);
  for (const repo of Object.values(snap.repos)) if (login in (repo.collaborators ?? {})) ids.add(String(repo.id));
  return [...ids];
}

const byLevelThenName = (snap) => (a, b) =>
  rank(b.level) - rank(a.level) || String(snap.repos[a.repo]?.name).localeCompare(String(snap.repos[b.repo]?.name));

export function personAccess(snap, idx, login, { archived = false } = {}) {
  return candidateRepos(snap, idx, login)
    .filter((id) => snap.repos[id] && shown(snap.repos[id], archived))
    .map((id) => accessOn(snap, idx, login, id))
    .filter(Boolean)
    .sort(byLevelThenName(snap));
}

export function repoAccess(snap, idx, repoId) {
  const repo = snap.repos[repoId];
  if (!repo) return [];
  const logins = new Set(Object.keys(repo.collaborators ?? {}));
  for (const [login, role] of Object.entries(snap.org?.members ?? {})) if (role === "owner" || baseLevel(snap)) logins.add(login);
  for (const team of Object.values(snap.teams)) if (repoId in (team.repos ?? {})) for (const login of Object.keys(team.members ?? {})) logins.add(login);
  return [...logins]
    .map((login) => ({ login, outside: !isMember(snap, login), ...accessOn(snap, idx, login, repoId) }))
    .filter((row) => row.sources)
    .sort((a, b) => rank(b.level) - rank(a.level) || a.login.localeCompare(b.login));
}

export function repoTeams(snap, idx, repoId) {
  return Object.values(snap.teams)
    .filter((team) => repoId in (team.repos ?? {}))
    .map((team) => {
      const from = grantedBy(snap, idx, team.id, repoId);
      return { team: team.id, level: team.repos[repoId], from: from.id !== team.id ? from.id : null };
    })
    .sort((a, b) => rank(b.level) - rank(a.level) || snap.teams[a.team].name.localeCompare(snap.teams[b.team].name));
}

const STRONG = new Set(["admin", "maintain"]);

export function adminRows(snap, idx, { archived = false } = {}) {
  const rows = [];
  for (const team of Object.values(snap.teams)) {
    for (const level of ["admin", "maintain"]) {
      const repos = Object.entries(team.repos ?? {})
        .filter(([id, l]) => l === level && snap.repos[id] && shown(snap.repos[id], archived))
        .map(([id]) => id);
      if (!repos.length) continue;
      const inherited = repos.filter((id) => grantedBy(snap, idx, team.id, id).id !== team.id).length;
      rows.push({ kind: "team", team: team.id, level, repos, members: Object.keys(team.members ?? {}).length, from: { inherited } });
    }
  }
  for (const login of idx.people) {
    if (isOwner(snap, login)) continue;
    const access = personAccess(snap, idx, login, { archived }).filter((a) => STRONG.has(a.level));
    for (const level of ["admin", "maintain"]) {
      const own = access.filter((a) => a.level === level && a.sources.some((s) => s.level === level && s.kind !== "team"));
      if (!own.length) continue;
      const via = new Map();
      for (const a of own) {
        for (const s of a.sources) {
          if (s.level !== level) continue;
          const key = s.kind === "team" ? `team:${s.team}` : s.kind;
          via.set(key, (via.get(key) ?? 0) + 1);
        }
      }
      rows.push({ kind: "person", login, level, repos: own.map((a) => String(a.repo)), outside: !isMember(snap, login), from: Object.fromEntries(via) });
    }
  }
  return rows.sort((a, b) => rank(b.level) - rank(a.level) || b.repos.length - a.repos.length ||
    (a.kind === b.kind ? 0 : a.kind === "team" ? -1 : 1));
}

export function directRows(snap, { archived = false } = {}) {
  const by = new Map();
  for (const repo of Object.values(snap.repos)) {
    if (!shown(repo, archived)) continue;
    for (const [login, level] of Object.entries(repo.collaborators ?? {})) {
      if (!by.has(login)) by.set(login, []);
      by.get(login).push({ repo: String(repo.id), level });
    }
  }
  return [...by].map(([login, grants]) => ({
    login,
    outside: !isMember(snap, login),
    grants: grants.sort((a, b) => rank(b.level) - rank(a.level) || snap.repos[a.repo].name.localeCompare(snap.repos[b.repo].name)),
  })).sort((a, b) => Number(b.outside) - Number(a.outside) || b.grants.length - a.grants.length || a.login.localeCompare(b.login));
}

export function teamRows(snap, { archived = false } = {}) {
  const teams = Object.values(snap.teams);
  const children = new Map();
  for (const t of teams) {
    const parent = t.parent != null && snap.teams[t.parent] ? String(t.parent) : "";
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(t);
  }
  const out = [];
  const walk = (parent, depth, seen) => {
    for (const t of (children.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name))) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      const levels = Object.fromEntries(LEVELS.map((l) => [l, 0]));
      let unknown = 0;
      for (const [id, level] of Object.entries(t.repos ?? {})) {
        if (!snap.repos[id] || !shown(snap.repos[id], archived)) continue;
        if (level in levels) levels[level]++;
        else unknown++;
      }
      const roles = Object.values(t.members ?? {});
      out.push({
        team: t.id, depth, parent: t.parent ?? null,
        members: roles.length, maintainers: roles.filter((r) => r === "maintainer").length,
        levels, unknown, repos: Object.values(levels).reduce((n, x) => n + x, 0) + unknown,
      });
      walk(String(t.id), depth + 1, seen);
    }
  };
  walk("", 0, new Set());
  return out;
}

export function problems(snap, idx, { archived = false } = {}) {
  const teams = Object.values(snap.teams);
  const repos = Object.values(snap.repos).filter((r) => shown(r, archived));
  const repoInvites = [];
  for (const [id, entry] of Object.entries(snap.repoInvites ?? {})) {
    const repo = snap.repos[id];
    if (!repo || !shown(repo, archived)) continue;
    for (const invite of entry.invites ?? []) repoInvites.push({ repo: id, ...invite });
  }
  const strongBase = rank(baseLevel(snap)) >= rank("maintain");
  const unowned = strongBase ? [] : repos.filter((repo) =>
    !teams.some((t) => STRONG.has(t.repos?.[repo.id])) &&
    !Object.values(repo.collaborators ?? {}).some((l) => STRONG.has(l)),
  ).map((r) => String(r.id));
  const checked = Object.keys(snap.repoInvites ?? {}).filter((id) => snap.repos[id]).length;
  return {
    orgInvites: snap.org?.invites ?? [],
    repoInvites,
    emptyTeams: teams.filter((t) => !Object.keys(t.members ?? {}).length).map((t) => t.id),
    teamsWithoutRepos: teams.filter((t) => !Object.keys(t.repos ?? {}).some((id) => snap.repos[id] && shown(snap.repos[id], archived))).map((t) => t.id),
    unowned,
    invitesChecked: { checked, total: Object.keys(snap.repos).length },
  };
}
