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
