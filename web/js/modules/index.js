import { esc } from "../format.js";
import { panel } from "../data.js";
import { applyFilter, preview, renderTable, sortRows } from "../table.js";
import { panelRows } from "../dream.js";
import { analyticsModules } from "./analytics.js";
import { dreamModules } from "./dream.js";
import { peopleModules } from "./people.js";
import { contributorModules } from "./contributor.js";
import { repoModules } from "./repo.js";

/**
 * Every module renders into a card on its page's overview grid, and into the
 * full-width area when its own tab is selected. `render(expanded)` gets to
 * decide how much detail that means.
 */
const MODULES = {
  ...analyticsModules,
  ...dreamModules,
  ...peopleModules,
  ...contributorModules,
  ...repoModules,
};

/* Generic panel-backed module renderer (Dream Panel tables). */
for (const m of Object.values(MODULES)) {
  if (!m.panelId || m.render) continue;
  m.render = function (expanded) {
    const p = panel(this.panelId);
    if (!p?.ok) return `<div class="error">This panel failed to build:<br>${esc(p?.error)}</div>`;
    const cols = this.cols();
    const rows = sortRows(applyFilter(panelRows(this.panelId)), cols);
    return renderTable(rows, expanded ? cols : preview(cols), {
      sortable: expanded, limit: expanded ? null : 5,
    });
  };
}

export { MODULES };
