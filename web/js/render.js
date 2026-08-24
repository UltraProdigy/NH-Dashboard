import { GRANS, isDrill, state } from "./state.js";
import { controlHtml } from "./module-helpers.js";
import { age, agoText, avatar, daysSince, esc, fmt } from "./format.js";
import {
  A,
  I,
  activeWindow,
  issuePeople,
  labelRows,
  panel,
  windowKey,
  windowList,
} from "./data.js";
import {
  backlogOf,
  queueCounts,
  subject,
  subjectList,
  subjectUrl,
} from "./drilldown-data.js";
import { hasIssues, issuesOf } from "./issue-data.js";
import { opponents } from "./versus-data.js";
import { byLabelCount, exclPopHtml, panelRows } from "./dream.js";
import { contributorRows } from "./contributor-data.js";
import { href } from "./paths.js";
import { PAGES } from "./pages.js";
import { MODULES, tabCountId, tabMembers, tabsFor } from "./modules/index.js";
import { withOwner } from "./table.js";
import { backFrom } from "./router.js";
import { teamsOf } from "./teams.js";

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
  // Whatever the card is actually summing, which is every labelled repo until
  // the chips narrow it. Reading one repo's list here — as this did — put a
  // badge on the tab that disagreed with the table underneath it the moment
  // the selection changed.
  if (id === "iLabels") return labelRows().filter(l => l.open).length || null;
  if (id === "iRepos") return I()?.repos?.filter(r => r.open).length ?? null;
  if (id === "iPeople") return issuePeople().length || null;
  // Null until a subject is picked, which is also when the tabs mean anything.
  // Only the four the drilldown groups borrow a badge from are here — Closed,
  // Biggest, Filed and Triage no longer name a tab, and a count nothing
  // displays is just a query someone will later wonder about.
  if (id === "cPRs" || id === "rBacklog") return subject() ? backlogOf().total : null;
  // The queue, not the assignment log: this badge is meant to read as "things
  // waiting on you", and half the assigned list is PRs that closed years ago.
  if (id === "cReviews") return subject() ? queueCounts().waiting || null : null;
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

/* ==========================================================================
   Cards with nothing behind them
   --------------------------------------------------------------------------
   Most repos in this org have no issue tracker, and most people in it have
   never opened a pull request — 237 of 299 and 5,632 of 6,818 at the time of
   writing. Their drilldowns were rendering the cards anyway, four or five of
   them in a row each saying some version of "nothing here", which buries the
   two or three cards that do have something to say and makes a page about a
   prolific bug reporter look like a page about nobody.

   A module declares `empty()` and returns the sentence explaining why it has
   nothing. The card doesn't render, the tab says so, and opening the tab gives
   you the sentence once rather than four times.
   ========================================================================== */

function emptyReason(id) {
  const m = MODULES[id];
  if (!m.empty) return null;
  // These all read the selected subject. Before one is picked — or before the
  // payload has arrived — there is no question yet for the answer to be empty.
  if (isDrill(state.page) && (state.drillState !== "ready" || !subject())) return null;
  return m.empty() || null;
}

/** The members of a tab that have something to show. */
const liveMembers = (pageId, tab) =>
  tabMembers(pageId, tab).filter(id => !emptyReason(id));

/**
 * Why a whole tab is empty, or null if any of its cards has something.
 *
 * The first member's reason stands for the tab: a group's cards share a data
 * source, so when they're all empty they're all empty for the same reason.
 */
function tabEmpty(pageId, tab) {
  const ids = tabMembers(pageId, tab);
  return ids.length && !liveMembers(pageId, tab).length ? emptyReason(ids[0]) : null;
}

function renderTabs() {
  const page = currentPage();
  document.getElementById("pageTitle").textContent = page.label;
  document.getElementById("tabs").innerHTML =
    `<button data-module="" aria-selected="${state.tab === null}">Overview</button>` +
    tabsFor(page.id).map(t => {
      // Still clickable, and still says what it's for. The tab is how you find
      // out this repo has no tracker, so removing it would hide the answer
      // along with the absence.
      const why = tabEmpty(page.id, t.id);
      if (why)
        return `<button data-module="${esc(t.id)}" aria-selected="${state.tab === t.id}"
          title="${esc(why)}">${esc(t.label)}<span class="count none">none</span></button>`;
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
    // Lazy, and only on the contributor list: this popup holds 60 rows and
    // repaints on every keystroke, so the images have to stay off the wire
    // until they scroll into view.
    const face = state.page === "contributor" ? avatar(o.id, 18) : "";
    return `<div class="combo-opt" role="option" data-pick="${esc(o.id)}"
      aria-selected="${i === state.combo.active}">${face}<span class="n">${name}</span><span class="c">${meta}</span></div>`;
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
 * Nothing at all when there's nowhere to return to.
 *
 * This used to render disabled, to keep the toolbar from shifting as you moved
 * between pages that had a trail and pages that didn't. But a greyed control is
 * still a control: it reads as something you could use and can't work out how,
 * and on a page you opened yourself there is no answer to that question. The
 * shift is one 30px button at the far left, which costs less than the puzzle.
 */
function backButtonHtml() {
  const from = backFrom();
  if (!from) return "";
  const arrow = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M3.4 6.2h6.3a3.4 3.4 0 0 1 0 6.8H6.1"/><path d="M6.2 3.1 3.1 6.2l3.1 3.1"/></svg>`;
  return `<button class="backbtn" id="backBtn" aria-label="Back"
    title="Back to ${esc(placeLabel(from))}">${arrow}</button>`;
}

/**
 * What the search box claims it matches.
 *
 * It said "repo, title, or author" everywhere, which is true of the PR and
 * issue tables and false of Label mix, whose filter only ever looked at the
 * label name. A box that names three fields and matches one reads as broken
 * data rather than a wrong caption, and you go looking for the bug in the
 * wrong place.
 *
 * A module says what it matches with `filterHint`; the default covers the
 * tables that really do take all three. Several modules on screen disagreeing
 * fall back to the bare word, which is at least not a claim.
 */
function filterPlaceholder(ids) {
  const hints = new Set();
  for (const id of ids ?? currentPage().modules) {
    const m = MODULES[id];
    const declared = [...(m.controls ?? []), ...(m.tabControls ?? [])];
    if (declared.includes("filter")) hints.add(m.filterHint ?? "repo, title, or author");
  }
  return hints.size === 1 ? `Filter by ${[...hints][0]}…` : "Filter…";
}

/**
 * Toolbar is per-view: the overview shows whatever its page needs globally,
 * a module tab shows only the controls that module declares.
 */
function renderToolbar() {
  const page = currentPage();
  // The live members, not every declared one: a card that isn't drawn shouldn't
  // put a control in the toolbar, and `alone` below has to agree with what
  // pageBody actually rendered or a grouped card's toggle lands in neither home.
  const ids = state.tab ? liveMembers(page.id, state.tab) : null;
  // Alone in its tab a module gets everything it asks for. On the overview only
  // `controls` are gathered — `tabControls` are ones that would be clutter
  // floating above a grid of cards they only affect one of.
  //
  // A group is the overview's problem again at a smaller scale: a three-way
  // filter in the toolbar that does nothing to two of the three tables under it
  // reads as page-wide and isn't. So `tabControls` only reach the toolbar when
  // there's one card in the tab; grouped, they render in that card's own
  // header instead. See cardControls.
  // `overviewControls` is the mirror of `tabControls`: a control the card needs
  // on the grid and not in its own tab. Pulse is the case it exists for — the
  // card reads one period, its tab is every period side by side, and a period
  // control above that table is a button that changes nothing.
  // Filter is the exception to the grouping rule. The rest of the toggles are
  // one card's opinion and belong in that card's header when it's sharing a
  // tab — but `state.filter` is a single value every table on the page reads,
  // so a box in the toolbar is exactly as page-wide as it looks. Left with the
  // card headers it rendered as nothing at all: the header slot goes through
  // `controlHtml`, which has never known how to draw a search box.
  const alone = ids?.length === 1;
  const wanted = new Set(
    ids
      ? ids.flatMap(id => [
          ...(MODULES[id].controls ?? []),
          ...(MODULES[id].tabControls ?? []).filter(c => alone || c === "filter"),
        ])
      : page.modules.flatMap(id => [
          ...(MODULES[id].controls ?? []),
          ...(MODULES[id].overviewControls ?? []),
        ])
  );
  // Window used to be added here for every org page, on the reasoning that
  // nearly everything reads it. Nearly isn't every: Open backlog, Label mix,
  // Triage state and Needs attention are all "right now" questions with no time
  // axis at all, and Actions load is projected from a fixed sample — five tabs
  // where the control sat there taking clicks and changing nothing.
  // It's a `controls` entry now, declared by the modules that read it, the same
  // as filter and the same as the drilldowns have always done it.
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
    bits.push(`<input type="search" id="filter" placeholder="${
      esc(filterPlaceholder(ids))}" value="${esc(state.filter)}">`);

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
        `<button data-window="${w.id}" data-windowkey="${esc(windowKey())}" aria-pressed="${
          w.id === cur}" title="${esc(w.label)}">${esc(w.short ?? w.label)}</button>`).join("")}</span></span>`);
  }

  // Granularity is not a time range — it's what one bar means — so it keeps
  // its own control, labelled the way the window control used to be so it's
  // obvious the two aren't the same kind of thing.
  if (wanted.has("gran"))
    bits.push(`<span class="minlabel">x-axis
      <span class="seg" id="granSeg">${GRANS.map(g =>
        `<button data-gran="${g.id}" aria-pressed="${state.gran === g.id}">${esc(g.label)}</button>`).join("")}</span></span>`);

  // Any declared control that CONTROL_HTML knows how to draw. Generic rather
  // than a list of names, because these toggles move between homes — a module
  // can decide its filter belongs in its own header instead, and that decision
  // shouldn't also require deleting a line here. `controlHtml` returns "" for
  // the ones handled above, so they can't render twice.
  for (const name of wanted) {
    const html = controlHtml(name);
    if (html) bits.push(html);
  }

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
 *
 * Told whether it's captioning the card or the tab, because the two can be
 * showing different things: Pulse's card is one period against the one before
 * it, and its tab is every period at once.
 */
const cardSub = (m, expanded) =>
  m.subHtml ? m.subHtml(expanded) : `<span class="sub">${esc(m.sub ? m.sub(expanded) : "")}</span>`;

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
  // No See all button on a `tab: false` card: there is nowhere for it to go.
  //
  // "See all →" rather than an up-and-right arrow: this opens the card's own
  // tab on the same page, and ↗ is the mark this dashboard uses for links that
  // leave it — "View on GitHub ↗" sits three lines above it on the drilldowns.
  return `<section class="card" style="--span:${m.span}">
    <header>
      <h2>${esc(m.label)}</h2>
      ${cardSub(m, false)}
      ${cardControls(m)}
      ${m.tab === false ? "" : `<button class="expand" data-open="${id}">See all →</button>`}
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
    <header><h2>${esc(m.label)}</h2>${cardSub(m, true)}${cardControls(m, grouped)}</header>
    <div class="body${m.flush ? " flush" : ""}">${body}</div>
  </section>`;
}

/** Overview grid, or the selected tab's cards stacked full-width. */
function pageBody() {
  const page = currentPage();
  if (state.tab === null) {
    const ids = page.modules.filter(id => !emptyReason(id));
    return `<div class="grid">${ids.map(card).join("")}</div>`;
  }

  const ids = liveMembers(page.id, state.tab);
  // Said once, in one card, rather than four times in four. The tab is
  // reachable on purpose — see renderTabs — so this is the page it lands on.
  if (!ids.length)
    return `<section class="card" style="--span:12"><div class="body"><div class="empty">${
      esc(tabEmpty(page.id, state.tab) ?? "Nothing here.")}</div></div></section>`;

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
      `<button data-pick="${esc(o.id)}">${
        state.page === "contributor" ? avatar(o.id, 18) : ""}${esc(o.id)}</button>`).join("")}</div>
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

  // A repo has no face of its own, so it borrows the org's — one mark that
  // says "GTNewHorizons" once, at the top, instead of on every row below.
  // Squared off, the way GitHub renders org avatars against round user ones.
  const face = what
    ? avatar(state.subject, 44)
    : avatar(state.data.org, 44, "sq");

  // Org teams, riding beside the GitHub link. Only people have them — a repo
  // isn't a member of anything — and most people have none, in which case the
  // strip collapses and the button keeps the right edge to itself.
  const teams = what ? teamsOf(state.subject) : [];
  const badges = teams.length
    ? `<div class="teams">${teams.map(t =>
        `<span class="teambadge" data-tip="${esc(t.name)}"><img src="${t.img}" alt="${esc(t.name)}" loading="lazy" decoding="async"></span>`
      ).join("")}</div>`
    : "";

  const head = `<div class="subject">
    ${face}
    <div class="idcard">
      <h2>${esc(state.subject)}</h2>
      <span class="dates">${bits.join(" · ")}</span>
    </div>
    ${badges}
    <a class="ghost" href="${subjectUrl(state.subject)}" target="_blank" rel="noopener">View on GitHub ↗</a>
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
    // Absolute from the app root, not relative: pushState has moved the
    // document URL to wherever you navigated, and "data/…" resolved against
    // /contributor/Dream-Master is not a file anybody has.
    const res = await fetch(href(`data/${file}`), { cache: "no-store" });
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
