import { state } from "./state.js";
import { panel } from "./data.js";

const repoPanel = () => (panel("repos")?.ok ? panel("repos").data : null);

/**
 * The rows with the selected window's metrics lifted onto them by name.
 *
 * The panel ships each window as an array against `windowFields` — ten named
 * keys per window per repo was 387 KB against 140 KB packed. Expanded on first
 * use and memoized per window onto the panel data, which is the deal
 * `issuePeople` gets for the same reason.
 */
function repoRows() {
  const d = repoPanel();
  if (!d) return [];
  const cache = (d._rows ??= {});
  const w = state.window;
  if (cache[w]) return cache[w];
  const fields = d.windowFields ?? [];
  return (cache[w] = d.rows.map((r) => {
    const out = { ...r };
    fields.forEach((f, i) => {
      out[f] = r[w][i];
    });
    return out;
  }));
}

const repoOrg = () => repoPanel()?.org ?? null;
const repoOrgWindow = () => repoOrg()?.byWindow?.[state.window] ?? null;

/** Lifecycle rungs with their counts, in order, with a tone for each. */
const LIFECYCLE_TONE = {
  active: "var(--good)",
  slowing: "var(--accent)",
  dormant: "var(--warn)",
  silent: "var(--bad)",
};

export { LIFECYCLE_TONE, repoOrg, repoOrgWindow, repoPanel, repoRows };
