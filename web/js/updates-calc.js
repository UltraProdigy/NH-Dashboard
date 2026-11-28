import { compareVersions } from "./release-tags.js";

const UNSTABLE = /(?:^|[-_.])(?:pre|rc|alpha|beta|snapshot|milestone|dev)(?:[-_.]?\d+)?$/i;
const SETTINGS_PLUGIN = /com\.gtnewhorizons\.gtnhsettingsconvention["']\s*\)?\s*version\s*\(?\s*["']([^"']+)["']/;
const LEGACY_HEADER = /^\s*\/\/\s*version:\s*(\d+)/;
const WRAPPER = /^\s*distributionUrl\s*=\s*\S*?gradle-(.+?)-(?:bin|all)\.zip\s*$/m;
const DEP = /["']com\.github\.GTNewHorizons:([^:"'\s]+):([^:"'\s]+)(?::[^"'\s]*)?["']/g;

export const isUnstable = (v) => UNSTABLE.test(String(v ?? ""));

export function stripComments(text) {
  return String(text ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'])\/\/.*$/gm, "$1");
}

export function parseSettings(text) {
  return SETTINGS_PLUGIN.exec(stripComments(text))?.[1] ?? null;
}

export function parseLegacyHeader(text) {
  return LEGACY_HEADER.exec(String(text ?? ""))?.[1] ?? null;
}

export function parseWrapper(text) {
  return WRAPPER.exec(String(text ?? ""))?.[1] ?? null;
}

export function parseDeps(text) {
  const seen = new Map();
  for (const m of stripComments(text).matchAll(DEP)) {
    const key = `${m[1]}\n${m[2]}`;
    if (!seen.has(key)) seen.set(key, [m[1], m[2]]);
  }
  return [...seen.values()];
}

const shape = (tag) => String(tag).replace(/\d+/g, "#");

// Newest first, as GitHub orders them. Only tags shaped like the newest one compete,
// so an old naming scheme (r1.8-321) can't outrank the current one (1.13.10-GTNH).
export function latestTag(names) {
  const stable = (names ?? []).filter((n) => n && !isUnstable(n) && /\d/.test(n));
  if (!stable.length) return null;
  const want = shape(stable[0]);
  let best = stable[0];
  for (const name of stable) if (shape(name) === want && compareVersions(name, best) > 0) best = name;
  return best;
}

function highest(values) {
  let best = null;
  for (const v of values) {
    if (!v || isUnstable(v)) continue;
    if (!best || compareVersions(v, best) > 0) best = v;
  }
  return best;
}

export function targets(repos) {
  const plugin = highest(repos.filter((r) => r.buildscript?.kind === "plugin").map((r) => r.buildscript.version));
  const legacy = plugin ? null : highest(repos.filter((r) => r.buildscript?.kind === "legacy").map((r) => r.buildscript.version));
  return {
    buildscript: plugin ? { kind: "plugin", version: plugin } : legacy ? { kind: "legacy", version: legacy } : null,
    gradle: highest(repos.map((r) => r.gradle)),
  };
}

function buildscriptStatus(bs, target) {
  if (!bs) return "none";
  if (!target) return "ok";
  if (bs.kind !== target.kind) return bs.kind === "legacy" ? "legacy" : "ok";
  return compareVersions(bs.version, target.version) < 0 ? "behind" : "ok";
}

function gradleStatus(v, target) {
  if (!v) return "none";
  if (!target) return "ok";
  return compareVersions(v, target) < 0 ? "behind" : "ok";
}

export const pinKey = (repo, dep) => `${repo}\n${String(dep).toLowerCase()}`;

function depRows(repo, tags, pinned) {
  return (repo.deps ?? []).map(([name, version]) => {
    const latest = tags?.[name.toLowerCase()] ?? null;
    const pin = pinned.has(pinKey(repo.name, name));
    let status = "ok";
    if (!latest || /[$+]/.test(version) || !/\d/.test(version)) status = "unknown";
    else if (compareVersions(version, latest) < 0) status = pin ? "pinned" : "behind";
    return { name, version, latest, status, pinned: pin };
  });
}

export function summarize(scan, { pins = [], countDeps = false } = {}) {
  const repos = scan?.repos ?? [];
  const target = targets(repos);
  const pinned = new Set(pins.map((p) => pinKey(p.repo, p.dep)));
  const rows = repos.map((r) => {
    const bs = buildscriptStatus(r.buildscript, target.buildscript);
    const gr = gradleStatus(r.gradle, target.gradle);
    const deps = depRows(r, scan.tags, pinned);
    const behind = deps.filter((d) => d.status === "behind").length;
    const reasons = [];
    if (bs === "behind" || bs === "legacy") reasons.push("buildscript");
    if (gr === "behind") reasons.push("gradle");
    if (countDeps && behind) reasons.push("dependencies");
    return { ...r, bsStatus: bs, gradleStatus: gr, depRows: deps, depsBehind: behind, reasons, outOfSync: reasons.length > 0 };
  });
  return {
    target,
    rows,
    counts: {
      repos: rows.length,
      outOfSync: rows.filter((r) => r.outOfSync).length,
      buildscript: rows.filter((r) => r.reasons.includes("buildscript")).length,
      gradle: rows.filter((r) => r.reasons.includes("gradle")).length,
      dependencies: rows.filter((r) => r.depsBehind > 0).length,
    },
  };
}

export const UPDATE_KINDS = ["buildscript", "gradle", "dependencies"];

const SETTINGS_BUMP = /(com\.gtnewhorizons\.gtnhsettingsconvention["']\s*\)?\s*version\s*\(?\s*["'])([^"']+)(["'])/g;
const WRAPPER_URL = /^(\s*distributionUrl\s*=\s*\S*?gradle-)(.+?)(-(bin|all)\.zip)(\s*)$/m;
const WRAPPER_SHA = /^\s*distributionSha256Sum\s*=\s*(\S*)\s*$/m;
const DEP_BUMP = /(["']com\.github\.GTNewHorizons:)([^:"'\s]+):([^:"'\s]+)((?::[^"'\s]*)?["'])/g;

const blank = (m) => m.replace(/[^\n]/g, " ");

export function maskComments(text) {
  return String(text ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:"'])(\/\/.*)$/gm, (m, a, b) => a + blank(b));
}

function replaceUnmasked(text, re, fn) {
  const masked = maskComments(text);
  const hits = [...masked.matchAll(re)];
  let out = text;
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    const next = fn(h);
    if (next != null && next !== h[0]) out = out.slice(0, h.index) + next + out.slice(h.index + h[0].length);
  }
  return out;
}

const dynamic = (v) => /[$+]/.test(v) || !/\d/.test(v);

export function bumpSettings(text, version) {
  if (text == null || !version) return null;
  const out = replaceUnmasked(String(text), SETTINGS_BUMP, (m) =>
    compareVersions(m[2], version) < 0 ? `${m[1]}${version}${m[3]}` : null);
  return out === text ? null : out;
}

export function bumpWrapper(text, version, source = null) {
  if (text == null || !version) return null;
  const m = WRAPPER_URL.exec(text);
  if (!m || compareVersions(m[2], version) >= 0) return null;
  let out = text.replace(WRAPPER_URL, `$1${version}$3$5`);
  if (WRAPPER_SHA.test(out)) {
    const src = WRAPPER_URL.exec(source ?? "");
    const sha = src && src[2] === version && src[4] === m[4] ? WRAPPER_SHA.exec(source)?.[1] : null;
    out = sha
      ? out.replace(WRAPPER_SHA, (line) => line.replace(/=\s*\S*/, `=${sha}`))
      : out.replace(/^\s*distributionSha256Sum\s*=.*(\r?\n|$)/m, "");
  }
  return out;
}

export function bumpDeps(text, bumps) {
  if (text == null) return { text: null, changed: [] };
  const want = new Map(Object.entries(bumps ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const changed = new Map();
  const out = replaceUnmasked(String(text), DEP_BUMP, (m) => {
    const to = want.get(m[2].toLowerCase());
    if (!to || dynamic(m[3]) || compareVersions(m[3], to) >= 0) return null;
    changed.set(`${m[2]}\n${m[3]}`, { name: m[2], from: m[3], to });
    return `${m[1]}${m[2]}:${to}${m[4]}`;
  });
  return { text: out === text ? null : out, changed: [...changed.values()] };
}

export function gradleSource(rows, version) {
  const on = rows.filter((r) => r.gradle === version && !r.fork);
  if (!on.length) return null;
  return (on.find((r) => r.name === "ExampleMod1.7.10") ?? on.find((r) => r.bsStatus === "ok") ?? on[0]).name;
}

export function planUpdates(scan, { pins = [], repos = [], kinds = {} } = {}) {
  const s = summarize(scan, { pins, countDeps: true });
  const byName = new Map(s.rows.map((r) => [r.name.toLowerCase(), r]));
  const items = [];
  const skipped = [];
  for (const name of new Set(repos)) {
    const r = byName.get(String(name).toLowerCase());
    if (!r) { skipped.push({ repo: name, why: "not in the last scan" }); continue; }
    const item = { repo: r.name };
    const notes = [];
    if (kinds.buildscript) {
      if (r.bsStatus === "behind" && s.target.buildscript?.kind === "plugin") item.buildscript = { from: r.buildscript.version, to: s.target.buildscript.version };
      else if (r.bsStatus === "legacy") notes.push("legacy buildscript needs migrating by hand");
    }
    if (kinds.gradle && r.gradleStatus === "behind") item.gradle = { from: r.gradle, to: s.target.gradle };
    if (kinds.dependencies) {
      const deps = r.depRows.filter((d) => d.status === "behind").map((d) => ({ name: d.name, from: d.version, to: d.latest }));
      if (deps.length) item.dependencies = deps;
    }
    if (item.buildscript || item.gradle || item.dependencies) items.push(item);
    else skipped.push({ repo: r.name, why: notes[0] ?? "nothing to update for the chosen parts" });
  }
  items.sort((a, b) => a.repo.localeCompare(b.repo));
  const source = items.some((i) => i.gradle) ? gradleSource(s.rows, s.target.gradle) : null;
  return { items, skipped, target: s.target, source };
}
