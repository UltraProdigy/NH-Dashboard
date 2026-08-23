import { state } from "../state.js";
import {
  MONTHS,
  age,
  avatar,
  bucketLabel,
  contribHref,
  contribName,
  dur,
  esc,
  fmt,
  kfmt,
  pctFmt,
  repoHref,
  repoLink,
} from "../format.js";
import {
  barChart,
  grossingBoxes,
  grossingNote,
  hbars,
  kpi,
  legend,
  lineChart,
  trio,
} from "../charts.js";
import { applyFilter, renderTable, sortRows } from "../table.js";
import {
  A,
  W,
  dayLimitNote,
  delta,
  panel,
  seriesSlice,
  windowLabel,
  windowPhrase,
} from "../data.js";
import { ciDur, missingIngest, sizeNotice } from "../module-helpers.js";
import { volumeTable } from "../contributor-data.js";

export const analyticsModules = {
  /* ---------------- General Analytics ---------------- */

  pulse: {
    page: "analytics", label: "Pulse", span: 12, flush: true,
    // Not `controls`: the expanded view is every window side by side, so a
    // period control on its tab would sit above a table it cannot change.
    overviewControls: ["window"],
    sub: (expanded) => expanded
      ? "every period side by side"
      : W()?.prevLabel
        ? `${windowPhrase()} vs. ${W().prevLabel}`
        : windowLabel().toLowerCase(),
    render(expanded) {
      const a = A(), w = W();
      if (!w) return missingIngest();
      if (!expanded) {
        // Every fallback is what the tile says when there's no comparison
        // period — i.e. on the all-time window.
        return `<div class="kpis">
          ${kpi("PRs opened", fmt(w.opened), delta("opened", { fallback: `across ${fmt(w.activeRepos)} repos` }))}
          ${kpi("Merged", fmt(w.merged), delta("merged", { fallback: `${pctFmt(w.opened ? w.merged / w.opened : null)} of everything opened` }))}
          ${kpi("Merge rate", pctFmt(w.mergeRate), delta("mergeRate", { pp: true, fallback: `${fmt(w.closed)} closed unmerged` }))}
          ${kpi("Median time to merge", dur(w.medianMergeHours), delta("medianMergeHours", { invert: true, fallback: `p90 ${dur(w.p90MergeHours)}` }))}
          ${kpi("Median first review", dur(w.medianFirstReviewHours), delta("medianFirstReviewHours", { invert: true, fallback: `${fmt(w.approvals)} approvals` }))}
          ${kpi("Active contributors", fmt(w.activeAuthors), delta("activeAuthors", { fallback: `${fmt(w.activeReviewers)} of them reviewed` }))}
          ${/* Dropped on the all-time window, where it is guaranteed to be a
                duplicate of the tile above rather than merely likely to look
                like one. activeAuthors counts distinct non-bot authors in the
                window; newContributors counts PRs that were their author's
                first ever. Over all of history every author's first PR falls
                inside the window, so each one increments newContributors
                exactly once and the two counts are forced equal. On a bounded
                window they diverge and the tile earns its place. */
            w.prevLabel
              ? kpi("First-time authors", fmt(w.newContributors), delta("newContributors", { fallback: `since ${new Date(a.totals.firstPR).getFullYear()}` }))
              : ""}
          ${kpi("Lines changed", kfmt(w.linesChanged), w.sizedPRs
                ? delta("linesChanged", { fallback: `median ${kfmt(w.medianPRLines)} per PR` })
                : "no diff data yet")}
          ${kpi("Open backlog", fmt(a.backlog.total), `${fmt(a.backlog.unreviewed)} never reviewed`, a.backlog.unreviewed > a.backlog.total / 2 ? "down" : "")}
        </div>` + sizeNotice(w);
      }
      // Expanded: every window side by side, so trends are readable without
      // clicking through the picker one option at a time.
      const rows = [
        ["PRs opened",           w => fmt(w.opened)],
        ["Merged",               w => fmt(w.merged)],
        ["Closed unmerged",      w => fmt(w.closed)],
        ["Merge rate",           w => pctFmt(w.mergeRate)],
        ["Median time to merge", w => dur(w.medianMergeHours)],
        ["p90 time to merge",    w => dur(w.p90MergeHours)],
        ["Median first review",  w => dur(w.medianFirstReviewHours)],
        ["Approvals given",      w => fmt(w.approvals)],
        ["Merged without approval", w => fmt(w.unapprovedMerges)],
        ["Approved before merge",w => pctFmt(w.approvedShare)],
        ["Top-5 reviewer share", w => pctFmt(w.reviewConcentration)],
        ["Active authors",       w => fmt(w.activeAuthors)],
        ["Active reviewers",     w => fmt(w.activeReviewers)],
        ["First-time contributors", w => fmt(w.newContributors)],
        ["Repos touched",        w => fmt(w.activeRepos)],
        ["Lines added",          w => kfmt(w.additions)],
        ["Lines removed",        w => kfmt(w.deletions)],
        ["Median PR size",       w => (w.sizedPRs ? `${kfmt(w.medianPRLines)} lines` : "—")],
        ["p90 PR size",          w => (w.sizedPRs ? `${kfmt(w.p90PRLines)} lines` : "—")],
        ["Commits",              w => fmt(w.commits)],
        ["PR comments",          w => fmt(w.comments)],
      ];
      return `<table>
        <thead><tr><th style="cursor:default">Metric</th>${a.windows.map(x => `<th style="cursor:default" class="num">${esc(x.label)}</th>`).join("")}</tr></thead>
        <tbody>${rows.map(([lab, f]) =>
          `<tr><td>${lab}</td>${a.windows.map(x => `<td class="num">${f(a.byWindow[x.id])}</td>`).join("")}</tr>`).join("")}</tbody>
      </table>`;
    },
  },

  volume: {
    page: "analytics", label: "PR volume", span: 8,
    sub: () => `by ${state.gran}, ${windowPhrase()}`,
    controls: ["window", "gran"],
    render(expanded) {
      if (!A()) return missingIngest();
      const s = seriesSlice();
      const series = [
        { key: "opened", label: "Opened", color: "var(--accent)" },
        { key: "merged", label: "Merged", color: "var(--good)" },
        { key: "closed", label: "Closed unmerged", color: "var(--bad)" },
      ];
      const tot = k => s.reduce((n, b) => n + (b[k] ?? 0), 0);
      const head = `<div class="kpis" style="margin:-14px -14px 14px">
        ${kpi("Opened in range", fmt(tot("opened")), `${s.length} ${state.gran}s`)}
        ${kpi("Merged in range", fmt(tot("merged")), pctFmt(tot("opened") ? tot("merged") / tot("opened") : null) + " of opened")}
        ${kpi(`Peak ${state.gran}`, fmt(Math.max(0, ...s.map(b => b.opened))), s.length ? bucketLabel(s.reduce((m, b) => b.opened > m.opened ? b : m, s[0]).b) : "")}
      </div>`;
      return head + legend(series) + barChart(s, series, { height: expanded ? 380 : 210 }) +
        dayLimitNote() + (expanded ? volumeTable(s) : "");
    },
  },

  backlog: {
    page: "analytics", label: "Open backlog", span: 4, controls: ["filter"],
    sub: () => "PRs still open, by age",
    render(expanded) {
      const a = A();
      if (!a) return missingIngest();
      const b = a.backlog;
      const colors = ["var(--good)", "var(--accent)", "var(--warn)", "#e8823a", "var(--bad)"];
      const bars = `<div class="hbars">${b.buckets.map((x, i) => `
        <div class="hbar">
          <span class="lab">${esc(x.label)}</span>
          <span class="track"><span class="fill" style="width:${(x.count / Math.max(1, ...b.buckets.map(y => y.count))) * 100}%;background:${colors[i]}"></span></span>
          <span class="val">${fmt(x.count)}</span>
        </div>`).join("")}</div>`;

      const summary = `<div style="display:flex;gap:18px;margin-bottom:12px">
        <div><div class="k" style="color:var(--muted);font-size:11px">OPEN</div><div style="font-size:22px;font-weight:600">${fmt(b.total)}</div></div>
        <div><div class="k" style="color:var(--muted);font-size:11px">NEVER REVIEWED</div><div style="font-size:22px;font-weight:600" class="${b.unreviewed > b.total / 2 ? "down" : ""}">${fmt(b.unreviewed)}</div></div>
        <div><div class="k" style="color:var(--muted);font-size:11px">OVER 3 MONTHS</div><div style="font-size:22px;font-weight:600">${fmt(b.buckets.slice(3).reduce((n, x) => n + x.count, 0))}</div></div>
      </div>`;

      if (!expanded) return summary + bars;

      const cols = [
        { key: "repo",   label: "Repo",   render: r => repoLink(r.repo) },
        { key: "number", label: "PR",     render: r => `<a href="${r.url}" target="_blank" rel="noopener">#${r.number}</a>` },
        { key: "author", label: "Author", render: r => contribName(r.author) },
        { key: "ageDays",  label: "Opened",  render: r => age(r.ageDays) },
        { key: "staleDays",label: "Updated", render: r => age(r.staleDays) },
        { key: "reviewed", label: "Reviewed?", render: r => r.reviewed ? "yes" : `<span class="down">never</span>` },
      ];
      return summary + bars +
        `<h3 style="font-size:13px;margin:22px 0 8px">Oldest open PRs</h3>` +
        renderTable(sortRows(applyFilter(b.oldest), cols), cols, { sortable: true });
    },
  },

  latency: {
    page: "analytics", label: "Review latency", span: 6,
    controls: ["window", "gran"],
    sub: () => `median hours, by ${state.gran}`,
    render(expanded) {
      if (!A()) return missingIngest();
      const s = seriesSlice().filter(b => b.mergeN > 3);
      const series = [
        { key: "reviewMedianH", label: "To first review (median)", color: "var(--purple)" },
        { key: "mergeMedianH",  label: "To merge (median)",        color: "var(--good)" },
        { key: "mergeP90H",     label: "To merge (p90)",           color: "var(--warn)" },
      ];
      return legend(series) + lineChart(s, series, { height: expanded ? 380 : 200, fmtV: dur }) +
        `<div class="hint" style="margin-top:10px">Points only appear once a ${state.gran} has more than three merges — small samples swing the median wildly, which is why a daily view of this is mostly gaps.</div>` +
        dayLimitNote();
    },
  },

  growth: {
    page: "analytics", label: "Contributor growth", span: 6,
    controls: ["window", "gran"],
    sub: () => "active vs. first-time",
    render(expanded) {
      if (!A()) return missingIngest();
      const s = seriesSlice();
      const series = [
        { key: "authors",    label: "Active authors", color: "var(--accent)" },
        { key: "newAuthors", label: "First-time",     color: "var(--pink)" },
      ];
      const a = A();
      return `<div class="kpis" style="margin:-14px -14px 14px">
          ${kpi("All-time contributors", fmt(a.totals.contributors), `since ${new Date(a.totals.firstPR).getFullYear()}`)}
          ${kpi("New this window", fmt(W()?.newContributors), `in ${windowLabel().toLowerCase()}`)}
          ${kpi("Repos with PRs", fmt(a.totals.repos), "all time")}
        </div>` + legend(series) + lineChart(s, series, { height: expanded ? 380 : 200 }) +
        dayLimitNote();
    },
  },

  repos: {
    page: "analytics", label: "Busiest repos", span: 6,
    controls: ["window"],
    sub: () => `PRs opened, ${windowPhrase()}`,
    render(expanded) {
      const w = W();
      if (!w) return missingIngest();
      const rows = expanded ? w.topRepos : w.topRepos.slice(0, 6);
      return hbars(rows, {
        label: r => r.repo,
        value: r => r.opened,
        href: r => repoHref(r.repo), internal: true,
      }) + (expanded ? `<h3 style="font-size:13px;margin:22px 0 8px">Merged share</h3>` +
        hbars(rows, { label: r => r.repo, value: r => r.merged, color: "var(--good)" }) : "");
    },
  },

  reviewload: {
    page: "analytics", label: "Review load", span: 6,
    controls: ["window"],
    sub: () => `approvals, ${windowPhrase()}`,
    render(expanded) {
      const w = W();
      if (!w) return missingIngest();
      const n = expanded ? 8 : 6;
      const conc = w.reviewConcentration;
      return `<div class="kpis" style="margin:-14px -14px 14px">
          ${kpi("Top-5 reviewer share", pctFmt(conc), "of all approvals", conc > 0.6 ? "down" : conc > 0.4 ? "flat" : "up")}
          ${kpi("Active reviewers", fmt(w.activeReviewers), `${fmt(w.approvals)} approvals`)}
          ${kpi("Merged unapproved", fmt(w.unapprovedMerges), `${pctFmt(1 - (w.approvedShare ?? 0))} of merges`)}
        </div>` +
        hbars(w.topReviewers.slice(0, n), {
          label: r => r.login, value: r => r.count, color: "var(--purple)",
          href: contribHref, internal: true, icon: r => avatar(r.login, 16),
        }) +
        (conc > 0.6 ? `<div class="hint" style="margin-top:12px">Five people are carrying most of the review load — worth watching for burnout.</div>` : "");
    },
  },

  labels: {
    page: "analytics", label: "Label mix", span: 6,
    sub: () => "open PRs per tracked label",
    render(expanded) {
      const p = panel("byLabel");
      if (!p?.ok) return `<div class="error">${esc(p?.error ?? "unavailable")}</div>`;
      const rows = Object.entries(p.data)
        .map(([name, prs]) => ({ name, count: prs.length }))
        .filter(r => r.count)
        .sort((a, b) => b.count - a.count);
      return hbars(expanded ? rows : rows.slice(0, 8), {
        label: r => r.name, value: r => r.count, color: "var(--warn)",
      });
    },
  },

  heatmap: {
    page: "analytics", label: "When PRs open", span: 6,
    sub: () => "last 12 months, UTC",
    render() {
      const a = A();
      if (!a) return missingIngest();
      const max = Math.max(1, ...a.heatmap.flat());
      const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
      const cells = a.heatmap.map((row, d) =>
        `<span class="rl">${days[d]}</span>` + row.map((v, h) =>
          `<span class="cell" style="background:${v ? `color-mix(in srgb, var(--accent) ${Math.round((v / max) * 100)}%, var(--panel-2))` : "var(--panel-2)"}" title="${days[d]} ${String(h).padStart(2, "0")}:00 UTC — ${fmt(v)} PRs"></span>`).join("")
      ).join("");
      const hourRow = `<span></span>` + Array.from({ length: 24 }, (_, h) =>
        `<span class="cl">${h % 6 === 0 ? h : ""}</span>`).join("");
      return `<div class="heat">${cells}${hourRow}</div>
        <div class="hint" style="margin-top:12px">Darker means more PRs opened in that hour. Useful for picking a maintenance window that annoys the fewest people.</div>`;
    },
  },

  /**
   * The org-wide version of the repo drilldown's Most Grossing card.
   *
   * Ten rows rather than five: a top 5 across 1,400 repos is almost entirely
   * one repo's greatest hits, and the point of the org board is that it isn't.
   */
  grossing: {
    page: "analytics", label: "Most grossing", span: 12,
    sub: () => "most discussed and most reacted-to PRs in the org, all time",
    render(expanded) {
      const a = A();
      if (!a) return missingIngest();
      return trio(grossingBoxes(a.grossing), {
        height: expanded ? "tall" : "short",
      }) + grossingNote(a.grossing);
    },
  },

  /**
   * What Actions is costing the org, projected from the runs CI health already
   * sampled.
   *
   * Everything here is an estimate and the card says so in three places, because
   * the numbers are large and large numbers get quoted. See summarizeOrg in
   * src/panels/ciHealth.js for what the projection does and doesn't cover; the
   * short version is that it sees only completed default-branch runs with
   * PR-triggered runs excluded, which on most repos is the minority of all CI
   * activity.
   */
  actions: {
    page: "analytics", label: "Actions load", span: 12, controls: ["filter"],
    sub: () => "estimated org-wide, projected from sampled runs",
    render(expanded) {
      const p = panel("ciHealth");
      if (!p) return `<div class="hint">Built before this panel existed — rerun <code>npm run build</code>.</div>`;
      if (!p.ok) return `<div class="error">CI health unavailable — ${esc(p.error)}</div>`;
      const o = p.data.org;
      if (!o) return `<div class="hint">No org-wide roll-up in this build. Rerun <code>npm run build</code>.</div>`;

      const rateCls = o.passRate == null ? "" : o.passRate > 0.9 ? "up" : o.passRate > 0.7 ? "flat" : "down";
      const tiles = `<div class="kpis" style="margin:-14px -14px 14px">
        ${kpi("Runs per month", `~${fmt(o.runsPerMonth)}`, `projected from ${fmt(o.projectedFrom)} of ${fmt(o.repos)} repos`)}
        ${kpi("Wall-clock hours per month", `~${fmt(o.hoursPerMonth)}`, `~${fmt(o.minutesPerMonth)} minutes`)}
        ${kpi("Average run", ciDur(o.meanRunMinutes), `over ${fmt(o.sampledRuns)} sampled runs`)}
        ${kpi("Pass rate", pctFmt(o.passRate), `${fmt(o.failures)} failed of ${fmt(o.decisive)} decisive`, rateCls)}
      </div>`;

      // The first two are the ones that stop the headline number being
      // misread, so the overview card carries those and the tab carries all
      // four. A card of four paragraphs of caveat under four tiles reads as an
      // apology rather than a measurement.
      const caveats = [
        `<strong>These are estimates, not a bill.</strong> Each repo contributes a rate — the runs in its sample divided by the days that sample covers — and the org figure is the sum of those rates over a 30-day month. A repo that hammered CI last week and has been quiet since projects a month that won't happen.`,
        `<strong>It's a floor, not a total.</strong> Only completed runs on each repo's default branch are sampled, and PR-triggered runs are excluded outright. On most repos those are the majority of all CI activity.`,
        `<strong>Wall-clock, not billable minutes.</strong> Billing is per job: a run with eight matrix jobs in parallel bills roughly eight times what it took on the clock, and macOS bills 10x, Windows 2x. Use this to see the trend and compare periods, not to reconcile an invoice.`,
        `<strong>No job counts.</strong> The runs endpoint returns runs, not jobs — a job breakdown needs one more request per run, roughly 1,500 per build, which would cost more than every other panel combined. The org's real billed total is one request to <code>/orgs/${esc(state.data.org)}/settings/billing/actions</code>, but that needs <code>admin:org</code> and has no per-repo breakdown.`,
      ];
      const notes = (n) => caveats.slice(0, n)
        .map(c => `<div class="hint" style="margin-top:8px">${c}</div>`).join("");

      if (!expanded) return tiles + notes(2);

      // Expanded: which repos are actually spending the time.
      const repos = Object.values(p.data.repos ?? {})
        .filter(r => r.sampleSpanDays && r.timedRuns)
        .map(r => ({
          repo: r.repo,
          perMonth: Math.round((r.runs / r.sampleSpanDays) * 30),
          minutes: Math.round((r.runs / r.sampleSpanDays) * 30 * ((r.totalMinutes ?? 0) / r.timedRuns)),
          median: r.medianMinutes,
          passRate: r.passRate,
        }))
        .sort((a, b) => b.minutes - a.minutes);

      const cols = [
        { key: "repo", label: "Repo", render: r => repoLink(r.repo) },
        { key: "minutes", label: "Est. minutes/month", render: r => `<span class="num">${fmt(r.minutes)}</span>` },
        { key: "perMonth", label: "Est. runs/month", render: r => `<span class="num">${fmt(r.perMonth)}</span>` },
        { key: "median", label: "Median run", render: r => `<span class="num">${ciDur(r.median)}</span>` },
        { key: "passRate", label: "Pass rate", get: r => r.passRate ?? -1, render: r => `<span class="num">${pctFmt(r.passRate)}</span>` },
      ];

      return tiles + notes(4) +
        `<h3 style="font-size:13px;margin:26px 0 8px">Where the time goes</h3>` +
        renderTable(sortRows(applyFilter(repos), cols), cols, { sortable: true });
    },
  },
};
