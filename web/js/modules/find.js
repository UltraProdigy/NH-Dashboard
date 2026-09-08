import { state } from "../state.js";
import { age, avatar, contribName, esc, fmt, repoLink } from "../format.js";
import { renderTable, sortRows, withOwner } from "../table.js";
import { ensureFacets, ensureSearch } from "../find-data.js";
import { render as repaint } from "../render.js";

/* ==========================================================================
   Org Search — one card, and it is the page

   Not a grid of cards with a filter over them. The form *is* the content, so
   it renders inside the card rather than in the page toolbar: a toolbar reads
   as something that narrows what is already on screen, and this page's results
   do not exist until the form has been used.
   ========================================================================== */

const TYPE_LABEL = { both: "Everything", issue: "Issues", pr: "Pull requests" };
const STATE_LABEL = { "": "Any state", open: "Open", closed: "Closed", merged: "Merged" };
const SORT_LABEL = {
  updated: "Recently updated", created: "Newest", oldest: "Oldest", comments: "Most discussed",
};

/** The three filters that have a list behind them, and what to call an unset one. */
const COMBOS = {
  repo: { any: "Any repo", placeholder: "any repo" },
  author: { any: "Any author", placeholder: "any author" },
  label: { any: "Any label", placeholder: "any label" },
};

const seg = (key, labels) =>
  `<span class="seg mini">${Object.entries(labels).map(([id, label]) =>
    `<button data-find="${key}" data-val="${esc(id)}" aria-pressed="${
      state.find[key] === id}">${esc(label)}</button>`).join("")}</span>`;

/**
 * What one picker can offer, from the facets the Worker sent.
 *
 * These came out of already-loaded panels until it turned out how little that
 * covered — 21 repos' worth of issue labels, no pull-request labels, and an
 * author list that was really a list of people who had opened a pull request.
 * See `ensureFacets`. The store answers now, so a label is offered if the store
 * has it and not otherwise.
 */
const FACET_KEY = { repo: "repos", author: "authors", label: "labels" };
const optionsFor = (key) => state.findFacets[FACET_KEY[key]] ?? [];

/**
 * The rows a popup is showing.
 *
 * Prefix matches are promoted the way the drilldown's picker promotes them, and
 * for the same reason: the list is pre-sorted by how busy each option is, sort
 * is stable, so typing "gt" puts GT5-Unofficial above a fork with "gt" buried
 * in the middle of its name.
 *
 * Exported because the keyboard handler has to agree with what is on screen
 * about which row is row three.
 */
function findOptions(key = state.findPop.key) {
  if (!key) return [];
  const q = state.findPop.q.trim().toLowerCase();
  const all = optionsFor(key);
  const list = q
    ? all
        .map((o) => ({ ...o, i: o.name.toLowerCase().indexOf(q) }))
        .filter((o) => o.i !== -1)
        .sort((a, b) => (a.i === 0 ? 0 : 1) - (b.i === 0 ? 0 : 1))
    : all;
  // "Any repo" first, always, and it is the only way back to an unset filter:
  // the box is cleared on focus and restored on a click elsewhere, so deleting
  // the text and walking away puts the old value back rather than clearing it.
  return [
    { id: "", label: COMBOS[key].any, count: "" },
    ...list.slice(0, 60).map((o) => ({ id: o.name, count: fmt(o.n) })),
  ];
}

function findPopHtml(key = state.findPop.key) {
  if (state.findFacets.status === "loading")
    return `<div class="combo-none">Loading ${key}s…</div>`;
  if (state.findFacets.status === "down")
    return `<div class="combo-none">The list of ${key}s needs the live API, which isn't answering. Typing a ${key} still filters.</div>`;

  const opts = findOptions(key);
  const q = state.findPop.q.trim().toLowerCase();
  if (opts.length === 1)
    return `<div class="combo-none">No ${key} matching “${esc(state.findPop.q)}”.</div>`;

  return opts.map((o, i) => {
    const text = o.label ?? o.id;
    const at = q && !o.label ? text.toLowerCase().indexOf(q) : -1;
    const name = at === -1 ? esc(text)
      : esc(text.slice(0, at)) + `<mark>${esc(text.slice(at, at + q.length))}</mark>` +
        esc(text.slice(at + q.length));
    // A face on the author rows and nothing on the other two, which is the same
    // rule the drilldown's picker follows: a login is a person and the avatar
    // is how you recognise one at a glance, while a repo and a label are
    // strings. Lazy, because this list repaints on every keystroke and sixty
    // images must not go on the wire until they scroll into view.
    const face = key === "author" && o.id ? avatar(o.id, 18) : "";
    return `<div class="combo-opt" role="option" data-findpick="${esc(o.id)}"
      aria-selected="${i === state.findPop.active}">${face}<span class="n">${
        o.label ? `<span class="sub">${name}</span>` : name}</span><span class="c">${esc(o.count)}</span></div>`;
  }).join("");
}

/**
 * Repaint the popups without going through render().
 *
 * Nothing here may replace the input being typed into. render() rebuilds the
 * card, and a rebuilt input is a *different element* — it loses the focus and
 * the caret, and the click that gave it focus in the first place then lands on
 * a node that is no longer in the document, which the outside-click handler
 * reads as a click on nothing and uses to close what just opened. So opening,
 * typing, arrowing and cancelling all come through here, and only choosing an
 * option — where the focus is being given up anyway — goes through render().
 *
 * All three popups are always in the DOM and hidden, for the same reason the
 * drilldown's picker keeps its one there: a popup that has to be created before
 * it can be shown cannot be shown without a render.
 */
function updateFindPop() {
  for (const pop of document.querySelectorAll("[data-findpop]")) {
    const key = pop.dataset.findpop;
    const open = state.findPop.key === key;
    pop.hidden = !open;
    pop.innerHTML = open ? findPopHtml(key) : "";
    document.querySelector(`input[data-findbox="${key}"]`)
      ?.setAttribute("aria-expanded", String(open));
    if (open)
      pop.querySelector('.combo-opt[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }
}

function closeFindPop() {
  state.findPop.key = null;
  state.findPop.q = "";
  state.findPop.active = 0;
}

const combo = (key) => `<span class="combo" data-findcombo="${key}">
    <input type="search" data-findbox="${key}" autocomplete="off" role="combobox"
           aria-expanded="false" aria-autocomplete="list"
           placeholder="${esc(COMBOS[key].placeholder)}" value="${esc(state.find[key])}">
    <div class="combo-pop" data-findpop="${key}" role="listbox" hidden></div>
  </span>`;

/**
 * open / draft / merged / closed, as a pill.
 *
 * Open is green rather than the muted grey a draft gets, because on this page
 * open is the state you are usually looking *for* — it is the live work, and
 * the one row in a list of fifty worth spotting at a glance.
 *
 * The closed cases follow `OUTCOME_CLASS` in issue-data.js rather than
 * inventing a second opinion: an issue closed as completed is purple like a
 * merged pull request, "not planned" is red, and a duplicate is dashed. A
 * closed pull request that never merged is red for the same reason "not
 * planned" is — the work did not land.
 */
function statePill(r) {
  if (r.state === "OPEN")
    return r.draft
      ? `<span class="pill draft">draft</span>`
      : `<span class="pill open">open</span>`;
  if (r.state === "MERGED") return `<span class="pill merged">merged</span>`;
  if (r.kind === "pr") return `<span class="pill dropped">closed</span>`;
  const why = (r.reason ?? "").toLowerCase();
  if (why === "not_planned") return `<span class="pill dropped">not planned</span>`;
  if (why === "duplicate") return `<span class="pill unknown">duplicate</span>`;
  return `<span class="pill merged">closed</span>`;
}

const stateOrder = (r) => (r.state === "OPEN" ? 0 : r.state === "MERGED" ? 1 : 2);

const COLS = [
  { key: "repo", label: "Repo", render: (r) => repoLink(r.repo) },
  {
    key: "title", label: "Title",
    render: (r) => `<a href="${r.url}" target="_blank" rel="noopener">${
      esc(r.title || `#${r.number}`)}</a> <span class="repo">#${r.number}</span>`,
  },
  {
    // The kinds are mixed by default and a row that does not say which it is
    // sends you to GitHub to find out. Narrow, because it is one word.
    key: "kind", label: "Kind",
    render: (r) => `<span class="repo">${r.kind === "pr" ? "PR" : "issue"}</span>`,
  },
  { key: "author", label: "Author", render: (r) => contribName(r.author ?? "ghost") },
  {
    // Tinted from the endpoint's colour map, the same way COLUMNS.pr tints a
    // pull request's labels. The map is nested by repo because the same label
    // name is a different colour in different repos, and this row knows which
    // one it came from. A name with no colour draws the default border — which
    // is what every chip did before the palettes were swept in, so a gap
    // degrades to the old look rather than to a wrong colour.
    key: "labels", label: "Labels", sortable: false,
    render: (r) => r.labels.length
      ? r.labels.map((n) => {
          const c = state.find.labelColors[r.repo]?.[n];
          return `<span class="label"${c ? ` style="border-color:#${esc(c)}"` : ""}>${esc(n)}</span>`;
        }).join("")
      : `<span class="sub">—</span>`,
  },
  { key: "comments", label: "Comments", render: (r) => `<span class="num">${fmt(r.comments)}</span>` },
  { key: "ageDays", label: "Opened", render: (r) => age(r.ageDays) },
  { key: "staleDays", label: "Updated", render: (r) => age(r.staleDays) },
  { key: "state", label: "State", get: stateOrder, render: statePill },
];

/**
 * What to say instead of a table.
 *
 * The distinction that earns its keep is the outage. This page has no static
 * floor — every other panel keeps the built file underneath it and degrades to
 * stale numbers, but a search has nothing to be stale *from* — so the Worker
 * not answering has to be its own message. An empty table would say "no such
 * issue" about an issue that exists.
 */
function notice() {
  const f = state.find;
  if (f.status === "loading" && !f.rows.length) return `<div class="loading">Searching…</div>`;
  if (f.status === "down")
    return `<div class="error">Org Search reads the database directly rather than a built file, so it needs the live API — and the Worker isn't answering.<br><br>
      The rest of the dashboard is unaffected: it's still showing you the last build. Try again in a moment.</div>`;
  if (f.status === "ready" && !f.rows.length)
    return `<div class="empty">Nothing matches. Titles only — the search doesn't read issue bodies or comments, so a word that appears in the discussion but not the title won't be found here.</div>`;
  return null;
}

/** True when the form is asking for something rather than showing the default. */
const searching = () =>
  !!(state.find.q || state.find.state || state.find.repo || state.find.author || state.find.label);

/**
 * Everything below the form, as its own function.
 *
 * The form and the results repaint on different occasions, and mixing them was
 * the bug this separates out: a fetch resolving mid-word would go through
 * `render()`, replace the card wholesale, and take the focus and the caret with
 * it — so typing "crash" lost the cursor 250ms after the "c". `paint()` in
 * find-data.js swaps only this, leaving the input the user is in untouched.
 *
 * Wrapped in `withOwner` because it can be called from outside `bodyOf`, which
 * is normally what tells table.js whose sort state a table is reading. Without
 * it the header cells render with an empty `data-sortowner` and clicking a
 * column does nothing.
 */
function resultsHtml() {
  return withOwner("find", () => {
    const why = notice();
    if (why) return why;

    const f = state.find;
    const lead = searching()
      ? `${fmt(f.rows.length)}${f.truncated ? "+" : ""} ${f.rows.length === 1 ? "match" : "matches"}`
      : `The ${fmt(f.rows.length)} most recently updated across the org`;

    return renderTable(sortRows(f.rows, COLS), COLS, { sortable: true }) +
      (f.truncated
        ? `<div class="more">${lead}. Narrow it with a repo, an author or a state — there is no page two, on purpose: past fifty rows the filters are the faster way to what you want.</div>`
        : `<div class="hint" style="margin-top:12px">${lead}. Sorting a column reorders what came back, not the whole store — change the sort control to reorder the search itself.</div>`);
  });
}

const findModules = {
  find: {
    page: "find", label: "Org Search", span: 12, tab: false,
    sub: () => "issues and pull requests, by title, straight from the database",

    /**
     * Its own freshness tier, because it has no panel to borrow one from.
     *
     * `direct` is a fifth tier and it is not `instant` renamed. Instant means a
     * panel was rebuilt the moment the webhook landed; this is never rebuilt at
     * all, because there is nothing cached to rebuild — the query reads the
     * same rows the delivery wrote. Same currency, different mechanism, and the
     * tooltip has to be able to say which.
     *
     * It shares instant's green all the same. The colour is the reader's
     * question — is what I am looking at current — and for both the answer is
     * yes, as current as the last delivery.
     */
    tier: () => (state.find.status === "down" ? "down" : "direct"),

    render() {
      // Asked for here rather than in render(), the way the drilldown asks for
      // its index: a deep link into a search has to run it, and this card is
      // the only thing that knows the route changed under it.
      ensureSearch();
      // Same place, same reasoning: this card is the only thing that knows the
      // page is open, and the pickers are empty until the lists arrive.
      //
      // A popup already open when they land is refreshed in place rather than
      // through a repaint, which would take the caret out of the box being
      // typed into — the list can arrive while somebody is staring at
      // "Loading repos…" and typing anyway.
      ensureFacets(() => (state.findPop.key ? updateFindPop() : repaint()));

      // Two rows, and which control goes in which is the distinction between
      // typing and clicking rather than anything about what they filter. The
      // query box is wider than the three beside it because it holds the
      // longest value and is the one the cursor starts in.
      const form = `<div class="findbar">
        <div class="findrow inputs">
          <input type="search" id="find-q" data-findbox="q" autocomplete="off"
                 placeholder="Search titles, or a number…" value="${esc(state.find.q)}">
          ${combo("repo")}
          ${combo("author")}
          ${combo("label")}
        </div>
        <div class="findrow toggles">
          ${seg("type", TYPE_LABEL)}
          ${seg("state", STATE_LABEL)}
          ${seg("sort", SORT_LABEL)}
          <button class="ghost" data-findreset="1">Reset</button>
        </div>
      </div>`;

      return `${form}<div id="findResults">${resultsHtml()}</div>`;
    },
  },
};

export { closeFindPop, findModules, findOptions, resultsHtml, updateFindPop };
