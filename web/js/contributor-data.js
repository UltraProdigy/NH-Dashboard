import { state } from "./state.js";
import {
  activeShare,
  age,
  bucketLabel,
  contribLink,
  daysSince,
  dur,
  esc,
  fmt,
  pctFmt,
} from "./format.js";
import { renderTable } from "./table.js";
import { panel, windowDays } from "./data.js";

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
    // Windowed like the three columns before it, over a period that ends
    // **today** rather than on the person's last active day. That distinction
    // is the whole column. Dividing by `last - first` froze the clock the day
    // somebody stopped, so their absence never entered the arithmetic: a
    // contributor who did one afternoon in 2023 scored a flat 100% and
    // outranked ten years of work, and 3,864 people were in that state.
    // Counting to today puts the silence in the denominator, where it grows
    // for every day they stay away.
    { key: `${w}.activeDays`, label: "Active days",
      get: r => activeShare(r[w]) ?? -1,
      render: r => {
        const share = activeShare(r[w]);
        if (share == null) return `<span class="sub">—</span>`;
        const period = windowDays() == null
          ? `the ${fmt(r[w].activeDenom)} days since their first activity`
          : `the last ${fmt(r[w].activeDenom)} days`;
        return `<span class="num" title="${esc(
          `active on ${fmt(r[w].activeDays)} of ${period}`)}">${pctFmt(share)}</span>`;
      } },
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
