import { state } from "../state.js";
import { age, contribName, esc, fmt, repoLink } from "../format.js";
import { renderTable, sortRows, withOwner } from "../table.js";
import { A, I, panel } from "../data.js";
import { asked, ensureSearch } from "../find-data.js";

/* ==========================================================================
   Find — one card, and it is the page

   Not a grid of cards with a filter over them. The form *is* the content, so
   it renders inside the card rather than in the page toolbar: a toolbar reads
   as something that narrows what is already on screen, and until you type
   there is nothing on screen to narrow.
   ========================================================================== */

const TYPE_LABEL = { both: "Everything", issue: "Issues", pr: "Pull requests" };
const STATE_LABEL = { "": "Any state", open: "Open", closed: "Closed", merged: "Merged" };
const SORT_LABEL = {
  updated: "Recently updated", created: "Newest", oldest: "Oldest", comments: "Most discussed",
};

const seg = (key, labels) =>
  `<span class="seg mini">${Object.entries(labels).map(([id, label]) =>
    `<button data-find="${key}" data-val="${esc(id)}" aria-pressed="${
      state.find[key] === id}">${esc(label)}</button>`).join("")}</span>`;

const box = (key, placeholder, list = null) =>
  `<input type="search" id="find-${key}" data-findbox="${key}" autocomplete="off"
     placeholder="${esc(placeholder)}" value="${esc(state.find[key])}"
     ${list ? `list="${list}"` : ""}>`;

/**
 * Options for the repo and author boxes, out of panels the page has already
 * paid for.
 *
 * Nothing is fetched to build these. The drilldown index carries a complete
 * repo list and is 470 KB that only two pages load, and downloading it to
 * populate an autocomplete would undo the laziness it was given deliberately.
 * A `<datalist>` is a suggestion rather than a constraint anyway — a repo it
 * has never heard of still searches perfectly well — so an incomplete list
 * costs a hint, not an answer.
 */
function options() {
  const repos = new Set();
  for (const r of I()?.repos ?? []) repos.add(r.repo);
  for (const r of A()?.repos ?? []) repos.add(r.repo ?? r);

  const labels = new Set();
  for (const list of Object.values(I()?.labelsByRepo ?? {}))
    for (const l of list) labels.add(l.name);

  const people = (panel("contributors")?.ok ? panel("contributors").data.rows ?? [] : [])
    .map((r) => r.login);

  return {
    repos: [...repos].sort((a, b) => a.localeCompare(b)),
    labels: [...labels].sort((a, b) => a.localeCompare(b)),
    // Already ordered by activity, which is the order worth keeping: the
    // person you mean is far more often one of the busy ones.
    people: people.slice(0, 500),
  };
}

const datalist = (id, items) =>
  `<datalist id="${id}">${items.map((v) => `<option value="${esc(v)}">`).join("")}</datalist>`;

/** open / closed / merged / draft, as the pill the rest of the dashboard uses. */
function statePill(r) {
  if (r.state === "OPEN")
    return r.draft
      ? `<span class="pill draft">draft</span>`
      : `<span class="pill draft">open</span>`;
  if (r.state === "MERGED") return `<span class="pill merged">merged</span>`;
  if (r.kind === "pr") return `<span class="pill dropped">closed</span>`;
  const why = (r.reason ?? "").toLowerCase();
  if (why === "not_planned") return `<span class="pill dropped">not planned</span>`;
  if (why === "duplicate") return `<span class="pill unknown">duplicate</span>`;
  return `<span class="pill ready">closed</span>`;
}

const stateOrder = (r) =>
  r.state === "OPEN" ? 0 : r.state === "MERGED" ? 1 : 2;

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
    key: "labels", label: "Labels", sortable: false,
    render: (r) => r.labels.length
      ? r.labels.map((n) => `<span class="label">${esc(n)}</span>`).join("")
      : `<span class="sub">—</span>`,
  },
  { key: "comments", label: "Comments", render: (r) => `<span class="num">${fmt(r.comments)}</span>` },
  { key: "ageDays", label: "Opened", render: (r) => age(r.ageDays) },
  { key: "staleDays", label: "Updated", render: (r) => age(r.staleDays) },
  { key: "state", label: "State", get: stateOrder, render: statePill },
];

/**
 * What to say instead of a table, which is four different things.
 *
 * The distinction that earns its keep is the last one. This page has no static
 * floor — every other panel keeps the built file underneath it and degrades to
 * stale numbers, but a search has nothing to be stale *from* — so the Worker
 * not answering has to be its own message. An empty table would say "no such
 * issue" about an issue that exists.
 */
function notice() {
  const f = state.find;
  if (!asked()) {
    return `<div class="empty">Type a word from a title, or pick a filter.
      Numbers work too — <code>4821</code> or <code>#4821</code> goes straight to that issue or PR.</div>`;
  }
  if (f.status === "loading" && !f.rows.length) return `<div class="loading">Searching…</div>`;
  if (f.status === "down")
    return `<div class="error">Search reads the database directly rather than a built file, so it needs the live API — and the Worker isn't answering.<br><br>
      The rest of the dashboard is unaffected: it's still showing you the last build. Try again in a moment.</div>`;
  if (f.status === "ready" && !f.rows.length)
    return `<div class="empty">Nothing matches. Titles only — the search doesn't read issue bodies or comments, so a word that appears in the discussion but not the title won't be found here.</div>`;
  return null;
}

/**
 * Everything below the form, as its own function.
 *
 * The form and the results repaint on different occasions, and mixing them was
 * the bug this separates out: a fetch resolving mid-word would go through
 * `render()`, replace the toolbar and the card wholesale, and take the focus
 * and the caret with it — so typing "crash" lost the cursor 250ms after the
 * "c". `paint()` in find-data.js swaps only this, leaving the input the user is
 * in untouched.
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
    return renderTable(sortRows(f.rows, COLS), COLS, { sortable: true }) +
      (f.truncated
        ? `<div class="more">Showing the first ${fmt(f.rows.length)}. Narrow it with a repo, an author or a state — there is no page two, on purpose: past fifty rows the filters are the faster way to what you want.</div>`
        : `<div class="hint" style="margin-top:12px">${fmt(f.rows.length)} ${
            f.rows.length === 1 ? "match" : "matches"}. Sorting a column reorders what came back, not the whole store — change the sort control to reorder the search itself.</div>`);
  });
}

const findModules = {
  find: {
    page: "find", label: "Search", span: 12, tab: false,
    sub: () => "issues and pull requests, by title, straight from the database",
    render() {
      // Asked for here rather than in render(), the way the drilldown asks for
      // its index: a deep link into a search has to run it, and this card is
      // the only thing that knows the route changed under it.
      ensureSearch();

      const opt = options();
      // The Clear button is always drawn rather than appearing once there is
      // something to clear. A control that comes and goes as you type would
      // reflow the row under the cursor, and this row is where the cursor is.
      const form = `<div class="findbar">
        <input type="search" id="find-q" data-findbox="q" autocomplete="off"
               class="wide" placeholder="Search titles, or a number…" value="${esc(state.find.q)}">
        ${seg("type", TYPE_LABEL)}
        ${seg("state", STATE_LABEL)}
        ${seg("sort", SORT_LABEL)}
        ${box("repo", "any repo", "findRepos")}
        ${box("author", "any author", "findPeople")}
        ${box("label", "any label", "findLabels")}
        <button class="ghost" data-findclear="1">Clear</button>
        ${datalist("findRepos", opt.repos)}
        ${datalist("findPeople", opt.people)}
        ${datalist("findLabels", opt.labels)}
      </div>`;

      return `${form}<div id="findResults">${resultsHtml()}</div>`;
    },
  },
};

export { findModules, resultsHtml };
