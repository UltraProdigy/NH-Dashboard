import { GRANS, isDrill, state } from "./state.js";
import { controlHtml } from "./module-helpers.js";
import { age, agoText, daysSince, esc, fmt } from "./format.js";
import { A, I, activeWindow, issuePeople, panel, windowList } from "./data.js";
import {
  backlogOf,
  subject,
  subjectList,
  subjectUrl,
} from "./drilldown-data.js";
import { hasIssues, issuesOf } from "./issue-data.js";
import { opponents } from "./versus-data.js";
import { byLabelCount, exclPopHtml, panelRows } from "./dream.js";
import { contributorRows } from "./contributor-data.js";
import { PAGES } from "./pages.js";
import { MODULES, tabCountId, tabMembers, tabsFor } from "./modules/index.js";
import { withOwner } from "./table.js";
import { backFrom } from "./router.js";

/* ==========================================================================
   Counts on tabs
   ========================================================================== */

function moduleCount(id) {
  const m = MODULES[id];
  if (m.panelId) {
    const p = panel(m.panelId);
    if (!p?.ok) return "!";
    // Counts follow the exclusions — a tab badge that disagrees with the list
    // underneath it is worse than no badge.
    return m.panelId === "byLabel" ? byLabelCount() : panelRows(m.panelId).length;
  }
  if (id === "leaderboard") return contributorRows().length;
  if (id === "backlog") return A()?.backlog?.total ?? null;
  if (id === "iTriage") return I()?.triage?.open ?? null;
  // labelsByRepo, not labels — the panel keys labels by repo, because a label
  // taxonomy belongs to one tracker. This counted an array that never existed
  // and quietly showed no badge at all.
  if (id === "iLabels") {
    const d = I();
    const rows = d?.labelsByRepo?.[state.issueLabelRepo ?? d?.labelFocus] ?? null;
    return rows ? rows.filter(l => l.open).length : null;
  }
  if (id === "iRepos") return I()?.repos?.filter(r => r.open).length ?? null;
  if (id === "iPeople") return issuePeople().length || null;
  // Null until a subject is picked, which is also when the tabs mean anything.
  // Only the four the drilldown groups borrow a badge from are here — Closed,
  // Biggest, Filed and Triage no longer name a tab, and a count nothing
  // displays is just a query someone will later wonder about.
  if (id === "cOpenPRs" || id === "rBacklog") return subject() ? backlogOf().total : null;
  if (id === "cIssues" || id === "rIssues")
    return subject() && hasIssues() ? issuesOf().totals.filed : null;
  // The lineup, not counting the subject — "1" on a card comparing nothing is
  // worse than no badge.
  if (id === "cVersus" || id === "rVersus") return opponents().length || null;
  return null;
}

/* ==========================================================================
   Rendering
   ========================================================================== */

const currentPage = () => PAGES.find(p => p.id === state.page) ?? PAGES[0];

function renderSidebar() {
  document.getElementById("pages").innerHTML = PAGES.map(p => `
    <button data-page="${p.id}" aria-current="${p.id === state.page}" title="${esc(p.label)}">
      <svg viewBox="0 0 16 16" fill="currentColor">${p.icon}</svg>
      <span class="plabel">${esc(p.label)}</span>
    </button>`).join("");
}

/**
 * A group's badge is one member's count, named by the group. Summing them
 * would double-count — Biggest PRs overlaps both Open and Closed — and a badge
 * that disagrees with the lists underneath it is worse than no badge.
 */
function tabCount(pageId, tab) {
  const id = tabCountId(pageId, tab);
  return id ? moduleCount(id) : null;
}

function renderTabs() {
  const page = currentPage();
  document.getElementById("pageTitle").textContent = page.label;
  document.getElementById("tabs").innerHTML =
    `<button data-module="" aria-selected="${state.tab === null}">Overview</button>` +
    tabsFor(page.id).map(t => {
      const c = tabCount(page.id, t.id);
      return `<button data-module="${esc(t.id)}" aria-selected="${state.tab === t.id}">${esc(t.label)}${
        c == null ? "" : `<span class="count">${typeof c === "number" ? fmt(c) : c}</span>`}</button>`;
    }).join("");
}

/* ---- the search-and-select popup ---------------------------------------- */

/**
 * Filtered subjects for the popup. The index is pre-sorted by activity, and
 * `sort` is stable, so promoting prefix matches keeps the busiest first within
 * each group — typing "gt" puts GT5-Unofficial above a fork with "gt" buried
 * in the middle of its name.
 */
function comboOptions() {
  const q = state.combo.q.trim().toLowerCase();
  const list = subjectList();
  if (!q) return list.slice(0, 60);

  const hits = [];
  for (const r of list) {
    const i = r.id.toLowerCase().indexOf(q);
    if (i !== -1) hits.push({ ...r, i });
  }
  return hits.sort((a, b) => (a.i === 0 ? 0 : 1) - (b.i === 0 ? 0 : 1)).slice(0, 60);
}

function comboPopHtml() {
  const opts = comboOptions();
  const what = state.page === "contributor" ? "contributor" : "repo";
  if (!opts.length)
    return `<div class="combo-none">No ${what} matching “${esc(state.combo.q)}”.</div>`;

  const q = state.combo.q.trim().toLowerCase();
  return opts.map((o, i) => {
    const at = q ? o.id.toLowerCase().indexOf(q) : -1;
    const name = at === -1 ? esc(o.id)
      : esc(o.id.slice(0, at)) + `<mark>${esc(o.id.slice(at, at + q.length))}</mark>` +
        esc(o.id.slice(at + q.length));
    // Last active, not volume. The totals were already visible on the profile
    // you're about to open; recency is the thing that tells you whether this
    // is the person you meant before you commit to the click.
    //
    // The list is still ranked by total activity — when you type "dre" you
    // want Dream-Master first, not whoever pushed most recently.
    const meta = `Active: ${esc(agoText(daysSince(o.last)))}`;
    return `<div class="combo-opt" role="option" data-pick="${esc(o.id)}"
      aria-selected="${i === state.combo.active}"><span class="n">${name}</span><span class="c">${meta}</span></div>`;
  }).join("");
}

/**
 * Repaint just the popup. Typing must not go through render() — that would
 * redraw every chart on the page on each keystroke.
 */
function updateComboPop() {
  const pop = document.getElementById("comboPop");
  if (!pop) return;
  pop.hidden = !state.combo.open;
  pop.innerHTML = state.combo.open ? comboPopHtml() : "";
  document.getElementById("comboInput")?.setAttribute("aria-expanded", String(state.combo.open));
  if (state.combo.open)
    pop.querySelector('.combo-opt[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
}

function closeCombo() {
  state.combo.open = false;
  state.combo.q = "";
  state.combo.active = 0;
}

/* ---- back to wherever the link was clicked ------------------------------ */

/** "Repo Drilldown · GT5-Unofficial · Activity" — the place, as a person reads it. */
function placeLabel(p) {
  const bits = [PAGES.find(x => x.id === p.page)?.label ?? p.page];
  if (p.subject) bits.push(p.subject);
  const tab = p.tab ? tabsFor(p.page).find(t => t.id === p.tab)?.label : null;
  if (tab) bits.push(tab);
  return bits.join(" · ");
}

/**
 * Disabled rather than hidden when there's nothing to return to: a control that
 * appears and disappears beside the search box shifts everything next to it,
 * and on these two pages that's most of the toolbar.
 */
function backButtonHtml() {
  const from = backFrom();
  const arrow = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M3.4 6.2h6.3a3.4 3.4 0 0 1 0 6.8H6.1"/><path d="M6.2 3.1 3.1 6.2l3.1 3.1"/></svg>`;
  return `<button class="backbtn" id="backBtn" aria-label="Back"${
    from ? ` title="Back to ${esc(placeLabel(from))}"`
         : ` disabled title="Nothing to go back to — you opened this page directly"`
  }>${arrow}</button>`;
}

/**
 * Toolbar is per-view: the overview shows whatever its page needs globally,
 * a module tab shows only the controls that module declares.
 */
function renderToolbar() {
  const page = currentPage();
  const ids = state.tab ? tabMembers(page.id, state.tab) : null;
  // Alone in its tab a module gets everything it asks for. On the overview only
  // `controls` are gathered — `tabControls` are ones that would be clutter
  // floating above a grid of cards they only affect one of.
  //
  // A group is the overview's problem again at a smaller scale: a three-way
  // filter in the toolbar that does nothing to two of the three tables under it
  // reads as page-wide and isn't. So `tabControls` only reach the toolbar when
  // there's one card in the tab; grouped, they render in that card's own
  // header instead. See cardControls.
  const alone = ids?.length === 1;
  const wanted = new Set(
    ids
      ? ids.flatMap(id => [
          ...(MODULES[id].controls ?? []),
          ...(alone ? MODULES[id].tabControls ?? [] : []),
        ])
      : page.modules.flatMap(id => MODULES[id].controls ?? [])
  );
  // Window applies to nearly everything on the org pages. The drilldowns
  // instead let each module declare it, so a tab that ignores the window —
  // all-time Collaboration, the open-PR list — doesn't display a control that
  // changes nothing when you touch it.
  // Filter used to be a hardcoded list of module ids right here, which meant
  // the renderer had to be edited whenever a module changed its mind about
  // filtering — and a grouped tab would have had to test every member against
  // it. It's a `controls` entry like everything else now.
  if (!isDrill(page.id) && page.id !== "dream") wanted.add("window");
  // The subject picker is the whole point of a drilldown page, so it's always
  // there — including before anything is selected, which is when it's needed.
  if (isDrill(page.id)) wanted.add("subject");

  const bits = [];

  if (wanted.has("subject")) {
    bits.push(backButtonHtml());
    const what = state.page === "contributor" ? "contributors" : "repos";
    bits.push(`<span class="combo" id="combo">
      <input type="search" id="comboInput" role="combobox" aria-expanded="${state.combo.open}"
             aria-autocomplete="list" aria-controls="comboPop" autocomplete="off"
             placeholder="Search ${what}…"
             value="${esc(state.combo.open ? state.combo.q : (state.subject ?? ""))}">
      <div class="combo-pop" id="comboPop" role="listbox"${state.combo.open ? "" : " hidden"}>${
        state.combo.open ? comboPopHtml() : ""}</div>
    </span>`);
    // Routes through the same go() the sidebar uses, so the toggle and the
    // sidebar highlight cannot disagree about which mode you're in.
    bits.push(`<span class="seg" id="modeSeg">${
      ["contributor", "repo"].map(m =>
        `<button data-mode="${m}" aria-pressed="${state.page === m}">${m === "contributor" ? "Contributor" : "Repo"}</button>`
      ).join("")}</span>`);
  }

  if (wanted.has("filter"))
    bits.push(`<input type="search" id="filter" placeholder="Filter by repo, title, or author…" value="${esc(state.filter)}">`);

  if (wanted.has("window")) {
    const ws = windowList();
    const cur = activeWindow();
    // The same segmented control on every page. It used to be a dropdown here
    // and a segmented control on the drilldowns, with a *second* range picker
    // beside it driving the charts — two time controls on one toolbar,
    // answering subtly different questions about the same page. One control,
    // one shape, scoping the numbers and the charts together.
    // Labelled for the same reason the x-axis control is: "3m" and "by month"
    // are both short strings of time next to each other, and which one is the
    // range and which one is the bucket size isn't guessable from the buttons.
    bits.push(`<span class="minlabel">period
      <span class="seg" id="windowSeg">${ws.map(w =>
        `<button data-window="${w.id}" aria-pressed="${w.id === cur}" title="${esc(w.label)}">${
          esc(w.short ?? w.label)}</button>`).join("")}</span></span>`);
  }

  // Granularity is not a time range — it's what one bar means — so it keeps
  // its own control, labelled the way the window control used to be so it's
  // obvious the two aren't the same kind of thing.
  if (wanted.has("gran"))
    bits.push(`<span class="minlabel">x-axis
      <span class="seg" id="granSeg">${GRANS.map(g =>
        `<button data-gran="${g.id}" aria-pressed="${state.gran === g.id}">${esc(g.label)}</button>`).join("")}</span></span>`);

  if (wanted.has("closedState")) bits.push(controlHtml("closedState"));

  if (wanted.has("minActivity"))
    bits.push(`<label class="minlabel">min activity <input type="number" id="minActivity" min="0" step="1" value="${state.minActivity}"></label>`);

  const tb = document.getElementById("toolbar");
  tb.innerHTML = bits.join("");
  tb.style.display = bits.length ? "" : "none";

  // A render triggered while the popup is open (changing the window picker,
  // say) rebuilds the input and drops the caret. Put it back.
  if (state.combo.open) {
    const c = document.getElementById("comboInput");
    if (c) { c.focus(); c.setSelectionRange(c.value.length, c.value.length); }
  }
}

/**
 * The line beside a card's title. Usually descriptive text; a module can hand
 * back markup instead when the thing that describes the card *is* a control —
 * By label, whose picker is the only sensible caption for it.
 */
const cardSub = (m) =>
  m.subHtml ? m.subHtml() : `<span class="sub">${esc(m.sub ? m.sub() : "")}</span>`;

/**
 * Controls that belong to one card rather than the page — the Dream filters,
 * and any `tabControls` of a module sharing its tab with others.
 */
const cardControls = (m, grouped = false) =>
  (m.controlsHtml ? m.controlsHtml() : "") +
  (grouped ? (m.tabControls ?? []).map(controlHtml).join("") : "");

/** Renders a module, telling table.js whose sort state to read. */
function bodyOf(m, id, expanded) {
  try { return withOwner(id, () => m.render(expanded)); }
  catch (err) { return `<div class="error">${esc(err.message)}</div>`; }
}

function card(id) {
  const m = MODULES[id];
  const body = bodyOf(m, id, false);
  // `fill` only on the overview: here the card is stretched by its row and the
  // list should take up the slack. In the expanded view the card stands alone,
  // so an unbounded list would just make the page metres long — there the
  // module's own max-height applies.
  //
  // No Expand button on a `tab: false` card: there is nowhere for it to go.
  return `<section class="card" style="--span:${m.span}">
    <header>
      <h2>${esc(m.label)}</h2>
      ${cardSub(m)}
      ${cardControls(m)}
      ${m.tab === false ? "" : `<button class="expand" data-open="${id}">Expand ↗</button>`}
    </header>
    <div class="body${m.flush ? " flush" : ""}${m.fill ? " fill" : ""}${
      m.fillList ? " fill-list" : ""}">${body}</div>
  </section>`;
}

/** One card of an opened tab, full width. */
function expandedCard(id, grouped) {
  const m = MODULES[id];
  const body = bodyOf(m, id, true);
  return `<section class="card" style="--span:12">
    <header><h2>${esc(m.label)}</h2>${cardSub(m)}${cardControls(m, grouped)}</header>
    <div class="body${m.flush ? " flush" : ""}">${body}</div>
  </section>`;
}

/** Overview grid, or the selected tab's cards stacked full-width. */
function pageBody() {
  const page = currentPage();
  if (state.tab === null)
    return `<div class="grid">${page.modules.map(card).join("")}</div>`;

  const ids = tabMembers(page.id, state.tab);
  const grouped = ids.length > 1;
  const cards = ids.map(id => expandedCard(id, grouped)).join("");
  return grouped ? `<div class="stack">${cards}</div>` : cards;
}

/* ---- the exclusion popup ------------------------------------------------
   Rendered into a layer at the end of <body> rather than inside the card whose
   button opened it. A card is `overflow: hidden` so its table can have rounded
   corners, and it's a query container so its KPI strips can size against it —
   between them a popup drawn inside the header is both clipped at the header's
   bottom edge and positioned against the card. Neither is fixable from inside;
   the popup has to be somewhere else in the tree and pointed at the button. */

function renderExclPop() {
  const layer = document.getElementById("popLayer");
  const key = state.exclOpen;
  const btn = key
    ? document.querySelector(`button[data-exclbtn="${CSS.escape(key)}"]`)
    : null;

  // Open, but its button isn't on screen any more — a tab changed underneath
  // it. Nothing to anchor to, so nothing to show.
  if (!key || !btn) {
    layer.innerHTML = "";
    state.exclOpen = null;
    return;
  }

  layer.innerHTML = `<div class="excl-pop" id="exclPop">${exclPopHtml(key)}</div>`;
  positionExclPop();
}

/** Under the button, nudged back on screen at either edge, flipped up if it won't fit below. */
function positionExclPop() {
  const pop = document.getElementById("exclPop");
  const key = state.exclOpen;
  const btn = key && document.querySelector(`button[data-exclbtn="${CSS.escape(key)}"]`);
  if (!pop || !btn) return;

  const r = btn.getBoundingClientRect();
  const { offsetWidth: w, offsetHeight: h } = pop;
  const gap = 4, edge = 8;

  const left = Math.max(edge, Math.min(r.left, window.innerWidth - w - edge));
  const below = r.bottom + gap;
  const top = below + h > window.innerHeight - edge && r.top - gap - h > edge
    ? r.top - gap - h
    : below;

  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
}

/** Nothing selected yet — offer the busiest subjects as a starting point. */
function pickerHtml() {
  const what = state.page === "contributor" ? "contributor" : "repo";
  const missing = state.subject && !subject();
  return `<div class="picker">
    ${missing ? `<div class="error" style="padding:0 0 22px">Nothing named “${esc(state.subject)}” in the ingested data. It may be a bot, or a repo with no pull requests.</div>` : ""}
    <h3>Pick a ${what}</h3>
    <p>Search above, or jump straight to one of the busiest.</p>
    <div class="chips">${subjectList().slice(0, 24).map(o =>
      `<button data-pick="${esc(o.id)}">${esc(o.id)}</button>`).join("")}</div>
  </div>`;
}

function renderDrill(view) {
  // Kicked off lazily on first visit; ensureDrilldown re-renders as it goes.
  if (state.drillState === "idle") return void ensureDrilldown();

  if (state.drillState === "loading") {
    view.innerHTML = `<div class="loading">Loading drilldown data…</div>`;
    return;
  }
  if (state.drillState === "error") {
    view.innerHTML = `<div class="error">Drilldown data unavailable — ${esc(state.drillError)}.<br><br>
      It's built from the local PR store: run <code>npm run ingest</code> then <code>npm run build</code> to generate <code>data/drilldown.json</code>.</div>`;
    return;
  }
  if (!state.subject || !subject()) {
    view.innerHTML = pickerHtml();
    return;
  }

  const s = subject();
  // Built from what the subject actually has rather than a fixed sentence: with
  // issue reporters and triagers among the subjects, "0 PRs authored" was the
  // first thing the page said about a good number of people.
  const iss = issuesOf(s)?.totals;
  const what = state.page === "contributor";
  const bits = [];
  if (s.totalPRs) bits.push(`${fmt(s.totalPRs)} PRs${what ? " authored" : ""}`);
  if (iss?.filed) bits.push(`${fmt(iss.filed)} issues${what ? " filed" : ""}`);
  if (what && iss?.closed) bits.push(`${fmt(iss.closed)} closed`);
  if (what && iss?.responses) bits.push(`${fmt(iss.responses)} first replies`);
  if (!bits.length) bits.push("nothing in the store");
  bits.push(`first ${s.first ? esc(s.first.slice(0, 10)) : "—"}`);
  bits.push(`last active ${age(daysSince(s.last))}`);

  const head = `<div class="subject">
    <h2>${esc(state.subject)}</h2>
    <a class="ghost" href="${subjectUrl(state.subject)}" target="_blank" rel="noopener">View on GitHub ↗</a>
    <span class="dates">${bits.join(" · ")}</span>
  </div>`;

  view.innerHTML = head + pageBody();
}

function render() {
  renderSidebar();
  renderTabs();
  renderToolbar();

  const view = document.getElementById("view");
  if (!state.data) return;

  if (isDrill(state.page)) renderDrill(view);
  else view.innerHTML = pageBody();

  // After the view, never before: the popup is positioned against a button
  // that only exists once the cards have been written out.
  renderExclPop();
}

/* ==========================================================================
   Drilldown data
   --------------------------------------------------------------------------
   drilldown.json is ~2.5 MB and only these two pages need it, so it's fetched
   the first time you land on one and kept for the rest of the session. The
   other three pages never pay for it.
   ========================================================================== */

async function ensureDrilldown() {
  if (state.drillState !== "idle") return;
  state.drillState = "loading";
  render();
  try {
    // The build names the file in dashboard.json rather than the page
    // hardcoding it, so renaming it later can't leave the two out of sync.
    const file = state.data?.panels?.drilldown?.file ?? "drilldown.json";
    const res = await fetch(`data/${file}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.drill = await res.json();
    state.drillState = "ready";
  } catch (err) {
    state.drillState = "error";
    // A build-time failure explains the problem far better than "HTTP 404"
    // does, so prefer it when the panel recorded one.
    state.drillError = state.data?.panels?.drilldown?.error ?? err.message;
  }
  render();
}

export { closeCombo, comboOptions, positionExclPop, render, updateComboPop };
