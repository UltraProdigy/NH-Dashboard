/**
 *   node --experimental-sqlite worker/test/permissions.test.js
 */

import { DatabaseSync } from "node:sqlite";
import {
  applyDelivery, checkPermissions, completeSnapshot, diffPermissions, logsPermissionLine, PERMISSION_EVENTS,
  Permissions, PERMISSIONS_NAME, recordPermissionDelivery, trimPayload,
} from "../src/permissions.js";
import { boxOf, KEEP_PER_BOX } from "../../web/js/log-boxes.js";
import { fetchPermissions, fetchRepoInvites, getAll } from "../src/permissions-read.js";
import {
  accessOn, adminRows, directRows, directTeamRepos, higher, indexSnapshot, levelOf, personAccess, problems, rank,
  repoAccess, repoTeams, teamAncestors, teamRows,
} from "../../web/js/permissions-calc.js";

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  ok ? (pass++, console.log("  ok    " + n))
     : (fail++, console.log("  FAIL  " + n + (d ? " — " + d : "")));
};

const ORG = "GTNewHorizons";
const AT = "2026-11-02T20:00:00.000Z";
const page = (hasNextPage, endCursor = null) => ({ hasNextPage, endCursor });
const member = (login, role) => ({ role, node: { login } });
const repoEdge = (databaseId, permission) => ({ permission, node: { databaseId } });
const source = (type, roleName, permission) => ({ roleName, permission, source: { __typename: type } });
const collab = (login, permission, sources) => ({ permission, permissionSources: sources, node: { login } });

function fakeGitHub({ failOn = null } = {}) {
  const calls = [];
  const query = async (token, text, vars) => {
    calls.push({ text, vars });
    if (failOn && text.includes(failOn)) throw new Error("graphql: Something went wrong");
    if (text.includes("membersWithRole")) {
      return vars.after
        ? { organization: { membersWithRole: { pageInfo: page(false), edges: [member("carol", "MEMBER")] } } }
        : { organization: { membersWithRole: { pageInfo: page(true, "m1"), edges: [member("alice", "ADMIN"), member("bob", "MEMBER")] } } };
    }
    if (text.includes("team(slug")) {
      const team = {};
      if (vars.withMembers) team.members = { pageInfo: page(false), edges: [member("carol", "MEMBER")] };
      if (vars.withRepos) team.repositories = vars.repos === "r1"
        ? { pageInfo: page(true, "r2"), edges: [repoEdge(2, "WRITE")] }
        : { pageInfo: page(false), edges: [repoEdge(3, "READ")] };
      return { organization: { team } };
    }
    if (text.includes("teams(")) {
      return { organization: { teams: { pageInfo: page(false), nodes: [
        { databaseId: 10, slug: "developers", name: "Developers", privacy: "CLOSED", parentTeam: null,
          members: { pageInfo: page(true, "x"), edges: [member("bob", "MAINTAINER")] },
          repositories: { pageInfo: page(true, "r1"), edges: [repoEdge(1, "WRITE")] } },
        { databaseId: 11, slug: "scala-developers", name: "Scala Developers", privacy: "CLOSED", parentTeam: { databaseId: 10 },
          members: { pageInfo: page(false), edges: [member("dave", "MEMBER")] },
          repositories: { pageInfo: page(false), edges: [repoEdge(1, "WRITE"), repoEdge(2, "MAINTAIN")] } },
      ] } } };
    }
    if (text.includes("repository(owner")) {
      return { repository: { collaborators: { pageInfo: page(false), edges: [collab("frank", "READ", [source("Repository", "read", "READ")])] } } };
    }
    if (text.includes("repositories(first: 100, after: $after)")) {
      return { organization: { repositories: { pageInfo: page(false), nodes: [
        { databaseId: 1, name: "GT5-Unofficial", visibility: "PUBLIC", isArchived: false, collaborators: { pageInfo: page(false), edges: [
          collab("dave", "MAINTAIN", [source("Organization", null, "READ"), source("Repository", "maintain", "WRITE"), source("Team", "write", "WRITE")]),
          collab("erin", "ADMIN", [source("Repository", "write", "WRITE"), source("Team", "admin", "ADMIN")]),
          collab("gus", "WRITE", [source("Repository", "content-writer", "WRITE")]),
        ] } },
        { databaseId: 2, name: "Secret-Repo", visibility: "PRIVATE", isArchived: true, collaborators: { pageInfo: page(true, "c1"), edges: [
          collab("dave", "ADMIN", [source("Repository", "write", "WRITE"), source("Repository", "admin", "ADMIN")]),
        ] } },
        { databaseId: 3, name: "Lonely", visibility: "PUBLIC", isArchived: false, collaborators: { pageInfo: page(false), edges: [] } },
      ] } } };
    }
    throw new Error(`unexpected query ${text.slice(0, 60)}`);
  };
  const request = async (url) => {
    calls.push({ url });
    if (url === `/orgs/${ORG}`) return Response.json({ login: ORG, default_repository_permission: "read" });
    if (url === `/orgs/${ORG}/invitations?per_page=100`) {
      return Response.json([{ login: "newbie", email: null, role: "direct_member", created_at: AT, inviter: { login: "alice" } }],
        { headers: { link: `<https://api.github.com/orgs/${ORG}/invitations?per_page=100&page=2>; rel="next"` } });
    }
    if (url === `https://api.github.com/orgs/${ORG}/invitations?per_page=100&page=2`) {
      return Response.json([{ login: null, email: "x@example.com", role: "admin", created_at: AT, inviter: { login: "alice" } }]);
    }
    const inv = url.match(/^\/repos\/GTNewHorizons\/([^/]+)\/invitations/);
    if (inv) {
      if (inv[1] === "Broken") throw new Error("GET -> 500");
      return Response.json(inv[1] === "GT5-Unofficial"
        ? [{ invitee: { login: "pending-person" }, inviter: { login: "alice" }, permissions: "write", created_at: AT, expired: false }]
        : []);
    }
    throw new Error(`unexpected request ${url}`);
  };
  return { query, request, calls };
}

console.log("\nlevels\n");
{
  check("GraphQL, REST and role names all map to one scale",
    levelOf("MAINTAIN") === "maintain" && levelOf("push") === "write" && levelOf("pull") === "read" && levelOf("triage") === "triage" && levelOf("ADMIN") === "admin");
  check("a REST permissions object reads as its highest flag",
    levelOf({ admin: false, maintain: false, push: true, triage: true, pull: true }) === "write" && levelOf({ pull: true }) === "read");
  check("anything else is unknown", levelOf("content-writer") === null && levelOf(null) === null && levelOf({}) === null);
  check("levels are ordered read < triage < write < maintain < admin",
    rank("read") < rank("triage") && rank("triage") < rank("write") && rank("write") < rank("maintain") && rank("maintain") < rank("admin") && rank(null) === 0);
  check("higher picks the higher level", higher("write", "admin") === "admin" && higher("admin", "read") === "admin" && higher(null, "read") === "read");
}

console.log("\nthe reader\n");
{
  const gh = fakeGitHub();
  const snap = await fetchPermissions("t", ORG, { query: gh.query, request: gh.request });
  check("members are read across pages with owners marked",
    JSON.stringify(snap.org.members) === JSON.stringify({ alice: "owner", bob: "member", carol: "member" }), JSON.stringify(snap.org.members));
  check("the base permission comes from the org", snap.org.base === "read");
  check("pending org invites are read across pages",
    snap.org.invites.length === 2 && snap.org.invites[0].login === "newbie" && snap.org.invites[0].by === "alice" && snap.org.invites[1].email === "x@example.com");
  const dev = snap.teams[10];
  check("a team keeps its slug, name and parent", dev.slug === "developers" && dev.name === "Developers" && dev.parent === null && snap.teams[11].parent === 10 && dev.privacy === "closed");
  check("team members are read past the first page with their role",
    JSON.stringify(dev.members) === JSON.stringify({ bob: "maintainer", carol: "member" }), JSON.stringify(dev.members));
  check("team repos are read past the first page, keyed by repo id",
    JSON.stringify(dev.repos) === JSON.stringify({ 1: "write", 2: "write", 3: "read" }), JSON.stringify(dev.repos));
  const followUps = gh.calls.filter((c) => c.text?.includes("team(slug"));
  check("follow-up pages only ask for the connections that still had more",
    followUps.length === 2 && followUps[0].vars.withMembers && followUps[0].vars.withRepos && !followUps[1].vars.withMembers && followUps[1].vars.withRepos);
  check("a team that needed no more pages costs no extra query", !followUps.some((c) => c.vars.slug === "scala-developers"));
  const gt = snap.repos[1];
  check("a repo keeps visibility and archived", gt.visibility === "public" && gt.archived === false && snap.repos[2].visibility === "private" && snap.repos[2].archived === true);
  check("a direct grant comes from roleName, so maintain isn't read as write", gt.collaborators.dave === "maintain", gt.collaborators.dave);
  check("a direct grant is the direct one, not the overall level from a team", gt.collaborators.erin === "write", gt.collaborators.erin);
  check("a custom role falls back to its base permission", gt.collaborators.gus === "write");
  check("two direct sources give the higher", snap.repos[2].collaborators.dave === "admin");
  check("collaborators are read past the first page", snap.repos[2].collaborators.frank === "read");
  check("a repo with nobody direct has an empty list", JSON.stringify(snap.repos[3].collaborators) === "{}");

  const broken = fakeGitHub({ failOn: "repository(owner" });
  let threw = null;
  try { await fetchPermissions("t", ORG, { query: broken.query, request: broken.request }); } catch (err) { threw = err; }
  check("any failed page fails the whole read", threw && /went wrong/.test(threw.message));

  const all = await getAll(`/orgs/${ORG}/invitations?per_page=100`, "t", { request: gh.request });
  check("REST lists follow the next link", all.length === 2);

  const inv = await fetchRepoInvites("t", ORG, [{ id: 1, name: "GT5-Unofficial" }, { id: 9, name: "Broken" }, { id: 3, name: "Lonely" }], { request: gh.request });
  check("repo invites are read per repo with level and inviter",
    inv.results[1]?.[0]?.login === "pending-person" && inv.results[1][0].level === "write" && inv.results[1][0].by === "alice" && JSON.stringify(inv.results[3]) === "[]");
  check("one repo failing doesn't stop the rest, and it's reported", !(9 in inv.results) && inv.failed.length === 1 && inv.failed[0].name === "Broken");
}

function fakeObject() {
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
    getWebSockets: () => [],
  };
  return { obj: new Permissions(ctx, {}), db };
}

const post = (obj, path, body) => obj.fetch(new Request(`https://permissions${path}`, { method: "POST", body: JSON.stringify(body) }));
const baseSnapshot = () => ({
  org: { login: ORG, base: "none", members: { alice: "owner", bob: "member" }, invites: [] },
  teams: { 10: { id: 10, slug: "developers", name: "Developers", parent: null, members: { bob: "member" }, repos: { 1: "write" } } },
  repos: {
    1: { id: 1, name: "GT5-Unofficial", visibility: "public", archived: false, collaborators: {} },
    2: { id: 2, name: "Secret-Repo", visibility: "private", archived: false, collaborators: { carol: "write" } },
  },
});

console.log("\nthe Durable Object\n");
{
  const { obj, db } = fakeObject();
  const rowsWritten = () => db.prepare("SELECT COUNT(*) n FROM entities").get().n;

  check("an incomplete snapshot is refused and nothing is stored",
    (await post(obj, "/snapshot", { at: AT, snapshot: { org: { members: {} }, teams: {}, repos: {} } })).status === 400 && rowsWritten() === 0);
  check("a snapshot with no repos is refused", completeSnapshot({ org: { members: { a: "member" } }, teams: {}, repos: {} }) === "no repos");

  const first = await (await post(obj, "/snapshot", { at: AT, snapshot: baseSnapshot() })).json();
  check("the first snapshot is a baseline", first.baseline === true && first.changed === 0 && rowsWritten() === 4, JSON.stringify(first));
  check("it reports what it read", first.members === 2 && first.teams === 1 && first.repos === 2);

  const writes = [];
  const exec = obj.sql.exec.bind(obj.sql);
  obj.sql = { exec: (q, ...b) => (/^\s*(INSERT|DELETE)/i.test(q) && !/meta|repo_invites|changes/.test(q) && writes.push(q), exec(q, ...b)) };
  const quiet = await (await post(obj, "/snapshot", { at: AT, snapshot: baseSnapshot() })).json();
  check("an unchanged snapshot writes nothing", quiet.baseline === false && quiet.changed === 0 && writes.length === 0, JSON.stringify(writes));

  const moved = baseSnapshot();
  moved.repos[2].archived = true;
  delete moved.teams[10];
  const second = await (await post(obj, "/snapshot", { at: "2026-11-02T20:10:00.000Z", snapshot: moved })).json();
  check("only the rows that moved are rewritten, and a gone team is deleted", second.changed === 2 && writes.length === 2 && rowsWritten() === 3, JSON.stringify(writes));

  const read = await (await obj.fetch(new Request("https://permissions/snapshot"))).json();
  check("GET /snapshot gives the stored snapshot back with when it was read",
    read.readAt === "2026-11-02T20:10:00.000Z" && read.org.base === "none" && read.repos[2].archived === true && Object.keys(read.teams).length === 0, JSON.stringify(read).slice(0, 200));
  check("anything else is a 404", (await obj.fetch(new Request("https://permissions/nope"))).status === 404);
}

console.log("\nrepo invites, a slice a tick\n");
{
  const { obj } = fakeObject();
  const snap = baseSnapshot();
  for (let i = 100; i < 400; i++) snap.repos[i] = { id: i, name: `repo-${i}`, visibility: "public", archived: false, collaborators: {} };
  const total = Object.keys(snap.repos).length;
  const first = await (await post(obj, "/snapshot", { at: AT, snapshot: snap })).json();
  const slice = Math.ceil(total / 144);
  check(`each tick checks ${slice} of ${total} repos, so all of them inside a day`, first.invitesDue.length === slice && slice * 144 >= total, first.invitesDue.length);
  await post(obj, "/invites", { at: AT, results: Object.fromEntries(first.invitesDue.map((r) => [r.id, [{ login: "x", level: "read" }]])) });
  const second = await (await post(obj, "/snapshot", { at: AT, snapshot: snap })).json();
  check("the next tick moves on to repos not checked yet", second.invitesDue.every((r) => !first.invitesDue.some((f) => f.id === r.id)));

  let ticks = 2;
  let due = second.invitesDue;
  const seen = new Set(first.invitesDue.map((r) => r.id));
  while (seen.size < total && ticks < 200) {
    due.forEach((r) => seen.add(r.id));
    await post(obj, "/invites", { at: `2026-11-02T20:${String(ticks).padStart(2, "0")}:00.000Z`, results: Object.fromEntries(due.map((r) => [r.id, []])) });
    due = (await (await post(obj, "/snapshot", { at: AT, snapshot: snap })).json()).invitesDue;
    ticks++;
  }
  check("every repo is reached within a day of ticks", seen.size === total && ticks <= 144, `${seen.size} in ${ticks}`);
  check("then the one checked longest ago comes round again", due.some((r) => first.invitesDue.some((f) => f.id === r.id)));

  delete snap.repos[first.invitesDue[0].id];
  await post(obj, "/snapshot", { at: AT, snapshot: snap });
  const read = await (await obj.fetch(new Request("https://permissions/snapshot"))).json();
  check("a repo that's gone loses its invites", !(first.invitesDue[0].id in read.repoInvites) && Object.keys(read.repoInvites).length === total - 1);
  check("invites come back with when they were checked", read.repoInvites[first.invitesDue[1].id]?.checkedAt === AT && read.repoInvites[first.invitesDue[1].id].invites[0].login === "x");
}

console.log("\nthe cron step\n");
{
  const { obj } = fakeObject();
  const named = [];
  const env = { GITHUB_ORG: ORG, PERMISSIONS: { idFromName: (n) => (named.push(n), n), get: () => ({ fetch: (u, init) => obj.fetch(new Request(u, init)) }) } };
  const gh = fakeGitHub();
  const result = await checkPermissions(env, { token: "t", query: gh.query, request: gh.request, now: new Date(AT) });
  check("it reads, stores and goes to the one named object", result.baseline === true && result.repos === 3 && named.every((n) => n === PERMISSIONS_NAME), JSON.stringify(result));
  check("it checks that tick's slice of repo invites", result.invitesChecked === 1 && result.invitesFailed.length === 0 && !("invitesDue" in result));
  const stored = await (await obj.fetch(new Request("https://permissions/snapshot"))).json();
  check("the stored snapshot is what was read", stored.teams[10].members.bob === "maintainer" && stored.repos[1].collaborators.dave === "maintain" && stored.readAt === AT);

  const before = JSON.stringify(stored);
  const broken = fakeGitHub({ failOn: "teams(" });
  let threw = false;
  try { await checkPermissions(env, { token: "t", query: broken.query, request: broken.request }); } catch { threw = true; }
  const after = await (await obj.fetch(new Request("https://permissions/snapshot"))).json();
  check("a read that fails partway stores nothing", threw && JSON.stringify(after) === before);

  check("without the binding it does nothing", (await checkPermissions({}, { token: "t" })).skipped !== undefined);
  check("without the App key it says so", /GH_APP/.test((await checkPermissions({ PERMISSIONS: env.PERMISSIONS })).skipped ?? ""));
}

const clone = (x) => JSON.parse(JSON.stringify(x));
const T1 = "2026-11-02T20:10:00.000Z";
const T2 = "2026-11-02T20:10:20.000Z";
const T3 = "2026-11-02T20:20:00.000Z";
const richSnapshot = () => ({
  org: { login: ORG, base: "none", members: { alice: "owner", bob: "member", carol: "member", dave: "member" }, invites: [] },
  teams: {
    10: { id: 10, slug: "developers", name: "Developers", parent: null, members: { bob: "member", carol: "maintainer" }, repos: { 1: "write", 2: "write" } },
    11: { id: 11, slug: "scala-developers", name: "Scala Developers", parent: 10, members: { dave: "member" }, repos: { 1: "write", 2: "admin" } },
  },
  repos: {
    1: { id: 1, name: "GT5-Unofficial", visibility: "public", archived: false, collaborators: { erin: "write" } },
    2: { id: 2, name: "Secret-Repo", visibility: "private", archived: false, collaborators: {} },
  },
});

console.log("\ndirect team grants\n");
{
  const direct = directTeamRepos(richSnapshot().teams);
  check("a team with no parent has every repo as its own", JSON.stringify(direct[10]) === JSON.stringify({ 1: "write", 2: "write" }));
  check("a child team's repo at its parent's level is inherited, not its own", !("1" in direct[11]));
  check("a child team's repo above its parent's level is its own", direct[11][2] === "admin");
}

console.log("\nthe diff\n");
{
  const opts = { at: T1, org: ORG };
  check("no change, no lines", diffPermissions(richSnapshot(), richSnapshot(), opts).length === 0);

  const b = richSnapshot(), a = richSnapshot();
  a.org.base = "read";
  a.org.members.bob = "owner";
  a.org.members.alice = "member";
  delete a.org.members.carol;
  a.org.members.zed = "member";
  const org = diffPermissions(b, a, opts);
  const texts = org.map((l) => l.text);
  check("the base permission change is logged", texts.includes("changed the base permission: none → read"), texts.join(" | "));
  check("an owner promotion and demotion are logged", texts.includes("made bob an owner") && texts.includes("made alice a member instead of an owner"));
  check("joining and leaving the org are logged", texts.includes("zed joined the org") && texts.includes("carol left the org"));
  check("lines look like the repo settings check's", org.every((l) => l.via === "10-min check" && l.actor === null && l.box === "org" && l.event === "permissions" && l.at === T1));
  check("each line has its own id", new Set(org.map((l) => l.id)).size === org.length);
  check("a line names the person it's about", org.find((l) => l.action === "owner_added").login === "bob");
  check("the 10-minute lines go in Org & people", boxOf("permissions") === "org");

  const tb = richSnapshot(), ta = richSnapshot();
  ta.teams[10].name = "Devs";
  ta.teams[10].members.bob = "maintainer";
  ta.teams[10].members.carol = null;
  ta.teams[10].members.frank = "member";
  delete ta.teams[11].members.dave;
  ta.teams[10].repos[3] = "read";
  ta.teams[10].repos[1] = "maintain";
  ta.teams[11].repos[1] = "maintain";
  delete ta.teams[10].repos[2];
  ta.teams[11].parent = null;
  ta.teams[12] = { id: 12, slug: "new", name: "New", parent: null, members: { a: "member" }, repos: { 1: "read" } };
  const team = diffPermissions(tb, ta, opts).map((l) => l.text);
  check("a rename is logged once with both names", team.filter((t) => t.startsWith("renamed team")).length === 1 && team.includes("renamed team Developers to Devs"), team.join(" | "));
  check("a role change is logged", team.includes("made bob a maintainer of team Devs"));
  check("a role nobody knows yet is not a change", !team.some((t) => t.includes("carol")));
  check("team members added and removed are logged", team.includes("added frank to team Devs") && team.includes("removed dave from team Scala Developers"));
  check("a team's own repo grants are logged", team.includes("gave team Devs read") && team.includes("changed team Devs: write → maintain") && team.includes("removed team Devs"));
  check("a child following its parent's change logs nothing of its own", !team.some((t) => t.includes("Scala Developers:")), team.join(" | "));
  check("moving a team is logged", team.includes("moved team Scala Developers to the top level"));
  check("a new team is one line, not one per member and repo", team.filter((t) => t.includes("New")).length === 1 && team.includes("created team New"));
  const removed = diffPermissions(ta, tb, opts).map((l) => l.text);
  check("a team that's gone is logged as deleted", removed.includes("deleted team New"));
  const grant = diffPermissions(tb, ta, opts).find((l) => l.action === "team_repo_added");
  check("a grant on a repo the snapshot hasn't read yet is named by its id", grant.repo === "repo 3", JSON.stringify(grant));
  check("a team grant line links to the team", grant.team === "developers" && grant.url === "https://github.com/orgs/GTNewHorizons/teams/developers");

  const rb = richSnapshot(), ra = richSnapshot();
  ra.repos[2].visibility = "public";
  ra.repos[1].archived = true;
  ra.repos[1].collaborators = { erin: "admin", gus: "read", hal: null };
  ra.repos[2].collaborators = { };
  ra.repos[5] = { id: 5, name: "Brand-New", visibility: "public", archived: false, collaborators: { x: "admin" } };
  const repo = diffPermissions(rb, ra, opts);
  const rt = repo.map((l) => `${l.repo}: ${l.text}`);
  check("visibility and archive are logged against the repo", rt.includes("Secret-Repo: made the repository public") && rt.includes("GT5-Unofficial: archived the repository"), rt.join(" | "));
  check("collaborator changes are logged", rt.includes("GT5-Unofficial: changed collaborator erin: write → admin") && rt.includes("GT5-Unofficial: added collaborator gus (read)"));
  check("a collaborator with an unknown level is still logged as added", rt.includes("GT5-Unofficial: added collaborator hal"));
  check("a new repo logs nothing", !rt.some((t) => t.startsWith("Brand-New")));
  check("repo lines link to the repo's access settings", repo.find((l) => l.repo === "Secret-Repo").url === "https://github.com/GTNewHorizons/Secret-Repo/settings/access");
  const back = diffPermissions(ra, rb, opts).map((l) => `${l.repo}: ${l.text}`);
  check("a removed collaborator is logged", back.includes("GT5-Unofficial: removed collaborator gus"));
  const unknown = richSnapshot();
  unknown.repos[1].collaborators.erin = null;
  check("a level becoming known is not a change", diffPermissions(unknown, richSnapshot(), opts).length === 0);
}

console.log("\nwebhook patches\n");
{
  const p = (event, payload) => { const s = richSnapshot(); const touched = applyDelivery(s, event, trimPayload(payload)); return { s, touched }; };

  let r = p("organization", { action: "member_added", membership: { role: "admin", user: { login: "neo" } } });
  check("a new member is added with their role", r.s.org.members.neo === "owner" && r.touched.has("org"));
  r = p("organization", { action: "member_removed", membership: { role: "member", user: { login: "carol" } } });
  check("a member who leaves is taken off the org and every team", !("carol" in r.s.org.members) && !("carol" in r.s.teams[10].members) && r.touched.has("team:10"));
  r = p("organization", { action: "member_invited", invitation: { login: "newbie", role: "direct_member", created_at: AT, inviter: { login: "alice" } } });
  check("an invite is added to pending", r.s.org.invites[0]?.login === "newbie" && r.s.org.invites[0].by === "alice");
  const s = richSnapshot();
  applyDelivery(s, "organization", trimPayload({ action: "member_invited", invitation: { login: "newbie" } }));
  applyDelivery(s, "organization", trimPayload({ action: "member_added", membership: { role: "member", user: { login: "newbie" } } }));
  check("accepting an invite clears it", s.org.invites.length === 0 && s.org.members.newbie === "member");

  r = p("membership", { action: "added", member: { login: "zed" }, team: { id: 10, slug: "developers" } });
  check("a team member added by webhook has an unknown role until the next read", "zed" in r.s.teams[10].members && r.s.teams[10].members.zed === null);
  r = p("membership", { action: "added", member: { login: "carol" }, team: { id: 10 } });
  check("re-adding someone keeps their role", r.s.teams[10].members.carol === "maintainer" && r.touched.size === 0);
  r = p("membership", { action: "removed", member: { login: "bob" }, team: { id: 10 } });
  check("a team member removed by webhook is taken off", !("bob" in r.s.teams[10].members));
  r = p("membership", { action: "added", member: { login: "bob" }, team: { id: 99 } });
  check("a team the snapshot doesn't know yet is left for the next read", r.touched.size === 0);

  r = p("team", { action: "created", team: { id: 12, slug: "fresh", name: "Fresh", privacy: "closed", parent: { id: 10 } } });
  check("a new team is created empty under its parent", r.s.teams[12]?.parent === 10 && JSON.stringify(r.s.teams[12].members) === "{}");
  r = p("team", { action: "deleted", team: { id: 11 } });
  check("a deleted team is removed", !r.s.teams[11] && r.touched.has("team:11"));
  r = p("team", { action: "edited", team: { id: 10, slug: "devs", name: "Devs", parent: null }, changes: { name: { from: "Developers" } } });
  check("a rename updates name and slug", r.s.teams[10].name === "Devs" && r.s.teams[10].slug === "devs");
  r = p("team", { action: "edited", team: { id: 10, slug: "developers", name: "Developers" }, repository: { id: 2, name: "Secret-Repo", permissions: { admin: true, push: true, pull: true } }, changes: { repository: { permissions: { from: { admin: false } } } } });
  check("a team's level on a repo changes", r.s.teams[10].repos[2] === "admin");
  r = p("team", { action: "added_to_repository", team: { id: 10 }, repository: { id: 5, permissions: { pull: true, triage: true } } });
  check("a team given a repo has its level", r.s.teams[10].repos[5] === "triage");
  r = p("team_add", { team: { id: 11 }, repository: { id: 5 } });
  check("team_add without permissions is unknown until the next read", 5 in r.s.teams[11].repos && r.s.teams[11].repos[5] === null);
  r = p("team", { action: "removed_from_repository", team: { id: 10 }, repository: { id: 1 } });
  check("a team taken off a repo loses it", !(1 in r.s.teams[10].repos));

  r = p("member", { action: "added", member: { login: "gus" }, repository: { id: 2 }, changes: { permission: { to: "write" } } });
  check("a collaborator added by webhook has their level", r.s.repos[2].collaborators.gus === "write");
  r = p("member", { action: "edited", member: { login: "erin" }, repository: { id: 1 }, changes: { role_name: { to: "maintain" } } });
  check("a collaborator's level changes", r.s.repos[1].collaborators.erin === "maintain");
  r = p("member", { action: "removed", member: { login: "erin" }, repository: { id: 1 } });
  check("a collaborator removed is taken off", !("erin" in r.s.repos[1].collaborators));

  r = p("repository", { action: "publicized", repository: { id: 2, visibility: "public" } });
  check("a repo made public", r.s.repos[2].visibility === "public");
  r = p("repository", { action: "archived", repository: { id: 1 } });
  check("a repo archived", r.s.repos[1].archived === true);
  r = p("repository", { action: "created", repository: { id: 7, name: "New-Mod", private: true } });
  check("a new repo appears with nobody direct", r.s.repos[7]?.visibility === "private" && JSON.stringify(r.s.repos[7].collaborators) === "{}");
  r = p("repository", { action: "renamed", repository: { id: 1, name: "GT6" } });
  check("a renamed repo keeps its id and takes the new name", r.s.repos[1].name === "GT6");
  r = p("repository", { action: "edited", repository: { id: 1, name: "GT5-Unofficial" } });
  check("anything else about a repo patches nothing", r.touched.size === 0);

  check("permission events are the six the plan lists plus repository", ["member", "membership", "team", "team_add", "organization", "repository"].every((e) => PERMISSION_EVENTS.has(e)) && PERMISSION_EVENTS.size === 6);
  check("only visibility and archive repository actions reach the changelog",
    logsPermissionLine("repository", "archived") && !logsPermissionLine("repository", "edited") && logsPermissionLine("team", "edited") && !logsPermissionLine("organization", "renamed"));
  const trimmed = trimPayload({ action: "added", member: { login: "x", id: 1, avatar_url: "u" }, repository: { id: 1, name: "n", description: "long", owner: { login: ORG, id: 3 } } });
  check("deliveries are trimmed to what the patch and the line use", !("avatar_url" in trimmed.member) && !("description" in trimmed.repository) && trimmed.repository.owner.login === ORG);
}

console.log("\nwebhooks and the read together\n");
{
  const { obj } = fakeObject();
  await post(obj, "/snapshot", { at: AT, snapshot: richSnapshot() });
  const membership = { action: "added", member: { login: "zed" }, team: { id: 10, slug: "developers", name: "Developers", html_url: "https://github.com/orgs/GTNewHorizons/teams/developers" }, sender: { login: "alice" } };
  const res = await (await post(obj, "/delivery", { event: "membership", payload: trimPayload(membership), delivery: "d-1", at: T2 })).json();
  check("a delivery patches the snapshot and logs its line", res.patched.includes("team:10") && res.logged);
  await post(obj, "/delivery", { event: "membership", payload: trimPayload(membership), delivery: "d-1", at: T2 });
  let changes = obj.changes();
  check("a redelivery isn't logged twice", changes.length === 1 && changes[0].id === "d-1" && changes[0].text === "added zed to team Developers" && changes[0].actor === "alice");
  check("the line names the person and the team", changes[0].login === "zed" && changes[0].team === "developers");

  const stale = await (await post(obj, "/snapshot", { at: T1, startedAt: T1, snapshot: richSnapshot() })).json();
  check("a read that started before the delivery doesn't undo it or log it as removed", stale.entries.length === 0 && obj.snapshot().teams[10].members.zed === null, JSON.stringify(stale.entries));

  const later = richSnapshot();
  later.teams[10].members.zed = "maintainer";
  const fresh = await (await post(obj, "/snapshot", { at: T3, startedAt: T3, snapshot: later })).json();
  check("the next read fills in the role without logging the change again", fresh.entries.length === 0 && obj.snapshot().teams[10].members.zed === "maintainer", JSON.stringify(fresh.entries));

  const promoted = clone(later);
  promoted.org.members.bob = "owner";
  const found = await (await post(obj, "/snapshot", { at: T3, startedAt: T3, snapshot: promoted })).json();
  changes = obj.changes();
  check("a change with no webhook is logged by the read", found.entries.length === 1 && changes[0].text === "made bob an owner" && changes[0].via === "10-min check");

  const ignored = await (await post(obj, "/delivery", { event: "repository", payload: trimPayload({ action: "edited", repository: { id: 1, name: "GT5-Unofficial" } }), delivery: "d-2", at: T3 })).json();
  check("a delivery that isn't a permission change logs nothing", !ignored.logged && obj.changes().length === 2);

  for (let i = 0; i < KEEP_PER_BOX + 5; i++) obj.record({ id: `x${i}`, text: `line ${i}` });
  const kept = obj.changes();
  check(`the changelog keeps the newest ${KEEP_PER_BOX}`, kept.length === KEEP_PER_BOX && kept[0].id === `x${KEEP_PER_BOX + 4}`);
  const read = await (await obj.fetch(new Request("https://permissions/snapshot"))).json();
  check("GET /snapshot carries the changelog, newest first", read.changes.length === KEEP_PER_BOX && read.changes[0].id === `x${KEEP_PER_BOX + 4}`);

  const empty = fakeObject().obj;
  const first = await (await post(empty, "/delivery", { event: "membership", payload: trimPayload(membership), delivery: "d-9", at: T2 })).json();
  check("before the first read a delivery is still logged, with nothing to patch", first.logged && first.patched.length === 0 && empty.rows().size === 0);
}

console.log("\nthe cron step logs what the read found\n");
{
  const { obj } = fakeObject();
  const logged = [];
  const env = {
    GITHUB_ORG: ORG,
    NH_INGEST_EXCLUDE: "Secret-*",
    PERMISSIONS: { idFromName: (n) => n, get: () => ({ fetch: (u, init) => obj.fetch(new Request(u, init)) }) },
    EVENT_LOG: { idFromName: (n) => n, get: () => ({ fetch: async (u, init) => (logged.push(...[].concat(JSON.parse(init.body))), new Response(null, { status: 204 })) }) },
  };
  const gh = fakeGitHub();
  await checkPermissions(env, { token: "t", query: gh.query, request: gh.request, now: new Date(AT) });
  check("the baseline logs nothing anywhere", logged.length === 0 && obj.changes().length === 0);
  const changed = fakeGitHub();
  const query = async (token, text, vars) => {
    const out = await changed.query(token, text, vars);
    if (text.includes("membersWithRole") && !vars.after) out.organization.membersWithRole.edges[1].role = "ADMIN";
    if (text.includes("repositories(first: 100, after: $after)")) {
      out.organization.repositories.nodes[1].collaborators.edges = [];
      out.organization.repositories.nodes[0].collaborators.edges = out.organization.repositories.nodes[0].collaborators.edges.slice(0, 2);
    }
    return out;
  };
  const r = await checkPermissions(env, { token: "t", query, request: changed.request, now: new Date(T3) });
  const kept = obj.changes().map((e) => `${e.repo ?? ""}: ${e.text}`);
  check("the read's lines go to the changelog", kept.includes(": made bob an owner") && kept.includes("Secret-Repo: removed collaborator dave") && kept.includes("GT5-Unofficial: removed collaborator gus"), kept.join(" | "));
  check("and to GitHub Logs, except for excluded repos", logged.length === kept.length - 1 && !logged.some((e) => e.repo === "Secret-Repo") && logged.some((e) => e.text === "made bob an owner"));
  check("the step reports how many lines it wrote, not the lines", r.logged === 3 && !("entries" in r), JSON.stringify(r));

  check("a delivery for another event is ignored", (await recordPermissionDelivery(env, "push", {}, "d")) === null);
  const res = await recordPermissionDelivery(env, "member", { action: "added", member: { login: "q" }, repository: { id: 3, name: "Lonely" }, changes: { permission: { to: "read" } }, sender: { login: "alice" } }, "d-7", T3);
  check("a permission delivery reaches the object", res.logged && obj.snapshot().repos[3].collaborators.q === "read");
}

console.log("\nthe webhook\n");
{
  const secret = "s3cret";
  const body = JSON.stringify({ action: "added", member: { login: "zed" }, team: { id: 10, slug: "developers", name: "Developers" }, sender: { login: "alice" } });
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))).toString("hex");
  const sent = [];
  const env = {
    GITHUB_WEBHOOK_SECRET: secret,
    DB: {},
    PERMISSIONS: { idFromName: (n) => n, get: () => ({ fetch: async (u, init) => (sent.push({ u, body: JSON.parse(init.body) }), Response.json({ logged: true })) }) },
  };
  const pending = [];
  const { default: worker } = await import("../src/index.js");
  const hit = (event, delivery) => worker.fetch(new Request("https://nh-dashboard.gtnh.workers.dev/webhook", {
    method: "POST",
    headers: { "x-hub-signature-256": `sha256=${sig}`, "x-github-event": event, "x-github-delivery": delivery },
    body,
  }), env, { waitUntil: (p) => pending.push(p) });
  const res = await hit("membership", "del-1");
  await Promise.all(pending);
  check("a team membership delivery still answers 200", res.status === 200);
  check("and reaches the permissions object", sent.length === 1 && sent[0].u.endsWith("/delivery") && sent[0].body.event === "membership" && sent[0].body.delivery === "del-1");
  await hit("star", "del-2");
  await Promise.all(pending);
  check("a delivery that isn't about access doesn't", sent.length === 1);
}

console.log("\neffective access\n");
{
  const snap = richSnapshot();
  snap.org.members.owner2 = "owner";
  snap.teams[11].repos[3] = "triage";
  snap.repos[3] = { id: 3, name: "Old-Mod", visibility: "public", archived: true, collaborators: { dave: "admin" } };
  snap.repos[1].collaborators.dave = "read";
  snap.repos[1].collaborators.outsider = "maintain";
  const idx = indexSnapshot(snap);
  const on = (login, repo) => accessOn(snap, idx, login, String(repo));

  const owner = on("alice", 2);
  check("an owner is admin everywhere, from being an owner", owner.level === "admin" && owner.sources.length === 1 && owner.sources[0].kind === "owner");
  const bob = on("bob", 1);
  check("a team member gets the team's level, sourced to the team", bob.level === "write" && bob.sources[0].kind === "team" && bob.sources[0].team === 10 && bob.sources[0].from === null);
  const dave = on("dave", 1);
  check("the highest source wins, and every source is kept", dave.level === "write" && dave.sources.map((s) => s.kind).join(",") === "team,direct", JSON.stringify(dave));
  check("access a child team gets from its parent says where it comes from", dave.sources[0].team === 11 && dave.sources[0].from === 10);
  const daveSecret = on("dave", 2);
  check("a child team's own higher grant is its own", daveSecret.level === "admin" && daveSecret.sources[0].from === null);
  check("a direct grant above the team's wins", on("dave", 3).level === "admin");
  check("someone with no source has no access", on("carol", 3) === null && on("nobody", 1) === null);
  check("an outside collaborator gets only their grant", on("outsider", 1).level === "maintain" && on("outsider", 1).sources.length === 1);

  snap.org.base = "read";
  const based = indexSnapshot(snap);
  const carol = accessOn(snap, based, "carol", "3");
  check("the base permission reaches every member on every repo", carol.level === "read" && carol.sources[0].kind === "base");
  check("but not outside collaborators", !accessOn(snap, based, "outsider", "1").sources.some((s) => s.kind === "base"));
  snap.org.base = "none";

  const list = personAccess(snap, idx, "dave");
  check("a person's repos leave archived ones out by default", list.length === 2 && list[0].level === "admin" && list[0].repo === 2, JSON.stringify(list.map((a) => [a.repo, a.level])));
  check("and include them when asked", personAccess(snap, idx, "dave", { archived: true }).length === 3);
  check("an owner reaches every repo", personAccess(snap, idx, "alice", { archived: true }).length === 3);

  const people = repoAccess(snap, idx, "1");
  check("a repo lists everyone who can reach it, highest first", people[0].level === "admin" && people.some((p) => p.login === "outsider" && p.outside) && people.some((p) => p.login === "bob"), people.map((p) => `${p.login}:${p.level}`).join(","));
  const teams = repoTeams(snap, idx, "1");
  check("a repo lists its teams, with inherited ones marked", teams.length === 2 && teams.find((t) => t.team === 11).from === 10 && teams.find((t) => t.team === 10).from === null);
  check("team ancestors are nearest first and survive a loop", teamAncestors(snap.teams, 11).map((t) => t.id).join() === "10" &&
    teamAncestors({ 1: { id: 1, parent: 2 }, 2: { id: 2, parent: 1 } }, 1).length === 1);
}

console.log("\nthe boxes\n");
{
  const snap = richSnapshot();
  snap.org.members.owner2 = "owner";
  snap.teams[10].repos[1] = "admin";
  snap.repos[1].collaborators.erin = "admin";
  snap.repos[2].collaborators.bob = "maintain";
  snap.repos[2].collaborators.outsider = "write";
  snap.repos[3] = { id: 3, name: "Old-Mod", visibility: "public", archived: true, collaborators: { erin: "admin" } };
  snap.teams[12] = { id: 12, slug: "empty", name: "Empty", parent: null, members: {}, repos: {} };
  snap.repoInvites = { 1: { checkedAt: AT, invites: [{ login: "inv", level: "write", at: AT, by: "alice" }] }, 3: { checkedAt: AT, invites: [{ login: "old" }] } };
  snap.org.invites = [{ login: "newbie" }];
  const idx = indexSnapshot(snap);

  const admins = adminRows(snap, idx);
  const who = admins.map((r) => `${r.kind === "team" ? `team:${r.team}` : r.login}:${r.level}:${r.repos.length}`);
  check("teams with admin or maintain get a row per level", who.includes("team:10:admin:1") && who.includes("team:11:admin:1"), who.join(" "));
  check("owners are left out", !admins.some((r) => r.login === "alice" || r.login === "owner2"));
  check("someone who only gets admin from a team is counted on the team's row", !admins.some((r) => r.login === "carol"));
  check("a direct admin or maintain grant gets its own row", who.includes("erin:admin:1") && who.includes("bob:maintain:1"));
  check("archived repos are left out unless asked", adminRows(snap, idx, { archived: true }).find((r) => r.login === "erin").repos.length === 2);
  check("a team row says how many members it has", admins.find((r) => r.team === 10).members === 2);
  check("rows go admin before maintain", admins.findIndex((r) => r.level === "maintain") > admins.findIndex((r) => r.level === "admin"));

  const direct = directRows(snap);
  const firstInside = direct.findIndex((r) => !r.outside);
  check("direct grants list outside collaborators first", direct.slice(0, firstInside).map((r) => r.login).join() === "erin,outsider" && !direct.find((r) => r.login === "bob").outside, direct.map((r) => `${r.login}:${r.outside}`).join());
  check("each person's grants are highest first", direct.find((r) => r.login === "erin").grants.length === 1 && directRows(snap, { archived: true }).find((r) => r.login === "erin").grants.length === 2);

  const rows = teamRows(snap);
  check("teams are listed with children under their parent", rows.map((r) => `${r.team}@${r.depth}`).join(",") === "10@0,11@1,12@0", rows.map((r) => `${r.team}@${r.depth}`).join(","));
  const dev = rows[0];
  check("a team row counts members, maintainers and repos at each level", dev.members === 2 && dev.maintainers === 1 && dev.levels.admin === 1 && dev.levels.write === 1 && dev.repos === 2);

  const p = problems(snap, idx);
  check("pending invites are listed, leaving archived repos' out", p.orgInvites.length === 1 && p.repoInvites.length === 1 && p.repoInvites[0].repo === "1");
  check("empty teams and teams with no repos are listed", p.emptyTeams.join() === "12" && p.teamsWithoutRepos.join() === "12");
  check("a repo nobody but owners can admin or maintain is listed", p.unowned.length === 0);
  delete snap.repos[2].collaborators.bob;
  snap.teams[11].repos[2] = "write";
  check("and turns up once its last admin or maintainer goes", problems(snap, indexSnapshot(snap)).unowned.join() === "2");
  check("invite coverage is how many repos have been checked", p.invitesChecked.checked === 2 && p.invitesChecked.total === 3, JSON.stringify(p.invitesChecked));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
