/**
 * Admin or member, from the GitHub teams Access reports for the person.
 *
 * Access only lets GTNewHorizons members in, so everyone who reaches this is at
 * least a member. Admin needs positive evidence of the org's admin team; any
 * doubt, including a failed lookup, falls back to member.
 *
 * For a GitHub login the identity carries `orgs` ([{ id, name }]) and `teams`
 * ([{ name, org_id }]), with the team's display name rather than its slug.
 * `groups` is how other identity providers report the same thing.
 */

const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 500;

const cache = new Map();

export function resetRoles() {
  cache.clear();
}

const lower = (v) => (typeof v === "string" ? v.trim().toLowerCase() : null);
const slug = (v) =>
  typeof v === "string" ? v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") : null;

const githubTeams = (identity) => {
  const orgs = new Map(
    (Array.isArray(identity?.orgs) ? identity.orgs : [])
      .filter((o) => o && typeof o.name === "string")
      .map((o) => [o.id, o.name]),
  );
  return (Array.isArray(identity?.teams) ? identity.teams : [])
    .filter((t) => t && typeof t.name === "string" && orgs.has(t.org_id))
    .map((t) => ({ org: orgs.get(t.org_id), team: t.name }));
};

export function groupNames(identity) {
  const groups = Array.isArray(identity?.groups) ? identity.groups : [];
  const teams = githubTeams(identity).map(({ org, team }) => `${org}:${team}`);
  return teams.concat(groups.flatMap((g) => {
    if (typeof g === "string") return [g];
    if (!g || typeof g !== "object") return [];
    return [g.name, g.slug, g.id, g.team, g.organization ?? g.org]
      .filter((v) => typeof v === "string");
  }));
}

export function isAdminTeam(identity, org, team) {
  const o = lower(org);
  const t = lower(team);
  if (githubTeams(identity).some((g) => lower(g.org) === o && slug(g.team) === slug(team))) return true;
  const groups = Array.isArray(identity?.groups) ? identity.groups : [];
  return groups.some((g) => {
    if (typeof g === "string") {
      const s = lower(g);
      return s === `${o}:${t}` || s === `${o}/${t}`;
    }
    if (!g || typeof g !== "object") return false;
    const name = lower(g.name);
    if (name === `${o}:${t}` || name === `${o}/${t}`) return true;
    const gOrg = lower(g.organization ?? g.org);
    const gTeam = lower(g.slug ?? g.team ?? g.name);
    return gOrg === o && gTeam === t;
  });
}

async function identityOf(request, env, ctx, fetchImpl) {
  if (typeof ctx?.access?.getIdentity === "function") return ctx.access.getIdentity();
  const token = request.headers.get("cf-access-jwt-assertion");
  const res = await fetchImpl(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/get-identity`, {
    headers: { cookie: `CF_Authorization=${token}` },
  });
  if (!res.ok) throw new Error(`get-identity ${res.status}`);
  return res.json();
}

/** Resolves to `{ role, groups }`, cached per person for a few minutes. */
export async function roleFor(request, env, ctx, identity, { fetchImpl = fetch, now = Date.now() } = {}) {
  const key = identity.sub ?? identity.email;
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.value;

  let full;
  try {
    full = await identityOf(request, env, ctx, fetchImpl);
  } catch (err) {
    console.log(JSON.stringify({ at: "roles", error: String(err) }));
    return { role: "member", groups: [] };
  }

  const org = env.GITHUB_ORG ?? "GTNewHorizons";
  const team = env.ADMIN_TEAM ?? "admin";
  const value = { role: isAdminTeam(full, org, team) ? "admin" : "member", groups: groupNames(full) };

  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { at: now, value });
  return value;
}
