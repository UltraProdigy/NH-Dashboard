import { state } from "./state.js";
import { age, bucketLabel, contribLink, daysSince, dur, esc, fmt } from "./format.js";
import { renderTable } from "./table.js";
import { panel } from "./data.js";

const contributorAll = () => panel("contributors")?.ok ? (panel("contributors").data.rows ?? []) : [];

/** Filtered against the *selected* window, not all-time. */
function contributorRows() {
  const w = state.window;
  return contributorAll().filter(r => r[w] && r[w].prs + r[w].approvals >= state.minActivity);
}

function contributorColumns() {
  const w = state.window;
  return [
    { key: "login", label: "Contributor", render: r => contribLink(r.login) },
    { key: `${w}.prs`,       label: "PRs opened",      get: r => r[w].prs,       render: r => `<span class="num">${fmt(r[w].prs)}</span>` },
    { key: `${w}.merged`,    label: "Merged",          get: r => r[w].merged,    render: r => `<span class="num">${fmt(r[w].merged)}</span>` },
    { key: `${w}.approvals`, label: "Approvals given", get: r => r[w].approvals, render: r => `<span class="num">${fmt(r[w].approvals)}</span>` },
    { key: "lastSeen", label: "Last active", get: r => r.lastSeen ?? "", render: r => age(daysSince(r.lastSeen)) },
  ];
}

function volumeTable(s) {
  const cols = [
    { key: "b", label: { day: "Day", week: "Week", month: "Month" }[state.gran] ?? "Bucket",
      render: b => esc(bucketLabel(b.b)) },
    { key: "opened", label: "Opened", render: b => `<span class="num">${fmt(b.opened)}</span>` },
    { key: "merged", label: "Merged", render: b => `<span class="num">${fmt(b.merged)}</span>` },
    { key: "closed", label: "Closed", render: b => `<span class="num">${fmt(b.closed)}</span>` },
    { key: "authors", label: "Authors", render: b => `<span class="num">${fmt(b.authors)}</span>` },
    { key: "newAuthors", label: "First-timers", render: b => `<span class="num">${fmt(b.newAuthors)}</span>` },
    { key: "mergeMedianH", label: "Median merge", render: b => `<span class="num">${dur(b.mergeMedianH)}</span>` },
  ];
  return `<h3 style="font-size:13px;margin:26px 0 8px">Breakdown</h3>` +
    renderTable([...s].reverse(), cols);
}

export { contributorAll, contributorColumns, contributorRows, volumeTable };
