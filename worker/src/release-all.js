import { appReady, installationToken, rest } from "./github.js";
import { orgManagerReady, orgManagerToken } from "./org-manager.js";
import { LOG_NAME } from "./event-log.js";
import {
  DATED_REPOS,
  isDatedTag,
  isDefaultRule,
  parseTag,
  predictDatedTag,
  predictTag,
  ruleFrom,
  validTagName,
} from "./release-tags.js";

const LOG_KEY = "release_all_log";
const LOG_SIZE = 1;
const LOG_REPOS = 8;
const COOLDOWN_MS = 2 * 60_000;
const CHUNK = 20;
const MAX_REPOS = 150;
const MAX_SKIPS = 20;
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;

const orgOf = (env) => env.GITHUB_ORG ?? "GTNewHorizons";

async function readLog(db) {
  try {
    const row = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(LOG_KEY).first();
    const log = row ? JSON.parse(row.value) : [];
    return Array.isArray(log) ? log : [];
  } catch {
    return [];
  }
}

async function writeLog(db, log) {
  await db
    .prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    )
    .bind(LOG_KEY, JSON.stringify(log.slice(0, LOG_SIZE)))
    .run();
}

async function corrections(db) {
  const { results } = await db
    .prepare(
      `SELECT repo, previous_tag, tag FROM release_tag_feedback
        WHERE wrong = 1 ORDER BY released_at DESC, id DESC`,
    )
    .all();
  const byRepo = new Map();
  for (const r of results) {
    if (!byRepo.has(r.repo)) byRepo.set(r.repo, []);
    byRepo.get(r.repo).push(r);
  }
  return byRepo;
}

async function accuracy(db) {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN tag = predicted_tag THEN 1 ELSE 0 END), 0) AS matched,
              COALESCE(SUM(wrong), 0) AS wrong
         FROM release_tag_feedback`,
    )
    .first();
  return { total: row?.total ?? 0, matched: row?.matched ?? 0, wrong: row?.wrong ?? 0 };
}

const FIELDS = `
  name
  defaultBranchRef { name target { oid } }
  releases(first: 10, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { tagName isDraft } }
  refs(refPrefix: "refs/tags/", first: 100, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) { nodes { name } }`;

async function lookUp(token, org, names) {
  const query = `query($org: String!) {${names
    .map((name, i) => `\n  r${i}: repository(owner: $org, name: "${name}") {${FIELDS}\n  }`)
    .join("")}\n}`;
  const res = await rest("/graphql", token, { method: "POST", body: { query, variables: { org } } });
  const out = await res.json();
  if (!out.data) throw new Error(`graphql: ${out.errors?.[0]?.message ?? "no data"}`);
  return names.map((_, i) => out.data[`r${i}`] ?? null);
}

function lastTagOf(repo, fits) {
  const released = repo.releases.nodes.find((r) => !r.isDraft && fits(r.tagName));
  if (released) return released.tagName;
  return repo.refs.nodes.find((t) => fits(t.name))?.name ?? null;
}

function planDated(repo, sha, now) {
  const lastTag = lastTagOf(repo, isDatedTag);
  const taken = new Set(repo.refs.nodes.map((t) => t.name));
  return {
    repo: repo.name,
    defaultBranch: repo.defaultBranchRef?.name ?? null,
    sha,
    problem: sha ? null : "The repo has no default branch",
    notes: lastTag ? [] : ["No earlier dated tag to copy. Type the tag in"],
    lastTag,
    lastWasPre: false,
    predicted: predictDatedTag(lastTag, taken, now),
    learned: null,
    skipped: [],
  };
}

function plan(name, repo, learned, now) {
  if (!repo) return { repo: name, problem: "GitHub doesn't know this repo, or NH-Dashbot can't see it", notes: [] };
  const sha = repo.defaultBranchRef?.target?.oid ?? null;
  if (DATED_REPOS.has(repo.name)) return planDated(repo, sha, now);
  const lastTag = lastTagOf(repo, parseTag);
  const rule = ruleFrom(learned.get(repo.name) ?? []);
  const taken = new Set(repo.refs.nodes.map((t) => t.name));

  let predicted = lastTag ? predictTag(lastTag, rule ?? undefined) : null;
  const skipped = [];
  while (predicted && taken.has(predicted) && skipped.length < MAX_SKIPS) {
    skipped.push(predicted);
    predicted = predictTag(predicted, rule ?? undefined);
  }

  const notes = [];
  if (!lastTag) notes.push("No earlier version tag to count up from. Type the tag in");
  if (skipped.length) notes.push(`Skipped ${skipped.join(", ")}: already tagged`);

  return {
    repo: repo.name,
    defaultBranch: repo.defaultBranchRef?.name ?? null,
    sha,
    problem: sha ? null : "The repo has no default branch",
    notes,
    lastTag,
    lastWasPre: Boolean(parseTag(lastTag)?.pre),
    predicted,
    learned: rule && !isDefaultRule(rule) ? rule : null,
    skipped,
  };
}

export function cleanRepos(list) {
  if (!Array.isArray(list)) return null;
  const names = [...new Set(list.filter((n) => typeof n === "string" && REPO_NAME.test(n)))];
  return names.length && names.length <= MAX_REPOS ? names : null;
}

export async function releaseAllPreview(env, repoNames, { now = Date.now() } = {}) {
  const names = cleanRepos(repoNames);
  if (!names) return { status: 400, body: { error: `send 1 to ${MAX_REPOS} repo names` } };
  if (!appReady(env)) return { status: 503, body: { error: "GH_APP_ID or GH_APP_PRIVATE_KEY not set" } };

  let learned = new Map();
  let stats = { total: 0, matched: 0, wrong: 0 };
  let storeError = null;
  try {
    [learned, stats] = await Promise.all([corrections(env.DB), accuracy(env.DB)]);
  } catch (err) {
    storeError = `Past releases couldn't be read, so nothing learned is applied (${String(err).slice(0, 120)})`;
  }

  let found;
  try {
    const token = await installationToken(env);
    found = [];
    for (let i = 0; i < names.length; i += CHUNK) {
      found.push(...(await lookUp(token, orgOf(env), names.slice(i, i + CHUNK))));
    }
  } catch (err) {
    return { status: 502, body: { error: `Couldn't read the repos from GitHub: ${String(err).slice(0, 200)}` } };
  }

  return {
    status: 200,
    body: {
      ready: orgManagerReady(env),
      repos: names.map((name, i) => plan(name, found[i], learned, now)),
      stats,
      storeError,
    },
  };
}

const text = (v) => (typeof v === "string" && v.length <= 100 ? v : null);

function cleanItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > MAX_REPOS) return null;
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (!it || !REPO_NAME.test(it.repo ?? "") || seen.has(it.repo)) return null;
    if (!validTagName(it.tag) || !SHA.test(it.sha ?? "")) return null;
    seen.add(it.repo);
    out.push({
      repo: it.repo,
      tag: it.tag,
      sha: it.sha,
      previous: text(it.previous),
      predicted: text(it.predicted),
      wrong: Boolean(it.wrong) && it.tag !== it.predicted,
    });
  }
  return out;
}

function explain(err) {
  const t = String(err);
  if (/installation -> 404/.test(t)) return "Org-Manager isn't installed on the org";
  if (/releases -> 422 .*already_exists/i.test(t)) return "that tag or release already exists";
  if (/releases -> 40[34]/.test(t))
    return "Org-Manager can't create releases here. Check it has Contents: Read and write, accepted on the installation, and that the repo is in its list";
  if (/releases -> 422/.test(t)) return `GitHub refused the release: ${t.split(" -> 422 ")[1] ?? t}`;
  return t;
}

const tagUrl = (org, repo, tag) => `https://github.com/${org}/${repo}/releases/tag/${encodeURIComponent(tag)}`;

export function logLine(entry, results) {
  const done = results.filter((r) => r.ok);
  const failed = results.length - done.length;
  const named = done.slice(0, LOG_REPOS).map((r) => `${r.repo} ${r.tag}`).join(", ");
  const more = done.length > LOG_REPOS ? ` and ${done.length - LOG_REPOS} more` : "";
  const text = done.length
    ? `ran Release all: ${named}${more}${failed ? ` (${failed} failed)` : ""}`
    : `ran Release all, and all ${failed} failed`;
  return {
    id: `release-all-${entry.at}`,
    at: entry.at,
    box: "releases",
    event: "release_all",
    action: null,
    repo: null,
    actor: entry.by,
    text,
    url: null,
    tone: failed ? "warn" : "good",
  };
}

async function postToLogs(env, entry, results) {
  if (!env.EVENT_LOG) return;
  const stub = env.EVENT_LOG.get(env.EVENT_LOG.idFromName(LOG_NAME));
  const res = await stub.fetch("https://event-log/record", { method: "POST", body: JSON.stringify(logLine(entry, results)) });
  if (!res.ok) throw new Error(`event log ${res.status}`);
}

export async function releaseAll(env, by, rawItems, { dryRun = false, now = Date.now() } = {}) {
  const items = cleanItems(rawItems);
  if (!items) return { status: 400, body: { error: "each repo needs a valid tag and a 40-character commit SHA, once" } };
  if (!dryRun && !orgManagerReady(env)) {
    return { status: 503, body: { error: "ORG_MANAGER_APP_ID or ORG_MANAGER_PRIVATE_KEY not set" } };
  }

  const log = await readLog(env.DB);
  const recent = log.find((e) => !e.dryRun && now - Date.parse(e.at) < COOLDOWN_MS);
  if (recent) {
    const seconds = Math.max(1, Math.round((now - Date.parse(recent.at)) / 1000));
    return { status: 429, body: { error: `${recent.by} ran Release All ${seconds}s ago` } };
  }

  const org = orgOf(env);
  let token = null;
  if (!dryRun) {
    try {
      token = await orgManagerToken(env, now);
    } catch (err) {
      return { status: 502, body: { error: explain(err) } };
    }
  }

  const results = [];
  for (const it of items) {
    if (dryRun) {
      results.push({ repo: it.repo, tag: it.tag, ok: true });
      continue;
    }
    try {
      const res = await rest(`/repos/${org}/${it.repo}/releases`, token, {
        method: "POST",
        body: { tag_name: it.tag, target_commitish: it.sha, name: it.tag, generate_release_notes: true },
      });
      const made = await res.json().catch(() => ({}));
      results.push({ repo: it.repo, tag: it.tag, ok: true, url: made.html_url ?? tagUrl(org, it.repo, it.tag) });
    } catch (err) {
      results.push({ repo: it.repo, tag: it.tag, ok: false, error: explain(err) });
    }
  }

  const at = new Date(now).toISOString();
  const made = items.filter((_, i) => results[i].ok);
  if (!dryRun && made.length) {
    await env.DB.batch(
      made.map((it) =>
        env.DB
          .prepare(
            `INSERT INTO release_tag_feedback
               (repo, previous_tag, predicted_tag, tag, sha, wrong, released_by, released_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(it.repo, it.previous, it.predicted, it.tag, it.sha, it.wrong ? 1 : 0, by, at),
      ),
    ).catch((err) => console.error(JSON.stringify({ at: "release-all", error: `feedback not saved: ${err}` })));
  }

  const entry = {
    at,
    by,
    created: made.length,
    failed: results.length - made.length,
    ...(dryRun ? { dryRun: true } : {}),
  };
  if (made.length || dryRun) await writeLog(env.DB, [entry, ...log]);
  if (!dryRun) await postToLogs(env, entry, results).catch((err) =>
    console.error(JSON.stringify({ at: "release-all", error: `GitHub Logs line not posted: ${err}` })),
  );
  console.log(JSON.stringify({ at: "release-all", ...entry, results }));
  return { status: made.length ? 200 : 502, body: { ok: made.length > 0, entry, results } };
}
