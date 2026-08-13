import { state } from "../state.js";
import { age, bucketLabel, daysSince, dur, esc, fmt, kfmt, pctFmt } from "../format.js";
import {
  barChart,
  grossingBoxes,
  grossingNote,
  kpi,
  legend,
  lineChart,
  trio,
} from "../charts.js";
import { applyFilter, renderTable, sortRows } from "../table.js";
import { activeWindow, windowPhrase } from "../data.js";
import {
  SW,
  backlogOf,
  byLogin,
  duo,
  linesIn,
  subject,
  subjectSlice,
  windowTable,
} from "../drilldown-data.js";
import {
  ciSection,
  draftNotice,
  draftOrder,
  draftPill,
  releaseFor,
  sizeNotice,
} from "../module-helpers.js";

export const repoModules = {
  /* ---------------- Repo Drilldown ---------------- */

  rProfile: {
    page: "repo", label: "Profile", span: 12, flush: true, twin: "cProfile",
    controls: ["window"],
    sub: () => `${windowPhrase()}`,
    render(expanded) {
      const s = subject(), w = SW(), bl = backlogOf();
      if (!expanded) {
        return `<div class="kpis">
          ${/* Closed in the same period rather than the all-time total: two
                numbers on the same clock compare, a windowed one against a
                lifetime one doesn't. "Closed" here is everything that reached
                a terminal state — merged or dropped — which is the natural
                counterpart to "opened". */""}
          ${kpi("PRs opened", fmt(w.opened), `${fmt(w.merged + w.closed)} PRs closed`)}
          ${kpi("Merged", fmt(w.merged), `${pctFmt(w.mergeRate)} of those resolved`)}
          ${kpi("Contributors", fmt(w.people), `${fmt(w.reviewers)} of them reviewed`)}
          ${kpi("Approvals", fmt(w.approvals), `${pctFmt(w.approvedShare)} of merges approved`)}
          ${kpi("Median time to merge", dur(w.medianMergeHours), `p90 ${dur(w.p90MergeHours)}`)}
          ${kpi("Median first review", dur(w.medianFirstReviewHours), "after opening")}
          ${kpi("Lines changed", kfmt(linesIn(w)),
                w.sizedPRs ? `median ${kfmt(w.medianPRLines)} per PR` : "no diff data yet")}
          ${kpi("Commits", fmt(w.commits), `across ${fmt(w.sizedPRs)} sized PRs`)}
          ${kpi("Open backlog", fmt(bl.total), `${fmt(bl.unreviewed)} never reviewed`,
                bl.unreviewed > bl.total / 2 ? "down" : "")}
          ${kpi("First PR", s.first ? new Date(s.first).getFullYear() : "—",
                s.last ? `last ${age(daysSince(s.last)).replace(/<[^>]+>/g, "")}` : "")}
        </div>` + sizeNotice(w);
      }
      return windowTable([
        ["PRs opened",            w => fmt(w.opened)],
        ["Merged",                w => fmt(w.merged)],
        ["Closed unmerged",       w => fmt(w.closed)],
        ["Merge rate",            w => pctFmt(w.mergeRate)],
        ["Median time to merge",  w => dur(w.medianMergeHours)],
        ["p90 time to merge",     w => dur(w.p90MergeHours)],
        ["Median first review",   w => dur(w.medianFirstReviewHours)],
        ["Approvals given",       w => fmt(w.approvals)],
        ["Approved before merge", w => pctFmt(w.approvedShare)],
        ["Merged without approval", w => fmt(w.unapprovedMerges)],
        ["Contributors",          w => fmt(w.people)],
        ["Reviewers",             w => fmt(w.reviewers)],
        ["Lines added",           w => kfmt(w.additions)],
        ["Lines removed",         w => kfmt(w.deletions)],
        ["Median PR size",        w => (w.sizedPRs ? `${kfmt(w.medianPRLines)} lines` : "—")],
        ["p90 PR size",           w => (w.sizedPRs ? `${kfmt(w.p90PRLines)} lines` : "—")],
        ["Commits",               w => fmt(w.commits)],
        ["Files touched",         w => fmt(w.filesChanged)],
        ["Comments",              w => fmt(w.comments)],
      ]);
    },
  },

  /**
   * What this repo actually argued about, liked and hated.
   *
   * All-time — see the note in src/panels/grossing.js. The other cards on this
   * page follow the period control; this one says "all time" in its caption
   * rather than displaying a control that would do nothing.
   */
  rGrossing: {
    page: "repo", label: "Most grossing", span: 12, twin: "cBiggest",
    sub: () => "most discussed and most reacted-to PRs, all time",
    render(expanded) {
      const s = subject();
      return trio(grossingBoxes(s.grossing), {
        height: expanded ? "tall" : "short",
        stacked: false,
        repo: s.repo,
      }) + grossingNote(s.grossing);
    },
  },

  rActivity: {
    page: "repo", label: "Activity", span: 8, twin: "cActivity",
    controls: ["window"], sub: () => `by month, ${windowPhrase()}`,
    render(expanded) {
      const s = subjectSlice();
      const prs = [
        { key: "opened", label: "Opened", color: "var(--accent)" },
        { key: "merged", label: "Merged", color: "var(--good)" },
        { key: "closed", label: "Closed unmerged", color: "var(--bad)" },
      ];
      const people = [{ key: "people", label: "Distinct authors", color: "var(--pink)" }];
      return legend(prs) + barChart(s, prs, { height: expanded ? 300 : 200, everyLabel: true }) +
        `<h3 style="font-size:13px;margin:22px 0 8px">People</h3>` +
        legend(people) + lineChart(s, people, { height: expanded ? 240 : 140, everyLabel: true }) +
        (expanded ? `<h3 style="font-size:13px;margin:26px 0 8px">Breakdown</h3>` +
          renderTable([...s].reverse(), [
            { key: "b", label: "Month", render: b => esc(bucketLabel(b.b)) },
            { key: "opened", label: "Opened", render: b => `<span class="num">${fmt(b.opened)}</span>` },
            { key: "merged", label: "Merged", render: b => `<span class="num">${fmt(b.merged)}</span>` },
            { key: "closed", label: "Closed", render: b => `<span class="num">${fmt(b.closed)}</span>` },
            { key: "people", label: "Authors", render: b => `<span class="num">${fmt(b.people)}</span>` },
          ]) : "");
    },
  },

  rPeople: {
    page: "repo", label: "People", span: 6, twin: "cRepos", fill: true,
    controls: ["window"],
    sub: () => `${windowPhrase()}`,
    render(expanded) {
      const s = subject(), w = activeWindow();
      // Shares alongside the counts, mirroring the contributor's Repos card:
      // on a repo, "who wrote most of this" is a question about proportion —
      // one person at 70% is a bus factor, three at 25% each isn't.
      return duo(
        { title: "PRs opened", rows: s.topAuthors[w] ?? [], color: "var(--accent)", ...byLogin },
        { title: "Approvals given", rows: s.topReviewers[w] ?? [], color: "var(--purple)", ...byLogin },
        { height: expanded ? "tall" : "short", share: true }
      );
    },
  },

  rBacklog: {
    page: "repo", label: "Backlog", span: 4, flush: false, twin: "cOpenPRs",
    sub: () => "open PRs, by age",
    render(expanded) {
      const s = subject(), b = backlogOf();
      if (!b.total) return `<div class="empty">Nothing open on this repo.</div>`;
      const colors = ["var(--good)", "var(--accent)", "var(--warn)", "#e8823a", "var(--bad)"];
      const max = Math.max(1, ...b.buckets.map(x => x.count));
      const bars = `<div class="hbars">${b.buckets.map((x, i) => `
        <div class="hbar">
          <span class="lab">${esc(x.label)}</span>
          <span class="track"><span class="fill" style="width:${(x.count / max) * 100}%;background:${colors[i]}"></span></span>
          <span class="val">${fmt(x.count)}</span>
        </div>`).join("")}</div>`;

      const stat = (k, v, cls = "") =>
        `<div><div style="color:var(--muted);font-size:11px">${k}</div><div style="font-size:22px;font-weight:600" class="${cls}">${v}</div></div>`;
      const summary = `<div style="display:flex;gap:18px;margin-bottom:12px;flex-wrap:wrap">
        ${stat("OPEN", fmt(b.total))}
        ${stat("NEVER REVIEWED", fmt(b.unreviewed), b.unreviewed > b.total / 2 ? "down" : "")}
        ${stat("DRAFT", b.draftsKnown ? fmt(b.drafts) : "—")}
      </div>`;

      const cols = [
        { key: "number", label: "PR",     render: r => `<a href="https://github.com/${state.data.org}/${encodeURIComponent(s.repo)}/pull/${r.number}" target="_blank" rel="noopener">#${r.number}</a>` },
        { key: "author", label: "Author", render: r => esc(r.author ?? "—") },
        { key: "draft",  label: "State",  get: r => draftOrder(r.draft), render: r => draftPill(r.draft) },
        { key: "ageDays",   label: "Opened",    render: r => age(r.ageDays) },
        { key: "staleDays", label: "Updated",   render: r => age(r.staleDays) },
        { key: "reviewed",  label: "Reviewed?", render: r => r.reviewed ? "yes" : `<span class="down">never</span>` },
      ];

      // The overview card is only 4 columns wide and the buckets alone left it
      // stretched against a much taller neighbour, so it carries the top of the
      // list too rather than a block of empty panel.
      if (!expanded)
        return summary + bars +
          `<h3 style="font-size:12px;margin:18px 0 6px;color:var(--muted)">Oldest</h3>` +
          `<div class="scroll short">${renderTable(b.oldest, [cols[0], cols[2], cols[3]], { limit: 8 })}</div>`;

      return summary + bars + draftNotice(b) +
        `<h3 style="font-size:13px;margin:22px 0 8px">Open PRs, oldest first</h3>` +
        renderTable(sortRows(applyFilter(b.oldest), cols), cols, { sortable: true });
    },
  },

  rHealth: {
    page: "repo", label: "Health", span: 6, twin: "cCollab",
    controls: ["window"],
    sub: () => `${windowPhrase()}`,
    render() {
      const s = subject(), w = SW();
      const rel = releaseFor(s.repo);

      const review = w.approvedShare == null ? null : w.approvedShare;
      const bars = [
        { label: "Merged with an approval", v: review, color: review == null ? "var(--muted)" : review > 0.8 ? "var(--good)" : review > 0.5 ? "var(--warn)" : "var(--bad)" },
        { label: "Merge rate", v: w.mergeRate, color: "var(--accent)" },
      ].filter(x => x.v != null);

      const gauges = `<div class="hbars">${bars.map(x => `
        <div class="hbar">
          <span class="lab">${esc(x.label)}</span>
          <span class="track"><span class="fill" style="width:${x.v * 100}%;background:${x.color}"></span></span>
          <span class="val">${pctFmt(x.v)}</span>
        </div>`).join("")}</div>`;

      const release = rel
        ? `<div class="kpis" style="margin:18px -14px 0">
             ${kpi("Last release", `<a href="${rel.releaseUrl}" target="_blank" rel="noopener" style="font-size:18px">${esc(rel.tagName)}</a>`,
                   `${fmt(rel.commitsAhead ?? "?")} commits behind ${esc(rel.defaultBranch)}`)}
             ${kpi("Released", age(rel.daysSinceRelease), rel.isPrerelease ? "prerelease" : "")}
           </div>`
        : `<div class="hint" style="margin-top:18px">Not flagged as needing a release — either it's current with its last tag, it has no releases, or it's excluded in <code>RELEASE_EXCLUDED_REPOS</code>.</div>`;

      return `<div class="kpis" style="margin:-14px -14px 16px">
          ${kpi("Merged unapproved", fmt(w.unapprovedMerges), `of ${fmt(w.merged)} merges`, w.unapprovedMerges > w.merged / 2 ? "down" : "")}
          ${kpi("Median first review", dur(w.medianFirstReviewHours), "after opening")}
          ${kpi("Reviewers active", fmt(w.reviewers), `${fmt(w.approvals)} approvals`)}
        </div>` + gauges + ciSection(s.repo) + release;
    },
  },
};
