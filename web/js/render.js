import { CLOSED_LABEL, GRANS, isDrill, state } from "./state.js";
import { age, agoText, daysSince, esc, fmt } from "./format.js";
import { A, I, activeWindow, panel, windowList } from "./data.js";
import {
  biggestRows,
  resolvedRows,
  subject,
  subjectList,
  subjectUrl,
} from "./drilldown-data.js";
import { EXCL_GROUPS, exclPopHtml, isExcludedRow, panelRows, visibleLabels } from "./dream.js";
import { contributorRows } from "./contributor-data.js";
import { PAGES } from "./pages.js";
import { MODULES } from "./modules/index.js";

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
    return m.panelId === "byLabel"
      ? visibleLabels().reduce(
          (n, k) => n + (p.data[k] ?? []).filter(r => !isExcludedRow(r)).length, 0)
      : panelRows(m.panelId).length;
  }
  if (id === "leaderboard") return contributorRows().length;
  if (id === "backlog") return A()?.backlog?.total ?? null;
  if (id === "iTriage") return I()?.triage?.open ?? null;
  if (id === "iLabels") return I()?.labels?.filter(l => l.open).length ?? null;
  if (id === "iRepos") return I()?.repos?.filter(r => r.open).length ?? null;
  // Null until a subject is picked, which is also when the tabs mean anything.
  if (id === "cOpenPRs" || id === "rBacklog") return subject()?.backlog?.total ?? null;
  if (id === "cClosed") return subject() ? resolvedRows().length : null;
  if (id === "cBiggest") return subject() ? biggestRows().length : null;
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

function renderTabs() {
  const page = currentPage();
  document.getElementById("pageTitle").textContent = page.label;
  document.getElementById("tabs").innerHTML =
    `<button data-module="" aria-selected="${state.module === null}">Overview</button>` +
    page.modules.map(id => {
      const c = moduleCount(id);
      return `<button data-module="${id}" aria-selected="${state.module === id}">${esc(MODULES[id].label)}${
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

/**
 * Toolbar is per-view: the overview shows whatever its page needs globally,
 * a module tab shows only the controls that module declares.
 */
function renderToolbar() {
  const page = currentPage();
  const mod = state.module ? MODULES[state.module] : null;
  // On a module's own tab it gets everything it asks for. On the overview only
  // `controls` are gathered — `tabControls` are ones that would be clutter
  // floating above a grid of cards they only affect one of.
  const wanted = new Set(
    mod
      ? [...(mod.controls ?? []), ...(mod.tabControls ?? [])]
      : page.modules.flatMap(id => MODULES[id].controls ?? [])
  );
  // Window applies to nearly everything on the org pages. The drilldowns
  // instead let each module declare it, so a tab that ignores the window —
  // all-time Collaboration, the open-PR list — doesn't display a control that
  // changes nothing when you touch it.
  if (!isDrill(page.id) && page.id !== "dream") wanted.add("window");
  if (mod?.panelId || ["leaderboard", "newcomers", "lapsed", "backlog", "cOpenPRs", "rBacklog", "cClosed", "cBiggest", "actions"].includes(state.module) ||
      page.id === "dream") wanted.add("filter");
  // Page-wide on Dream: it hides rows from every card, so it belongs up here
  // rather than on any one of them.
  if (page.id === "dream") wanted.add("excl");
  // The subject picker is the whole point of a drilldown page, so it's always
  // there — including before anything is selected, which is when it's needed.
  if (isDrill(page.id)) wanted.add("subject");

  const bits = [];

  if (wanted.has("subject")) {
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

  // One button per kind. "Exclusions ▾" hid two unrelated decisions behind one
  // control and gave no clue from the toolbar whether what was hidden was a
  // repo or a label — the count was the sum of both.
  if (wanted.has("excl")) {
    for (const g of EXCL_GROUPS) {
      const open = state.exclOpen === g.kind;
      const n = state.dreamExcl[g.kind].length;
      bits.push(`<span class="combo excl-wrap" data-exclgroup="${g.kind}">
        <button class="ghost excl-btn" data-exclbtn="${g.kind}" aria-expanded="${open}">
          ${esc(g.label)}${n ? ` <span class="count">${n}</span>` : ""} ▾
        </button>
        <div class="combo-pop excl-pop"${open ? "" : " hidden"}>${
          open ? exclPopHtml(g.kind) : ""}</div>
      </span>`);
    }
  }

  if (wanted.has("closedState"))
    bits.push(`<span class="seg" id="closedSeg">${
      Object.entries(CLOSED_LABEL).map(([id, label]) =>
        `<button data-closed="${id}" aria-pressed="${state.closedState === id}">${esc(label)}</button>`
      ).join("")}</span>`);

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

function card(id) {
  const m = MODULES[id];
  let body;
  try { body = m.render(false); }
  catch (err) { body = `<div class="error">${esc(err.message)}</div>`; }
  // `fill` only on the overview: here the card is stretched by its row and the
  // list should take up the slack. In the expanded view the card stands alone,
  // so an unbounded list would just make the page metres long — there the
  // module's own max-height applies.
  return `<section class="card" style="--span:${m.span}">
    <header>
      <h2>${esc(m.label)}</h2>
      ${cardSub(m)}
      <button class="expand" data-open="${id}">Expand ↗</button>
    </header>
    <div class="body${m.flush ? " flush" : ""}${m.fill ? " fill" : ""}">${body}</div>
  </section>`;
}

/** Overview grid, or the one selected module full-width. */
function pageBody() {
  if (state.module === null)
    return `<div class="grid">${currentPage().modules.map(card).join("")}</div>`;

  const m = MODULES[state.module];
  let body;
  try { body = m.render(true); }
  catch (err) { body = `<div class="error">${esc(err.message)}</div>`; }
  return `<section class="card" style="--span:12">
    <header><h2>${esc(m.label)}</h2>${cardSub(m)}</header>
    <div class="body${m.flush ? " flush" : ""}">${body}</div>
  </section>`;
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
  const head = `<div class="subject">
    <h2>${esc(state.subject)}</h2>
    <a class="ghost" href="${subjectUrl(state.subject)}" target="_blank" rel="noopener">View on GitHub ↗</a>
    <span class="dates">${fmt(s.totalPRs)} PRs${
      state.page === "contributor" ? " authored" : ""} · first ${
      s.first ? esc(s.first.slice(0, 10)) : "—"} · last active ${age(daysSince(s.last))}</span>
  </div>`;

  view.innerHTML = head + pageBody();
}

function render() {
  renderSidebar();
  renderTabs();
  renderToolbar();

  const view = document.getElementById("view");
  if (!state.data) return;

  if (isDrill(state.page)) return renderDrill(view);
  view.innerHTML = pageBody();
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

export { closeCombo, comboOptions, render, updateComboPop };
