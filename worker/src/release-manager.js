import { appReady, installationToken, nextPage, rest } from "./github.js";
import { orgManagerReady, orgManagerToken } from "./org-manager.js";
import { LOG_NAME } from "./event-log.js";
import {
  BUMPS,
  DATED_REPOS,
  globPrefix,
  globToRegex,
  isDatedTag,
  isDefaultRule,
  parseTag,
  planTag,
  ruleFrom,
  validTagName,
} from "../../web/js/release-tags.js";

const LOCK_KEY = "release_manager_run";
const LOCK_MS = 3 * 60_000;
const LOG_REPOS = 8;
const CHUNK = 10;
const MAX_PREVIEW = 100;
const MAX_BATCH = 25;
const MAX_TAG_PAGES = 10;
const PACE_MS = 1000;
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^(?!.*\.\.)(?!\/)[A-Za-z0-9._\/-]{1,200}(?<![\/.])$/;
const RUN_ID = /^[A-Za-z0-9-]{8,64}$/;
const SHA = /^[0-9a-f]{40}$/;
const ANY_TAG = /^[^\s~^:?*[\\]{1,250}$/;
const GLOB = /^[^\s~^:[\\]{1,120}$/;

const orgOf = (env) => env.GITHUB_ORG ?? "GTNewHorizons";
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const short = (err, n = 200) => String(err).slice(0, n);

async function pages(path, token, max = 20) {
  const out = [];
  let url = path;
  for (let i = 0; url && i < max; i++) {
    const res = await rest(url, token);
    out.push(...(await res.json()));
    url = nextPage(res.headers.get("link"));
  }
  return out;
}

function explainRead(err) {
  const t = String(err);
  if (/-> 403|-> 404/.test(t)) return "NH-Dashbot can't read custom properties. Give it organization Custom properties: Read and accept it on the installation";
  return `Custom properties couldn't be read: ${short(t, 160)}`;
}

export async function repoList(env) {
  if (!appReady(env)) return { status: 503, body: { error: "GH_APP_ID or GH_APP_PRIVATE_KEY not set" } };
  const org = orgOf(env);
  let token;
  let repos;
  try {
    token = await installationToken(env);
    repos = await pages(`/orgs/${org}/repos?type=all&per_page=100&sort=full_name`, token);
  } catch (err) {
    return { status: 502, body: { error: `Couldn't list the repos from GitHub: ${short(err)}` } };
  }

  let schema = [];
  let values = null;
  let propertiesError = null;
  try {
    const [s, v] = await Promise.all([
      rest(`/orgs/${org}/properties/schema`, token).then((r) => r.json()),
      pages(`/orgs/${org}/properties/values?per_page=100`, token),
    ]);
    schema = s.map((p) => ({
      name: p.property_name,
      type: p.value_type,
      allowed: p.allowed_values ?? null,
      description: p.description ?? null,
    }));
    values = new Map(v.map((r) => [r.repository_name, Object.fromEntries(r.properties.map((p) => [p.property_name, p.value]))]));
  } catch (err) {
    propertiesError = explainRead(err);
  }

  const list = repos
    .filter((r) => !r.archived)
    .map((r) => ({
      name: r.name,
      defaultBranch: r.default_branch ?? null,
      pushedAt: r.pushed_at ?? null,
      fork: Boolean(r.fork),
      properties: values?.get(r.name) ?? r.custom_properties ?? {},
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    status: 200,
    body: { org, readAt: new Date().toISOString(), repos: list, schema, propertiesError, archived: repos.length - list.length },
  };
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
         FROM release_tag_feedback
        WHERE bump = 'predicted'`,
    )
    .first();
  return { total: row?.total ?? 0, matched: row?.matched ?? 0, wrong: row?.wrong ?? 0 };
}

const FIELDS = `
  name
  isArchived
  defaultBranchRef { name target { oid } }
  releases(first: 10, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { tagName isDraft tagCommit { oid } } }
  refs(refPrefix: "refs/tags/", first: 100, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) { nodes { name } }`;

async function lookUp(token, org, rows) {
  const vars = { org };
  const decl = ["$org: String!"];
  const parts = rows.map((row, i) => {
    let branch = "";
    if (row.branch) {
      vars[`b${i}`] = `refs/heads/${row.branch}`;
      decl.push(`$b${i}: String!`);
      branch = `\n    branch: ref(qualifiedName: $b${i}) { target { oid } }`;
    }
    return `\n  r${i}: repository(owner: $org, name: "${row.repo}") {${FIELDS}${branch}\n  }`;
  });
  const query = `query(${decl.join(", ")}) {${parts.join("")}\n}`;
  const res = await rest("/graphql", token, { method: "POST", body: { query, variables: vars } });
  const out = await res.json();
  if (!out.data) throw new Error(`graphql: ${out.errors?.[0]?.message ?? "no data"}`);
  return rows.map((_, i) => out.data[`r${i}`] ?? null);
}

async function lookUpSplitting(token, org, rows) {
  try {
    return await lookUp(token, org, rows);
  } catch (err) {
    if (rows.length === 1) return [{ failed: `GitHub didn't answer for this repo (${short(err, 120)})` }];
    const half = Math.ceil(rows.length / 2);
    return [...(await lookUpSplitting(token, org, rows.slice(0, half))), ...(await lookUpSplitting(token, org, rows.slice(half)))];
  }
}

async function lookUpAll(env, rows) {
  const token = await installationToken(env);
  const org = orgOf(env);
  const chunks = [];
  for (let i = 0; i < rows.length; i += CHUNK) chunks.push(rows.slice(i, i + CHUNK));
  const found = [];
  for (let i = 0; i < chunks.length; i += 3) {
    for (const part of await Promise.all(chunks.slice(i, i + 3).map((c) => lookUpSplitting(token, org, c)))) found.push(...part);
  }
  return found;
}

function lastOf(repo, fits) {
  const released = repo.releases.nodes.find((r) => !r.isDraft && fits(r.tagName));
  if (released) return { tag: released.tagName, sha: released.tagCommit?.oid ?? null };
  const ref = repo.refs.nodes.find((t) => fits(t.name));
  return ref ? { tag: ref.name, sha: null } : { tag: null, sha: null };
}

export function lastTagOf(repo) {
  return lastOf(repo, DATED_REPOS.has(repo.name) ? isDatedTag : parseTag).tag;
}

function plan(row, repo, learned, now) {
  if (!repo) return { repo: row.repo, problem: "GitHub doesn't know this repo, or NH-Dashbot can't see it", notes: [] };
  if (repo.failed) return { repo: row.repo, problem: repo.failed, notes: [] };
  if (repo.isArchived) return { repo: repo.name, problem: "Archived, so it can't be released", notes: [] };
  const dated = DATED_REPOS.has(repo.name);
  const last = lastOf(repo, dated ? isDatedTag : parseTag);
  const branch = row.branch ?? null;
  const sha = branch ? repo.branch?.target?.oid ?? null : repo.defaultBranchRef?.target?.oid ?? null;
  const rule = dated ? null : ruleFrom(learned.get(repo.name) ?? []);
  const taken = [...new Set([...repo.refs.nodes.map((t) => t.name), ...repo.releases.nodes.map((r) => r.tagName)])];

  let problem = null;
  if (branch && !sha) problem = `No ${branch} branch`;
  else if (!sha) problem = "The repo has no default branch";

  const out = {
    repo: repo.name,
    defaultBranch: repo.defaultBranchRef?.name ?? null,
    branch: branch ?? repo.defaultBranchRef?.name ?? null,
    customBranch: Boolean(branch),
    sha,
    problem,
    dated,
    lastTag: last.tag,
    lastSha: last.sha,
    lastWasPre: Boolean(parseTag(last.tag)?.pre),
    unchanged: Boolean(sha && last.sha && sha === last.sha),
    learned: rule && !isDefaultRule(rule) ? rule : null,
    taken,
  };
  const guess = planTag(out, { now });
  return { ...out, predicted: guess.tag || null, notes: guess.notes };
}

function cleanPreviewRows(list) {
  if (!Array.isArray(list) || !list.length || list.length > MAX_PREVIEW) return null;
  const seen = new Set();
  const out = [];
  for (const it of list) {
    const repo = typeof it === "string" ? it : it?.repo;
    const branch = typeof it === "string" ? null : it?.branch || null;
    if (typeof repo !== "string" || !REPO_NAME.test(repo) || seen.has(repo)) continue;
    if (branch !== null && (typeof branch !== "string" || !BRANCH.test(branch))) return null;
    seen.add(repo);
    out.push({ repo, branch });
  }
  return out.length ? out : null;
}

export async function releasePreview(env, list, { now = Date.now() } = {}) {
  const rows = cleanPreviewRows(list);
  if (!rows) return { status: 400, body: { error: `send 1 to ${MAX_PREVIEW} repos, each a repo name and an optional plain branch name` } };
  if (!appReady(env)) return { status: 503, body: { error: "GH_APP_ID or GH_APP_PRIVATE_KEY not set" } };

  let learned = new Map();
  let stats = { total: 0, matched: 0, wrong: 0 };
  let storeError = null;
  try {
    [learned, stats] = await Promise.all([corrections(env.DB), accuracy(env.DB)]);
  } catch (err) {
    storeError = `Past releases couldn't be read, so nothing learned is applied (${short(err, 120)})`;
  }

  let found;
  try {
    found = await lookUpAll(env, rows);
  } catch (err) {
    return { status: 502, body: { error: `Couldn't read the repos from GitHub: ${short(err)}` } };
  }

  return {
    status: 200,
    body: {
      ready: orgManagerReady(env),
      repos: rows.map((row, i) => plan(row, found[i], learned, now)),
      stats,
      storeError,
    },
  };
}

const text = (v) => (typeof v === "string" && v.length <= 100 ? v : null);

function cleanRunBody(body, cleanItem) {
  if (!body || !RUN_ID.test(body.run ?? "")) return null;
  const items = body.items;
  if (!Array.isArray(items) || !items.length || items.length > MAX_BATCH) return null;
  const out = [];
  for (const it of items) {
    const item = cleanItem(it);
    if (!item) return null;
    out.push(item);
  }
  return { run: body.run, last: Boolean(body.last), total: Number.isInteger(body.total) ? body.total : null, items: out };
}

function cleanReleaseItem(it) {
  if (!it || !REPO_NAME.test(it.repo ?? "") || !validTagName(it.tag) || !SHA.test(it.sha ?? "")) return null;
  const bump = it.bump === "pattern" || BUMPS.includes(it.bump) ? it.bump : "predicted";
  return {
    repo: it.repo,
    tag: it.tag,
    sha: it.sha,
    previous: text(it.previous),
    predicted: text(it.predicted),
    bump,
    wrong: bump === "predicted" && Boolean(it.wrong) && it.tag !== it.predicted,
  };
}

function cleanDeleteItem(it) {
  if (!it || !REPO_NAME.test(it.repo ?? "") || typeof it.tag !== "string" || !ANY_TAG.test(it.tag)) return null;
  const release = Boolean(it.release);
  const tag = Boolean(it.deleteTag);
  if (!release && !tag) return null;
  const id = Number.isSafeInteger(it.releaseId) && it.releaseId > 0 ? it.releaseId : null;
  return { repo: it.repo, tag: it.tag, release, deleteTag: tag, releaseId: id };
}

function explain(err) {
  const t = String(err);
  if (/installation -> 404/.test(t)) return "Org-Manager isn't installed on the org";
  if (/releases -> 422 .*already_exists/i.test(t)) return "that tag or release already exists";
  if (/-> 422 .*(rule|protected)/i.test(t)) return "protected by a ruleset on the repo";
  if (/-> 40[34]/.test(t))
    return "Org-Manager can't change releases here. Check it has Contents: Read and write, accepted on the installation, and that the repo is in its list";
  if (/-> 422/.test(t)) return `GitHub refused it: ${t.split(" -> 422 ")[1] ?? t}`;
  return short(t);
}

async function readLock(db) {
  const row = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(LOCK_KEY).first();
  try {
    return row ? JSON.parse(row.value) : null;
  } catch {
    return null;
  }
}

async function claim(db, state, now) {
  const res = await db
    .prepare(
      `INSERT INTO meta (key, value) VALUES (?1, ?2)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value
       WHERE json_extract(meta.value, '$.run') = ?3 OR json_extract(meta.value, '$.seen') < ?4`,
    )
    .bind(LOCK_KEY, JSON.stringify(state), state.run, now - LOCK_MS)
    .run();
  return (res?.meta?.changes ?? res?.changes ?? 0) > 0;
}

async function unlock(db, run) {
  await db.prepare("DELETE FROM meta WHERE key = ?1 AND json_extract(value, '$.run') = ?2").bind(LOCK_KEY, run).run();
}

async function begin(env, kind, by, body, now) {
  const held = await readLock(env.DB);
  const mine = held?.run === body.run;
  const state = mine
    ? { ...held, seen: now }
    : { run: body.run, kind, by, at: new Date(now).toISOString(), seen: now, done: [], made: 0, failed: 0, releases: 0, tags: 0 };
  if (await claim(env.DB, state, now)) return { state };
  const other = (await readLock(env.DB)) ?? held;
  const seconds = Math.max(1, Math.round((now - (other?.seen ?? now)) / 1000));
  const what = other?.kind === "delete" ? "deleting releases" : "releasing";
  return { refused: { status: 409, body: { error: `${other?.by ?? "Someone"} is ${what} right now (last batch ${seconds}s ago). Wait for it to finish` } } };
}

function logLine(state, label) {
  const named = state.done.slice(0, LOG_REPOS).map((r) => `${r.repo} ${r.tag}`).join(", ");
  const more = state.made > LOG_REPOS ? ` and ${state.made - LOG_REPOS} more` : "";
  const fail = state.failed ? ` (${state.failed} failed)` : "";
  let text;
  if (state.kind === "delete") {
    const bits = [];
    if (state.releases) bits.push(`${state.releases} ${state.releases === 1 ? "release" : "releases"}`);
    if (state.tags) bits.push(`${state.tags} ${state.tags === 1 ? "tag" : "tags"}`);
    text = bits.length ? `deleted ${bits.join(" and ")} ${label}${fail}` : `tried to delete ${label}, and all ${state.failed} failed`;
  } else {
    text = state.made ? `ran Releases & Tags: ${named}${more}${fail}` : `ran Releases & Tags, and all ${state.failed} failed`;
  }
  return {
    id: `release-manager-${state.at}`,
    at: state.at,
    box: "releases",
    event: state.kind === "delete" ? "release_manager_delete" : "release_manager",
    action: null,
    repo: null,
    actor: state.by,
    text,
    url: null,
    tone: state.failed ? "warn" : "good",
  };
}

async function postToLogs(env, line) {
  if (!env.EVENT_LOG) return;
  const stub = env.EVENT_LOG.get(env.EVENT_LOG.idFromName(LOG_NAME));
  const res = await stub.fetch("https://event-log/record", { method: "POST", body: JSON.stringify(line) });
  if (!res.ok) throw new Error(`event log ${res.status}`);
}

async function finishBatch(env, state, body, results, label, now) {
  state.seen = now;
  if (body.last) {
    await unlock(env.DB, body.run);
    await postToLogs(env, logLine(state, label)).catch((err) =>
      console.error(JSON.stringify({ at: "release-manager", error: `GitHub Logs line not posted: ${err}` })),
    );
  } else {
    await claim(env.DB, state, now);
  }
  console.log(JSON.stringify({ at: "release-manager", kind: state.kind, run: body.run, by: state.by, results }));
}

async function whoReleased(db, repo, tag) {
  try {
    const row = await db
      .prepare("SELECT released_by, released_at FROM release_tag_feedback WHERE repo = ? AND tag = ? ORDER BY id DESC LIMIT 1")
      .bind(repo, tag)
      .first();
    return row ?? null;
  } catch {
    return null;
  }
}

async function recheck(env, items, now) {
  const found = await lookUpAll(env, items.map((it) => ({ repo: it.repo, branch: null })));
  const out = new Map();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const repo = found[i];
    if (!repo || repo.failed) {
      out.set(it.repo, repo?.failed ? `Couldn't check it again before releasing: ${repo.failed}` : "GitHub doesn't know this repo any more");
      continue;
    }
    const taken = new Set([...repo.refs.nodes.map((t) => t.name), ...repo.releases.nodes.map((r) => r.tagName)]);
    if (taken.has(it.tag)) {
      out.set(it.repo, "that tag or release already exists");
      continue;
    }
    const lastNow = lastTagOf(repo);
    if (lastNow && lastNow !== it.previous) {
      const who = await whoReleased(env.DB, it.repo, lastNow);
      const when = who ? ` ${Math.max(1, Math.round((now - Date.parse(who.released_at)) / 1000))}s ago by ${who.released_by}` : "";
      out.set(it.repo, `${lastNow} was released${when} since the preview. Open the preview again`);
    }
  }
  return out;
}

async function saveFeedback(env, made, by, at) {
  if (!made.length) return;
  await env.DB.batch(
    made.map((it) =>
      env.DB
        .prepare(
          `INSERT INTO release_tag_feedback
             (repo, previous_tag, predicted_tag, tag, sha, wrong, bump, released_by, released_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(it.repo, it.previous, it.predicted, it.tag, it.sha, it.wrong ? 1 : 0, it.bump, by, at),
    ),
  ).catch((err) => console.error(JSON.stringify({ at: "release-manager", error: `feedback not saved: ${err}` })));
}

export async function releaseRun(env, by, raw, { dryRun = false, now = Date.now(), pace = PACE_MS } = {}) {
  const body = cleanRunBody(raw, cleanReleaseItem);
  if (!body) return { status: 400, body: { error: `send a run id and 1 to ${MAX_BATCH} repos, each with a valid tag and a 40-character commit SHA` } };
  if (new Set(body.items.map((it) => it.repo)).size !== body.items.length) return { status: 400, body: { error: "the same repo twice" } };
  if (dryRun) {
    return { status: 200, body: { ok: true, dryRun: true, results: body.items.map((it) => ({ repo: it.repo, tag: it.tag, ok: true })) } };
  }
  if (!orgManagerReady(env)) return { status: 503, body: { error: "ORG_MANAGER_APP_ID or ORG_MANAGER_PRIVATE_KEY not set" } };

  const { state, refused } = await begin(env, "release", by, body, now);
  if (refused) return refused;

  const org = orgOf(env);
  let token;
  let stale;
  try {
    [token, stale] = await Promise.all([orgManagerToken(env, now), recheck(env, body.items, now)]);
  } catch (err) {
    if (body.last) await unlock(env.DB, body.run);
    return { status: 502, body: { error: explain(err) } };
  }

  const results = [];
  let wrote = false;
  for (const it of body.items) {
    if (stale.has(it.repo)) {
      results.push({ repo: it.repo, tag: it.tag, ok: false, error: stale.get(it.repo) });
      continue;
    }
    if (wrote) await sleep(pace);
    wrote = true;
    try {
      const res = await rest(`/repos/${org}/${it.repo}/releases`, token, {
        method: "POST",
        body: { tag_name: it.tag, target_commitish: it.sha, name: it.tag, generate_release_notes: true },
      });
      const made = await res.json().catch(() => ({}));
      results.push({ repo: it.repo, tag: it.tag, ok: true, url: made.html_url ?? `https://github.com/${org}/${it.repo}/releases/tag/${encodeURIComponent(it.tag)}` });
    } catch (err) {
      results.push({ repo: it.repo, tag: it.tag, ok: false, error: explain(err) });
    }
  }

  const at = new Date(now).toISOString();
  const made = body.items.filter((_, i) => results[i].ok);
  await saveFeedback(env, made, by, at);
  state.made += made.length;
  state.failed += results.length - made.length;
  state.done = [...state.done, ...made.map((it) => ({ repo: it.repo, tag: it.tag }))].slice(0, LOG_REPOS);
  await finishBatch(env, state, body, results, null, now);
  return { status: made.length ? 200 : 502, body: { ok: made.length > 0, results } };
}

function cleanDeletePreview(body) {
  const repos = Array.isArray(body?.repos) ? [...new Set(body.repos.filter((n) => typeof n === "string" && REPO_NAME.test(n)))] : [];
  if (!repos.length || repos.length > MAX_PREVIEW) return null;
  if (body.latest) return { repos, latest: true, pattern: null };
  const pattern = typeof body.pattern === "string" ? body.pattern.trim() : "";
  if (!GLOB.test(pattern) || pattern.replace(/[*?]/g, "") === "") return null;
  return { repos, latest: false, pattern };
}

const DELETE_QUERY = `query($org: String!, $name: String!, $q: String, $after: String, $n: Int!) {
  repository(owner: $org, name: $name) {
    name
    isArchived
    releases(first: 100, orderBy: { field: CREATED_AT, direction: DESC }) {
      totalCount
      nodes { databaseId tagName isDraft isPrerelease createdAt }
    }
    refs(refPrefix: "refs/tags/", query: $q, first: $n, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { name target { ... on Commit { committedDate } ... on Tag { target { ... on Commit { committedDate } } } } }
    }
  }
}`;

const tagDate = (node) => node?.target?.committedDate ?? node?.target?.target?.committedDate ?? null;

async function matchesIn(token, org, name, sel) {
  const first = await rest("/graphql", token, {
    method: "POST",
    body: { query: DELETE_QUERY, variables: { org, name, q: sel.latest ? null : globPrefix(sel.pattern) || null, after: null, n: sel.latest ? 1 : 100 } },
  }).then((r) => r.json());
  if (!first.data) throw new Error(`graphql: ${first.errors?.[0]?.message ?? "no data"}`);
  const repo = first.data.repository;
  if (!repo) return { repo: name, problem: "GitHub doesn't know this repo, or NH-Dashbot can't see it", matches: [] };
  if (repo.isArchived) return { repo: name, problem: "Archived, so nothing can be deleted", matches: [] };

  const releases = repo.releases.nodes;
  const more = repo.releases.totalCount > releases.length;

  if (sel.latest) {
    const r = releases[0];
    const matches = r ? [{ tag: r.tagName, release: { id: r.databaseId, draft: r.isDraft, pre: r.isPrerelease, at: r.createdAt }, tagged: !r.isDraft, date: null }] : [];
    return { repo: repo.name, problem: null, matches, notes: r ? [] : ["No releases"] };
  }

  const re = globToRegex(sel.pattern);
  const tags = new Map();
  let refs = repo.refs;
  let page = 1;
  for (;;) {
    for (const n of refs.nodes) if (re.test(n.name)) tags.set(n.name, tagDate(n));
    if (!refs.pageInfo.hasNextPage || page >= MAX_TAG_PAGES) break;
    const next = await rest("/graphql", token, {
      method: "POST",
      body: { query: DELETE_QUERY, variables: { org, name, q: globPrefix(sel.pattern) || null, after: refs.pageInfo.endCursor, n: 100 } },
    }).then((r) => r.json());
    refs = next.data?.repository?.refs;
    if (!refs) break;
    page++;
  }
  const notes = [];
  if (refs?.pageInfo?.hasNextPage) notes.push(`Only the first ${MAX_TAG_PAGES * 100} matching tags were checked`);
  if (more) notes.push("More than 100 releases, so older matches are checked for a release when deleting");

  const byTag = new Map(releases.filter((r) => re.test(r.tagName)).map((r) => [r.tagName, r]));
  const names = [...new Set([...tags.keys(), ...byTag.keys()])];
  const matches = names
    .map((tag) => {
      const r = byTag.get(tag);
      return {
        tag,
        release: r ? { id: r.databaseId, draft: r.isDraft, pre: r.isPrerelease, at: r.createdAt } : null,
        maybeRelease: !r && more,
        tagged: tags.has(tag),
        date: tags.get(tag) ?? r?.createdAt ?? null,
      };
    })
    .sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
  return { repo: repo.name, problem: null, matches, notes };
}

export async function deletePreview(env, raw) {
  const sel = cleanDeletePreview(raw);
  if (!sel) return { status: 400, body: { error: `send 1 to ${MAX_PREVIEW} repo names, and either latest or a tag pattern that isn't only wildcards` } };
  if (!appReady(env)) return { status: 503, body: { error: "GH_APP_ID or GH_APP_PRIVATE_KEY not set" } };
  const org = orgOf(env);
  let token;
  try {
    token = await installationToken(env);
  } catch (err) {
    return { status: 502, body: { error: `Couldn't read the repos from GitHub: ${short(err)}` } };
  }
  const repos = [];
  for (let i = 0; i < sel.repos.length; i += 6) {
    const chunk = sel.repos.slice(i, i + 6);
    repos.push(
      ...(await Promise.all(
        chunk.map((name) =>
          matchesIn(token, org, name, sel).catch((err) => ({ repo: name, problem: `Couldn't read its tags: ${short(err, 140)}`, matches: [] })),
        ),
      )),
    );
  }
  return { status: 200, body: { ready: orgManagerReady(env), pattern: sel.pattern, latest: sel.latest, repos } };
}

const refPath = (tag) => tag.split("/").map(encodeURIComponent).join("/");

async function releaseIdFor(org, it, token) {
  if (it.releaseId) return it.releaseId;
  try {
    const res = await rest(`/repos/${org}/${it.repo}/releases/tags/${encodeURIComponent(it.tag)}`, token);
    return (await res.json()).id ?? null;
  } catch (err) {
    if (/-> 404/.test(String(err))) return null;
    throw err;
  }
}

export async function deleteRun(env, by, raw, { dryRun = false, now = Date.now(), pace = PACE_MS } = {}) {
  const body = cleanRunBody(raw, cleanDeleteItem);
  if (!body) return { status: 400, body: { error: `send a run id and 1 to ${MAX_BATCH} tags, each saying what to delete` } };
  const label = raw?.latest ? "(the latest release of each repo)" : `matching ${String(raw?.pattern ?? "").slice(0, 60)}`;
  if (dryRun) {
    return { status: 200, body: { ok: true, dryRun: true, results: body.items.map((it) => ({ repo: it.repo, tag: it.tag, ok: true })) } };
  }
  if (!orgManagerReady(env)) return { status: 503, body: { error: "ORG_MANAGER_APP_ID or ORG_MANAGER_PRIVATE_KEY not set" } };

  const { state, refused } = await begin(env, "delete", by, body, now);
  if (refused) return refused;

  const org = orgOf(env);
  let token;
  try {
    token = await orgManagerToken(env, now);
  } catch (err) {
    if (body.last) await unlock(env.DB, body.run);
    return { status: 502, body: { error: explain(err) } };
  }

  const results = [];
  for (let i = 0; i < body.items.length; i++) {
    const it = body.items[i];
    if (i) await sleep(pace);
    const done = { repo: it.repo, tag: it.tag, release: false, tagDeleted: false };
    try {
      if (it.release) {
        const id = await releaseIdFor(org, it, token);
        if (id) {
          await rest(`/repos/${org}/${it.repo}/releases/${id}`, token, { method: "DELETE" });
          done.release = true;
          state.releases++;
        }
      }
      if (it.deleteTag) {
        try {
          await rest(`/repos/${org}/${it.repo}/git/refs/tags/${refPath(it.tag)}`, token, { method: "DELETE" });
          done.tagDeleted = true;
          state.tags++;
        } catch (err) {
          if (!/-> 422 .*Reference does not exist/i.test(String(err))) throw err;
        }
      }
      results.push({ ...done, ok: true });
    } catch (err) {
      results.push({ ...done, ok: false, error: explain(err) });
    }
  }

  const ok = results.filter((r) => r.ok).length;
  state.made += ok;
  state.failed += results.length - ok;
  await finishBatch(env, state, body, results, label, now);
  return { status: ok ? 200 : 502, body: { ok: ok > 0, results } };
}
