import { state } from "../state.js";
import { age, avatar, contribHref, contribLink, daysSince, esc, fmt } from "../format.js";
import { hbars } from "../charts.js";
import { applyFilter, renderTable, sortRows } from "../table.js";
import { activeWindow, panel, windowDays, windowPhrase } from "../data.js";
import { cardWindow } from "../module-helpers.js";
import { contributorAll, contributorColumns, contributorRows } from "../contributor-data.js";

export const peopleModules = {
  /* ---------------- Contributor Activity ---------------- */

  leaderboard: {
    page: "people", label: "Leaderboard", span: 12, flush: true,
    controls: ["window", "minActivity", "filter"],
    sub: () => `by activity, ${windowPhrase()}`,
    render(expanded) {
      const p = panel("contributors");
      if (!p?.ok) return `<div class="error">${esc(p.error)}</div>`;
      const cols = contributorColumns();
      const rows = sortRows(applyFilter(contributorRows()), cols);
      const total = p.data.rows?.length ?? 0;
      const hidden = total - contributorRows().length;
      const hint = expanded && hidden > 0
        ? `<div class="hint" style="padding:12px 14px 0">${fmt(hidden)} of ${fmt(total)} hidden by min activity ${state.minActivity} in this window — set it to 0 to show everyone.</div>` : "";
      return hint + renderTable(rows, cols, { sortable: expanded, limit: expanded ? null : 8 });
    },
  },

  /* No tab of their own. Both are `contributorRows()` ranked by one column the
     Leaderboard already has, so expanding either gives you 25 bars where that
     tab gives you every column, sortable. They earn their place on the grid as
     a glance and earn nothing by being openable. */
  topAuthors: {
    page: "people", label: "Most PRs opened", span: 6, tab: false,
    controls: ["window"],
    sub: () => `${windowPhrase()}`,
    render(expanded) {
      const rows = contributorRows()
        .map(r => ({ login: r.login, count: r[state.window].prs }))
        .filter(r => r.count).sort((a, b) => b.count - a.count);
      return hbars(rows.slice(0, expanded ? 25 : 7), {
        label: r => r.login, value: r => r.count,
        href: contribHref, internal: true, icon: r => avatar(r.login, 16),
      });
    },
  },

  topReviewers: {
    page: "people", label: "Most approvals given", span: 6, tab: false,
    controls: ["window"],
    sub: () => `${windowPhrase()}`,
    render(expanded) {
      const rows = contributorRows()
        .map(r => ({ login: r.login, count: r[state.window].approvals }))
        .filter(r => r.count).sort((a, b) => b.count - a.count);
      return hbars(rows.slice(0, expanded ? 25 : 7), {
        label: r => r.login, value: r => r.count, color: "var(--purple)",
        href: contribHref, internal: true, icon: r => avatar(r.login, 16),
      });
    },
  },

  newcomers: {
    page: "people", label: "New faces", span: 6, flush: true, controls: ["filter"],
    // Its period lives in its own header rather than the toolbar, because it
    // isn't the page's: this card opens on 3 months while its neighbours are on
    // 6, and a control in the toolbar can only read as governing all four.
    controlsHtml: () => cardWindow("newFacesWindow"),
    // The caption still names the period, for the same reason it always did —
    // on the grid this card is showing a different span from the three beside
    // it, and that's worth saying rather than leaving you to notice.
    sub: () => activeWindow("newcomers") === "all"
      ? "first PR ever"
      : `first PR in the ${windowPhrase("newcomers")}`,
    render(expanded) {
      const days = windowDays("newcomers");
      const rows = contributorAll()
        .filter(r => r.firstSeen && (days == null || daysSince(r.firstSeen) <= days))
        .sort((a, b) => String(b.firstSeen).localeCompare(String(a.firstSeen)));
      const cols = [
        { key: "login", label: "Contributor", render: r => contribLink(r.login) },
        { key: "firstSeen", label: "First PR", get: r => r.firstSeen ?? "", render: r => age(daysSince(r.firstSeen)) },
        { key: "prs", label: "PRs", get: r => r.all.prs, render: r => `<span class="num">${r.all.prs}</span>` },
        { key: "merged", label: "Merged", get: r => r.all.merged, render: r => `<span class="num">${r.all.merged}</span>` },
      ];
      return renderTable(sortRows(applyFilter(rows), cols), cols, { sortable: expanded, limit: expanded ? null : 7 });
    },
  },

  lapsed: {
    page: "people", label: "Gone quiet", span: 6, flush: true, controls: ["filter"],
    sub: () => "regulars with no activity in 6 months",
    render(expanded) {
      const rows = contributorAll()
        .filter(r => r.all.prs + r.all.approvals >= 20 && (daysSince(r.lastSeen) ?? 0) > 180)
        .sort((a, b) => (b.all.prs + b.all.approvals) - (a.all.prs + a.all.approvals));
      const cols = [
        { key: "login", label: "Contributor", render: r => contribLink(r.login) },
        { key: "lastSeen", label: "Last active", get: r => r.lastSeen ?? "", render: r => age(daysSince(r.lastSeen)) },
        { key: "prs", label: "PRs (all time)", get: r => r.all.prs, render: r => `<span class="num">${fmt(r.all.prs)}</span>` },
        { key: "approvals", label: "Approvals", get: r => r.all.approvals, render: r => `<span class="num">${fmt(r.all.approvals)}</span>` },
      ];
      return renderTable(sortRows(applyFilter(rows), cols), cols, { sortable: expanded, limit: expanded ? null : 7 });
    },
  },
};
