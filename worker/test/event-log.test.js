/**
 *   node --experimental-sqlite worker/test/event-log.test.js
 */

import { DatabaseSync } from "node:sqlite";
import { EventLog, excludeRules, LOG_NAME, logDelivery, summarise } from "../src/event-log.js";
import { BOXES, boxOf, DROPPED_EVENTS, KEEP_PER_BOX } from "../../web/js/log-boxes.js";

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  ok ? (pass++, console.log("  ok    " + n))
     : (fail++, console.log("  FAIL  " + n + (d ? " — " + d : "")));
};

const REPO = { name: "GT5-Unofficial", html_url: "https://github.com/GTNewHorizons/GT5-Unofficial", default_branch: "master" };
const SENDER = { login: "Dream-Master" };
const AT = "2026-10-22T21:00:00.000Z";
const line = (event, payload, opts = {}) => summarise(event, { repository: REPO, sender: SENDER, ...payload }, { at: AT, delivery: "d1", ...opts });

console.log("\nboxes\n");
{
  const ids = new Set(BOXES.map((b) => b.id));
  const expected = {
    dependabot_alert: "security", code_scanning_alert: "security", security_and_analysis: "security", deploy_key: "security",
    personal_access_token_request: "security", org_block: "security",
    workflow_run: "ci", workflow_dispatch: "ci", deployment: "ci",
    pull_request: "pulls",
    pull_request_review: "reviews", pull_request_review_comment: "reviews", pull_request_review_thread: "reviews",
    issues: "issues", issue_comment: "issues", milestone: "issues", sub_issues: "issues", issue_dependencies: "issues", issue_relates_to: "issues",
    push: "pushes", create: "pushes", delete: "pushes", commit_comment: "pushes",
    release: "releases", registry_package: "releases",
    repository: "repo", label: "repo", branch_protection_rule: "repo", branch_protection_configuration: "repo", public: "repo", custom_property_values: "repo",
    organization: "org", member: "org", membership: "org", team: "org", team_add: "org", custom_property: "org",
    installation: "org", installation_repositories: "org", installation_target: "org",
    discussion: "community", discussion_comment: "community", gollum: "community", star: "community", watch: "community", fork: "community",
  };
  const wrong = Object.entries(expected).filter(([e, box]) => boxOf(e, { repository: REPO }) !== box);
  check("every subscribed event goes in its planned box", !wrong.length, wrong.map(([e]) => `${e}→${boxOf(e, { repository: REPO })}`).join(", "));
  check("every planned box is drawn", Object.values(expected).every((b) => ids.has(b)) && ids.size === 10);
  check("an event nobody planned for goes in Community", boxOf("sponsorship") === "community");
  check("a comment on a PR goes with the reviews", boxOf("issue_comment", { issue: { pull_request: {} } }) === "reviews");
  check("a comment on an issue stays with the issues", boxOf("issue_comment", { issue: {} }) === "issues");
  check("a repo ruleset is a repo setting", boxOf("repository_ruleset", { repository: REPO }) === "repo");
  check("an org-wide ruleset is an org change", boxOf("repository_ruleset", { organization: {} }) === "org");
  check("box ids are unique", ids.size === BOXES.length);
}

console.log("\nsummaries\n");
{
  const merged = line("pull_request", { action: "closed", pull_request: { number: 21, title: "Fix the thing", merged: true, html_url: "https://github.com/GTNewHorizons/GT5-Unofficial/pull/21" } });
  check("a merged PR says merged", merged?.text === "merged PR #21: Fix the thing" && merged.tone === "good" && merged.box === "pulls", JSON.stringify(merged));
  check("the line carries repo, actor, time and delivery", merged.repo === "GT5-Unofficial" && merged.actor === "Dream-Master" && merged.at === AT && merged.id === "d1");

  const closed = line("pull_request", { action: "closed", pull_request: { number: 22, title: "Nope", merged: false } });
  check("a closed PR says closed", closed.text === "closed PR #22: Nope");

  const labeled = line("issues", { action: "labeled", label: { name: "bug" }, issue: { number: 7, title: "Crash" } });
  check("a label names itself", labeled.text === "labeled “bug” on issue #7: Crash" && labeled.box === "issues", labeled.text);

  const prComment = line("issue_comment", { action: "created", issue: { number: 9, title: "T", pull_request: {} }, comment: { html_url: "https://github.com/x/y/pull/9#c" } });
  check("a comment on a PR says PR", prComment.text === "commented on PR #9: T" && prComment.url.endsWith("#c"));

  const approved = line("pull_request_review", { action: "submitted", review: { state: "APPROVED" }, pull_request: { number: 3, title: "A" } });
  check("an approval is good news in Reviews", approved.text === "approved PR #3: A" && approved.tone === "good" && approved.box === "reviews");

  const push = line("push", { ref: "refs/heads/master", commits: [{}, {}], forced: true, head_commit: { message: "Bump\n\nbody" }, compare: "https://github.com/x/y/compare/a...b" });
  check("a push counts commits and flags a force-push", push.text === "pushed 2 commits to master (force-push): Bump" && push.tone === "warn", push.text);

  const tag = line("push", { ref: "refs/tags/2.7.0", commits: [], compare: "https://github.com/x/y/compare/a" });
  check("a tag push says tag", tag.text === "pushed tag 2.7.0");

  const rel = line("release", { action: "published", release: { tag_name: "2.7.0", name: "", html_url: "https://github.com/x/y/releases/2.7.0" } });
  check("a release falls back to its tag", rel.text === "published release 2.7.0" && rel.box === "releases");

  const edited = line("repository", { action: "edited", changes: { default_branch: { from: "main" }, description: {} } });
  check("a settings edit lists what changed", edited.text === "edited repository settings (default branch, description)" && edited.box === "repo", edited.text);

  const ruleset = summarise("repository_ruleset", { action: "created", repository_ruleset: { name: "Protect master" }, organization: { login: "GTNewHorizons" }, sender: SENDER }, { at: AT });
  check("an org ruleset has no repo and links to the org", ruleset.repo === null && ruleset.text === "created org ruleset “Protect master”" && ruleset.url === "https://github.com/orgs/GTNewHorizons/settings/rules", JSON.stringify(ruleset));

  const team = summarise("membership", { action: "added", member: { login: "someone" }, team: { name: "Admin", html_url: "https://github.com/orgs/GTNewHorizons/teams/admin" }, sender: SENDER }, { at: AT });
  check("a team change names the person and the team", team.text === "added someone to team Admin" && team.box === "org");

  const odd = line("sponsorship", { action: "created" });
  check("an unhandled event still gets a line", odd.text === "sponsorship created" && odd.box === "community", JSON.stringify(odd));

  const long = line("issues", { action: "opened", issue: { number: 1, title: "x".repeat(500) } });
  check("long titles are clipped", long.text.length <= 240 && long.text.endsWith("…"));

  const sneaky = line("release", { action: "published", release: { tag_name: "v", html_url: "javascript:alert(1)" } });
  check("only github.com links are kept", sneaky.url === null);
}


console.log("\nnew events\n");
{
  const dep = line("dependabot_alert", { action: "created", alert: { number: 12, html_url: "https://github.com/x/y/security/dependabot/12",
    dependency: { package: { name: "log4j-core" } }, security_advisory: { severity: "critical", summary: "Remote code execution" } } });
  check("a new Dependabot alert is red and names the package", dep.text === "new Dependabot alert #12 (critical) in log4j-core: Remote code execution" && dep.tone === "bad" && dep.box === "security", dep.text);
  const fixed = line("dependabot_alert", { action: "fixed", alert: { number: 12 } });
  check("a fixed alert is green", fixed.tone === "good" && fixed.text.startsWith("fixed Dependabot alert #12"));
  const cs = line("code_scanning_alert", { action: "appeared_in_branch", alert: { number: 3, rule: { description: "Unsafe deserialization", security_severity_level: "high" } } });
  check("code scanning names the rule", cs.text === "new branch for code scanning alert #3 (high): Unsafe deserialization" && cs.tone === "bad", cs.text);

  const sec = line("security_and_analysis", {
    changes: { from: { security_and_analysis: { secret_scanning: { status: "enabled" }, dependabot_security_updates: { status: "disabled" } } } },
    repository: { ...REPO, security_and_analysis: { secret_scanning: { status: "disabled" }, dependabot_security_updates: { status: "enabled" } } },
  });
  check("a security feature switched off is amber and named", sec.text === "changed security settings: secret scanning disabled, dependabot security updates enabled" && sec.tone === "warn", sec.text);

  const pat = line("personal_access_token_request", { action: "approved", personal_access_token_request: { owner: { login: "newdev" } } });
  check("an approved token request is amber", pat.text === "approved newdev's fine-grained token request" && pat.tone === "warn" && pat.box === "security", pat.text);
  const block = summarise("org_block", { action: "blocked", blocked_user: { login: "spammer" }, organization: { login: "GTNewHorizons" }, sender: SENDER }, { at: AT });
  check("a block names who", block.text === "blocked spammer from the org" && block.box === "security" && block.url === "https://github.com/orgs/GTNewHorizons/settings/blocked_users");

  const cpv = line("custom_property_values", {
    old_property_values: [{ property_name: "maintainer", value: "someone" }, { property_name: "tier", value: "core" }],
    new_property_values: [{ property_name: "maintainer", value: "Dream-Master" }, { property_name: "tier", value: "core" }, { property_name: "tags", value: null }],
  });
  check("custom property changes name what changed", cpv.text === "set custom properties: maintainer = Dream-Master" && cpv.box === "repo", cpv.text);

  const dispatch = line("workflow_dispatch", { workflow: ".github/workflows/release.yml", ref: "refs/heads/master" });
  check("a manual run names the workflow", dispatch.text === "ran release.yml by hand on master" && dispatch.box === "ci", dispatch.text);
  const deploy = line("deployment", { deployment: { ref: "master", environment: "github-pages" } });
  check("a deploy names where it went", deploy.text === "deployed master to github-pages" && deploy.box === "ci");

  const sub = line("sub_issues", { action: "sub_issue_added", sub_issue: { number: 5 }, parent_issue: { number: 2, title: "Epic", html_url: "https://github.com/x/y/issues/2" } });
  check("a sub-issue link reads parent and child", sub.text === "added #5 as a sub-issue of #2: Epic", sub.text);
  check("the mirror delivery on the child is skipped", line("sub_issues", { action: "parent_issue_added" }) === null);
  const dep2 = line("issue_dependencies", { action: "blocked_by_added", blocked_issue: { number: 9 }, blocking_issue: { number: 4 }, blocking_issue_repo: { name: "Other-Repo" } });
  check("a dependency across repos names the other repo", dep2.text === "marked #9 as blocked by Other-Repo#4", dep2.text);
  check("the mirror dependency delivery is skipped", line("issue_dependencies", { action: "blocking_added" }) === null);

  const cc = line("commit_comment", { action: "created", comment: { commit_id: "abcdef1234567", html_url: "https://github.com/x/y/commit/abc#c" } });
  check("a commit comment shows the short sha", cc.text === "commented on commit abcdef1" && cc.box === "pushes");
  const wiki = line("gollum", { pages: [{ action: "edited", title: "Home", html_url: "https://github.com/x/y/wiki/Home" }, { action: "created", title: "B" }] });
  check("wiki edits count the pages", wiki.text === "edited wiki page “Home” and 1 more page" && wiki.box === "community", wiki.text);
  const fork = line("fork", { forkee: { full_name: "someone/GT5-Unofficial", html_url: "https://github.com/someone/GT5-Unofficial" } });
  check("a fork names the copy", fork.text === "forked the repository to someone/GT5-Unofficial" && fork.url.endsWith("someone/GT5-Unofficial"));

  const removed = summarise("membership", { action: "removed", member: { login: "x" }, team: { name: "Admin" }, sender: SENDER }, { at: AT });
  check("someone leaving a team is amber", removed.tone === "warn");
  const prop = summarise("custom_property", { action: "created", definition: { property_name: "maintainer" }, organization: { login: "GTNewHorizons" }, sender: SENDER }, { at: AT });
  check("a property definition is an org change", prop.text === "created custom property “maintainer”" && prop.box === "org");
}

console.log("\ndropped\n");
for (const event of ["check_run", "check_suite", "status", "workflow_job", "merge_group"]) {
  check(`${event} never reaches the log`, DROPPED_EVENTS.has(event) && line(event, { action: "completed" }) === null);
}

console.log("\nwhat is left out\n");
{
  check("the App's ping", summarise("ping", { zen: "hi" }) === null);
  const prRun = line("workflow_run", { action: "completed", workflow_run: { name: "Build", head_branch: "fix/thing", conclusion: "failure" } });
  check("CI on a PR branch", prRun === null);
  const masterRun = line("workflow_run", { action: "completed", workflow_run: { name: "Build and test", head_branch: "master", conclusion: "failure", html_url: "https://github.com/x/y/actions/runs/1" } });
  check("CI on the default branch is kept, and a failure is bad", masterRun?.text === "Build and test failed on master" && masterRun.tone === "bad" && masterRun.box === "ci", JSON.stringify(masterRun));
  const running = line("workflow_run", { action: "in_progress", workflow_run: { name: "Build", head_branch: "master" } });
  check("a running build says running", running.text === "Build running on master" && running.tone === "run");

  const rules = excludeRules({ NH_INGEST_EXCLUDE: "Dupes-*" });
  const hidden = summarise("push", { repository: { name: "Dupes-Exploits-GTNH" }, ref: "refs/heads/master", commits: [] }, { rules });
  check("anything in an excluded repo", hidden === null);
  const shown = summarise("push", { repository: REPO, ref: "refs/heads/master", commits: [] }, { rules });
  check("other repos still show with exclusions set", shown !== null);
}

console.log("\nlogDelivery\n");
{
  const sent = [];
  const env = {
    EVENT_LOG: {
      idFromName: (n) => `id:${n}`,
      get: (id) => ({ fetch: async (url, init) => (sent.push({ id, url, entry: JSON.parse(init.body) }), new Response(null, { status: 204 })) }),
    },
  };
  check("without the binding it does nothing", (await logDelivery({}, "push", { repository: REPO, ref: "refs/heads/master", commits: [] }, "x")) === null);
  await logDelivery(env, "issues", { action: "opened", repository: REPO, sender: SENDER, issue: { number: 4, title: "Hi" } }, "abc");
  check("a delivery goes to the one named log", sent.length === 1 && sent[0].id === `id:${LOG_NAME}` && sent[0].url.endsWith("/record"));
  check("with its delivery id", sent[0].entry.id === "abc" && sent[0].entry.text === "opened issue #4: Hi");
  await logDelivery(env, "workflow_run", { action: "requested", repository: REPO, workflow_run: { head_branch: "pr" } }, "def");
  check("a filtered delivery never reaches the object", sent.length === 1);
}

function fakeObject() {
  const db = new DatabaseSync(":memory:");
  const sockets = [];
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
    getWebSockets: () => sockets,
  };
  return { obj: new EventLog(ctx, {}), sockets, db };
}

console.log("\nthe Durable Object\n");
{
  const { obj, sockets, db } = fakeObject();
  const a = { sent: [], send(m) { this.sent.push(m); } };
  const b = { send() { throw new Error("gone"); } };
  sockets.push(b, a);

  obj.record({ id: "s1", box: "settings", text: "edited" });
  for (let i = 0; i < KEEP_PER_BOX + 5; i++) obj.record({ id: `c${i}`, box: "ci", text: `run ${i}` });

  const all = obj.history();
  const ci = all.filter((e) => e.box === "ci");
  check(`keeps the newest ${KEEP_PER_BOX} per box`, ci.length === KEEP_PER_BOX && ci[0].id === `c${KEEP_PER_BOX + 4}` && ci.at(-1).id === "c5", `${ci.length} ${ci[0]?.id} ${ci.at(-1)?.id}`);
  check("a busy box doesn't push a quiet one out", all.some((e) => e.id === "s1"));
  check("history is newest first", all[0].id === `c${KEEP_PER_BOX + 4}`);
  check("the table never grows past the cap", db.prepare("SELECT COUNT(*) n FROM events").get().n === KEEP_PER_BOX + 1);
  check("every open socket is sent each line, and a dead one doesn't stop the rest",
    a.sent.length === KEEP_PER_BOX + 6 && JSON.parse(a.sent.at(-1)).event.id === `c${KEEP_PER_BOX + 4}`);

  const res = await obj.fetch(new Request("https://event-log/record", { method: "POST", body: JSON.stringify({ id: "p1", box: "pulls", text: "x" }) }));
  check("POST /record stores the line", res.status === 204 && obj.history()[0].id === "p1");
  const other = await obj.fetch(new Request("https://event-log/anything"));
  check("anything else is a 404", other.status === 404);

  const pinged = { sent: [], send(m) { this.sent.push(m); } };
  obj.webSocketMessage(pinged, "ping");
  check("a ping is answered", pinged.sent[0] === "pong");
}

console.log("\nthe webhook\n");
{
  const secret = "s3cret";
  const body = JSON.stringify({ action: "created", repository: REPO, sender: SENDER });
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))).toString("hex");
  const sent = [];
  const env = {
    GITHUB_WEBHOOK_SECRET: secret,
    DB: {},
    EVENT_LOG: { idFromName: (n) => n, get: () => ({ fetch: async (u, init) => (sent.push(JSON.parse(init.body)), new Response(null, { status: 204 })) }) },
  };
  const pending = [];
  const { default: worker } = await import("../src/index.js");
  const res = await worker.fetch(new Request("https://nh-dashboard.gtnh.workers.dev/webhook", {
    method: "POST",
    headers: { "x-hub-signature-256": `sha256=${sig}`, "x-github-event": "star", "x-github-delivery": "del-1" },
    body,
  }), env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  check("an event the handlers ignore still answers 200", res.status === 200, res.status);
  check("and still reaches the log", sent.length === 1 && sent[0].id === "del-1" && sent[0].box === "community", JSON.stringify(sent));

  const broken = { ...env, EVENT_LOG: { idFromName: (n) => n, get: () => ({ fetch: async () => { throw new Error("down"); } }) } };
  const pending2 = [];
  const quiet = console.error;
  console.error = () => {};
  const res2 = await worker.fetch(new Request("https://nh-dashboard.gtnh.workers.dev/webhook", {
    method: "POST",
    headers: { "x-hub-signature-256": `sha256=${sig}`, "x-github-event": "star", "x-github-delivery": "del-2" },
    body,
  }), broken, { waitUntil: (p) => pending2.push(p) });
  await Promise.all(pending2);
  console.error = quiet;
  check("a log that is down doesn't fail the delivery", res2.status === 200, res2.status);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
