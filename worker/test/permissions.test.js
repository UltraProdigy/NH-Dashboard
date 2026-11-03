/**
 *   node --experimental-sqlite worker/test/permissions.test.js
 */

import { DatabaseSync } from "node:sqlite";
import { checkPermissions, completeSnapshot, Permissions, PERMISSIONS_NAME } from "../src/permissions.js";
import { fetchPermissions, fetchRepoInvites, getAll } from "../src/permissions-read.js";
import { higher, levelOf, rank } from "../../web/js/permissions-calc.js";

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
  obj.sql = { exec: (q, ...b) => (/^\s*(INSERT|DELETE)/i.test(q) && !/meta|repo_invites/.test(q) && writes.push(q), exec(q, ...b)) };
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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
