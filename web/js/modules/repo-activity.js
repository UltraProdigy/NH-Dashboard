import { state } from "../state.js";
import { age, dur, esc, fmt, pctFmt, repoHref, repoLink } from "../format.js";
import { hbars, kpi } from "../charts.js";
import { applyFilter, renderTable, sortRows } from "../table.js";
import { panel, windowPhrase } from "../data.js";
import { LIFECYCLE_TONE, repoOrg, repoOrgWindow, repoPanel, repoRows } from "../repo-activity-data.js";

/**
 * Why a card has nothing to draw.
 *
 * Three different states, and the first is the normal one for now. This panel
 * reaches the page from the Worker rather than from `dashboard.json`, which has
 * carried no `repos` key since before it existed — so until a build has run,
 * *every* load renders once with the panel absent and again once the overlay
 * lands. Telling somebody to run a build during that first paint would be
 * advice about a file the page is not waiting on.
 */
const missing = () => {
  const p = panel("repos");
  if (!p) return `<div class="empty">Loading…</div>`;
  if (!p.ok) return `<div class="error">${esc(p.error)}</div>`;
  return `<div class="empty">Nothing to show.</div>`;
};

/**
 * The rung a repo is on, as a chip.
 *
 * Archived and abandoned are indistinguishable from the two stores — the
 * `archived` flag lives in a table the panel deliberately does not read — so
 * `silent` says "quiet", never "dead".
 */
const rungChip = (r) => {
  const rung = repoOrg()?.byLifecycle?.find((b) => b.id === r.lifecycle);
  return `<span class="pill" style="border-color:${LIFECYCLE_TONE[r.lifecycle]};color:${
    LIFECYCLE_TONE[r.lifecycle]}">${esc(rung?.label ?? r.lifecycle)}</span>`;
};

export const repoActivityModules = {
  /* ---------------- Repo Activity ---------------- */

  oPulse: {
    page: "repos", label: "Pulse", span: 12,
    controls: ["window"],
    sub: () => `${windowPhrase()}`,
    render() {
      const org = repoOrg();
      const w = repoOrgWindow();
      if (!org || !w) return missing();
      const quiet = org.byLifecycle
        .filter((b) => b.id === "dormant" || b.id === "silent")
        .reduce((n, b) => n + b.count, 0);
      const conc = w.concentration;
      return `<div class="kpis">
        ${kpi("Repos", fmt(org.repos), "with any PR or issue")}
        ${kpi("Active in this period", fmt(w.activeRepos), `${pctFmt(org.repos ? w.activeRepos / org.repos : null)} of them`)}
        ${kpi("Quiet for 3 months or more", fmt(quiet), "dormant or silent", quiet > org.repos / 3 ? "down" : "")}
        ${kpi(`Top-${repoPanel()?.concentrationN ?? 5} share`, pctFmt(conc), "of this period's activity",
              conc > 0.6 ? "down" : conc > 0.4 ? "flat" : "up")}
        ${kpi("Open PRs", fmt(org.openPRs), `${fmt(org.staleOpenPRs)} older than 6 months`,
              org.staleOpenPRs > org.openPRs / 4 ? "down" : "")}
        ${kpi("Open issues", fmt(org.openIssues), `${fmt(org.unansweredIssues)} never answered`)}
      </div>`;
    },
  },

  /**
   * How much of the org is still moving.
   *
   * The rungs are days since the last act — see `repo-activity-rules.js` for
   * why the boundaries are the period control's own spans. Deliberately not
   * windowed: idleness is measured from today whatever period the rest of the
   * page is showing, and a control above it would imply otherwise.
   */
  oLifecycle: {
    page: "repos", label: "Lifecycle", span: 6,
    sub: () => "every repo by time since its last activity",
    render(expanded) {
      const org = repoOrg();
      if (!org) return missing();
      const rows = org.byLifecycle;
      const max = Math.max(1, ...rows.map((b) => b.count));
      const bars = `<div class="hbars">${rows.map((b) => `
        <div class="hbar">
          <span class="lab" title="${esc(b.detail)}">${esc(b.label)} <span class="sh">${esc(b.detail)}</span></span>
          <span class="track"><span class="fill" style="width:${(b.count / max) * 100}%;background:${LIFECYCLE_TONE[b.id]}"></span></span>
          <span class="val">${fmt(b.count)}<span class="sh">${pctFmt(org.repos ? b.count / org.repos : null)}</span></span>
        </div>`).join("")}</div>`;

      if (!expanded) return bars;

      const cols = [
        { key: "repo", label: "Repo", render: (r) => repoLink(r.repo) },
        { key: "lifecycle", label: "Rung", get: (r) => r.idleDays ?? -1, render: rungChip },
        { key: "idleDays", label: "Last activity", get: (r) => r.idleDays ?? -1, render: (r) => age(r.idleDays) },
        { key: "totalPRs", label: "PRs", render: (r) => `<span class="num">${fmt(r.totalPRs)}</span>` },
        { key: "totalIssues", label: "Issues", render: (r) => `<span class="num">${fmt(r.totalIssues)}</span>` },
      ];
      const rowsByIdle = [...repoRows()].sort((a, b) => (b.idleDays ?? 0) - (a.idleDays ?? 0));
      return bars +
        `<div class="hint" style="margin-top:12px">A repo archived on purpose and one nobody has touched look identical from the PR and issue stores, so <strong>Silent</strong> means quiet, not dead.</div>` +
        `<h3 style="font-size:13px;margin:22px 0 8px">Quietest first</h3>` +
        renderTable(sortRows(applyFilter(rowsByIdle), cols), cols, { sortable: true });
    },
  },

  /**
   * Open pull requests old enough to be a question about the repo.
   *
   * Six months, and the threshold is shared with the panel rather than repeated
   * here. Nothing else in the dashboard shows this org-wide — the backlog card
   * on PR Analytics buckets every open PR by age without naming a repo, and the
   * repo drilldown names one repo at a time.
   */
  oStale: {
    page: "repos", label: "Stale backlog", span: 6, tabControls: ["filter"],
    sub: () => "open PRs older than 6 months, by repo",
    render(expanded) {
      const org = repoOrg();
      if (!org) return missing();
      const rows = repoRows().filter((r) => r.staleOpenPRs).sort(
        (a, b) => b.staleOpenPRs - a.staleOpenPRs || a.repo.localeCompare(b.repo));
      if (!rows.length) return `<div class="empty">Nothing has been open that long. </div>`;

      const head = `<div class="kpis" style="margin:-14px -14px 14px">
        ${kpi("Stale PRs", fmt(org.staleOpenPRs), `of ${fmt(org.openPRs)} open`)}
        ${kpi("Repos holding one", fmt(rows.length), `of ${fmt(org.repos)}`)}
        ${kpi("Worst repo", fmt(rows[0].staleOpenPRs), esc(rows[0].repo))}
      </div>`;

      if (!expanded)
        return head + hbars(rows.slice(0, 8), {
          label: (r) => r.repo, value: (r) => r.staleOpenPRs,
          href: (r) => repoHref(r.repo), internal: true, color: "var(--warn)",
          note: (r) => `${fmt(r.openPRs)} open`,
        });

      const cols = [
        { key: "repo", label: "Repo", render: (r) => repoLink(r.repo) },
        { key: "staleOpenPRs", label: "Older than 6mo", render: (r) => `<span class="num down">${fmt(r.staleOpenPRs)}</span>` },
        { key: "openPRs", label: "Open", render: (r) => `<span class="num">${fmt(r.openPRs)}</span>` },
        { key: "unreviewedOpenPRs", label: "Never reviewed", render: (r) => `<span class="num ${r.unreviewedOpenPRs ? "down" : ""}">${fmt(r.unreviewedOpenPRs)}</span>` },
        { key: "lifecycle", label: "Rung", get: (r) => r.idleDays ?? -1, render: rungChip },
      ];
      return head + renderTable(sortRows(applyFilter(rows), cols), cols, { sortable: true });
    },
  },

  /**
   * Every repo on one row, which is the whole argument for the page.
   *
   * The numbers here live on four other pages between them — Busiest repos has
   * the PR counts, Where the issues are has the issue counts, the drilldown has
   * the rest one repo at a time — and none of those lets you sort three hundred
   * repos by the column you care about.
   */
  oTable: {
    page: "repos", label: "Every repo", span: 12, flush: true,
    controls: ["window", "filter"],
    filterHint: ["repo"],
    sub: () => `one row per repo, ${windowPhrase()}`,
    render(expanded) {
      const p = repoPanel();
      if (!p) return missing();
      const cols = [
        { key: "repo", label: "Repo", render: (r) => repoLink(r.repo) },
        { key: "lifecycle", label: "Rung", get: (r) => r.idleDays ?? -1, render: rungChip },
        { key: "opened", label: "PRs opened", render: (r) => `<span class="num">${fmt(r.opened)}</span>` },
        { key: "merged", label: "Merged", render: (r) => `<span class="num">${fmt(r.merged)}</span>` },
        { key: "mergeRate", label: "Merge rate", get: (r) => r.mergeRate ?? -1, render: (r) => `<span class="num">${pctFmt(r.mergeRate)}</span>` },
        { key: "medianMergeHours", label: "Median to merge", get: (r) => r.medianMergeHours ?? -1, render: (r) => `<span class="num">${dur(r.medianMergeHours)}</span>` },
        { key: "people", label: "Authors", render: (r) => `<span class="num">${fmt(r.people)}</span>` },
        { key: "reviewers", label: "Reviewers", render: (r) => `<span class="num">${fmt(r.reviewers)}</span>` },
        { key: "openPRs", label: "Open", render: (r) => `<span class="num">${fmt(r.openPRs)}</span>` },
        // A dash rather than a nought for the 237 repos that have never had an
        // issue: "none open" and "does not use issues" are different facts.
        { key: "openIssues", label: "Open issues",
          render: (r) => (r.totalIssues ? `<span class="num">${fmt(r.openIssues)}</span>` : `<span class="sub">—</span>`) },
        { key: "idleDays", label: "Last activity", get: (r) => r.idleDays ?? -1, render: (r) => age(r.idleDays) },
      ];
      const rows = sortRows(applyFilter(repoRows()), cols);
      return renderTable(rows, cols, { sortable: expanded, limit: expanded ? null : 10 });
    },
  },
};
