import {
  DREAM_EXCL_DEFAULT,
  DREAM_EXCL_KINDS,
  DREAM_LABELS_DEFAULT,
  DREAM_LABELS_MAX,
  state,
} from "./state.js";
import { age, bareRepo, esc, fmt, repoHref } from "./format.js";
import { panel } from "./data.js";
import { applyFilter } from "./table.js";

/* ==========================================================================
   Dream Panel filtering
   --------------------------------------------------------------------------
   The page's job is a short list of things somebody should act on. Anything
   that's permanently somebody else's problem — a label that says "the author
   merges this", a repo you don't own — is noise, so it can be switched off
   once rather than skipped over every morning.

   Each card keeps its own list. The cards ask different questions and the
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

/** Tracked labels the By-label columns can be set to — excluded ones drop out. */
const visibleLabels = () => {
  const p = panel("byLabel");
  if (!p?.ok) return [];
  return Object.keys(p.data).filter(k => !exclOf("byLabel").labels.includes(k));
};

function panelRows(id) {
  const p = panel(id);
  if (!p?.ok) return [];
  return p.data.filter(r => !isExcludedRow(id, r));
}

/* ==========================================================================
   By label: several labels at once
   --------------------------------------------------------------------------
   One label at a time behind a dropdown made the card answer a question nobody
   was asking — "what's tagged X" — when the actual question is which of the
   handful of labels that gate a merge has something sitting under it this
   morning. So the card is the width of the page and every label it's watching
   gets a column, each one swappable and removable on its own.
   ========================================================================== */

/**
 * The columns actually drawn: what's saved, minus anything now excluded.
 *
 * Each carries its index in `state.dreamLabels` rather than its position on
 * screen, because the two come apart the moment a label is excluded — and the
 * remove button has to reach the right entry, not the one two along.
 */
const selectedColumns = () => {
  const vis = new Set(visibleLabels());
  return state.dreamLabels
    .map((label, i) => ({ label, i }))
    .filter(c => vis.has(c.label));
};

const selectedLabels = () => selectedColumns().map(c => c.label);

/** One column's rows, after this card's repo exclusions and the toolbar filter. */
function labelRows(label) {
  const p = panel("byLabel");
  if (!p?.ok) return [];
  return applyFilter((p.data[label] ?? []).filter(r => !isExcludedRow("byLabel", r)));
}

/**
 * Distinct PRs across the selected columns, for the tab badge.
 *
 * Distinct rather than summed: a PR tagged both Affects Balance and Requires
 * Admin is one thing to deal with, and a badge that counts it twice disagrees
 * with the card underneath it.
 */
function byLabelCount() {
  const seen = new Set();
  for (const l of selectedLabels()) for (const r of labelRows(l)) seen.add(r.url);
  return seen.size;
}

/* ---- the column controls ------------------------------------------------ */

/** Labels a given column may switch to: everything visible, minus the other columns'. */
function labelOptions(cur) {
  const taken = new Set(selectedLabels().filter(l => l !== cur));
  return visibleLabels().filter(l => !taken.has(l));
}

/** The first label nothing is showing yet, or null when they're all up. */
const nextFreeLabel = () => {
  const taken = new Set(selectedLabels());
  return visibleLabels().find(l => !taken.has(l)) ?? null;
};

function setLabelColumn(i, name) {
  if (i < 0 || i >= state.dreamLabels.length) return;
  state.dreamLabels[i] = name;
  saveLabels();
}

function addLabelColumn() {
  const next = nextFreeLabel();
  if (!next || state.dreamLabels.length >= DREAM_LABELS_MAX) return;
  state.dreamLabels.push(next);
  saveLabels();
}

function removeLabelColumn(i) {
  state.dreamLabels.splice(i, 1);
  saveLabels();
}

/**
 * Whether the card is untouched, which is what greys its Reset out. Covers the
 * columns and both exclusion lists — the button puts the whole card back, so
 * it has to be lit whenever any part of it has moved.
 */
function labelCardIsDefault() {
  const cur = state.dreamLabels;
  return cur.length === DREAM_LABELS_DEFAULT.length &&
    cur.every((l, i) => l === DREAM_LABELS_DEFAULT[i]) &&
    isDefault(exclKey("byLabel", "repos")) &&
    isDefault(exclKey("byLabel", "labels"));
}

function resetLabelCard() {
  state.dreamLabels = [...DREAM_LABELS_DEFAULT];
  resetExclusions(exclKey("byLabel", "repos"));
  resetExclusions(exclKey("byLabel", "labels"));
  saveLabels();
}

/** Add and Reset, which sit alongside this card's two exclusion buttons. */
function labelCardControlsHtml() {
  const full = state.dreamLabels.length >= DREAM_LABELS_MAX || !nextFreeLabel();
  return `<button class="ghost excl-btn" data-labeladd
      ${full ? "disabled" : ""} title="${full ? "Every tracked label is already up" : "Watch another label"}">+ Label</button>
    <button class="ghost excl-btn" data-labelreset
      ${labelCardIsDefault() ? "disabled" : ""} title="Back to the labels and filters this card ships with">Reset</button>`;
}

/* ---- the card ----------------------------------------------------------- */

/**
 * One PR, as two lines rather than a table row. A column is ~260px wide and
 * six table columns don't fit in that; the title is the thing you're reading
 * and the repo and the age are what tell you whether it's yours and whether
 * it's been there a while.
 */
const labelRowHtml = (r) => `
  <div class="bl-row">
    <a class="t" href="${r.url}" target="_blank" rel="noopener" title="${esc(r.title)}">${esc(r.title)}</a>
    <div class="m"><a class="repo" href="${repoHref(r.repo)}" data-drilllink
        title="${esc(r.repo)}">${esc(bareRepo(r.repo))}</a><span class="sep">·</span>${age(r.ageDays)}${
      r.draft ? `<span class="label">draft</span>` : ""}</div>
  </div>`;

function labelColumnHtml(label, i, limit) {
  const rows = labelRows(label);
  const shown = limit ? rows.slice(0, limit) : rows;
  const rest = rows.length - shown.length;
  const opts = labelOptions(label).map(l =>
    `<option value="${esc(l)}"${l === label ? " selected" : ""}>${esc(l)}</option>`).join("");

  return `<section class="bl-col">
    <header>
      <select class="inline-sel" data-labelcol="${i}">${opts}</select>
      <span class="count">${fmt(rows.length)}</span>
      <button class="ghost bl-del" data-labeldel="${i}" title="Stop watching this label" aria-label="Remove ${esc(label)}">×</button>
    </header>
    <div class="bl-list">${
      shown.length ? shown.map(labelRowHtml).join("")
        : `<div class="empty">Nothing here.</div>`}</div>
    ${rest > 0 ? `<div class="more">+ ${fmt(rest)} more</div>` : ""}
  </section>`;
}

/**
 * The card body. Collapsed it shows the first few of each column, which is
 * what fits beside three other cards; expanded it shows the lot.
 */
function byLabelHtml(expanded) {
  const p = panel("byLabel");
  if (!p) return `<div class="empty">Not in this build yet — run <code>npm run build</code>.</div>`;
  if (!p.ok) return `<div class="error">This panel failed to build:<br>${esc(p.error)}</div>`;

  const cols = selectedColumns();
  if (!cols.length)
    return `<div class="empty">No labels selected. Add one from this card's header.</div>`;

  return `<div class="bl-cols">${
    cols.map(c => labelColumnHtml(c.label, c.i, expanded ? null : 6)).join("")}</div>`;
}

/* ---- the controls in a card header --------------------------------------
   The buttons sit on the card they filter. They used to sit on the page
   toolbar, which is where a control that changes the whole page belongs — and
   these don't: hiding a repo from Needs a release should say nothing about
   whether you want to see its open PRs. A control that far from what it
   affects also reads as page-wide, which is exactly what it was. */

function exclControlsHtml(panelId, extra = "") {
  const kinds = DREAM_EXCL_KINDS[panelId];
  if (!kinds) return "";
  const ex = exclOf(panelId);
  return `<span class="card-filters">${extra}${kinds.map(kind => {
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
      <button class="ghost" data-exclreset="${esc(key)}"${
        isDefault(key) ? " disabled" : ""} title="Back to the list this card ships with">Reset</button>
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

/** The list this card ships with. */
const defaultFor = (panelId, kind) => DREAM_EXCL_DEFAULT[panelId]?.[kind] ?? [];

/** Whether a list is already the default, which is what greys Reset out. */
function isDefault(key) {
  const [panelId, kind] = splitKey(key);
  const cur = exclOf(panelId)[kind];
  const def = defaultFor(panelId, kind);
  if (cur.length !== def.length) return false;
  const have = new Set(cur);
  return def.every(o => have.has(o));
}

function resetExclusions(key) {
  const [panelId, kind] = splitKey(key);
  exclOf(panelId)[kind] = [...defaultFor(panelId, kind)];
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

/* By label's columns save under their own key for the same reason the
   exclusions do: it's a different question with a different shape, and an empty
   list is a decision — you removed every column — rather than "never set". */

const LABELS_KEY = "nh:dreamLabels:v1";

function saveLabels() {
  try { localStorage.setItem(LABELS_KEY, JSON.stringify(state.dreamLabels)); }
  catch { /* private mode, or storage full — the card still works this session */ }
}

function loadLabels() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(LABELS_KEY)); } catch { /* corrupt */ }
  state.dreamLabels = Array.isArray(saved)
    ? saved.filter(x => typeof x === "string").slice(0, DREAM_LABELS_MAX)
    : [...DREAM_LABELS_DEFAULT];
}

export {
  addLabelColumn,
  byLabelCount,
  byLabelHtml,
  clearExclusions,
  exclControlsHtml,
  exclPopHtml,
  labelCardControlsHtml,
  loadExclusions,
  loadLabels,
  panelRows,
  removeLabelColumn,
  resetExclusions,
  resetLabelCard,
  setLabelColumn,
  toggleExclusion,
  updateExclList,
  visibleLabels,
};
