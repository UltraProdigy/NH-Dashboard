import { state } from "./state.js";
import { age, esc, fmt, repoLink } from "./format.js";

/* ==========================================================================
   Shared table rendering
   ========================================================================== */

/* ---- who owns the sort --------------------------------------------------
   Sort used to be one key on `state` for the whole page, which worked only
   because exactly one table was ever sortable at a time: the overview grid
   renders every card with `sortable: false`. A group tab stacks several
   sortable tables in one view, and three of them share a `repo` column, so one
   global key would have made a click on one table silently re-sort the others.

   Sort is therefore per module. Rather than thread an owner argument through
   thirty-odd renderTable and sortRows calls, render.js names the module it is
   about to call — it is the only thing that ever calls one — and the two read
   it from here. Always cleared in a finally, so a module that throws can't
   leave its name behind for the next one. */

let owner = null;

function withOwner(id, fn) {
  owner = id;
  try { return fn(); }
  finally { owner = null; }
}

const sortOf = () => state.sort[owner] ?? { key: null, dir: -1 };

const COLUMNS = {
  pr: [
    { key: "repo",      label: "Repo",   render: r => repoLink(r.repo) },
    { key: "title",     label: "Title",  render: r => `<a href="${r.url}" target="_blank" rel="noopener">${esc(r.title)}</a> <span class="repo">#${r.number}</span>` },
    { key: "author",    label: "Author", render: r => esc(r.author) },
    { key: "labels",    label: "Labels", sortable: false, render: r => r.labels.map(l => `<span class="label" style="border-color:#${l.color}">${esc(l.name)}</span>`).join("") },
    { key: "ageDays",   label: "Opened", render: r => age(r.ageDays) },
    { key: "staleDays", label: "Updated",render: r => age(r.staleDays) },
  ],
  release: [
    { key: "repo",             label: "Repo",          render: r => `<a href="${r.repoUrl}" target="_blank" rel="noopener">${esc(r.repo)}</a>` },
    { key: "tagName",          label: "Last release",  render: r => `<a href="${r.releaseUrl}" target="_blank" rel="noopener">${esc(r.tagName)}</a>${r.isPrerelease ? ' <span class="label">pre</span>' : ""}` },
    { key: "commitsAhead",     label: "Commits ahead", render: r => `<span class="num">${r.commitsAhead ?? "?"}</span>` },
    { key: "daysSinceRelease", label: "Released",      render: r => age(r.daysSinceRelease) },
    { key: "defaultBranch",    label: "Branch",        render: r => `<span class="repo">${esc(r.defaultBranch)}</span>` },
  ],
};

/** Compact column subset for overview previews — six columns don't fit a card. */
const preview = cols => cols.filter(c => ["repo", "title", "tagName", "commitsAhead", "ageDays", "login"].includes(c.key));

/**
 * `rows` is whatever the caller decided should be in this table — already
 * filtered and sorted. The "+ N more" line therefore counts only what *this
 * render* truncated, and says nothing when nothing was.
 *
 * It used to take a separate `total` and subtract the rows shown from that.
 * Callers passed the pre-filter count, so searching an already-complete list
 * produced "+ 312 more — open the tab for the full list" underneath every
 * matching row: the list was complete, the search had simply removed 312 rows
 * on purpose. A count of hidden rows has to be derived from the same array the
 * rows came from, or it ends up describing a different question.
 */
function renderTable(rows, cols, { sortable = false, limit = null } = {}) {
  if (!rows.length) return `<div class="empty">Nothing here. That's usually good news.</div>`;
  const shown = limit ? rows.slice(0, limit) : rows;
  const { key, dir } = sortOf();
  const head = cols.map(c =>
    `<th ${sortable && c.sortable !== false ? `data-sort="${c.key}"` : ""}>${c.label}${
      sortable && key === c.key ? (dir > 0 ? " ▲" : " ▼") : ""}</th>`).join("");
  const body = shown.map(r => `<tr>${cols.map(c => `<td>${c.render(r)}</td>`).join("")}</tr>`).join("");
  const rest = rows.length - shown.length;
  // The table is wrapped rather than emitted bare because .num cells are
  // nowrap, which gives any table with a few numeric columns a hard minimum
  // width. Past that it overflowed the card and .card's overflow:hidden — there
  // to clip the border radius — silently cut the rest off with no way to reach
  // it. The wrapper scrolls instead of clipping. The "+ N more" line stays
  // outside it so it doesn't slide out of view when you scroll across.
  return `<div class="tscroll" data-sortowner="${esc(owner ?? "")}"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>` +
    (rest > 0 ? `<div class="more">+ ${fmt(rest)} more — open the tab for the full list.</div>` : "");
}

function sortRows(rows, cols) {
  const { key, dir } = sortOf();
  if (!key) return rows;
  const col = cols.find(c => c.key === key);
  const val = col?.get ?? (r => r[key]);
  return [...rows].sort((a, b) => {
    const x = val(a), y = val(b);
    const cmp = typeof x === "number" && typeof y === "number"
      ? x - y : String(x ?? "").localeCompare(String(y ?? ""));
    return cmp * dir;
  });
}

function applyFilter(rows) {
  if (!state.filter) return rows;
  const q = state.filter.toLowerCase();
  return rows.filter(r =>
    [r.repo, r.title, r.author, r.tagName, r.login].some(v => String(v ?? "").toLowerCase().includes(q)));
}

export { COLUMNS, applyFilter, preview, renderTable, sortRows, withOwner };
