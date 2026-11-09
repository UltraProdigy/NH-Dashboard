import { API, onUpdatesStamp } from "./live.js";
import { state } from "./state.js";
import { esc, fmt, repoLink, safeUrl } from "./format.js";
import { applyFilter, renderTable, sortRows } from "./table.js";
import { cardReposFrom, exclControlsHtml, isExcludedRepo } from "./dream.js";
import { summarize } from "./updates-calc.js";

const STALE_MS = 5 * 60_000;
const ONLY_KEY = "nh:updates:onlyOut";
const DEPS_KEY = "nh:updates:countDeps";

let data = null;
let error = null;
let loading = null;
let fetchedAt = 0;
let busy = false;
let seen = null;
let note = "";
const pinning = new Set();
const opened = new Set();
let redraw = () => {};
let onlyOut = true;
let countDeps = false;
let memo = null;

try {
  onlyOut = localStorage.getItem(ONLY_KEY) !== "0";
  countDeps = localStorage.getItem(DEPS_KEY) === "1";
} catch {}

const remember = (key, on) => { try { localStorage.setItem(key, on ? "1" : "0"); } catch {} };

export function onUpdatesChange(fn) {
  redraw = fn;
}

onUpdatesStamp((at) => {
  if (data && at && at !== seen && !busy) loadUpdates();
});

cardReposFrom("updates", () => (data?.scan?.repos ?? []).map((r) => r.name));

function summary() {
  if (!data?.scan) return null;
  if (memo?.scan === data.scan && memo.pins === data.pins && memo.countDeps === countDeps) return memo.value;
  memo = { scan: data.scan, pins: data.pins, countDeps, value: summarize(data.scan, { pins: data.pins, countDeps }) };
  return memo.value;
}

function ago(iso) {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 90) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 36 ? `${hours} hr ago` : `${Math.round(hours / 24)} days ago`;
}

async function readBody(res) {
  const body = await res.json().catch(() => ({}));
  if (res.status === 403) throw new Error("Only the admin team can see build updates.");
  if (!res.ok) throw new Error(body.error ?? `The dashboard answered ${res.status}.`);
  return body;
}

const reachError = (err) => (err instanceof TypeError ? "The dashboard couldn't be reached." : err.message);

export function loadUpdates() {
  if (loading) return loading;
  loading = (async () => {
    await null;
    try {
      data = await readBody(await fetch(`${API}/api/updates`, { cache: "no-store" }));
      seen = data.stamp ?? null;
      error = null;
    } catch (err) {
      error = reachError(err);
    } finally {
      fetchedAt = Date.now();
      loading = null;
      redraw();
    }
  })();
  return loading;
}

async function scan() {
  if (busy) return;
  busy = true;
  note = "";
  redraw();
  try {
    data = await readBody(await fetch(`${API}/api/updates/scan`, { method: "POST", cache: "no-store" }));
    seen = data.stamp ?? seen;
    fetchedAt = Date.now();
    error = null;
    const errs = data.scan?.errors?.length ?? 0;
    note = errs ? `Scanned, but ${errs} part${errs === 1 ? "" : "s"} couldn't be read. See the list under the table.` : "";
  } catch (err) {
    note = reachError(err);
    loadUpdates();
  } finally {
    busy = false;
    redraw();
  }
}

async function pin(repo, dep, pinned) {
  const key = `${repo}\n${dep}`;
  if (pinning.has(key)) return;
  pinning.add(key);
  redraw();
  try {
    const body = await readBody(await fetch(`${API}/api/updates/pin`, {
      method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo, dep, pinned }),
    }));
    data = { ...data, pins: body.pins };
    seen = body.stamp ?? seen;
  } catch (err) {
    note = reachError(err);
  } finally {
    pinning.delete(key);
    redraw();
  }
}

function ensureLoaded() {
  if (!loading && (!data || Date.now() - fetchedAt > STALE_MS)) loadUpdates();
}

function visibleRows(s) {
  return applyFilter(s.rows.map((r) => ({ ...r, repo: r.name })).filter((r) => !isExcludedRepo("updates", r.name)));
}

export const updatesTier = () => (error && !data ? "down" : "manual");

export function updatesCount() {
  const s = summary();
  return s ? visibleRows(s).filter((r) => r.outOfSync).length : null;
}

const repoUrl = (name) => `https://github.com/${encodeURIComponent(data?.scan?.org ?? "GTNewHorizons")}/${encodeURIComponent(name)}`;

function depRepoName(dep) {
  const lower = dep.toLowerCase();
  return data?.scan?.repos?.find((r) => r.name.toLowerCase() === lower)?.name ?? dep;
}

function bsText(r) {
  if (!r.buildscript) return `<span class="sub">—</span>`;
  const v = r.buildscript.kind === "legacy"
    ? `<span title="Old buildscript, no settings convention plugin">legacy <code>${esc(r.buildscript.version)}</code></span>`
    : `<code>${esc(r.buildscript.version)}</code>`;
  if (r.bsStatus === "behind") return `${v} <span class="pill neutral">behind</span>`;
  if (r.bsStatus === "legacy") return `${v} <span class="pill dropped">migrate</span>`;
  return v;
}

function gradleText(r) {
  if (!r.gradle) return `<span class="sub">—</span>`;
  return `<code>${esc(r.gradle)}</code>${r.gradleStatus === "behind" ? ` <span class="pill neutral">behind</span>` : ""}`;
}

function depLine(r, d) {
  const busyPin = pinning.has(`${r.name}\n${d.name}`);
  const latest = d.latest
    ? `<a href="${safeUrl(`${repoUrl(depRepoName(d.name))}/releases/tag/${encodeURIComponent(d.latest)}`)}" target="_blank" rel="noopener"><code>${esc(d.latest)}</code></a>`
    : "";
  const pinBtn = `<button class="ghost upd-pin" data-upd-pin="${esc(r.name)}" data-dep="${esc(d.name)}" data-on="${d.pinned ? 0 : 1}"${busyPin ? " disabled" : ""}
    title="${d.pinned ? "Count this dependency again" : "Stop counting this dependency as behind in this repo"}">${d.pinned ? "Unpin" : "Pin"}</button>`;
  const tag = d.status === "pinned" ? ` <span class="pill draft">pinned</span>` : "";
  return `<li><span class="upd-dep">${esc(d.name)}</span> <code>${esc(d.version)}</code> → ${latest}${tag} ${pinBtn}</li>`;
}

function depsText(r, expanded) {
  const behind = r.depRows.filter((d) => d.status === "behind" || d.status === "pinned");
  if (!r.depRows.length) return `<span class="sub">—</span>`;
  if (!behind.length) return `<span class="sub">${fmt(r.depRows.length)} up to date</span>`;
  const label = `${fmt(r.depsBehind)} behind${r.depsBehind < behind.length ? `, ${behind.length - r.depsBehind} pinned` : ""}`;
  if (!expanded) return r.depsBehind ? `<span class="num">${fmt(r.depsBehind)}</span>` : `<span class="sub">pinned</span>`;
  return `<details class="upd-deps" data-upd-open="${esc(r.name)}"${opened.has(r.name) ? " open" : ""}><summary>${label}</summary><ul>${behind.map((d) => depLine(r, d)).join("")}</ul></details>`;
}

function statusText(r) {
  if (!r.outOfSync) return `<span class="pill open">In sync</span>`;
  const names = { buildscript: "Buildscript", gradle: "Gradle", dependencies: "Deps" };
  return r.reasons.map((k) => `<span class="pill neutral">${names[k]}</span>`).join(" ");
}

const rank = { legacy: 2, behind: 1, ok: 0, none: -1 };

function columns(expanded) {
  const cols = [
    { key: "repo", label: "Repo", render: (r) => `${repoLink(r.name)}${r.fork ? ` <span class="pill draft">fork</span>` : ""}` },
    { key: "buildscript", label: "Buildscript", get: (r) => rank[r.bsStatus], render: bsText },
    { key: "gradle", label: "Gradle", get: (r) => rank[r.gradleStatus], render: gradleText },
    { key: "deps", label: expanded ? "Dependencies" : "Deps behind", get: (r) => r.depsBehind, render: (r) => depsText(r, expanded) },
  ];
  if (expanded) cols.push({ key: "status", label: "Needs", get: (r) => r.reasons.length, sortable: true, render: statusText });
  return cols;
}

function targetsLine(s) {
  const bs = s.target.buildscript;
  const bsText = bs ? (bs.kind === "plugin" ? `buildscript <code>${esc(bs.version)}</code>` : `buildscript <code>${esc(bs.version)}</code> (legacy)`) : "no buildscript found";
  return `Newest in the org: ${bsText} · Gradle ${s.target.gradle ? `<code>${esc(s.target.gradle)}</code>` : "—"}`;
}

function scanLine() {
  const sc = data.scan;
  const skipped = sc.skipped ?? {};
  const bits = [`Scanned ${esc(ago(sc.scannedAt))}${sc.by ? ` by ${esc(sc.by)}` : ""}`];
  bits.push(`${fmt(sc.repos.length)} repos with Gradle files`);
  const left = [
    skipped.noGradle && `${fmt(skipped.noGradle)} without`,
    skipped.archived && `${fmt(skipped.archived)} archived`,
    skipped.excluded && `${fmt(skipped.excluded)} excluded`,
  ].filter(Boolean);
  if (left.length) bits.push(`skipped ${left.join(", ")}`);
  return bits.join(" · ");
}

function togglesHtml() {
  return `<div class="upd-bar">
    <label class="minlabel"><input type="checkbox" data-upd-only${onlyOut ? " checked" : ""}> only out of sync</label>
    <label class="minlabel" title="Off by default: nearly every repo is behind on something, so deps would drown out the buildscript and Gradle gaps"><input type="checkbox" data-upd-deps${countDeps ? " checked" : ""}> count dependencies as out of sync</label>
  </div>`;
}

export function updatesHtml(expanded) {
  ensureLoaded();
  if (!data) {
    if (error) return `<div class="error">${esc(error)}</div>`;
    return `<div class="empty">Loading the last scan…</div>`;
  }
  if (!data.scan) {
    return `<div class="empty">${busy ? "Reading every repo's Gradle files from GitHub. This takes a few seconds…"
      : "Nothing scanned yet. Press <strong>Refresh</strong> to read every repo's buildscript, Gradle wrapper and dependencies."}</div>`;
  }
  const s = summary();
  const cols = columns(expanded);
  const all = visibleRows(s);
  const shown = expanded && !onlyOut ? all : all.filter((r) => r.outOfSync);
  const head = expanded
    ? `<div class="upd-head"><p class="sub">${targetsLine(s)}</p><p class="sub">${scanLine()}</p>${togglesHtml()}</div>`
    : "";
  const errors = expanded && data.scan.errors?.length
    ? `<div class="upd-errors"><p class="sub">Some files couldn't be read, so these repos may show less than they have:</p><ul>${
      data.scan.errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>`
    : "";
  if (!shown.length) {
    const why = all.length ? "Every repo is on the newest buildscript and Gradle." : "No repos match.";
    return `${head}<div class="empty">${why}</div>${errors}`;
  }
  const table = renderTable(expanded ? sortRows(shown, cols) : shown, cols, { sortable: expanded, limit: expanded ? null : 10 });
  return `${head}${table}${errors}`;
}

export function updatesSubHtml() {
  const s = summary();
  if (!s) return `<span class="sub">${busy ? "scanning…" : "buildscript, Gradle and dependencies"}</span>`;
  const c = s.counts;
  const parts = [`${fmt(updatesCount())} of ${fmt(c.repos)} out of sync`];
  if (busy) parts.push("scanning…");
  else parts.push(`scanned ${ago(data.scan.scannedAt)}`);
  return `<span class="sub">${esc(parts.join(" · "))}</span>`;
}

export function updatesControlsHtml() {
  const refresh = `<button class="ghost" data-upd-scan${busy ? " disabled" : ""}
    title="Read every repo's settings.gradle, gradle-wrapper.properties and dependencies.gradle from GitHub again">${
    busy ? "Scanning…" : "Refresh"}</button>${note ? `<span class="minlabel upd-note">${esc(note)}</span>` : ""}`;
  return exclControlsHtml("updates", refresh);
}

globalThis.document?.addEventListener("click", (e) => {
  if (e.target.closest?.("button[data-upd-scan]")) return scan();
  const p = e.target.closest?.("button[data-upd-pin]");
  if (p) {
    e.preventDefault();
    pin(p.dataset.updPin, p.dataset.dep, p.dataset.on === "1");
  }
});

globalThis.document?.addEventListener("change", (e) => {
  if (e.target.matches?.("[data-upd-only]")) {
    onlyOut = e.target.checked;
    remember(ONLY_KEY, onlyOut);
    redraw();
  } else if (e.target.matches?.("[data-upd-deps]")) {
    countDeps = e.target.checked;
    remember(DEPS_KEY, countDeps);
    redraw();
  }
});

globalThis.document?.addEventListener("toggle", (e) => {
  const name = e.target.dataset?.updOpen;
  if (name == null) return;
  if (e.target.open) opened.add(name);
  else opened.delete(name);
}, true);
