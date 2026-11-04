import { seriesOf, validTagName } from "../../web/js/release-tags.js";

export const SNAPSHOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^(?!.*\.\.)(?!\/)[A-Za-z0-9._\/-]{1,200}(?<![\/.])$/;
const BUMPS = ["patch", "minor", "major", "super"];
const MODES = ["new", "merge", "replace"];
const MAX_REPOS = 1000;
const KEEP_CHANGES = 50;
const SHOWN_CHANGES = 15;
const BIND = 90;

const newId = () => crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
const short = (err, n = 200) => String(err).slice(0, n);
const missing = (err) => /no such table/i.test(String(err));
const notReady = { status: 503, body: { error: "Snapshots aren't set up yet. Run migrations/008-release-snapshots.sql on D1" } };

function chunks(list, n = BIND) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

function cleanSettings(s) {
  if (!s || typeof s !== "object") return null;
  const branch = typeof s.branch === "string" ? s.branch.trim() : "";
  if (branch && !BRANCH.test(branch)) return null;
  const bump = BUMPS.includes(s.bump) ? s.bump : "patch";
  return { branch: branch || null, bump, notLatest: s.notLatest === undefined ? true : Boolean(s.notLatest), pre: Boolean(s.pre) };
}

const tagOrNull = (t) => (t == null || t === "" ? null : validTagName(t) ? t : undefined);

async function snapshotRow(db, name) {
  return db.prepare("SELECT * FROM release_snapshots WHERE name = ?").bind(name).first();
}

async function tagsOf(db, name) {
  const { results } = await db.prepare("SELECT * FROM release_snapshot_tags WHERE snapshot = ?").bind(name).all();
  return new Map(results.map((r) => [r.repo, r]));
}

function upsertTag(db, name, repo, { tag, base, series, since }, by, at) {
  return db
    .prepare(
      `INSERT INTO release_snapshot_tags (snapshot, repo, tag, base_tag, series, since, updated_by, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT (snapshot, repo) DO UPDATE SET
         tag = excluded.tag, base_tag = excluded.base_tag, series = excluded.series,
         since = excluded.since, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    )
    .bind(name, repo, tag, base, series, since, by, at);
}

const dropTag = (db, name, repo) => db.prepare("DELETE FROM release_snapshot_tags WHERE snapshot = ? AND repo = ?").bind(name, repo);

function logChange(db, name, change, kind, repo, before, after, base, since, by, at, reverts = null) {
  return db
    .prepare(
      `INSERT INTO release_snapshot_changes
         (snapshot, change, kind, repo, before_tag, after_tag, base_tag, since, reverts, changed_by, changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(name, change, kind, repo, before, after, base, since, reverts, by, at);
}

const touch = (db, name, by, at) => db.prepare("UPDATE release_snapshots SET updated_by = ?, updated_at = ? WHERE name = ?").bind(by, at, name);

const prune = (db, name) =>
  db
    .prepare(
      `DELETE FROM release_snapshot_changes
        WHERE snapshot = ?1
          AND change NOT IN (SELECT change FROM release_snapshot_changes WHERE snapshot = ?1
                              GROUP BY change ORDER BY MAX(id) DESC LIMIT ${KEEP_CHANGES})`,
    )
    .bind(name);

function settingsOut(s) {
  return { branch: s.branch ?? "", bump: s.bump, notLatest: Boolean(s.not_latest), pre: Boolean(s.pre) };
}

export async function listSnapshots(env) {
  const db = env.DB;
  try {
    const [{ results: snaps }, { results: tags }, { results: groups }, { results: undone }] = await Promise.all([
      db.prepare("SELECT * FROM release_snapshots ORDER BY created_at, name").all(),
      db.prepare("SELECT snapshot, repo, tag, base_tag, series, since, updated_by, updated_at FROM release_snapshot_tags ORDER BY repo").all(),
      db.prepare("SELECT snapshot, change, MAX(id) AS last FROM release_snapshot_changes GROUP BY snapshot, change ORDER BY last DESC").all(),
      db.prepare("SELECT DISTINCT snapshot, reverts FROM release_snapshot_changes WHERE reverts IS NOT NULL").all(),
    ]);
    const reverted = new Set(undone.map((r) => `${r.snapshot}\n${r.reverts}`));
    const out = [];
    for (const s of snaps) {
      const shown = groups.filter((g) => g.snapshot === s.name).slice(0, SHOWN_CHANGES).map((g) => g.change);
      const rows = [];
      for (const part of chunks(shown)) {
        const marks = part.map(() => "?").join(", ");
        const { results } = await db
          .prepare(`SELECT * FROM release_snapshot_changes WHERE snapshot = ? AND change IN (${marks}) ORDER BY id`)
          .bind(s.name, ...part)
          .all();
        rows.push(...results);
      }
      const changes = shown.map((change) => {
        const mine = rows.filter((r) => r.change === change);
        const head = mine[0] ?? {};
        return {
          change,
          kind: head.kind ?? null,
          by: head.changed_by ?? null,
          at: head.changed_at ?? null,
          reverts: head.reverts ?? null,
          reverted: reverted.has(`${s.name}\n${change}`),
          rows: mine.map((r) => ({ repo: r.repo, before: r.before_tag, after: r.after_tag })),
        };
      });
      out.push({
        name: s.name,
        ...settingsOut(s),
        createdBy: s.created_by,
        createdAt: s.created_at,
        updatedBy: s.updated_by,
        updatedAt: s.updated_at,
        repos: tags
          .filter((t) => t.snapshot === s.name)
          .map((t) => ({ repo: t.repo, tag: t.tag, base: t.base_tag, series: t.series, since: t.since, updatedBy: t.updated_by, updatedAt: t.updated_at })),
        changes,
      });
    }
    return { status: 200, body: { snapshots: out } };
  } catch (err) {
    if (missing(err)) return notReady;
    return { status: 502, body: { error: `Snapshots couldn't be read: ${short(err)}` } };
  }
}

function cleanRepos(list) {
  if (!Array.isArray(list) || list.length > MAX_REPOS) return null;
  const seen = new Set();
  const out = [];
  for (const it of list) {
    if (!it || !REPO_NAME.test(it.repo ?? "") || seen.has(it.repo) || !validTagName(it.tag)) return null;
    const base = tagOrNull(it.base);
    if (base === undefined) return null;
    seen.add(it.repo);
    out.push({ repo: it.repo, tag: it.tag, base });
  }
  return out;
}

async function answer(env, extra = {}) {
  const list = await listSnapshots(env);
  return list.status === 200 ? { status: 200, body: { ...list.body, ...extra } } : list;
}

export async function saveSnapshot(env, by, raw, { now = Date.now() } = {}) {
  const name = raw?.name;
  const settings = cleanSettings(raw?.settings);
  const repos = cleanRepos(raw?.repos);
  const mode = MODES.includes(raw?.mode) ? raw.mode : "new";
  const kind = raw?.kind === "import" ? "import" : "save";
  if (!SNAPSHOT_NAME.test(name ?? "")) return { status: 400, body: { error: "a snapshot name of up to 40 letters, numbers, dots, dashes and underscores" } };
  if (!settings || !repos || !repos.length) return { status: 400, body: { error: `send settings and 1 to ${MAX_REPOS} repos, each with a valid tag` } };
  const db = env.DB;
  const at = new Date(now).toISOString();
  try {
    const existing = await snapshotRow(db, name);
    if (existing && mode === "new") return { status: 409, body: { error: `A snapshot called ${name} already exists. Merge into it or replace it` } };
    const current = existing ? await tagsOf(db, name) : new Map();
    const change = newId();
    const list = [
      existing
        ? db.prepare("UPDATE release_snapshots SET branch = ?, bump = ?, not_latest = ?, pre = ?, updated_by = ?, updated_at = ? WHERE name = ?")
            .bind(settings.branch, settings.bump, settings.notLatest ? 1 : 0, settings.pre ? 1 : 0, by, at, name)
        : db.prepare(
            `INSERT INTO release_snapshots (name, branch, bump, not_latest, pre, created_by, created_at, updated_by, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(name, settings.branch, settings.bump, settings.notLatest ? 1 : 0, settings.pre ? 1 : 0, by, at, by, at),
    ];
    let added = 0;
    let changed = 0;
    let removed = 0;
    const incoming = new Set();
    for (const r of repos) {
      incoming.add(r.repo);
      const cur = current.get(r.repo);
      const base = r.base ?? cur?.base_tag ?? r.tag;
      const series = seriesOf(r.tag, settings.bump);
      if (cur && cur.tag === r.tag && cur.base_tag === base && cur.series === series) continue;
      const since = cur?.since ?? at;
      list.push(upsertTag(db, name, r.repo, { tag: r.tag, base, series, since }, by, at));
      if (!cur || cur.tag !== r.tag || cur.base_tag !== base) list.push(logChange(db, name, change, kind, r.repo, cur?.tag ?? null, r.tag, base, since, by, at));
      cur ? changed++ : added++;
    }
    for (const [repo, cur] of current) {
      if (incoming.has(repo)) continue;
      if (mode === "replace") {
        list.push(dropTag(db, name, repo), logChange(db, name, change, kind, repo, cur.tag, null, cur.base_tag, cur.since, by, at));
        removed++;
      } else if (existing && existing.bump !== settings.bump) {
        list.push(upsertTag(db, name, repo, { tag: cur.tag, base: cur.base_tag, series: seriesOf(cur.tag, settings.bump), since: cur.since }, cur.updated_by, cur.updated_at));
      }
    }
    list.push(prune(db, name));
    await db.batch(list);
    return answer(env, { saved: { name, added, changed, removed } });
  } catch (err) {
    if (missing(err)) return notReady;
    return { status: 502, body: { error: `The snapshot couldn't be saved: ${short(err)}` } };
  }
}

export async function editSnapshot(env, by, raw, { now = Date.now() } = {}) {
  const name = raw?.name;
  if (!SNAPSHOT_NAME.test(name ?? "")) return { status: 400, body: { error: "no such snapshot name" } };
  const settings = raw?.settings == null ? null : cleanSettings(raw.settings);
  if (raw?.settings != null && !settings) return { status: 400, body: { error: "the branch isn't a plain branch name" } };
  const set = Array.isArray(raw?.set) ? raw.set : [];
  const remove = Array.isArray(raw?.remove) ? raw.remove : [];
  if (set.length + remove.length > MAX_REPOS) return { status: 400, body: { error: `at most ${MAX_REPOS} changes at once` } };
  for (const s of set) if (!REPO_NAME.test(s?.repo ?? "") || !validTagName(s.tag) || tagOrNull(s.was) === undefined) return { status: 400, body: { error: "each change needs a repo and a valid tag" } };
  for (const r of remove) if (!REPO_NAME.test(r?.repo ?? "") || tagOrNull(r.was) === undefined) return { status: 400, body: { error: "each removal needs a repo" } };
  if (new Set([...set, ...remove].map((x) => x.repo)).size !== set.length + remove.length) return { status: 400, body: { error: "the same repo twice" } };
  if (!settings && !set.length && !remove.length) return { status: 400, body: { error: "nothing to change" } };
  const kind = raw?.kind === "refresh" ? "refresh" : "edit";
  const db = env.DB;
  const at = new Date(now).toISOString();
  try {
    const snap = await snapshotRow(db, name);
    if (!snap) return { status: 404, body: { error: `There's no snapshot called ${name}` } };
    const current = await tagsOf(db, name);
    const moved = [...set, ...remove].filter((x) => (current.get(x.repo)?.tag ?? null) !== (tagOrNull(x.was) ?? null));
    if (moved.length) {
      const said = moved.slice(0, 5).map((x) => `${x.repo} is ${current.get(x.repo)?.tag ?? "not in it"}`).join(", ");
      return { status: 409, body: { error: `The snapshot changed since it was read (${said}${moved.length > 5 ? ", …" : ""}). Reload it and try again` } };
    }
    const bump = settings?.bump ?? snap.bump;
    const change = newId();
    const list = [];
    if (settings) {
      list.push(db.prepare("UPDATE release_snapshots SET branch = ?, bump = ?, not_latest = ?, pre = ?, updated_by = ?, updated_at = ? WHERE name = ?")
        .bind(settings.branch, settings.bump, settings.notLatest ? 1 : 0, settings.pre ? 1 : 0, by, at, name));
    } else {
      list.push(touch(db, name, by, at));
    }
    const touched = new Set();
    for (const s of set) {
      touched.add(s.repo);
      const cur = current.get(s.repo);
      if (cur?.tag === s.tag && cur.series === seriesOf(s.tag, bump)) continue;
      const base = cur?.base_tag ?? s.tag;
      const since = cur?.since ?? at;
      list.push(upsertTag(db, name, s.repo, { tag: s.tag, base, series: seriesOf(s.tag, bump), since }, by, at));
      if (cur?.tag !== s.tag) list.push(logChange(db, name, change, kind, s.repo, cur?.tag ?? null, s.tag, base, since, by, at));
    }
    for (const r of remove) {
      touched.add(r.repo);
      const cur = current.get(r.repo);
      if (!cur) continue;
      list.push(dropTag(db, name, r.repo), logChange(db, name, change, "remove", r.repo, cur.tag, null, cur.base_tag, cur.since, by, at));
    }
    if (settings && settings.bump !== snap.bump) {
      for (const [repo, cur] of current) {
        if (touched.has(repo)) continue;
        list.push(upsertTag(db, name, repo, { tag: cur.tag, base: cur.base_tag, series: seriesOf(cur.tag, bump), since: cur.since }, cur.updated_by, cur.updated_at));
      }
    }
    list.push(prune(db, name));
    await db.batch(list);
    return answer(env);
  } catch (err) {
    if (missing(err)) return notReady;
    return { status: 502, body: { error: `The snapshot couldn't be changed: ${short(err)}` } };
  }
}

export async function revertChange(env, by, raw, { now = Date.now() } = {}) {
  const name = raw?.name;
  const change = raw?.change;
  if (!SNAPSHOT_NAME.test(name ?? "") || typeof change !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(change)) {
    return { status: 400, body: { error: "send a snapshot name and the change to revert" } };
  }
  const db = env.DB;
  const at = new Date(now).toISOString();
  try {
    const snap = await snapshotRow(db, name);
    if (!snap) return { status: 404, body: { error: `There's no snapshot called ${name}` } };
    const { results: rows } = await db.prepare("SELECT * FROM release_snapshot_changes WHERE snapshot = ? AND change = ? ORDER BY id").bind(name, change).all();
    if (!rows.length) return { status: 404, body: { error: "That change isn't in the snapshot's history any more" } };
    const done = await db.prepare("SELECT 1 AS x FROM release_snapshot_changes WHERE snapshot = ? AND reverts = ? LIMIT 1").bind(name, change).first();
    if (done) return { status: 409, body: { error: "That change was already reverted" } };
    const current = await tagsOf(db, name);
    const undo = newId();
    const list = [touch(db, name, by, at)];
    const skipped = [];
    let reverted = 0;
    for (const r of rows) {
      const cur = current.get(r.repo);
      if ((cur?.tag ?? null) !== r.after_tag) {
        skipped.push({ repo: r.repo, now: cur?.tag ?? null });
        continue;
      }
      if (r.before_tag == null) {
        list.push(dropTag(db, name, r.repo));
      } else {
        const base = (r.after_tag == null ? r.base_tag : cur?.base_tag) ?? r.before_tag;
        const since = (r.after_tag == null ? r.since : cur?.since) ?? at;
        list.push(upsertTag(db, name, r.repo, { tag: r.before_tag, base, series: seriesOf(r.before_tag, snap.bump), since }, by, at));
      }
      list.push(logChange(db, name, undo, "revert", r.repo, r.after_tag, r.before_tag, cur?.base_tag ?? r.base_tag, cur?.since ?? r.since, by, at, change));
      reverted++;
    }
    if (!reverted) return { status: 409, body: { error: "Every repo in that change has moved on since, so there's nothing to put back", skipped } };
    list.push(prune(db, name));
    await db.batch(list);
    return answer(env, { reverted, skipped });
  } catch (err) {
    if (missing(err)) return notReady;
    return { status: 502, body: { error: `The change couldn't be reverted: ${short(err)}` } };
  }
}

export async function deleteSnapshot(env, raw) {
  const name = raw?.name;
  if (!SNAPSHOT_NAME.test(name ?? "") || raw?.confirm !== name) return { status: 400, body: { error: "type the snapshot's name to delete it" } };
  const db = env.DB;
  try {
    if (!(await snapshotRow(db, name))) return { status: 404, body: { error: `There's no snapshot called ${name}` } };
    await db.batch([
      db.prepare("DELETE FROM release_snapshot_changes WHERE snapshot = ?").bind(name),
      db.prepare("DELETE FROM release_snapshot_tags WHERE snapshot = ?").bind(name),
      db.prepare("DELETE FROM release_snapshots WHERE name = ?").bind(name),
    ]);
    return answer(env, { deleted: name });
  } catch (err) {
    if (missing(err)) return notReady;
    return { status: 502, body: { error: `The snapshot couldn't be deleted: ${short(err)}` } };
  }
}

export async function snapshotLines(db, repos) {
  const out = new Map();
  for (const part of chunks([...new Set(repos)])) {
    const marks = part.map(() => "?").join(", ");
    const { results } = await db
      .prepare(`SELECT snapshot, repo, tag, base_tag, series FROM release_snapshot_tags WHERE repo IN (${marks}) ORDER BY snapshot`)
      .bind(...part)
      .all();
    for (const r of results) {
      if (!out.has(r.repo)) out.set(r.repo, []);
      out.get(r.repo).push({ snapshot: r.snapshot, tag: r.tag, base: r.base_tag, series: r.series });
    }
  }
  return out;
}

export async function advanceSnapshots(db, made, by, at, change) {
  const advanced = new Set();
  const byName = new Map();
  for (const it of made) {
    if (!it.snapshot) continue;
    if (!byName.has(it.snapshot)) byName.set(it.snapshot, []);
    byName.get(it.snapshot).push(it);
  }
  for (const [name, items] of byName) {
    const snap = await snapshotRow(db, name);
    if (!snap) continue;
    const current = await tagsOf(db, name);
    const list = [touch(db, name, by, at)];
    for (const it of items) {
      const cur = current.get(it.repo);
      if (!cur || cur.tag !== it.previous) continue;
      list.push(
        upsertTag(db, name, it.repo, { tag: it.tag, base: cur.base_tag, series: seriesOf(it.tag, snap.bump), since: cur.since }, by, at),
        logChange(db, name, change, "release", it.repo, cur.tag, it.tag, cur.base_tag, cur.since, by, at),
      );
      advanced.add(`${name}\n${it.repo}`);
    }
    if (list.length > 1) {
      list.push(prune(db, name));
      await db.batch(list);
    }
  }
  return advanced;
}
