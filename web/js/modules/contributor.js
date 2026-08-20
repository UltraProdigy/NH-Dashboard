import { PR_STATE_LABEL, REVIEW_KIND_LABEL, state } from "../state.js";
import {
  activeShare,
  age,
  bucketLabel,
  contribName,
  dateFmt,
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
  backlogOf,
  biggestRows,
  byLogin,
  byRepo,
  duo,
  linesIn,
  prRows,
  prStateOrder,
  queueCounts,
  queueDataMissing,
  reviewRows,
  subject,
  subjectSlice,
  windowTable,
} from "../drilldown-data.js";
import { cardSeg, draftNotice, draftPill, sizeNotice } from "../module-helpers.js";

const prUrl = (r) =>
  `https://github.com/${state.data.org}/${encodeURIComponent(r.repo)}/pull/${r.number}`;

const prTitle = (r) =>
  `<a href="${prUrl(r)}" target="_blank" rel="noopener">${
    esc(r.title || `#${r.number}`)}</a> <span class="repo">#${r.number}</span>`;

/**
 * The merged State column. An open PR's draft status and a resolved one's
 * outcome are the same question asked at different points — "where is this" —
 * so they share a column rather than each having one that's blank half the time.
 */
const prStatePill = (r) =>
  r.open
    ? draftPill(r.draft)
    : r.merged
      ? `<span class="pill merged">merged</span>`
      : `<span class="pill dropped">closed</span>`;

/* Why a PR is on their plate, and how the last review went. Requests read as
   the thing to act on, so they take the attention colour; the rest are
   context. */
const WHY_TONE = { requested: "fail", reviewing: "neutral", assigned: "merged" };
const VERDICT_TONE = {
  APPROVED: "pass", CHANGES_REQUESTED: "fail",
  COMMENTED: "neutral", DISMISSED: "unknown", PENDING: "draft",
};

/**
 * How long this person has been around, and how much of it they were working.
 *
 * Measured over their own span rather than the org's: somebody who did six
 * months of solid work in 2019 was not idle for the seven years since, they
 * left, and a percentage that counts the leaving would say more about the
 * calendar than about them. The denominator is first activity to last, so it
 * reads "while they were here".
 */
function tenureNote(s) {
  if (!s.first) return "";
  const share = activeShare(s);
  if (share == null) return "rebuild for the active-day count";
  return `active ${fmt(s.activeDays)} of ${fmt(s.activeSpan)} days · ${pctFmt(share)}`;
}

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
      const s = subject(), w = SW(), b = backlogOf();
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
          ${kpi("Open PRs", fmt(b.total), `${fmt(b.unreviewed)} never reviewed`,
                b.unreviewed ? "down" : "")}
          ${/* The full date, not the year. "2021" is true of twelve months and
                tells you which of them only by accident, and the tile sat next
                to nine others carrying real numbers. The line underneath is
                the density behind the span — a year on the calendar and a year
                of work are very different claims about somebody. */""}
          ${kpi("Active since", dateFmt(s.first), tenureNote(s), "date")}
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

  /**
   * What somebody is waiting on this person for.
   *
   * Replaces the Open PRs card, which showed their own backlog — a list the
   * merged Pull requests card now carries as one of its four states, and which
   * was never the question an admin opens a contributor page to ask. This is:
   * reviews they've been asked for, reviews they've started and not finished,
   * and the PRs they were put down as owning.
   *
   * Individual reviewers only. A team review request resolves to a team rather
   * than to people, and attributing one to its members needs org read the
   * ingest token doesn't have — so a PR whose only outstanding request is to a
   * team is absent here rather than wrongly quiet.
   */
  cReviews: {
    page: "contributor", label: "Reviews", span: 6, flush: true,
    controls: ["filter"],
    // In this card's own header rather than the page toolbar. It filters one
    // card, so it sits on that card — and unlike `tabControls` it's there on
    // the overview too, which is where you most want to flip it.
    controlsHtml: () => cardSeg("reviewKind"),
    sub: () => `${REVIEW_KIND_LABEL[state.reviewKind].toLowerCase()}, on their plate`,
    render(expanded) {
      const q = queueCounts();
      const missing = queueDataMissing();

      const head = `<div class="kpis">
        ${kpi("Review requests", fmt(q.requested), "waiting on them", q.requested ? "down" : "")}
        ${kpi("Ongoing reviews", fmt(q.reviewing), "reviewed, not yet merged")}
        ${kpi("Assigned PRs", fmt(q.assignedOpen), `${fmt(q.assigned)} all time`)}
      </div>`;

      // Two separate absences, and they need separate wording: the review
      // backfill is the cheap one and may well have run on its own.
      const notices =
        (missing.requests
          ? `<div class="hint" style="padding:12px 14px 0">Review requests aren't in the store yet. Run <code>npm run ingest</code> — it re-walks the open PRs only, then <code>npm run build</code>.</div>`
          : "") +
        (missing.assignees
          ? `<div class="hint" style="padding:12px 14px 0">Assignments aren't in the store yet. Run <code>npm run ingest</code> — this one re-walks every PR once, since assignment outlives the close.</div>`
          : "");

      const rows = reviewRows();
      const cols = [
        { key: "repo", label: "Repo", render: r => repoLink(r.repo) },
        { key: "title", label: "PR", get: r => r.title ?? "", render: prTitle },
        { key: "author", label: "Author", render: r => contribName(r.author) },
        { key: "why", label: "Why", sortable: false, render: r => r.why.map(w =>
            `<span class="pill ${WHY_TONE[w]}">${w}</span>`).join(" ") },
        { key: "state", label: "State", get: prStateOrder,
          render: r => (r.outcome === 0
            ? draftPill(r.draft)
            : r.outcome === 1
              ? `<span class="pill merged">merged</span>`
              : `<span class="pill dropped">closed</span>`) },
        { key: "reviewState", label: "Verdict", get: r => r.reviewState ?? "",
          render: r => (r.reviewState
            ? `<span class="pill ${VERDICT_TONE[r.reviewState] ?? "unknown"}">${
                esc(r.reviewState.toLowerCase().replace("_", " "))}</span>`
            : `<span class="sub">—</span>`) },
        { key: "ageDays", label: "Opened", render: r => age(r.ageDays) },
        { key: "staleDays", label: "Updated", render: r => age(r.staleDays) },
      ];

      // Narrow in the overview slot, so the four columns that carry the point
      // of the card and none of the ones that only refine it.
      const shown = expanded
        ? cols
        : cols.filter(c => ["title", "why", "state", "ageDays"].includes(c.key));

      const table = renderTable(sortRows(applyFilter(rows), shown), shown,
        { sortable: expanded, limit: expanded ? null : 6 });

      if (!expanded) return head + notices + table;

      return head + notices + table +
        `<div class="hint" style="margin-top:12px">A PR can carry more than one reason and often does — being re-requested after a round of changes puts it in both review lists, and being assigned something you're also asked to review is normal. It's one row either way, with every reason on it. "Ongoing" means the newest thing they said on a PR that hasn't landed: an approval sitting on an unmerged PR is as much an open loop as a request for changes, just somebody else's. Assignments are the only half that keeps closed rows, because "what did I own" is a fair question about last quarter as well as today.</div>`;
    },
  },

  /**
   * Their pull requests, whatever state they're in.
   *
   * Open and closed were two cards, which split one list down a line nobody
   * asks questions across: the tables shared five of six columns, and "how much
   * has this person got going in GT5-Unofficial" meant reading both and adding
   * up. One table with a four-way state filter, and "All" — which the old pair
   * could not express at all.
   */
  cPRs: {
    page: "contributor", label: "Pull requests", span: 12, flush: true, twin: "rBacklog",
    controls: ["window", "filter"],
    controlsHtml: () => cardSeg("prState"),
    sub: () => `${PR_STATE_LABEL[state.prState].toLowerCase()}, ${windowPhrase()}`,
    render(expanded) {
      const rows = prRows();
      const cols = [
        { key: "repo",   label: "Repo",  render: r => repoLink(r.repo) },
        { key: "title",  label: "PR", get: r => r.title ?? "", render: prTitle },
        { key: "state",  label: "State", get: prStateOrder, render: prStatePill },
        { key: "ageDays", label: "Opened", render: r => age(r.ageDays) },
        { key: "at", label: "Resolved", get: r => r.at ?? "",
          render: r => (r.at ? age(daysSince(r.at)) : `<span class="sub">—</span>`) },
        { key: "reviewed", label: "Reviewed?", get: r => (r.open ? (r.reviewed ? 1 : 0) : 2),
          render: r => (!r.open
            ? `<span class="sub">—</span>`
            : r.reviewed ? "yes" : `<span class="down">never</span>`) },
      ];
      // Already ordered by the build and by prRows, and sortRows is a no-op
      // until a header is clicked, so that's the default order for free.
      return draftNotice(backlogOf()) +
        renderTable(sortRows(applyFilter(rows), cols), cols,
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
    controls: ["window", "filter"], twin: "rGrossing",
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
