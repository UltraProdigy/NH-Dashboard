import { appReady, graphql, installationToken } from "./github.js";
import { compileRules, matchesAny, parseRepoList } from "../../src/shared/repo-rules.js";
import { latestTag, parseDeps, parseLegacyHeader, parseSettings, parseWrapper } from "../../web/js/updates-calc.js";

const SCAN_KEY = "build_updates";
const PINS_KEY = "build_updates_pins";
const LOCK_KEY = "build_updates_lock";
const STAMP_KEY = "build_updates_at";
const LOCK_MS = 3 * 60_000;
const PAGE = 25;
const MIN_PAGE = 3;
const MAX_PAGES = 80;
const LEGACY_CHUNK = 10;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

const orgOf = (env) => env.GITHUB_ORG ?? "GTNewHorizons";
const short = (err, n = 200) => String(err).slice(0, n);
const blob = (path) => `object(expression: "HEAD:${path}") { ... on Blob { text } }`;

const REPO_FIELDS = `
  name isArchived isPrivate isFork
  defaultBranchRef { name }
  settings: ${blob("settings.gradle")}
  settingsKts: ${blob("settings.gradle.kts")}
  wrapper: ${blob("gradle/wrapper/gradle-wrapper.properties")}
  deps: ${blob("dependencies.gradle")}
  depsKts: ${blob("dependencies.gradle.kts")}
  tags: refs(refPrefix: "refs/tags/", first: 15, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) { nodes { name } }`;

const PAGE_QUERY = `query($org: String!, $n: Int!, $after: String) {
  organization(login: $org) {
    repositories(first: $n, after: $after, orderBy: { field: NAME, direction: ASC }) {
      pageInfo { hasNextPage endCursor }
      nodes {${REPO_FIELDS}
      }
    }
  }
}`;

async function readJson(db, key, fallback) {
  try {
    const row = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first();
    return row ? JSON.parse(row.value) : fallback;
  } catch {
    return fallback;
  }
}

async function writeJson(db, key, value) {
  await db
    .prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    )
    .bind(key, JSON.stringify(value))
    .run();
}

async function stamp(db, now) {
  const at = new Date(now).toISOString();
  await db
    .prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    )
    .bind(STAMP_KEY, at)
    .run();
  return at;
}

async function readStamp(db) {
  try {
    return (await db.prepare("SELECT value FROM meta WHERE key = ?").bind(STAMP_KEY).first())?.value ?? null;
  } catch {
    return null;
  }
}

const dropKey = (db, key) => db.prepare("DELETE FROM meta WHERE key = ?").bind(key).run();

async function readPins(db) {
  const pins = await readJson(db, PINS_KEY, []);
  return Array.isArray(pins) ? pins : [];
}

async function page(token, org, after, n) {
  try {
    return (await graphql(token, PAGE_QUERY, { org, n, after })).organization.repositories;
  } catch (err) {
    if (n <= MIN_PAGE) throw err;
    return page(token, org, after, Math.ceil(n / 2));
  }
}

async function walk(token, org) {
  const nodes = [];
  let after = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const conn = await page(token, org, after, PAGE);
    nodes.push(...conn.nodes.filter(Boolean));
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return nodes;
}

async function legacyHeaders(token, org, names, errors) {
  const found = new Map();
  for (let i = 0; i < names.length; i += LEGACY_CHUNK) {
    const chunk = names.slice(i, i + LEGACY_CHUNK);
    const parts = chunk.map(
      (name, j) => `r${j}: repository(owner: $org, name: ${JSON.stringify(name)}) { groovy: ${blob("build.gradle")} kts: ${blob("build.gradle.kts")} }`,
    );
    try {
      const data = await graphql(token, `query($org: String!) {\n  ${parts.join("\n  ")}\n}`, { org });
      chunk.forEach((name, j) => {
        const r = data[`r${j}`];
        const v = parseLegacyHeader(r?.groovy?.text) ?? parseLegacyHeader(r?.kts?.text);
        if (v) found.set(name, v);
      });
    } catch (err) {
      errors.push(`Couldn't read build.gradle for ${chunk.join(", ")}: ${short(err, 160)}`);
    }
  }
  return found;
}

const hasGradle = (n) => Boolean(n.settings || n.settingsKts || n.wrapper || n.deps || n.depsKts);

export async function scanOrg(env, { now = Date.now() } = {}) {
  const org = orgOf(env);
  const rules = compileRules(parseRepoList(env.NH_INGEST_EXCLUDE));
  const token = await installationToken(env);
  const nodes = await walk(token, org);
  const errors = [];
  const skipped = { archived: 0, excluded: 0, noGradle: 0 };

  const kept = [];
  for (const n of nodes) {
    if (n.isArchived) skipped.archived++;
    else if (matchesAny(rules, n.name)) skipped.excluded++;
    else if (!hasGradle(n)) skipped.noGradle++;
    else kept.push(n);
  }

  const plugin = new Map(kept.map((n) => [n.name, parseSettings(n.settings?.text) ?? parseSettings(n.settingsKts?.text)]));
  const legacy = await legacyHeaders(token, org, kept.filter((n) => !plugin.get(n.name)).map((n) => n.name), errors);

  const tags = {};
  const repos = kept.map((n) => {
    const latest = latestTag((n.tags?.nodes ?? []).map((t) => t.name));
    if (latest) tags[n.name.toLowerCase()] = latest;
    const pv = plugin.get(n.name);
    const lv = legacy.get(n.name);
    return {
      name: n.name,
      branch: n.defaultBranchRef?.name ?? null,
      private: Boolean(n.isPrivate),
      fork: Boolean(n.isFork),
      latestTag: latest,
      buildscript: pv ? { kind: "plugin", version: pv } : lv ? { kind: "legacy", version: lv } : null,
      gradle: parseWrapper(n.wrapper?.text),
      deps: parseDeps(`${n.deps?.text ?? ""}\n${n.depsKts?.text ?? ""}`),
    };
  });
  repos.sort((a, b) => a.name.localeCompare(b.name));

  return { org, scannedAt: new Date(now).toISOString(), repos, tags, skipped, errors };
}

export async function updatesStatus(env, { now = Date.now() } = {}) {
  const [scan, pins, lock, at] = await Promise.all([
    readJson(env.DB, SCAN_KEY, null),
    readPins(env.DB),
    readJson(env.DB, LOCK_KEY, null),
    readStamp(env.DB),
  ]);
  const scanning = lock && now - Date.parse(lock.at) < LOCK_MS ? lock : null;
  return { status: 200, body: { scan, pins, scanning, stamp: at } };
}

export async function runUpdatesScan(env, by, { now = Date.now() } = {}) {
  if (!appReady(env)) return { status: 503, body: { error: "GH_APP_ID or GH_APP_PRIVATE_KEY not set" } };
  const mine = { at: new Date(now).toISOString(), by };
  // One statement, so two presses landing together can't both see the lock free.
  const claim = await env.DB
    .prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value
       WHERE json_extract(meta.value, '$.at') IS NULL OR json_extract(meta.value, '$.at') < ?`,
    )
    .bind(LOCK_KEY, JSON.stringify(mine), new Date(now - LOCK_MS).toISOString())
    .run();
  if (!(claim.meta?.changes ?? claim.changes)) {
    const lock = await readJson(env.DB, LOCK_KEY, null);
    return { status: 409, body: { error: `A scan started by ${lock?.by ?? "another admin"} is still running.`, scanning: lock } };
  }
  await stamp(env.DB, now);
  const started = Date.now();
  try {
    const scan = await scanOrg(env, { now });
    scan.by = by;
    scan.ms = Date.now() - started;
    await writeJson(env.DB, SCAN_KEY, scan);
    const at = await stamp(env.DB, Date.now());
    console.log(JSON.stringify({ at: "build-updates", by, repos: scan.repos.length, ms: scan.ms, errors: scan.errors.length }));
    return { status: 200, body: { scan, pins: await readPins(env.DB), scanning: null, stamp: at } };
  } catch (err) {
    console.error(JSON.stringify({ at: "build-updates", by, error: String(err) }));
    return { status: 502, body: { error: `The scan couldn't read the org from GitHub: ${short(err)}` } };
  } finally {
    await dropKey(env.DB, LOCK_KEY);
  }
}

export async function setPin(env, by, sent, { now = Date.now() } = {}) {
  const repo = sent?.repo;
  const dep = sent?.dep;
  if (typeof repo !== "string" || !NAME.test(repo) || typeof dep !== "string" || !NAME.test(dep)) {
    return { status: 400, body: { error: "repo and dep must be repo names" } };
  }
  const same = (p) => p.repo === repo && p.dep.toLowerCase() === dep.toLowerCase();
  const pins = (await readPins(env.DB)).filter((p) => !same(p));
  if (sent.pinned) pins.push({ repo, dep, by, at: new Date(now).toISOString() });
  pins.sort((a, b) => a.repo.localeCompare(b.repo) || a.dep.localeCompare(b.dep));
  await writeJson(env.DB, PINS_KEY, pins);
  return { status: 200, body: { pins, stamp: await stamp(env.DB, Date.now()) } };
}
