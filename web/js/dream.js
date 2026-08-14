import { DREAM_EXCL_DEFAULT, DREAM_EXCL_KINDS, state } from "./state.js";
import { bareRepo, esc } from "./format.js";
import { panel } from "./data.js";

/* ==========================================================================
   Dream Panel filtering
   --------------------------------------------------------------------------
   The page's job is a short list of things somebody should act on. Anything
   that's permanently somebody else's problem — a label that says "the author
   merges this", a repo you don't own — is noise, so it can be switched off
   once rather than skipped over every morning.

   Each card keeps its own list. The four cards ask different questions and the
   same repo can be noise in one and the point of another: nobody here cuts
   DreamAssemblerXXL's releases, but a PR sitting approved in it still wants
   looking at. One page-wide list forced those two answers to be the same.
   ========================================================================== */

/* `bareRepo` lives up with the formatters — the exclusion list and the repo
   drilldown links both need it, and it has to be defined before the module-scope
   consts that close over it. */

const DREAM_PANELS = Object.keys(DREAM_EXCL_KINDS);

const KIND_LABEL = { repos: "Repos", labels: "Labels" };

/** "<panelId>:<kind>" — the id a button, a popup and a search box share. */
const exclKey = (panelId, kind) => `${panelId}:${kind}`;
const splitKey = (key) => {
  const i = key.indexOf(":");
  return [key.slice(0, i), key.slice(i + 1)];
};

/** The list one card hides, created on demand so a new card can't read undefined. */
function exclOf(panelId) {
  const cur = state.dreamExcl[panelId];
  if (cur) return cur;
  return (state.dreamExcl[panelId] = { repos: [], labels: [] });
}

/* ---- what a card offers -------------------------------------------------
   Two groups, in this order: what's on this card, then everything else the
   build knows about. The second group is what makes a filter usable before
   the fact — half the repos worth hiding from Approved have no PR open in it
   today, and a list that only offers what's currently on screen can't be told
   about them until the morning they show up. */

/** Bare repo names appearing on one card, unfiltered. */
function panelRepos(panelId) {
  const p = panel(panelId);
  if (!p?.ok) return [];
  const lists = panelId === "byLabel" ? Object.values(p.data) : [p.data];
  const out = new Set();
  for (const list of lists) for (const r of list) out.add(bareRepo(r.repo));
  return [...out];
}

/** Every repo the build touched — the CI panel walks the whole org. */
function orgRepos() {
  const p = panel("ciHealth");
  return p?.ok ? Object.keys(p.data.repos ?? {}) : [];
}

/** Label names on one card. By label is keyed by label; the PR cards carry them per row. */
function panelLabels(panelId) {
  const p = panel(panelId);
  if (!p?.ok) return [];
  if (panelId === "byLabel") return Object.keys(p.data);
  const out = new Set();
  for (const r of p.data) for (const l of r.labels ?? []) out.add(l.name);
  return [...out];
}

/** Every label the Dream Panel has seen, plus the tracked ones it queries for. */
function allLabels() {
  const out = new Set(state.data?.trackedLabels ?? []);
  for (const id of DREAM_PANELS) for (const l of panelLabels(id)) out.add(l);
  return [...out];
}

const byName = (a, b) => a.localeCompare(b);

/** `{ here, rest }` for one popup, both sorted and disjoint. */
function exclOptions(panelId, kind) {
  const here = kind === "repos" ? panelRepos(panelId) : panelLabels(panelId);
  const all = kind === "repos" ? orgRepos() : allLabels();
  const seen = new Set(here);
  return {
    here: [...here].sort(byName),
    rest: all.filter(o => !seen.has(o)).sort(byName),
  };
}

/* ---- filtering ---------------------------------------------------------- */

const isExcludedRow = (panelId, r) => {
  const ex = exclOf(panelId);
  return ex.repos.includes(bareRepo(r.repo)) ||
    (r.labels ?? []).some(l => ex.labels.includes(l.name));
};

/** Tracked labels the By-label picker should offer — excluded ones drop out. */
const visibleLabels = () => {
  const p = panel("byLabel");
  if (!p?.ok) return [];
  return Object.keys(p.data).filter(k => !exclOf("byLabel").labels.includes(k));
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
      (p.data[k] ?? []).filter(r => !isExcludedRow("byLabel", r)).length})</option>`).join("")}</select>`;
}

function panelRows(id) {
  const p = panel(id);
  if (!p?.ok) return [];
  const rows = id === "byLabel" ? (p.data[activeLabel()] ?? []) : p.data;
  return rows.filter(r => !isExcludedRow(id, r));
}

/** Rows on one card counting every visible label, for the By-label tab badge. */
function byLabelCount() {
  const p = panel("byLabel");
  if (!p?.ok) return 0;
  return visibleLabels().reduce(
    (n, k) => n + (p.data[k] ?? []).filter(r => !isExcludedRow("byLabel", r)).length, 0);
}

/* ---- the controls in a card header --------------------------------------
   The buttons sit on the card they filter. They used to sit on the page
   toolbar, which is where a control that changes the whole page belongs — and
   these don't: hiding a repo from Needs a release should say nothing about
   whether you want to see its open PRs. A control that far from what it
   affects also reads as page-wide, which is exactly what it was. */

function exclControlsHtml(panelId) {
  const kinds = DREAM_EXCL_KINDS[panelId];
  if (!kinds) return "";
  const ex = exclOf(panelId);
  return `<span class="card-filters">${kinds.map(kind => {
    const key = exclKey(panelId, kind);
    const n = ex[kind].length;
    return `<button class="ghost excl-btn" data-exclbtn="${esc(key)}"
      aria-expanded="${state.exclOpen === key}">${KIND_LABEL[kind]}${
      n ? ` <span class="count">${n}</span>` : ""} ▾</button>`;
  }).join("")}</span>`;
}

/* ---- the exclusion popups -----------------------------------------------
   Checkbox lists rather than native <select multiple> boxes: the native control
   is a fixed-height scrolling list that can't show which of 80 repos are ticked
   without scrolling, and ctrl-clicking to deselect one item is a well-known way
   to lose the other nine.

   The row pins its checkbox with absolute positioning and leaves the name an
   ordinary block. Both a grid with a fixed first track and a flex line with a
   non-shrinking box looked equivalent and weren't — each ended up handing the
   free space to the wrong place and dropping the box in the middle of the row
   with the name squeezed against the right edge. Neither construction is used
   here any more: there is no free space to distribute, so there is nothing to
   distribute wrongly. */

/** One checkbox row. */
const exclOpt = (key, name, on) => `
  <label class="excl-opt${on ? " on" : ""}">
    <input type="checkbox" data-excl="${esc(key)}" value="${esc(name)}"${on ? " checked" : ""}>
    <span class="nm" title="${esc(name)}">${esc(name)}</span>
  </label>`;

/**
 * The rows for one popup: everything currently hidden first, then what's on
 * this card, then the rest of the org.
 *
 * Eighty repos don't fit in a popup, so what you've already excluded would
 * otherwise be somewhere down an alphabetical list you have to scroll to audit.
 * Pinned to the top, "what am I hiding" is the first thing the list answers.
 * The search box filters the two unpinned groups.
 */
function exclListHtml(key) {
  const [panelId, kind] = splitKey(key);
  const chosen = exclOf(panelId)[kind];
  const q = (state.exclQ[key] ?? "").trim().toLowerCase();
  const { here, rest } = exclOptions(panelId, kind);
  const keep = (o) => !chosen.includes(o) && (!q || o.toLowerCase().includes(q));

  const pinned = [...chosen].sort(byName);
  const onCard = here.filter(keep);
  const elsewhere = rest.filter(keep);

  if (!pinned.length && !onCard.length && !elsewhere.length)
    return `<div class="combo-none">${q ? `Nothing matching “${esc(q)}”.` : "Nothing to list."}</div>`;

  const group = (title, list) =>
    list.length ? `<div class="excl-sep">${title}</div>` + list.map(o => exclOpt(key, o, false)).join("") : "";

  return pinned.map(o => exclOpt(key, o, true)).join("") +
    group("On this card", onCard) +
    group("Elsewhere in the org", elsewhere);
}

function exclPopHtml(key) {
  const [panelId, kind] = splitKey(key);
  const n = exclOf(panelId)[kind].length;
  return `<div class="excl-head">
      <span>${n ? `${n} hidden from this card` : "Hide from this card"}</span>
      <button class="ghost" data-exclclear="${esc(key)}"${n ? "" : " disabled"}>Clear</button>
    </div>
    <div class="excl-search">
      <input type="search" data-exclq="${esc(key)}" autocomplete="off"
             placeholder="Search ${esc(kind)}…" value="${esc(state.exclQ[key] ?? "")}">
    </div>
    <div class="excl-list" id="exclList">${exclListHtml(key)}</div>`;
}

/** Repaint the open list in place — a full render() would drop the search caret. */
function updateExclList(key) {
  const el = document.getElementById("exclList");
  if (el) el.innerHTML = exclListHtml(key);
}

/** Toggle one name in one card's list. */
function toggleExclusion(key, name, on) {
  const [panelId, kind] = splitKey(key);
  const list = exclOf(panelId)[kind];
  const i = list.indexOf(name);
  if (on) { if (i === -1) list.push(name); }
  else if (i !== -1) list.splice(i, 1);
  saveExclusions();
}

function clearExclusions(key) {
  const [panelId, kind] = splitKey(key);
  exclOf(panelId)[kind] = [];
  saveExclusions();
}

/* ---- persistence --------------------------------------------------------
   Its own key rather than the old one: the saved shape changed from one list
   per page to one per card, and a half-read old value would have silently
   applied Angelica to everything and nothing else to anything. */

const STORE_KEY = "nh:dreamExcl:v2";

function saveExclusions() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state.dreamExcl)); }
  catch { /* private mode, or storage full — the filter still works this session */ }
}

/**
 * A card falls back to its defaults only when it has nothing saved at all.
 * An empty saved list is a decision — you unticked everything — and has to
 * survive a reload rather than being read as "never set".
 */
function loadExclusions() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY)); } catch { /* corrupt */ }
  const arr = (v) => (Array.isArray(v) ? v.filter(x => typeof x === "string") : null);

  state.dreamExcl = {};
  for (const id of DREAM_PANELS) {
    const def = DREAM_EXCL_DEFAULT[id] ?? { repos: [], labels: [] };
    const got = saved?.[id];
    state.dreamExcl[id] = {
      repos: arr(got?.repos) ?? [...def.repos],
      labels: arr(got?.labels) ?? [...def.labels],
    };
  }
}

export {
  byLabelCount,
  clearExclusions,
  exclControlsHtml,
  exclPopHtml,
  labelPickerHtml,
  loadExclusions,
  panelRows,
  toggleExclusion,
  updateExclList,
  visibleLabels,
};
