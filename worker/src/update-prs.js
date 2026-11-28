import { bumpDeps, bumpSettings, bumpWrapper, planUpdates, UPDATE_KINDS } from "../../web/js/updates-calc.js";
import { forgetOrgManagerToken, orgManagerToken } from "./org-manager.js";
import { ghFetch, rateWait } from "./permission-jobs.js";

export const UPDATE_JOBS_NAME = "update-pr-jobs";
export const BRANCH_PREFIX = "org-manager/build-updates";
export const MAX_REPOS = 300;

const GAP_MS = 1000;
const REPO_GAP_MS = 2000;
const PER_MINUTE = 70;
const PER_HOUR = 480;
const WRITES_PER_REPO = 11;
const MAX_TRIES = 5;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

const SETTINGS = ["settings.gradle", "settings.gradle.kts"];
const DEPS = ["dependencies.gradle", "dependencies.gradle.kts"];
const WRAPPER_PROPS = "gradle/wrapper/gradle-wrapper.properties";
const WRAPPER_FILES = [
  { path: "gradle/wrapper/gradle-wrapper.jar", mode: "100644" },
  { path: "gradlew", mode: "100755" },
  { path: "gradlew.bat", mode: "100644" },
];

export const updateJobsStub = (env) => env.UPDATE_PR_JOBS.get(env.UPDATE_PR_JOBS.idFromName(UPDATE_JOBS_NAME));

const seg = encodeURIComponent;
const pathSeg = (p) => p.split("/").map(seg).join("/");

const decoder = new TextDecoder();
const fromBase64 = (b64) => decoder.decode(Uint8Array.from(atob(String(b64).replace(/\s/g, "")), (c) => c.charCodeAt(0)));

class RateLimited extends Error {
  constructor(wait) {
    super(`GitHub asked to wait ${Math.ceil(wait / 1000)}s`);
    this.wait = wait;
  }
}

const failure = (what, res) => new Error(`${what}: GitHub said ${res.status}${res.json?.message ? ` (${res.json.message})` : ""}`);

export function buildRequest(sent, scan, pins) {
  if (!scan?.repos?.length) return { error: "run a scan first" };
  const repos = Array.isArray(sent?.repos) ? sent.repos.filter((r) => typeof r === "string" && NAME.test(r)) : [];
  if (!repos.length) return { error: "pick at least one repo" };
  if (repos.length > MAX_REPOS) return { error: `at most ${MAX_REPOS} repos at a time` };
  const kinds = Object.fromEntries(UPDATE_KINDS.map((k) => [k, Boolean(sent?.kinds?.[k])]));
  if (!UPDATE_KINDS.some((k) => kinds[k])) return { error: "pick buildscript, Gradle or dependencies" };
  const plan = planUpdates(scan, { pins, repos, kinds });
  if (!plan.items.length) return { error: "none of those repos have anything to update for the chosen parts", skipped: plan.skipped };
  if (plan.items.some((i) => i.gradle) && !plan.source) return { error: "no repo on the newest Gradle to copy the wrapper from" };
  return { ...plan, kinds, dry: Boolean(sent?.dry) };
}

export function prTitle(item) {
  const parts = [item.buildscript && "buildscript", item.gradle && "Gradle", item.dependencies && "dependencies"].filter(Boolean);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  return `Update ${list}`;
}

export function prBody(done, { by, scanAt }) {
  const lines = [];
  if (done.buildscript) lines.push(`- Buildscript: \`${done.buildscript.from}\` → \`${done.buildscript.to}\``);
  if (done.gradle) lines.push(`- Gradle: \`${done.gradle.from}\` → \`${done.gradle.to}\``);
  if (done.dependencies) {
    lines.push("- Dependencies:");
    for (const d of done.dependencies) lines.push(`  - ${d.name}: \`${d.from}\` → \`${d.to}\``);
  }
  const who = by ? ` for ${by}` : "";
  return `${lines.join("\n")}\n\nOpened from the NH Dashboard's Updates card${who}. "Newest" is the highest version anywhere in the org${scanAt ? ` as of the scan on ${scanAt.slice(0, 10)}` : ""}.`;
}

export class UpdatePrJobs {
  constructor(ctx, env, deps = {}) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.request = deps.request ?? ghFetch;
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.token = deps.token ?? ((fresh) => (fresh && forgetOrgManagerToken(), orgManagerToken(env)));
    this.wrapperCache = null;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, by TEXT NOT NULL, login TEXT,
      state TEXT NOT NULL, dry INTEGER NOT NULL, offline INTEGER NOT NULL DEFAULT 0, cancel INTEGER NOT NULL DEFAULT 0, cancelled_by TEXT,
      created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, branch TEXT NOT NULL, source TEXT, scan_at TEXT,
      wait_until TEXT, wait_note TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS items (job TEXT NOT NULL, i INTEGER NOT NULL, repo TEXT NOT NULL, plan TEXT NOT NULL,
      status TEXT NOT NULL, note TEXT, url TEXT, attempts INTEGER NOT NULL DEFAULT 0, at TEXT, PRIMARY KEY (job, i))`);
    this.sql.exec("CREATE TABLE IF NOT EXISTS writes (at INTEGER NOT NULL)");
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/submit" && request.method === "POST") return Response.json(await this.submit(await request.json()));
    if (url.pathname === "/cancel" && request.method === "POST") return Response.json(await this.cancel(await request.json()));
    if (url.pathname === "/state" && request.method === "GET") return Response.json(this.state());
    return new Response("not found", { status: 404 });
  }

  rows(q, ...b) {
    return this.sql.exec(q, ...b).toArray();
  }

  async submit({ by, login = null, items, dry = false, offline = false, source = null, scanAt = null }) {
    const now = this.now();
    const seq = (this.rows("SELECT MAX(seq) AS n FROM jobs")[0]?.n ?? 0) + 1;
    const id = `upd-${now.toString(36)}-${seq}`;
    const branch = `${BRANCH_PREFIX}-${now.toString(36)}`;
    this.sql.exec(
      "INSERT INTO jobs (id, seq, by, login, state, dry, offline, created_at, branch, source, scan_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)",
      id, seq, by, login, dry ? 1 : 0, offline ? 1 : 0, new Date(now).toISOString(), branch, source, scanAt,
    );
    items.forEach((it, i) => this.sql.exec("INSERT INTO items (job, i, repo, plan, status) VALUES (?, ?, ?, ?, 'pending')", id, i, it.repo, JSON.stringify(it)));
    const ahead = this.rows("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('queued', 'running') AND id != ?", id)[0].n;
    if (!ahead) await this.ctx.storage.setAlarm(now);
    return { job: id, ahead, total: items.length };
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
    return { ok: true, job: target.id };
  }

  summary(job) {
    const counts = Object.fromEntries(this.rows("SELECT status, COUNT(*) AS n FROM items WHERE job = ? GROUP BY status", job.id).map((r) => [r.status, r.n]));
    return {
      id: job.id, by: job.by, state: job.state, dry: Boolean(job.dry), cancelling: Boolean(job.cancel), cancelledBy: job.cancelled_by ?? null,
      createdAt: job.created_at, startedAt: job.started_at, finishedAt: job.finished_at, branch: job.branch,
      waitUntil: job.wait_until, waitNote: job.wait_note, counts, total: Object.values(counts).reduce((a, b) => a + b, 0),
    };
  }

  state() {
    const jobs = this.rows("SELECT * FROM jobs ORDER BY seq");
    const focus = jobs.find((j) => j.state === "running") ?? [...jobs].reverse().find((j) => j.state !== "queued") ?? jobs[0] ?? null;
    const items = focus
      ? this.rows("SELECT i, repo, plan, status, note, url, at FROM items WHERE job = ? ORDER BY i", focus.id)
        .map((r) => ({ i: r.i, repo: r.repo, plan: JSON.parse(r.plan), status: r.status, note: r.note, url: r.url, at: r.at }))
      : [];
    return { jobs: jobs.map((j) => this.summary(j)), focus: focus ? { ...this.summary(focus), items } : null };
  }

  paceWait(now) {
    this.sql.exec("DELETE FROM writes WHERE at < ?", now - 3_600_000);
    const hour = this.rows("SELECT at FROM writes ORDER BY at").map((r) => r.at);
    const minute = hour.filter((t) => t > now - 60_000);
    let wait = 0;
    if (minute.length + WRITES_PER_REPO > PER_MINUTE) wait = Math.max(wait, minute[minute.length + WRITES_PER_REPO - PER_MINUTE - 1] + 60_000 - now);
    if (hour.length + WRITES_PER_REPO > PER_HOUR) wait = Math.max(wait, hour[hour.length + WRITES_PER_REPO - PER_HOUR - 1] + 3_600_000 - now);
    return Math.max(0, wait);
  }

  async finish(job, state) {
    this.sql.exec("UPDATE items SET status = 'cancelled' WHERE job = ? AND status = 'pending'", job.id);
    this.sql.exec("UPDATE jobs SET state = ?, finished_at = ?, wait_until = NULL, wait_note = NULL WHERE id = ?", state, new Date(this.now()).toISOString(), job.id);
    this.wrapperCache = null;
    console.log(JSON.stringify({ at: "update-prs", job: job.id, by: job.by, state, counts: this.summary({ ...job, state }).counts }));
    if (this.rows("SELECT 1 FROM jobs WHERE state = 'queued' LIMIT 1").length) await this.ctx.storage.setAlarm(this.now());
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
      for (const old of this.rows("SELECT id FROM jobs WHERE state NOT IN ('queued', 'running') ORDER BY seq DESC LIMIT -1 OFFSET 4")) {
        this.sql.exec("DELETE FROM items WHERE job = ?", old.id);
        this.sql.exec("DELETE FROM jobs WHERE id = ?", old.id);
      }
      this.sql.exec("UPDATE jobs SET state = 'running', started_at = ? WHERE id = ?", new Date(now).toISOString(), next.id);
      job = { ...next, state: "running", started_at: new Date(now).toISOString() };
    }
    if (job.cancel) return this.finish(job, "cancelled");

    const row = this.rows("SELECT * FROM items WHERE job = ? AND status = 'pending' ORDER BY i LIMIT 1", job.id)[0];
    if (!row) return this.finish(job, "done");

    if (!job.dry) {
      const wait = this.paceWait(now);
      if (wait > 0) {
        this.sql.exec("UPDATE jobs SET wait_until = ?, wait_note = ? WHERE id = ?", new Date(now + wait).toISOString(), "pacing writes under GitHub's limits", job.id);
        return this.ctx.storage.setAlarm(now + wait);
      }
    }

    let outcome;
    try {
      outcome = job.offline
        ? { status: "done", note: "dry run, GitHub wasn't contacted" }
        : await this.run(job, JSON.parse(row.plan));
    } catch (err) {
      if (err instanceof RateLimited && row.attempts + 1 < MAX_TRIES) {
        const until = now + err.wait;
        this.sql.exec("UPDATE items SET attempts = attempts + 1 WHERE job = ? AND i = ?", job.id, row.i);
        this.sql.exec("UPDATE jobs SET wait_until = ?, wait_note = ? WHERE id = ?", new Date(until).toISOString(), err.message, job.id);
        return this.ctx.storage.setAlarm(until);
      }
      outcome = { status: "failed", note: String(err.message ?? err).slice(0, 300) };
    }

    this.sql.exec("UPDATE items SET status = ?, note = ?, url = ?, at = ? WHERE job = ? AND i = ?",
      outcome.status, outcome.note ?? null, outcome.url ?? null, new Date(this.now()).toISOString(), job.id, row.i);
    this.sql.exec("UPDATE jobs SET wait_until = NULL, wait_note = NULL WHERE id = ?", job.id);
    await this.ctx.storage.setAlarm(this.now() + (job.dry ? 250 : REPO_GAP_MS));
  }

  async call(token, path, { method = "GET", body, write = false, allow = [] } = {}) {
    if (write && this.lastWrite) {
      const gap = this.lastWrite + GAP_MS - this.now();
      if (gap > 0) await this.sleep(gap);
    }
    let res = await this.request(token.value, path, { method, body });
    if (res.status === 401) {
      token.value = await this.token(true);
      res = await this.request(token.value, path, { method, body });
    }
    if (write) {
      this.lastWrite = this.now();
      this.sql.exec("INSERT INTO writes (at) VALUES (?)", this.lastWrite);
    }
    const wait = rateWait(res, this.now());
    if (wait != null) throw new RateLimited(wait);
    if (!res.ok && !allow.includes(res.status)) throw failure(`${method} ${path.split("?")[0]}`, res);
    return res;
  }

  async readFile(call, repo, path, ref) {
    const res = await call(`${repo}/contents/${pathSeg(path)}?ref=${seg(ref)}`, { allow: [404] });
    if (res.status === 404 || Array.isArray(res.json) || res.json?.type !== "file") return null;
    return { sha: res.json.sha, base64: String(res.json.content ?? "").replace(/\s/g, ""), text: fromBase64(res.json.content ?? "") };
  }

  async wrapperFrom(call, org, source) {
    if (this.wrapperCache?.source === source) return this.wrapperCache;
    const repo = `/repos/${seg(org)}/${seg(source)}`;
    const info = (await call(repo)).json;
    const files = {};
    for (const f of [{ path: WRAPPER_PROPS }, ...WRAPPER_FILES]) files[f.path] = await this.readFile(call, repo, f.path, info.default_branch);
    if (!files[WRAPPER_PROPS]) throw new Error(`${source} has no gradle-wrapper.properties to copy from`);
    this.wrapperCache = { source, files };
    return this.wrapperCache;
  }

  async commit(call, repo, parent, files, message, dry) {
    if (dry) return { sha: parent.sha, tree: parent.tree };
    const tree = [];
    for (const f of files) {
      if (f.base64 != null) {
        const blob = await call(`${repo}/git/blobs`, { method: "POST", body: { content: f.base64, encoding: "base64" }, write: true });
        tree.push({ path: f.path, mode: f.mode, type: "blob", sha: blob.json.sha });
      } else {
        tree.push({ path: f.path, mode: f.mode, type: "blob", content: f.text });
      }
    }
    const t = await call(`${repo}/git/trees`, { method: "POST", body: { base_tree: parent.tree, tree }, write: true });
    const c = await call(`${repo}/git/commits`, { method: "POST", body: { message, tree: t.json.sha, parents: [parent.sha] }, write: true });
    return { sha: c.json.sha, tree: t.json.sha };
  }

  async run(job, plan) {
    const org = this.env.GITHUB_ORG ?? "GTNewHorizons";
    const token = { value: await this.token(false) };
    const call = (path, opts) => this.call(token, path, opts);
    const dry = Boolean(job.dry);
    const repo = `/repos/${seg(org)}/${seg(plan.repo)}`;

    const info = await call(repo, { allow: [404] });
    if (info.status === 404) return { status: "failed", note: "Org-Manager can't see this repo" };
    if (info.json.archived) return { status: "skipped", note: "archived" };
    const base = info.json.default_branch;

    const open = (await call(`${repo}/pulls?state=open&per_page=100`)).json ?? [];
    const mine = open.find((p) => p.head?.ref?.startsWith(BRANCH_PREFIX) && p.head?.repo?.full_name === `${org}/${plan.repo}`);
    if (mine) return { status: "skipped", note: `already has an open update PR #${mine.number}`, url: mine.html_url };

    const head = (await call(`${repo}/git/ref/heads/${pathSeg(base)}`)).json.object.sha;
    const headCommit = (await call(`${repo}/git/commits/${head}`)).json;
    let parent = { sha: head, tree: headCommit.tree.sha };
    const done = {};
    const notes = [];

    if (plan.buildscript) {
      const files = [];
      for (const path of SETTINGS) {
        const f = await this.readFile(call, repo, path, head);
        const next = f && bumpSettings(f.text, plan.buildscript.to);
        if (next) files.push({ path, mode: "100644", text: next });
      }
      if (files.length) {
        parent = await this.commit(call, repo, parent, files, `Update buildscript to ${plan.buildscript.to}`, dry);
        done.buildscript = plan.buildscript;
      } else notes.push(`buildscript already on ${plan.buildscript.to} or not found`);
    }

    if (plan.gradle) {
      const props = await this.readFile(call, repo, WRAPPER_PROPS, head);
      const src = await this.wrapperFrom(call, org, job.source);
      const next = props && bumpWrapper(props.text, plan.gradle.to, src.files[WRAPPER_PROPS]?.text);
      if (next) {
        const files = [{ path: WRAPPER_PROPS, mode: "100644", text: next }];
        for (const w of WRAPPER_FILES) {
          const theirs = src.files[w.path];
          if (!theirs) continue;
          const mine = await this.readFile(call, repo, w.path, head);
          if (mine && mine.sha !== theirs.sha) files.push({ path: w.path, mode: w.mode, base64: theirs.base64 });
        }
        parent = await this.commit(call, repo, parent, files, `Update Gradle to ${plan.gradle.to}`, dry);
        done.gradle = plan.gradle;
      } else notes.push(`Gradle already on ${plan.gradle.to} or no wrapper`);
    }

    if (plan.dependencies?.length) {
      const bumps = Object.fromEntries(plan.dependencies.map((d) => [d.name, d.to]));
      const files = [];
      const changed = new Map();
      for (const path of DEPS) {
        const f = await this.readFile(call, repo, path, head);
        const out = f ? bumpDeps(f.text, bumps) : { text: null, changed: [] };
        if (out.text) files.push({ path, mode: "100644", text: out.text });
        for (const c of out.changed) changed.set(`${c.name}\n${c.from}`, c);
      }
      if (files.length) {
        const list = [...changed.values()].sort((a, b) => a.name.localeCompare(b.name));
        const msg = `Update dependencies\n\n${list.map((d) => `${d.name} ${d.from} -> ${d.to}`).join("\n")}`;
        parent = await this.commit(call, repo, parent, files, msg, dry);
        done.dependencies = list;
      } else notes.push("dependencies already current");
    }

    if (!done.buildscript && !done.gradle && !done.dependencies) return { status: "skipped", note: notes.join("; ") || "nothing to change" };
    const summary = [done.buildscript && `buildscript ${done.buildscript.to}`, done.gradle && `Gradle ${done.gradle.to}`,
      done.dependencies && `${done.dependencies.length} dep${done.dependencies.length === 1 ? "" : "s"}`].filter(Boolean).join(", ");
    if (dry) return { status: "done", note: `dry run, would open a PR for ${summary}` };

    const branch = job.branch;
    const made = await call(`${repo}/git/refs`, { method: "POST", body: { ref: `refs/heads/${branch}`, sha: parent.sha }, write: true, allow: [422] });
    if (made.status === 422) await call(`${repo}/git/refs/heads/${pathSeg(branch)}`, { method: "PATCH", body: { sha: parent.sha, force: true }, write: true });
    const pr = await call(`${repo}/pulls`, {
      method: "POST",
      body: { title: prTitle(done), head: branch, base, body: prBody(done, { by: job.login, scanAt: job.scan_at }) },
      write: true,
    });
    return { status: "done", note: `#${pr.json.number}: ${summary}${notes.length ? ` (${notes.join("; ")})` : ""}`, url: pr.json.html_url };
  }
}
