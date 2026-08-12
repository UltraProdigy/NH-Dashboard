import { CLOSED_LABEL, state } from "../state.js";
import {
  age,
  bucketLabel,
  daysSince,
  diff,
  dur,
  esc,
  fmt,
  kfmt,
  linesOf,
  pctFmt,
  repoLink,
} from "../format.js";
import { barChart, kpi, legend } from "../charts.js";
import { applyFilter, renderTable, sortRows } from "../table.js";
import { activeWindow, windowLabel, windowPhrase } from "../data.js";
import {
  SW,
  biggestRows,
  byLogin,
  byRepo,
  duo,
  linesIn,
  resolvedRows,
  subject,
  subjectSlice,
  windowTable,
} from "../drilldown-data.js";
import { draftNotice, draftOrder, draftPill, sizeNotice } from "../module-helpers.js";

export const contributorModules = {
  /* ---------------- Contributor Drilldown ----------------
     Every module here assumes a subject is selected — render() shows the
     picker instead of the grid when one isn't, so the guard lives in one
     place rather than at the top of all ten. */

  cProfile: {
    page: "contributor", label: "Profile", span: 12, flush: true, twin: "rProfile",
    controls: ["window"],
    sub: () => `${windowPhrase()}`,
    render(expanded) {
      const s = subject(), w = SW();
      if (!expanded) {
        return `<div class="kpis">
          ${/* Closed in the same period rather than the all-time total: two
                numbers on the same clock compare, a windowed one against a
                lifetime one doesn't. "Closed" here is everything that reached
                a terminal state — merged or dropped — which is the natural
                counterpart to "opened". */""}
          ${kpi("PRs opened", fmt(w.opened), `${fmt(w.merged + w.closed)} PRs closed`)}
          ${kpi("Merged", fmt(w.merged), `${pctFmt(w.mergeRate)} of those resolved`)}
          ${kpi("Approvals given", fmt(w.approvals), `for ${fmt(w.reviewers)} different authors`)}
          ${kpi("Repos touched", fmt(w.people), `in ${windowLabel().toLowerCase()}`)}
          ${kpi("Median time to merge", dur(w.medianMergeHours), `p90 ${dur(w.p90MergeHours)}`)}
          ${kpi("Median first review", dur(w.medianFirstReviewHours), "on their PRs")}
          ${/* Added and removed rather than a net figure: a refactor that moves
                4,000 lines nets to zero, which is the least informative thing
                that could be said about it. The median is beside it because the
                sum is dominated by whichever PR regenerated a lang file. */""}
          ${kpi("Lines changed", kfmt(linesIn(w)),
                w.sizedPRs ? `median ${kfmt(w.medianPRLines)} per PR` : "no diff data yet")}
          ${kpi("Commits", fmt(w.commits), `across ${fmt(w.sizedPRs)} sized PRs`)}
          ${kpi("Open PRs", fmt(s.backlog.total), `${fmt(s.backlog.unreviewed)} never reviewed`,
                s.backlog.unreviewed ? "down" : "")}
          ${kpi("Active since", s.first ? new Date(s.first).getFullYear() : "—",
                s.last ? `last seen ${age(daysSince(s.last)).replace(/<[^>]+>/g, "")}` : "")}
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
        ["Authors reviewed for",  w => fmt(w.reviewers)],
        ["Repos touched",         w => fmt(w.people)],
        ["Merged without approval", w => fmt(w.unapprovedMerges)],
        ["Lines added",           w => kfmt(w.additions)],
        ["Lines removed",         w => kfmt(w.deletions)],
        ["Median PR size",        w => (w.sizedPRs ? `${kfmt(w.medianPRLines)} lines` : "—")],
        ["p90 PR size",           w => (w.sizedPRs ? `${kfmt(w.p90PRLines)} lines` : "—")],
        ["Commits",               w => fmt(w.commits)],
        ["Files touched",         w => fmt(w.filesChanged)],
        ["Comments received",     w => fmt(w.comments)],
      ]);
    },
  },

  cActivity: {
    page: "contributor", label: "Activity", span: 8, twin: "rActivity",
    controls: ["window"], sub: () => `by month, ${windowPhrase()}`,
    render(expanded) {
      const s = subjectSlice();
      const prs = [
        { key: "opened", label: "Opened", color: "var(--accent)" },
        { key: "merged", label: "Merged", color: "var(--good)" },
        { key: "closed", label: "Closed unmerged", color: "var(--bad)" },
      ];
      const reviews = [{ key: "approvals", label: "Approvals given", color: "var(--purple)" }];
      const authoring = legend(prs) + barChart(s, prs, { height: expanded ? 300 : 200, everyLabel: true });
      // Two charts rather than one: a prolific reviewer's approval count dwarfs
      // their PR count, and on a shared axis the PR bars vanish entirely.
      const reviewing = `<h3 style="font-size:13px;margin:22px 0 8px">Reviewing</h3>` +
        legend(reviews) + barChart(s, reviews, { height: expanded ? 240 : 140, everyLabel: true });
      return authoring + reviewing +
        (expanded ? `<h3 style="font-size:13px;margin:26px 0 8px">Breakdown</h3>` +
          renderTable([...s].reverse(), [
            { key: "b", label: "Month", render: b => esc(bucketLabel(b.b)) },
            { key: "opened", label: "Opened", render: b => `<span class="num">${fmt(b.opened)}</span>` },
            { key: "merged", label: "Merged", render: b => `<span class="num">${fmt(b.merged)}</span>` },
            { key: "closed", label: "Closed", render: b => `<span class="num">${fmt(b.closed)}</span>` },
            { key: "approvals", label: "Approvals", render: b => `<span class="num">${fmt(b.approvals)}</span>` },
            { key: "people", label: "Repos", render: b => `<span class="num">${fmt(b.people)}</span>` },
          ]) : "");
    },
  },

  /**
   * Where this person's effort goes, split by the two things they do.
   *
   * Authoring and reviewing are different jobs and they land in different
   * repos — plenty of people open PRs against one mod and review across a
   * dozen. One list only ever told half that story. The mirror of rPeople on
   * the repo side, which splits the same card by person instead of by repo.
   */
  cRepos: {
    page: "contributor", label: "Repos", span: 4, twin: "rPeople", fill: true,
    controls: ["window"],
    sub: () => `PRs opened and reviewed, ${windowPhrase()}`,
    render(expanded) {
      const s = subject();
      const w = activeWindow();
      // Side by side once the card is full width, stacked in the 4-column
      // overview slot where two ranked lists would be too narrow to read.
      //
      // `share` is the point of the card as much as the counts are: "48 PRs in
      // GT5-Unofficial" is a different fact at 12% of their output than at 80%,
      // and the bar only compares rows against the biggest one, not against
      // the whole.
      return duo(
        { title: "PRs opened", rows: s?.topRepos?.[w] ?? [], color: "var(--accent)", ...byRepo },
        { title: "PRs reviewed", rows: s?.reviewRepos?.[w] ?? [], color: "var(--purple)", ...byRepo },
        { height: expanded ? "tall" : "short", stacked: !expanded, share: true }
      );
    },
  },

  cCollab: {
    page: "contributor", label: "Collaboration", span: 6, twin: "rHealth", fill: true,
    sub: () => "all time",
    render(expanded) {
      const s = subject();
      return duo(
        { title: "Approves their PRs", rows: s.reviewedBy, color: "var(--good)", ...byLogin },
        { title: "They approve", rows: s.reviewsFor, color: "var(--purple)", ...byLogin },
        { height: expanded ? "tall" : "short" }
      );
    },
  },

  cOpenPRs: {
    page: "contributor", label: "Open PRs", span: 6, flush: true, twin: "rBacklog",
    sub: () => "still waiting",
    render(expanded) {
      const s = subject();
      const cols = [
        { key: "repo",   label: "Repo", render: r => repoLink(r.repo) },
        { key: "number", label: "PR",   render: r => `<a href="https://github.com/${state.data.org}/${encodeURIComponent(r.repo)}/pull/${r.number}" target="_blank" rel="noopener">#${r.number}</a>` },
        { key: "draft",  label: "State", get: r => draftOrder(r.draft), render: r => draftPill(r.draft) },
        { key: "ageDays",   label: "Opened",    render: r => age(r.ageDays) },
        { key: "staleDays", label: "Updated",   render: r => age(r.staleDays) },
        { key: "reviewed",  label: "Reviewed?", render: r => r.reviewed ? "yes" : `<span class="down">never</span>` },
      ];
      return draftNotice(s.backlog) +
        renderTable(sortRows(applyFilter(s.backlog.oldest), cols), cols,
          { sortable: expanded, limit: expanded ? null : 7 });
    },
  },

  cClosed: {
    page: "contributor", label: "Closed PRs", span: 12, flush: true,
    controls: ["window"],
    // tabControls, not controls: the overview gathers every module's controls
    // into one toolbar, and a three-way filter for one card down the page is
    // noise up there. It appears when this tab is the thing you're looking at.
    tabControls: ["closedState"],
    sub: () => `${CLOSED_LABEL[state.closedState]}, ${windowPhrase()}`,
    render(expanded) {
      const rows = resolvedRows();
      const cols = [
        { key: "repo",   label: "Repo",  render: r => repoLink(r.repo) },
        { key: "number", label: "PR",    render: r => `<a href="https://github.com/${state.data.org}/${encodeURIComponent(r.repo)}/pull/${r.number}" target="_blank" rel="noopener">#${r.number}</a>` },
        { key: "merged", label: "Outcome", get: r => (r.merged ? 0 : 1),
          render: r => r.merged
            ? `<span class="pill merged">merged</span>`
            : `<span class="pill dropped">closed</span>` },
        { key: "at", label: "Resolved", get: r => r.at, render: r => age(daysSince(r.at)) },
      ];
      // Already newest-first from the build, and sortRows is a no-op until a
      // header is clicked, so that's the default order for free.
      return renderTable(sortRows(applyFilter(rows), cols), cols,
        { sortable: expanded, limit: expanded ? null : 10 });
    },
  },

  /**
   * The PRs this person is known for.
   *
   * Ranked by lines changed, with commits, comments and reviews beside them —
   * "biggest" has four plausible meanings and the honest answer is to show all
   * four and let the column headers re-rank. Diff size leads because it's the
   * one that most often matches what someone means by "their big PR".
   *
   * Open PRs are included alongside resolved ones: a 6,000-line PR that has
   * been sitting open for a year is exactly the kind of thing this card should
   * surface, and excluding it because it hasn't landed would be perverse.
   */
  cBiggest: {
    page: "contributor", label: "Biggest PRs", span: 12, flush: true,
    controls: ["window"], twin: "rGrossing",
    sub: () => `by lines changed, ${windowPhrase()}`,
    render(expanded) {
      const rows = biggestRows();
      if (!rows.length)
        return `<div class="hint" style="padding:14px">No diff data for this period. It arrives with the ingest backfill — run <code>npm run ingest</code>, then <code>npm run build</code>.</div>`;

      const cols = [
        { key: "repo", label: "Repo", render: r => repoLink(r.repo) },
        { key: "title", label: "PR", get: r => r.title ?? "",
          render: r => `<a href="https://github.com/${state.data.org}/${encodeURIComponent(r.repo)}/pull/${r.number}" target="_blank" rel="noopener">${
            r.title ? esc(r.title) : `#${r.number}`}</a> <span class="repo">#${r.number}</span>` },
        { key: "lines", label: "Lines", get: r => linesOf(r) ?? -1,
          render: r => `<span class="num">${kfmt(linesOf(r))}</span>` },
        { key: "diff", label: "Diff", sortable: false, render: r => diff(r.additions, r.deletions) },
        { key: "commits", label: "Commits", get: r => r.commits ?? -1,
          render: r => `<span class="num">${fmt(r.commits)}</span>` },
        { key: "comments", label: "Comments", get: r => r.comments ?? -1,
          render: r => `<span class="num">${fmt(r.comments)}</span>` },
        { key: "state", label: "Outcome", get: r => (r.open ? 0 : r.merged ? 1 : 2),
          render: r => r.open
            ? `<span class="pill draft">open</span>`
            : r.merged
              ? `<span class="pill merged">merged</span>`
              : `<span class="pill dropped">closed</span>` },
      ];
      // Pre-sorted by size, so sortRows is a no-op until a header is clicked
      // and that's the default order for free — the same deal as Closed PRs.
      return renderTable(sortRows(applyFilter(rows), cols), cols,
        { sortable: expanded, limit: expanded ? 100 : 8 });
    },
  },
};
