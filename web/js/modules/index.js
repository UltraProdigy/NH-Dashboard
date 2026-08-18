import { esc } from "../format.js";
import { panel } from "../data.js";
import { applyFilter, preview, renderTable, sortRows } from "../table.js";
import { panelRows } from "../dream.js";
import { PAGES } from "../pages.js";
import { analyticsModules } from "./analytics.js";
import { dreamModules } from "./dream.js";
import { issueModules } from "./issues.js";
import { peopleModules } from "./people.js";
import { contributorModules } from "./contributor.js";
import { contributorIssueModules } from "./contributor-issues.js";
import { repoModules } from "./repo.js";
import { repoIssueModules } from "./repo-issues.js";
import { versusModules } from "./versus.js";

/**
 * Every module renders into a card on its page's overview grid, and into the
 * full-width area when its own tab is selected. `render(expanded)` gets to
 * decide how much detail that means.
 */
const MODULES = {
  ...analyticsModules,
  ...dreamModules,
  ...issueModules,
  ...peopleModules,
  ...contributorModules,
  ...contributorIssueModules,
  ...repoModules,
  ...repoIssueModules,
  ...versusModules,
};

/* Generic panel-backed module renderer (Dream Panel tables). */
for (const m of Object.values(MODULES)) {
  if (!m.panelId || m.render) continue;
  m.render = function (expanded) {
    const p = panel(this.panelId);
    // Absent and failed are different problems: a panel added since the data
    // was last built isn't in the file at all, and "failed: undefined" sends
    // whoever reads it looking for a build error that never happened.
    if (!p) return `<div class="empty">Not in this build yet — run <code>npm run build</code>.</div>`;
    if (!p.ok) return `<div class="error">This panel failed to build:<br>${esc(p.error)}</div>`;
    const cols = this.cols();
    const rows = sortRows(applyFilter(panelRows(this.panelId)), cols);
    return renderTable(rows, expanded ? cols : preview(cols), {
      sortable: expanded, limit: expanded ? null : this.previewLimit ?? 5,
    });
  };
}

/* ==========================================================================
   Tabs
   --------------------------------------------------------------------------
   One card, one tab is still the default. Two things bend it: a page can put
   several cards in a `group`, which gives them one tab that stacks them, and a
   card can set `tab: false` to stay on the overview without claiming a tab of
   its own — for the ones whose expanded view is strictly worse than another
   tab's, like the ranked-bar previews of a sortable table.

   Neither touches `page.modules`, which is still the overview grid in its
   original order with its original spans.
   ========================================================================== */

const pageOf = (id) => PAGES.find(p => p.id === id);
const groupOf = (page, moduleId) =>
  (page.groups ?? []).find(g => g.modules.includes(moduleId)) ?? null;
const groupById = (page, tab) =>
  tab?.startsWith("@") ? (page.groups ?? []).find(g => `@${g.id}` === tab) ?? null : null;

/**
 * The tab bar, derived from the grid rather than declared separately: a group
 * appears where its first member sits in `page.modules`, so there's no second
 * ordering to drift out of sync with the layout.
 */
function tabsFor(pageId) {
  const page = pageOf(pageId);
  if (!page) return [];
  const seen = new Set();
  const out = [];
  for (const id of page.modules) {
    const g = groupOf(page, id);
    if (!g) {
      if (MODULES[id].tab !== false) out.push({ id, label: MODULES[id].label });
      continue;
    }
    if (seen.has(g.id)) continue;
    seen.add(g.id);
    out.push({ id: `@${g.id}`, label: g.label, group: g });
  }
  return out;
}

/**
 * Which cards a tab shows. A group's own `modules` list wins over grid order —
 * the grid puts Biggest PRs before Closed PRs to fill a row, but stacked they
 * read better as Open, Closed, Biggest.
 */
function tabMembers(pageId, tab) {
  if (tab == null) return [];
  const g = groupById(pageOf(pageId), tab);
  return g ? g.modules : [tab];
}

/** The other mode's equivalent tab, for the contributor/repo toggle. */
function tabTwin(pageId, tab) {
  if (tab == null) return null;
  const g = groupById(pageOf(pageId), tab);
  return g ? g.twin ?? null : MODULES[tab]?.twin ?? null;
}

/** Which member's badge a group borrows, if it declared one. */
function tabCountId(pageId, tab) {
  const g = groupById(pageOf(pageId), tab);
  return g ? g.count ?? null : tab;
}

/**
 * A tab id out of a URL, or null for the overview.
 *
 * Ids that used to name a tab and now name a group member resolve to that
 * group, so links and bookmarks made before the consolidation still land
 * somewhere sensible. Derived from the group declarations rather than a
 * hand-kept list of retired ids, which would only rot.
 */
function resolveTab(pageId, raw) {
  const page = pageOf(pageId);
  if (!raw || !page) return null;
  if (raw.startsWith("@")) return groupById(page, raw) ? raw : null;
  if (MODULES[raw]?.page !== pageId) return null;
  const g = groupOf(page, raw);
  if (g) return `@${g.id}`;
  return MODULES[raw].tab === false ? null : raw;
}

export { MODULES, resolveTab, tabCountId, tabMembers, tabTwin, tabsFor };
