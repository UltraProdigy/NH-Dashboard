import { DREAM_EXCL_DEFAULT, state } from "./state.js";
import { bareRepo, esc } from "./format.js";
import { panel } from "./data.js";

/* ==========================================================================
   Dream Panel filtering
   --------------------------------------------------------------------------
   The page's job is a short list of things somebody should act on. Anything
   that's permanently somebody else's problem — a label that says "the author
   merges this", a repo you don't own — is noise, so it can be switched off
   once rather than skipped over every morning.
   ========================================================================== */

/* `bareRepo` lives up with the formatters — the exclusion list and the repo
   drilldown links both need it, and it has to be defined before the module-scope
   consts that close over it. */

const DREAM_PANELS = ["approvedUnmerged", "changesRequested", "needsRelease", "byLabel"];

/** Every repo that appears anywhere on the Dream Panel, deduped and sorted. */
function dreamRepoOptions() {
  const out = new Set();
  for (const id of DREAM_PANELS) {
    const p = panel(id);
    if (!p?.ok) continue;
    const lists = id === "byLabel" ? Object.values(p.data) : [p.data];
    for (const list of lists) for (const r of list) out.add(bareRepo(r.repo));
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/**
 * Every label that appears on a Dream Panel PR — not just the tracked ones the
 * By-label tab queries. A PR can be excluded by any label it carries, and the
 * "author merge only" case is exactly that: you want it gone from Approved and
 * Changes-requested too, not only from its own tab.
 */
function dreamLabelOptions() {
  const out = new Set(Object.keys(panel("byLabel")?.ok ? panel("byLabel").data : {}));
  for (const id of ["approvedUnmerged", "changesRequested"]) {
    const p = panel(id);
    if (!p?.ok) continue;
    for (const r of p.data) for (const l of r.labels ?? []) out.add(l.name);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

const isExcludedRepo = (repo) => state.dreamExcl.repos.includes(bareRepo(repo));
const isExcludedRow = (r) =>
  isExcludedRepo(r.repo) ||
  (r.labels ?? []).some(l => state.dreamExcl.labels.includes(l.name));

/** Tracked labels the By-label picker should offer — excluded ones drop out. */
const visibleLabels = () => {
  const p = panel("byLabel");
  if (!p?.ok) return [];
  return Object.keys(p.data).filter(k => !state.dreamExcl.labels.includes(k));
};

/** The label actually being shown, falling back when the selection is hidden. */
const activeLabel = () => {
  const vis = visibleLabels();
  return vis.includes(state.label) ? state.label : vis[0] ?? null;
};

function labelPickerHtml() {
  const vis = visibleLabels();
  if (!vis.length) return `<span class="sub">every label is excluded</span>`;
  const cur = activeLabel();
  const p = panel("byLabel");
  return `<select id="labelPicker" class="inline-sel">${vis.map(k =>
    `<option value="${esc(k)}"${k === cur ? " selected" : ""}>${esc(k)} (${
      (p.data[k] ?? []).filter(r => !isExcludedRow(r)).length})</option>`).join("")}</select>`;
}

function panelRows(id) {
  const p = panel(id);
  if (!p?.ok) return [];
  const rows = id === "byLabel" ? (p.data[activeLabel()] ?? []) : p.data;
  return rows.filter(r => !isExcludedRow(r));
}

/* ---- the exclusion popups -----------------------------------------------
   Checkbox lists rather than native <select multiple> boxes: the native control
   is a fixed-height scrolling list that can't show which of 80 repos are ticked
   without scrolling, and ctrl-clicking to deselect one item is a well-known way
   to lose the other nine.

   One popup per kind. They used to share one, as two columns — which meant the
   row layout had to work at half the width, the search inputs needed a
   specificity fight with the global search rule to stop being twice too wide,
   and the toolbar showed a single count that was the sum of two unrelated
   things. Two buttons cost one more slot on a toolbar that has room, and every
   one of those problems stops existing. */

/** One checkbox row. */
const exclOpt = (kind, name, on) => `
  <label class="excl-opt${on ? " on" : ""}">
    <input type="checkbox" data-excl="${kind}" value="${esc(name)}"${on ? " checked" : ""}>
    <span class="nm" title="${esc(name)}">${esc(name)}</span>
  </label>`;

/**
 * The rows for one group: everything currently hidden first, then the rest.
 *
 * Nineteen labels and eighty repos don't fit in a popup, so what you've already
 * excluded would otherwise be somewhere down an alphabetical list you have to
 * scroll to audit. Pinned to the top, "what am I hiding" is the first thing the
 * list answers. The search box filters the unpinned remainder.
 */
function exclListHtml(kind, options) {
  const chosen = state.dreamExcl[kind];
  const q = state.exclQ[kind].trim().toLowerCase();
  const rest = options.filter(o => !chosen.includes(o) && (!q || o.toLowerCase().includes(q)));
  const pinned = [...chosen].sort((a, b) => a.localeCompare(b));

  if (!pinned.length && !rest.length)
    return `<div class="combo-none">${q ? `Nothing matching “${esc(q)}”.` : "Nothing to list."}</div>`;

  return pinned.map(o => exclOpt(kind, o, true)).join("") +
    (pinned.length && rest.length ? `<div class="excl-sep">Everything else</div>` : "") +
    rest.map(o => exclOpt(kind, o, false)).join("");
}

/** The options one group offers, computed on demand from the live panel data. */
const exclOptions = (kind) =>
  kind === "labels" ? dreamLabelOptions() : dreamRepoOptions();

const EXCL_GROUPS = [
  { kind: "repos", label: "Repos", noun: "repos" },
  { kind: "labels", label: "Labels", noun: "labels" },
];

function exclPopHtml(kind) {
  const n = state.dreamExcl[kind].length;
  return `<div class="excl-head">
      <span>${n ? `${n} hidden from every card` : "Hide from every card on this page"}</span>
      <button class="ghost" data-exclclear="${kind}"${n ? "" : " disabled"}>Clear</button>
    </div>
    <div class="excl-search">
      <input type="search" data-exclq="${kind}" autocomplete="off"
             placeholder="Search ${esc(kind)}…" value="${esc(state.exclQ[kind])}">
    </div>
    <div class="excl-list" id="exclList-${kind}">${exclListHtml(kind, exclOptions(kind))}</div>`;
}

/** Repaint one list in place — a full render() would drop the search caret. */
function updateExclList(kind) {
  const el = document.getElementById(`exclList-${kind}`);
  if (el) el.innerHTML = exclListHtml(kind, exclOptions(kind));
}

/** Persisted, so the same handful doesn't have to be re-hidden every morning. */
function saveExclusions() {
  try { localStorage.setItem("nh:dreamExcl", JSON.stringify(state.dreamExcl)); }
  catch { /* private mode, or storage full — the filter still works this session */ }
}

function loadExclusions() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem("nh:dreamExcl")); } catch { /* corrupt */ }
  state.dreamExcl = {
    repos: Array.isArray(saved?.repos) ? saved.repos : [...DREAM_EXCL_DEFAULT.repos],
    labels: Array.isArray(saved?.labels) ? saved.labels : [...DREAM_EXCL_DEFAULT.labels],
  };
}

export {
  EXCL_GROUPS,
  exclPopHtml,
  isExcludedRow,
  labelPickerHtml,
  loadExclusions,
  panelRows,
  saveExclusions,
  updateExclList,
  visibleLabels,
};
