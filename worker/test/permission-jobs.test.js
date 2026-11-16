/**
 *   node --experimental-sqlite worker/test/permission-jobs.test.js
 */

import { DatabaseSync } from "node:sqlite";
import { currentValue, makeChange, normaliseBatch, PermissionJobs, rateWait, slugOf } from "../src/permission-jobs.js";
import { deliveryKey, describe, expectKeys, isInvite, isRisky, keyOf, needsOwner } from "../../web/js/permission-changes.js";

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  ok ? (pass++, console.log("  ok    " + n))
     : (fail++, console.log("  FAIL  " + n + (d ? " — " + d : "")));
};

const ORG = "GTNewHorizons";
const snapshot = () => ({
  org: { login: ORG, base: "none", members: { alice: "owner", bob: "member", carol: "member" }, invites: [] },
  teams: {
    1: { id: 1, slug: "admin", name: "Admin", parent: null, members: { alice: "maintainer" }, repos: { 10: "admin" } },
    2: { id: 2, slug: "developers", name: "Developers", parent: null, members: { bob: "member" }, repos: { 10: "write" } },
    3: { id: 3, slug: "scala", name: "Scala", parent: 2, members: {}, repos: { 10: "write" } },
  },
  repos: {
    10: { id: 10, name: "GT5-Unofficial", visibility: "public", archived: false, collaborators: { carol: "read" } },
    11: { id: 11, name: "Secret", visibility: "private", archived: false, collaborators: {} },
  },
});

const team = (id, slug = "whatever") => ({ id, slug, name: "x" });
const repo = (id, name = "whatever") => ({ id, name });

console.log("\nthe shared change helpers\n");
{
  const add = { kind: "team_member", team: { id: 2, name: "Developers" }, login: "Dave", from: null, to: "member" };
  check("a change's key ignores the login's case", keyOf(add) === "tm:2:dave");
  check("adding a non-member to a team is an invite", isInvite(add, () => false) && !isInvite(add, () => true));
  check("giving an outsider direct access is an invite, changing it isn't",
    isInvite({ kind: "collaborator", login: "x", from: null, to: "read" }, () => false) && !isInvite({ kind: "collaborator", login: "x", from: "read", to: "write" }, () => false));
  check("removals, admin, visibility and deletes are risky",
    isRisky({ kind: "team_repo", to: null }) && isRisky({ kind: "collaborator", to: "admin" }) && isRisky({ kind: "visibility", to: "public" }) &&
    isRisky({ kind: "team_delete" }) && !isRisky({ kind: "team_repo", to: "write" }));
  check("owners and anything about the admin team need an owner",
    needsOwner({ kind: "owner" }, 1) && needsOwner({ kind: "team_member", team: { id: 1 } }, 1) &&
    needsOwner({ kind: "team_parent", team: { id: 3 }, from: 2, to: 1 }, 1) && needsOwner({ kind: "team_create", parent: 1 }, 1) &&
    !needsOwner({ kind: "team_member", team: { id: 2 } }, 1));
  check("descriptions read naturally, in both tenses",
    describe(add) === "add Dave to team Developers as member" &&
    describe({ kind: "team_repo", team: { name: "Scala" }, repo: { name: "R" }, from: "read", to: "write" }, { past: true }) === "changed team Scala on R: read → write" &&
    describe({ kind: "team_parent", team: { name: "Scala" }, to: 2 }, { teamName: () => "Developers" }) === "move team Scala under Developers");
  check("a change and the webhook it causes share a key",
    expectKeys({ kind: "team_repo", team: { id: 2 }, repo: { id: 10 } })[0] === deliveryKey("team", { action: "added_to_repository", team: { id: 2 }, repository: { id: 10 } }) &&
    expectKeys({ kind: "team_repo", team: { id: 2 }, repo: { id: 10 } })[0] === deliveryKey("team_add", { team: { id: 2 }, repository: { id: 10 } }) &&
    expectKeys(add, { member: false }).includes(deliveryKey("organization", { action: "member_invited", invitation: { login: "dave" } })) &&
    expectKeys({ kind: "team_rename", team: { id: 3 } })[0] === deliveryKey("team", { action: "edited", team: { id: 3 }, changes: { name: {} } }) &&
    expectKeys({ kind: "archived", repo: { id: 11 } })[0] === deliveryKey("repository", { action: "archived", repository: { id: 11 } }));
}

console.log("\nnormaliseBatch\n");
{
  const snap = snapshot();
  const ok = normaliseBatch([
    { kind: "team_member", team: { id: 2, slug: "lies" }, login: "carol", from: null, to: "maintainer" },
    { kind: "team_repo", team: team(3), repo: repo(11, "Wrong"), from: null, to: "read" },
  ], snap);
  check("teams and repos are rebuilt from the snapshot by id",
    ok.changes?.[0].team.slug === "developers" && ok.changes[1].repo.name === "Secret", JSON.stringify(ok));
  check("an unknown team is refused", normaliseBatch([{ kind: "team_member", team: team(99), login: "bob", from: null, to: "member" }], snap).error);
  check("a bad login is refused", normaliseBatch([{ kind: "collaborator", repo: repo(10), login: "-no-", from: null, to: "read" }], snap).problems?.[0].error === "not a GitHub login");
  check("a bad level is refused", normaliseBatch([{ kind: "collaborator", repo: repo(10), login: "bob", from: null, to: "god" }], snap).error);
  check("an unknown starting level is allowed", normaliseBatch([{ kind: "team_repo", team: team(2), repo: repo(10), from: "unknown", to: "read" }], snap).changes?.length === 1);
  check("a change to the admin team is refused for non-owners",
    normaliseBatch([{ kind: "team_member", team: team(1), login: "bob", from: null, to: "member" }], snap).problems?.[0].error.includes("owner"));
  check("and allowed for owners",
    normaliseBatch([{ kind: "team_member", team: team(1), login: "bob", from: null, to: "member" }], snap, { owner: true }).changes?.length === 1);
  check("owner changes are owner-only too, and take their starting role from the snapshot",
    normaliseBatch([{ kind: "owner", login: "bob", from: "owner", to: "owner" }], snap, { owner: true }).changes?.[0].from === "member" &&
    normaliseBatch([{ kind: "owner", login: "bob", to: "owner" }], snap).error);
  check("only members can become owners", normaliseBatch([{ kind: "owner", login: "zed", to: "owner" }], snap, { owner: true }).error);
  check("a change to what's already there is dropped, and an empty batch refused",
    normaliseBatch([{ kind: "visibility", repo: repo(10), from: "public", to: "public" }], snap).error === "nothing to apply");
  check("the same change staged twice keeps the last",
    normaliseBatch([
      { kind: "collaborator", repo: repo(10), login: "carol", from: "read", to: "write" },
      { kind: "collaborator", repo: repo(10), login: "Carol", from: "read", to: "admin" },
    ], snap).changes?.map((c) => c.to).join() === "admin");
  check("a team can't go under its own child", normaliseBatch([{ kind: "team_parent", team: team(2), from: null, to: 3 }], snap).error);
  check("a new team can't take an existing name", normaliseBatch([{ kind: "team_create", name: "developers" }], snap).error);
  const made = normaliseBatch([{ kind: "team_create", name: " Ports ", parent: 2 }], snap).changes?.[0];
  check("a new team keeps its trimmed name and parent", made?.name === "Ports" && made.parent === 2 && made.to === "created");
  check("too many changes at once are refused", normaliseBatch(Array.from({ length: 1001 }, () => ({})), snap).error.includes("at most"));
}

console.log("\nrateWait\n");
{
  const h = (o) => ({ get: (k) => o[k] ?? null });
  check("retry-after is honoured", rateWait({ status: 403, headers: h({ "retry-after": "30" }) }) === 30_000);
  check("an empty primary limit waits for its reset", rateWait({ status: 403, headers: h({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1010" }) }, 1_000_000) === 10_000);
  check("a secondary limit with no header waits a minute", rateWait({ status: 403, headers: h({}), text: "You have exceeded a secondary rate limit" }) === 60_000);
  check("an ordinary 403 isn't a rate limit", rateWait({ status: 403, headers: h({}), text: "Resource not accessible by integration" }) === null);
}

function fakeGitHub(state) {
  const calls = [];
  const respond = (status, json, headers = {}) => ({ status, ok: status >= 200 && status < 300, json, text: JSON.stringify(json ?? ""), headers: { get: (k) => headers[k] ?? null } });
  const request = async (token, path, { method = "GET", body } = {}) => {
    calls.push({ token, path, method, body });
    if (state.limitOnce && method !== "GET") { state.limitOnce = false; return respond(403, { message: "secondary rate limit" }, { "retry-after": "5" }); }
    if (state.expireOnce) { state.expireOnce = false; return respond(401, { message: "Bad credentials" }); }
    let m;
    if ((m = path.match(/^\/orgs\/GTNewHorizons\/teams\/([^/]+)\/memberships\/([^/]+)$/))) {
      const key = `${m[1]}:${m[2]}`;
      if (method === "GET") return state.memberships[key] ? respond(200, state.memberships[key]) : respond(404, { message: "Not Found" });
      if (method === "PUT") { state.memberships[key] = { role: body.role, state: state.pendingFor === m[2] ? "pending" : "active" }; return respond(200, state.memberships[key]); }
      if (method === "DELETE") { delete state.memberships[key]; return respond(204, null); }
    }
    if ((m = path.match(/^\/repos\/GTNewHorizons\/([^/]+)\/teams\?per_page=100&page=1$/))) return respond(200, state.repoTeams[m[1]] ?? []);
    if ((m = path.match(/^\/orgs\/GTNewHorizons\/teams\/([^/]+)\/repos\/GTNewHorizons\/([^/]+)$/))) {
      if (method === "PUT") { state.repoTeams[m[2]] = [...(state.repoTeams[m[2]] ?? []).filter((t) => t.slug !== m[1]), { id: state.teamIds[m[1]], slug: m[1], permission: body.permission }]; return respond(204, null); }
      if (method === "DELETE") { state.repoTeams[m[2]] = (state.repoTeams[m[2]] ?? []).filter((t) => t.slug !== m[1]); return respond(204, null); }
    }
    if (path === "/graphql") {
      const { name, login } = body.variables;
      const level = state.collaborators[`${name}:${login}`];
      return respond(200, { data: { repository: { collaborators: { edges: level ? [{ permission: level.toUpperCase(), permissionSources: [{ roleName: level, permission: "READ", source: { __typename: "Repository" } }], node: { login } }] : [] } } } });
    }
    if ((m = path.match(/^\/repos\/GTNewHorizons\/([^/]+)\/collaborators\/([^/]+)$/))) {
      if (method === "PUT") { const fresh = !state.collaborators[`${m[1]}:${m[2]}`]; state.collaborators[`${m[1]}:${m[2]}`] = body.permission === "push" ? "write" : body.permission === "pull" ? "read" : body.permission; return respond(fresh && state.outsiders?.includes(m[2]) ? 201 : 204, null); }
      if (method === "DELETE") { delete state.collaborators[`${m[1]}:${m[2]}`]; return respond(204, null); }
    }
    if ((m = path.match(/^\/repos\/GTNewHorizons\/([^/?]+)$/))) {
      const r = state.repos[m[1]];
      if (method === "PATCH") Object.assign(r, body);
      return respond(200, r);
    }
    if ((m = path.match(/^\/orgs\/GTNewHorizons\/teams\/([^/]+)$/))) {
      const t = state.teams[m[1]];
      if (method === "GET") return t ? respond(200, t) : respond(404, { message: "Not Found" });
      if (method === "PATCH") {
        if (body.name) { delete state.teams[m[1]]; const slug = slugOf(body.name); state.teams[slug] = { ...t, name: body.name, slug }; state.teamIds[slug] = t.id; return respond(200, state.teams[slug]); }
        if ("parent_team_id" in body) t.parent = body.parent_team_id == null ? null : { id: body.parent_team_id };
        return respond(200, t);
      }
      if (method === "DELETE") { delete state.teams[m[1]]; return respond(204, null); }
    }
    if (path === "/orgs/GTNewHorizons/teams" && method === "POST") {
      const slug = slugOf(body.name);
      state.teams[slug] = { id: 77, slug, name: body.name, parent: body.parent_team_id ? { id: body.parent_team_id } : null };
      return respond(201, state.teams[slug]);
    }
    if ((m = path.match(/^\/orgs\/GTNewHorizons\/memberships\/([^/]+)$/))) {
      if (method === "PUT") state.org[m[1]] = body.role;
      return state.org[m[1]] ? respond(200, { role: state.org[m[1]], state: "active" }) : respond(404, { message: "Not Found" });
    }
    return respond(500, { message: `unexpected ${method} ${path}` });
  };
  return { request, calls };
}

const world = () => ({
  memberships: { "developers:bob": { role: "member", state: "active" } },
  repoTeams: { "GT5-Unofficial": [{ id: 2, slug: "developers", permission: "push" }, { id: 3, slug: "scala", permission: "push" }] },
  teamIds: { developers: 2, scala: 3 },
  collaborators: { "GT5-Unofficial:carol": "read" },
  repos: { "GT5-Unofficial": { visibility: "public", archived: false }, Secret: { visibility: "private", archived: false } },
  teams: { developers: { id: 2, slug: "developers", name: "Developers", parent: null }, scala: { id: 3, slug: "scala", name: "Scala", parent: { id: 2 } } },
  org: { alice: "admin", bob: "member" },
});

console.log("\nreading and making each kind of change\n");
{
  const st = world();
  const gh = fakeGitHub(st);
  const call = async (path, { method = "GET", body, allow = [] } = {}) => {
    const res = await gh.request("t", path, { method, body });
    if (!res.ok && !allow.includes(res.status)) throw new Error(`${res.status}`);
    return res;
  };
  const env = { org: ORG, call };
  const T = { id: 2, slug: "developers", name: "Developers" };
  const R = { id: 10, name: "GT5-Unofficial" };
  check("a team membership reads as its role, or none", await currentValue({ kind: "team_member", team: T, login: "bob" }, env) === "member" &&
    await currentValue({ kind: "team_member", team: T, login: "zed" }, env) === null);
  check("a team's grant is read from the repo's own team list", await currentValue({ kind: "team_repo", team: T, repo: R }, env) === "write");
  check("a direct grant is read by login", await currentValue({ kind: "collaborator", repo: R, login: "carol" }, env) === "read");
  check("visibility, archived, teams and owners read as their values",
    await currentValue({ kind: "visibility", repo: R }, env) === "public" && await currentValue({ kind: "archived", repo: R }, env) === false &&
    await currentValue({ kind: "team_parent", team: { id: 3, slug: "scala" } }, env) === 2 &&
    await currentValue({ kind: "team_create", name: "Developers" }, env) === "created" &&
    await currentValue({ kind: "owner", login: "alice" }, env) === "owner" && await currentValue({ kind: "owner", login: "zed" }, env) === null);

  st.pendingFor = "dave";
  const invited = await makeChange({ kind: "team_member", team: T, login: "dave", to: "member" }, env);
  check("adding someone GitHub has to invite says so", invited.invited === true);
  await makeChange({ kind: "team_repo", team: T, repo: R, to: "maintain" }, env);
  check("a team grant is sent with GitHub's name for the level", st.repoTeams["GT5-Unofficial"].find((t) => t.slug === "developers").permission === "maintain");
  await makeChange({ kind: "collaborator", repo: R, login: "carol", to: "write" }, env);
  check("write goes to GitHub as push", gh.calls.at(-1).body.permission === "push");
  const made = await makeChange({ kind: "team_create", name: "New Folks", parent: 2 }, env);
  check("a new team comes back with its id and slug, closed so it can have a parent",
    made.team.id === 77 && made.team.slug === "new-folks" && gh.calls.at(-1).body.privacy === "closed" && gh.calls.at(-1).body.parent_team_id === 2);
  const renamed = await makeChange({ kind: "team_rename", team: { id: 3, slug: "scala" }, to: "Scala Devs" }, env);
  check("a rename comes back with the new slug", renamed.slug === "scala-devs");
  await makeChange({ kind: "owner", login: "bob", to: "owner" }, env);
  check("making an owner sends the admin role", st.org.bob === "admin");
}

function fakeCtx() {
  const db = new DatabaseSync(":memory:");
  const sent = [];
  const ctx = {
    alarms: [],
    storage: {
      sql: {
        exec(q, ...b) {
          const st = db.prepare(q);
          if (/^\s*SELECT/i.test(q)) { const rows = st.all(...b); return { toArray: () => rows }; }
          st.run(...b);
          return { toArray: () => [] };
        },
      },
      setAlarm: async (t) => { ctx.alarms.push(t); },
    },
    getWebSockets: () => [{ send: (m) => sent.push(JSON.parse(m)) }],
  };
  return { ctx, sent };
}

function jobsWith(st, { now = { t: 1_000_000 } } = {}) {
  const gh = fakeGitHub(st);
  const told = [];
  const { ctx, sent } = fakeCtx();
  let mints = 0;
  const obj = new PermissionJobs(ctx, { GITHUB_ORG: ORG }, {
    request: gh.request,
    now: () => now.t,
    token: async (fresh) => `tok${++mints}${fresh ? "-fresh" : ""}`,
    permissions: () => ({ fetch: async (url, init) => (told.push({ path: new URL(url).pathname, body: JSON.parse(init.body) }), new Response(null, { status: 204 })) }),
  });
  const runAll = async (max = 50) => {
    for (let n = 0; n < max; n++) {
      const before = ctx.alarms.length;
      now.t += 5_000;
      await obj.alarm();
      if (ctx.alarms.length === before) break;
    }
  };
  return { obj, gh, told, ctx, sent, now, runAll };
}

const post = (obj, path, body) => obj.fetch(new Request(`https://jobs${path}`, { method: "POST", body: JSON.stringify(body) })).then((r) => r.json());
const state = (obj) => obj.fetch(new Request("https://jobs/state")).then((r) => r.json());

console.log("\nPermissionJobs\n");
{
  const st = world();
  const j = jobsWith(st);
  const T = { id: 2, slug: "developers", name: "Developers" };
  const R = { id: 10, name: "GT5-Unofficial" };
  const sub = await post(j.obj, "/submit", { by: "admin@example.com", changes: [
    { kind: "team_member", team: T, login: "bob", from: "member", to: "maintainer" },
    { kind: "team_repo", team: T, repo: R, from: "read", to: "admin" },
    { kind: "collaborator", repo: R, login: "carol", from: "read", to: "read" },
    { kind: "visibility", repo: { id: 11, name: "Secret" }, from: "private", to: "public" },
  ] });
  check("a batch is queued and its first alarm set", sub.job && sub.ahead === 0 && sub.total === 4 && j.ctx.alarms.length === 1);
  await j.runAll();
  const s = await state(j.obj);
  const items = s.focus.items;
  check("a change that still matches is made", items[0].status === "done" && st.memberships["developers:bob"].role === "maintainer");
  check("a change GitHub no longer matches is skipped and says why", items[1].status === "skipped" && /write/.test(items[1].note) && st.repoTeams["GT5-Unofficial"].find((t) => t.slug === "developers").permission === "push", items[1].note);
  check("one already done on GitHub is skipped too", items[2].status === "skipped" && /already/.test(items[2].note));
  check("the rest still go", items[3].status === "done" && st.repos.Secret.visibility === "public");
  check("the job finishes with its counts", s.focus.state === "done" && s.focus.counts.done === 2 && s.focus.counts.skipped === 2);
  check("the object is told before and after each change it makes",
    j.told.map((t) => t.path).join() === "/expect,/applied,/expect,/applied" && j.told[0].body.by === "admin@example.com" && j.told[0].body.keys[0] === "tm:2:bob");
  check("and the applied change carries what GitHub returned", j.told[1].body.change.to === "maintainer" && j.told[1].body.result);
  const writes = j.gh.calls.filter((c) => c.method !== "GET" && c.path !== "/graphql");
  check("only the two changes that went ahead wrote anything", writes.length === 2, writes.map((w) => w.path).join());
  check("progress goes out over the socket", j.sent.some((m) => m.type === "item") && j.sent.at(-1).type === "state");
}

{
  const st = world();
  st.limitOnce = true;
  const j = jobsWith(st);
  await post(j.obj, "/submit", { by: "a", changes: [{ kind: "archived", repo: { id: 11, name: "Secret" }, from: false, to: true }] });
  j.now.t += 1;
  await j.obj.alarm();
  const waiting = await state(j.obj);
  check("a rate limit leaves the change pending and waits as long as GitHub said",
    waiting.focus.items[0].status === "pending" && waiting.focus.waitNote?.includes("5s") && j.ctx.alarms.at(-1) === j.now.t + 5_000, JSON.stringify(waiting.focus));
  await j.runAll();
  check("and tries again after", (await state(j.obj)).focus.items[0].status === "done" && st.repos.Secret.archived === true);
}

{
  const st = world();
  st.expireOnce = true;
  const j = jobsWith(st);
  await post(j.obj, "/submit", { by: "a", changes: [{ kind: "visibility", repo: { id: 10, name: "GT5-Unofficial" }, from: "public", to: "private" }] });
  await j.runAll();
  check("an expired token is minted again once", (await state(j.obj)).focus.items[0].status === "done" && j.gh.calls[1].token.endsWith("-fresh"));
}

{
  const st = world();
  const j = jobsWith(st);
  const T = { id: 3, slug: "scala", name: "Scala" };
  await post(j.obj, "/submit", { by: "a", changes: [
    { kind: "team_rename", team: T, from: "Scala", to: "Scala Devs" },
    { kind: "team_parent", team: T, from: 2, to: null },
  ] });
  await j.runAll();
  const items = (await state(j.obj)).focus.items;
  check("a change after a rename uses the team's new slug", items.every((i) => i.status === "done") && st.teams["scala-devs"].parent === null, JSON.stringify(items));
}

{
  const st = world();
  const j = jobsWith(st);
  const R = { id: 10, name: "GT5-Unofficial" };
  const first = await post(j.obj, "/submit", { by: "a", changes: [
    { kind: "collaborator", repo: R, login: "carol", from: "read", to: "write" },
    { kind: "collaborator", repo: R, login: "carol", from: "write", to: "admin" },
  ] });
  const second = await post(j.obj, "/submit", { by: "b", changes: [{ kind: "visibility", repo: R, from: "public", to: "private" }] });
  check("a second batch waits behind the first", second.ahead === 1 && j.ctx.alarms.length === 1);
  j.now.t += 5_000;
  await j.obj.alarm();
  await post(j.obj, "/cancel", { by: "c" });
  await j.runAll();
  const s = await state(j.obj);
  check("cancel stops after the change in flight and leaves the rest undone",
    s.jobs.find((x) => x.id === first.job) === undefined || s.jobs.find((x) => x.id === first.job).state === "cancelled");
  check("the next batch then runs, and the finished one's results are cleared", s.focus.id === second.job && s.focus.state === "done" && s.jobs.length === 1);
  check("what the cancelled batch did stays done", st.collaborators["GT5-Unofficial:carol"] === "write");
}

{
  const st = world();
  const j = jobsWith(st);
  const queued = await post(j.obj, "/submit", { by: "a", changes: [{ kind: "visibility", repo: { id: 10, name: "GT5-Unofficial" }, from: "public", to: "private" }] });
  const other = await post(j.obj, "/submit", { by: "a", changes: [{ kind: "archived", repo: { id: 11, name: "Secret" }, from: false, to: true }] });
  await post(j.obj, "/cancel", { job: other.job, by: "a" });
  await j.runAll();
  const s = await state(j.obj);
  check("a queued batch can be cancelled before it starts", st.repos.Secret.archived === false && s.focus.id === queued.job);
}

{
  const st = world();
  const j = jobsWith(st);
  await post(j.obj, "/submit", { by: "a", dry: true, changes: [{ kind: "visibility", repo: { id: 10, name: "GT5-Unofficial" }, from: "public", to: "private" }] });
  await j.runAll();
  check("a dry run sends nothing", (await state(j.obj)).focus.items[0].status === "done" && j.gh.calls.length === 0 && j.told.length === 0);
}

{
  const j = jobsWith(world());
  for (let i = 0; i < 70; i++) j.obj.sql.exec("INSERT INTO writes (at) VALUES (?)", j.now.t - 50_000 + i * 100);
  check("70 writes in the last minute wait for the oldest to age out", j.obj.paceWait(j.now.t) === 10_000, j.obj.paceWait(j.now.t));
  j.obj.sql.exec("DELETE FROM writes");
  j.obj.sql.exec("INSERT INTO writes (at) VALUES (?)", j.now.t - 300);
  check("otherwise writes are a second apart", j.obj.paceWait(j.now.t) === 700);
  j.obj.sql.exec("DELETE FROM writes");
  for (let i = 0; i < 480; i++) j.obj.sql.exec("INSERT INTO writes (at) VALUES (?)", j.now.t - 3_000_000 + i * 10);
  check("480 in the hour wait for the oldest to age out", j.obj.paceWait(j.now.t) === 600_000, j.obj.paceWait(j.now.t));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
