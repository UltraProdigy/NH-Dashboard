import { state } from "../state.js";
import { age, avatar, contribHref, contribName, dur, esc, fmt, pctFmt } from "../format.js";
import { barChart, hbars, kpi, legend, lineChart } from "../charts.js";
import { applyFilter, renderTable, sortRows } from "../table.js";
import { I, activeWindow, windowPhrase } from "../data.js";
import { byLogin, duo, subject } from "../drilldown-data.js";
import {
  IIW,
  closerNotice,
  hasIssues,
  issueBacklogOf,
  issueMissing,
  issueSlice,
  issueWindowTable,
  issuesOf,
} from "../issue-data.js";
import { groupLabels, groupSection, labelChips } from "./issues.js";

/** Backlog movement reads as a direction, not a magnitude. */
const signed = (n) =>
  n == null ? "—" : n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(Math.abs(n))}` : "0";

const netClass = (n) => (n == null || n === 0 ? "" : n > 0 ? "down" : "up");

const issueLink = (r, repo) =>
  `<a href="https://github.com/${state.data.org}/${encodeURIComponent(repo)}/issues/${r.number}" target="_blank" rel="noopener">${
    esc(r.title || `#${r.number}`)}</a> <span class="repo">#${r.number}</span>`;

/** The five horizontal bars both backlog views draw. */
const bucketBars = (buckets) => {
  const colors = ["var(--good)", "var(--accent)", "var(--warn)", "#e8823a", "var(--bad)"];
  const max = Math.max(1, ...buckets.map((x) => x.count));
  return `<div class="hbars">${buckets.map((x, i) => `
    <div class="hbar">
      <span class="lab">${esc(x.label)}</span>
      <span class="track"><span class="fill" style="width:${(x.count / max) * 100}%;background:${colors[i]}"></span></span>
      <span class="val">${fmt(x.count)}</span>
    </div>`).join("")}</div>`;
};

const stat = (k, v, cls = "") =>
  `<div><div style="color:var(--muted);font-size:11px">${esc(k)}</div><div style="font-size:22px;font-weight:600" class="${cls}">${fmt(v)}</div></div>`;

export const repoIssueModules = {
  /* ---------------- Repo Drilldown: issues ----------------
     The repo page had a complete picture of its pull requests and nothing at
     all about its tracker, which on several repos in this org is where all the
     activity is. Same shape as the PR cards beside them so the two can be read
     against each other. */

  rIssues: {
    page: "repo", label: "Issues", span: 12, flush: true, twin: "cIssues",
    controls: ["window"],
    sub: () => `the tracker, ${windowPhrase()}`,
    render(expanded) {
      if (!hasIssues()) return issueMissing();
      const w = IIW();
      const b = issueBacklogOf();

      if (!expanded) {
        return `<div class="kpis">
          ${kpi("Opened", fmt(w.opened), `${fmt(w.closed)} closed in the same period`)}
          ${kpi("Backlog moved", signed(w.net), `${fmt(b.total)} open now`, netClass(w.net))}
          ${kpi("Median first response", dur(w.medianFirstResponseHours), `p90 ${dur(w.p90FirstResponseHours)}`)}
          ${kpi("Median time to close", dur(w.medianCloseHours), `${fmt(w.closedN)} closed in range`)}
          ${kpi("Answered at all", pctFmt(w.answeredShare), `${fmt(w.neverAnswered)} never were`,
                w.answeredShare != null && w.answeredShare < 0.5 ? "down" : "")}
          ${kpi("Resolved rather than declined", pctFmt(w.completedShare), `${fmt(w.unresolved)} resolved nothing`)}
          ${kpi("Reporters", fmt(w.reporters), `${fmt(w.newReporters)} filing their first`)}
          ${kpi("People answering", fmt(w.responders), `${fmt(w.responses)} first replies`)}
          ${/* Who closes things here, and how. A tracker where nearly every
                close arrives with a pull request is a tracker being fixed; one
                where they're nearly all by hand is one being tidied. Neither is
                wrong, but they're different jobs and the split says which. */""}
          ${kpi("Closers", fmt(w.closers), `${fmt(w.closedByPR)} closes came from a PR`)}
          ${kpi("Unlabeled and open", fmt(b.unlabeled), `of ${fmt(b.total)} open`,
                b.total && b.unlabeled > b.total / 3 ? "down" : "")}
        </div>` + closerNotice(w);
      }

      const s = issueSlice();
      const volume = [
        { key: "opened", label: "Opened", color: "var(--accent)" },
        { key: "closed", label: "Closed", color: "var(--good)" },
      ];
      const people = [
        { key: "responses", label: "First replies", color: "var(--purple)" },
        { key: "people", label: "Distinct reporters", color: "var(--pink)" },
      ];

      return issueWindowTable([
        ["Opened",                    (x) => fmt(x.opened)],
        ["Closed",                    (x) => fmt(x.closed)],
        ["…as completed",             (x) => fmt(x.completed)],
        ["…as not planned",           (x) => fmt(x.notPlanned)],
        ["…as duplicate",             (x) => fmt(x.duplicate)],
        ["Resolved share",            (x) => pctFmt(x.completedShare)],
        ["Backlog moved",             (x) => signed(x.net)],
        ["Median time to close",      (x) => dur(x.medianCloseHours)],
        ["p90 time to close",         (x) => dur(x.p90CloseHours)],
        ["Median first response",     (x) => dur(x.medianFirstResponseHours)],
        ["p90 first response",        (x) => dur(x.p90FirstResponseHours)],
        ["Answered at all",           (x) => pctFmt(x.answeredShare)],
        ["Never answered",            (x) => fmt(x.neverAnswered)],
        ["Labeled on arrival",        (x) => pctFmt(x.labeledShare)],
        ["Unlabeled",                 (x) => fmt(x.unlabeled)],
        ["Reporters",                 (x) => fmt(x.reporters)],
        ["First-time reporters",      (x) => fmt(x.newReporters)],
        ["People answering",          (x) => fmt(x.responders)],
        ["First replies",             (x) => fmt(x.responses)],
        ["People closing",            (x) => fmt(x.closers)],
        ["Closed by a PR",            (x) => fmt(x.closedByPR)],
        ["Closed by hand",            (x) => fmt(x.closedByHand)],
        ["Closer not recorded",       (x) => fmt(x.unknownCloser)],
        ["People assigned",           (x) => fmt(x.assignees)],
        ["Comments",                  (x) => fmt(x.comments)],
      ]) +
        `<h3 style="font-size:13px;margin:26px 0 8px">By month</h3>` +
        (s.length
          ? legend(volume) + barChart(s, volume, { height: 260, everyLabel: true }) +
            `<h3 style="font-size:13px;margin:22px 0 8px">People</h3>` +
            legend(people) + lineChart(s, people, { height: 200, everyLabel: true })
          : `<div class="empty">Not enough months to chart.</div>`) +
        `<div class="hint" style="margin-top:12px">"Labeled on arrival" is measured against issues opened in the period, so it drifts down as the newest arrivals wait for triage — a low number on the 1-month column is normal, a low number on the 1-year column is not.</div>` +
        closerNotice(IIW());
    },
  },

  rIssueTriage: {
    page: "repo", label: "Issue backlog", span: 6, twin: "cFiled",
    tabControls: ["filter"],
    sub: () => "open issues, right now",
    render(expanded) {
      if (!hasIssues()) return issueMissing();
      const b = issueBacklogOf();
      if (!b.total) return `<div class="empty">Nothing open on this tracker.</div>`;

      const summary = `<div style="display:flex;gap:18px;margin-bottom:12px;flex-wrap:wrap">
        ${stat("OPEN", b.total)}
        ${stat("UNANSWERED", b.unanswered, b.unanswered > b.total / 2 ? "down" : "")}
        ${stat("UNLABELED", b.unlabeled, b.unlabeled > b.total / 3 ? "down" : "")}
        ${stat("UNASSIGNED", b.unassigned)}
      </div>`;

      const cols = [
        { key: "number", label: "Issue", render: (r) => issueLink(r, subject().repo) },
        { key: "author", label: "Reporter", render: (r) => contribName(r.author ?? "ghost") },
        { key: "labels", label: "Labels", sortable: false, render: (r) => labelChips(r.labels) },
        { key: "ageDays", label: "Opened", render: (r) => age(r.ageDays) },
        { key: "staleDays", label: "Updated", render: (r) => age(r.staleDays) },
        { key: "answered", label: "Answered?", get: (r) => (r.answered ? 1 : 0),
          render: (r) => (r.answered ? "yes" : `<span class="down">never</span>`) },
      ];

      // The overview card is half width, so it carries the counts, the age
      // profile and the top of the list rather than a block of empty panel.
      if (!expanded)
        return summary + bucketBars(b.buckets) +
          `<h3 style="font-size:12px;margin:18px 0 6px;color:var(--muted)">Oldest</h3>` +
          `<div class="scroll short">${renderTable(b.oldest, [cols[0], cols[3], cols[5]], { limit: 8 })}</div>`;

      return summary +
        `<h3 style="font-size:13px;margin:22px 0 8px">By age</h3>` + bucketBars(b.buckets) +
        `<h3 style="font-size:13px;margin:22px 0 8px">By last activity</h3>` + bucketBars(b.staleBuckets) +
        `<div class="hint" style="margin-top:12px">${fmt(b.stale)} open issues here have had no activity at all in ${b.staleDays} days. "Unanswered" means nobody except the reporter ever commented — a label or an assignment doesn't count, because neither of those is visible to the person waiting.</div>` +
        `<h3 style="font-size:13px;margin:26px 0 8px">Open issues, oldest first</h3>` +
        renderTable(sortRows(applyFilter(b.oldest), cols), cols, { sortable: true });
    },
  },

  rIssuePeople: {
    page: "repo", label: "Issue people", span: 6, twin: "cTriage", fill: true,
    controls: ["window"],
    sub: () => `who files, answers and closes, ${windowPhrase()}`,
    render(expanded) {
      if (!hasIssues()) return issueMissing();
      const rec = issuesOf(), w = activeWindow(), iw = IIW();

      const filing = duo(
        { title: "Most filed", rows: rec.topReporters?.[w] ?? [], color: "var(--accent)", ...byLogin },
        { title: "First to reply", rows: rec.topResponders?.[w] ?? [], color: "var(--purple)", ...byLogin },
        { height: expanded ? "tall" : "short", stacked: !expanded, share: true }
      );

      if (!expanded) return filing;

      const closing = duo(
        { title: "Closed the most", rows: rec.topClosers?.[w] ?? [], color: "var(--good)", ...byLogin },
        { title: "Whose PRs closed them", rows: rec.topFixers?.[w] ?? [], color: "var(--pink)", ...byLogin },
        { height: "tall", share: true }
      );

      const assignees = rec.topAssignees?.[w] ?? [];

      return `<div class="kpis" style="margin:-14px -14px 16px">
          ${kpi("Reporters", fmt(iw.reporters), `${fmt(iw.newReporters)} filing their first`)}
          ${kpi("People answering", fmt(iw.responders), `${fmt(iw.responses)} first replies`)}
          ${kpi("People closing", fmt(iw.closers), `${fmt(iw.closedByPR)} closes came from a PR`)}
        </div>` +
        filing +
        `<h3 style="font-size:13px;margin:26px 0 8px">Closing</h3>` + closing +
        `<h3 style="font-size:13px;margin:26px 0 8px">Assigned</h3>` +
        (assignees.length
          ? hbars(assignees, { label: (r) => r.login, value: (r) => r.count, color: "var(--warn)",
                               href: contribHref, internal: true, icon: (r) => avatar(r.login, 16) })
          : `<div class="empty" style="padding:8px 0">Nobody is assigned anything here.</div>`) +
        `<div class="hint" style="margin-top:12px">Credit for a reply goes to whoever spoke first and isn't the reporter or a bot. "Closed the most" is whoever pressed the button; "whose PRs closed them" is whoever wrote the fix. Both are counted because on this org they're usually different people.</div>` +
        closerNotice(iw);
    },
  },

  /**
   * One repo's label mix, read from the issues panel rather than the drilldown.
   *
   * dashboard.json already carries every label of every repo with its counts and
   * medians, so the drilldown doesn't duplicate a byte of it — this card just
   * looks up its own repo. The consequence is that it needs the issues panel to
   * have built, which is stated rather than silently rendering empty.
   */
  rLabels: {
    page: "repo", label: "Labels", span: 12, flush: true,
    tabControls: ["filter"],
    sub: () => "issue labels on this repo, all time",
    render(expanded) {
      const d = I();
      if (!d) return `<div class="error">Label data comes from the issue analytics panel, which hasn't built. Run <code>npm run ingest</code>, then <code>npm run build</code>.</div>`;
      const repo = subject()?.repo;
      const rows = d.labelsByRepo?.[repo] ?? [];
      if (!rows.length) return `<div class="empty">No labels have ever been used on this tracker.</div>`;

      const groups = groupLabels(d, rows);
      const open = rows.filter((l) => l.open);

      if (!expanded) {
        const status = groups.find((g) => g.name === "Status");
        const show = status ?? { rows: [...rows].sort((a, b) => b.open - a.open) };
        const bars = show.rows.filter((l) => l.open).slice(0, 8);
        if (!bars.length) return `<div class="empty" style="padding:14px">Nothing labeled and open.</div>`;
        return `<div style="padding:0 14px 14px">${
          status ? "" : `<div class="hint" style="margin-bottom:10px">No <code>Status:</code> labels here — showing the busiest instead.</div>`
        }${hbars(bars, { label: (l) => l.short, value: (l) => l.open, color: "var(--warn)", share: true })}</div>`;
      }

      return `<div style="padding:0 14px">
          <div class="kpis" style="margin:0 -14px 8px">
            ${kpi("Labels used", fmt(rows.length), `${fmt(open.length)} with something open`)}
            ${kpi("Open and labeled", fmt(open.reduce((n, l) => n + l.open, 0)), "issues carrying at least one")}
            ${kpi("Slowest to answer", dur(Math.max(0, ...rows.map((l) => l.medianFirstResponseHours ?? 0)) || null),
                  esc(rows.slice().sort((a, b) => (b.medianFirstResponseHours ?? 0) - (a.medianFirstResponseHours ?? 0))[0]?.short ?? ""))}
          </div>
          ${groups.map((g) => groupSection(g, repo)).join("")}
          <div class="hint" style="margin-top:16px">Grouped by the prefix before the colon, because <code>Status:</code> is a triage pipeline and <code>Mod:</code> is a parts list — one ranked chart of both buries the nine labels that say where work is stuck under a hundred that say what it's about.</div>
        </div>`;
    },
  },
};
