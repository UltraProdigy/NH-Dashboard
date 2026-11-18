import { kpi } from "./charts.js";
import { freshness, panel } from "./data.js";
import { esc, fmt, pctFmt, repoLink } from "./format.js";
import { ciDur } from "./module-helpers.js";
import { pageSlug } from "./pages.js";
import { href } from "./paths.js";
import { state } from "./state.js";
import { renderTable, sortRows, withOwner } from "./table.js";

function ciHealth() {
  const p = panel("ciHealth");
  if (!p) return '<section class="card"><div class="body">Loading CI health…</div></section>';
  if (!p.ok) return `<section class="card"><div class="body error">${esc(p.error ?? "CI data unavailable")}</div></section>`;
  const o = p.data.org;
  if (!o) return '<section class="card"><div class="body empty">No workflow sample is available.</div></section>';

  const f = freshness({ reads: "ciHealth" });
  const time = f?.refreshedAt ?? f?.computedAt;
  const caption = time ? `Refreshed ${new Date(time).toLocaleString()}` : "";
  const rows = Object.entries(p.data.repos ?? {}).map(([repo, r]) => ({
    ...r, repo, avg: r.timedRuns ? (r.totalMinutes ?? 0) / r.timedRuns : null,
  }));
  const cols = [
    { key: "repo", label: "Repository", render: r => repoLink(r.repo) },
    { key: "runs", label: "Sampled runs", render: r => fmt(r.runs) },
    { key: "failures", label: "Failures", render: r => fmt(r.failures) },
    { key: "passRate", label: "Pass rate", render: r => pctFmt(r.passRate) },
    { key: "avg", label: "Average run", render: r => ciDur(r.avg) },
    { key: "sampleSpanDays", label: "Sample span", render: r => r.sampleSpanDays ? `${fmt(r.sampleSpanDays)} days` : "—" },
  ];
  const table = withOwner("ci-health", () => renderTable(sortRows(rows, cols), cols, { sortable: true }));
  return `<div class="stack timber-admin-diagnostics">
    <section class="card fresh-${f?.tier ?? "build"}">
      <header><h2>Workflow health</h2><span class="sub">Completed runs on sampled default branches</span>
        ${caption ? `<span class="card-freshness" title="${esc(caption)}">${esc(caption)}</span>` : ""}</header>
      <div class="body flush"><div class="kpis">
        ${kpi("Pass rate", pctFmt(o.passRate), `${fmt(o.failures)} failed of ${fmt(o.decisive)}`)}
        ${kpi("Sampled runs", fmt(o.sampledRuns), `Across ${fmt(o.repos)} repositories`)}
        ${kpi("Monthly runs", `~${fmt(o.runsPerMonth)}`, "Projected")}
        ${kpi("Average run", ciDur(o.meanRunMinutes), "Wall-clock duration")}
      </div></div>
      <footer class="module-footer"><a class="expand" data-pagelink href="${href(pageSlug("analytics") + "/actions-load")}">Actions load →</a></footer>
    </section>
    <section class="card">
      <header><h2>Repository samples</h2><span class="sub">Sample coverage and pass rates by repository</span></header>
      <div class="body">${table}</div>
    </section>
  </div>`;
}

function rulesets() {
  const org = encodeURIComponent(state.data?.org ?? "GTNewHorizons");
  return `<div class="stack timber-admin-diagnostics">
    <section class="card">
      <header><h2>Organization rulesets</h2></header>
      <div class="body"><p>Review active rulesets, enforcement, bypass lists, and targets in GitHub settings.</p></div>
      <footer class="module-footer"><a class="expand" href="https://github.com/organizations/${org}/settings/rules" target="_blank" rel="noopener">Open GitHub rulesets ↗</a></footer>
    </section>
    <section class="card">
      <header><h2>Related views</h2></header>
      <div class="body diagnostic-links">
        <a class="ghost" data-pagelink href="${href(pageSlug("ci"))}">CI Health</a>
        <a class="ghost" data-pagelink href="${href(pageSlug("logs"))}">GitHub Logs</a>
      </div>
    </section>
  </div>`;
}

export const renderAdminDiagnostics = page => page === "ci" ? ciHealth() : rulesets();
