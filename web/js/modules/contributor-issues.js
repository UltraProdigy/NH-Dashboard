import { state } from "../state.js";
import { age, daysSince, dur, esc, fmt, pctFmt, repoLink } from "../format.js";
import { barChart, kpi, legend } from "../charts.js";
import { applyFilter, renderTable, sortRows } from "../table.js";
import { activeWindow, windowPhrase } from "../data.js";
import { byLogin, byRepo, duo } from "../drilldown-data.js";
import {
  IIW,
  closedRows,
  closerNotice,
  filedRows,
  hasIssues,
  issueBacklogOf,
  issueMissing,
  issueSlice,
  issueWindowTable,
  issuesOf,
  outcomeOrder,
  outcomePill,
} from "../issue-data.js";

const issueUrl = (r) =>
  `https://github.com/${state.data.org}/${encodeURIComponent(r.repo)}/issues/${r.number}`;

const issueTitle = (r) =>
  `<a href="${issueUrl(r)}" target="_blank" rel="noopener">${
    esc(r.title || `#${r.number}`)}</a> <span class="repo">#${r.number}</span>`;

export const contributorIssueModules = {
  /* ---------------- Contributor Drilldown: issues ----------------
     The other half of what a person does here. Pull requests say what they
     built; these say what they sorted out — and for a good few people in this
     org the second list is the whole contribution. */

  cIssues: {
    page: "contributor", label: "Issues", span: 12, flush: true, twin: "rIssues",
    controls: ["window"],
    sub: () => `filed, answered and closed, ${windowPhrase()}`,
    render(expanded) {
      if (!hasIssues()) return issueMissing();
      const w = IIW();
      const b = issueBacklogOf();

      if (!expanded) {
        return `<div class="kpis">
          ${kpi("Issues filed", fmt(w.filed), `${fmt(w.filedClosed)} of them closed`)}
          ${/* Of their reports that reached a verdict, how many were fixed
                rather than declined. A property of the reports as much as of
                the person — a good report about an unmaintained mod still ends
                up not-planned. */""}
          ${kpi("Accepted", pctFmt(w.acceptedShare), `${fmt(w.filedUnresolved)} declined or duplicate`)}
          ${kpi("Their reports answered", pctFmt(w.answeredShare),
                `${fmt(w.filedUnanswered)} never were`,
                w.answeredShare != null && w.answeredShare < 0.5 ? "down" : "")}
          ${kpi("They waited", dur(w.medianWaitHours), `median, p90 ${dur(w.p90WaitHours)}`)}
          ${kpi("First replies given", fmt(w.responses), `to ${fmt(w.helped)} different people`)}
          ${kpi("They answered in", dur(w.medianResponseLagHours), "median after filing")}
          ${kpi("Issues closed", fmt(w.closed), `${fmt(w.closedForOthers)} of other people's`)}
          ${kpi("Closed by their PR", fmt(w.fixed), "a fix of theirs landed")}
          ${kpi("Open filed", fmt(b.total), `${fmt(b.unanswered)} unanswered`,
                b.unanswered ? "down" : "")}
          ${kpi("Assigned to them", fmt(w.assigned), `${fmt(w.assignedOpen)} still open`)}
        </div>` + closerNotice(w);
      }

      return issueWindowTable([
        ["Issues filed",            (x) => fmt(x.filed)],
        ["…still open",             (x) => fmt(x.filedOpen)],
        ["…closed",                 (x) => fmt(x.filedClosed)],
        ["…closed as completed",    (x) => fmt(x.filedCompleted)],
        ["…declined or duplicate",  (x) => fmt(x.filedUnresolved)],
        ["Accepted share",          (x) => pctFmt(x.acceptedShare)],
        ["…answered by somebody",   (x) => fmt(x.filedAnswered)],
        ["…never answered",         (x) => fmt(x.filedUnanswered)],
        ["Answered share",          (x) => pctFmt(x.answeredShare)],
        ["Median wait for a reply", (x) => dur(x.medianWaitHours)],
        ["p90 wait for a reply",    (x) => dur(x.p90WaitHours)],
        ["Comments received",       (x) => fmt(x.commentsReceived)],
        ["First replies given",     (x) => fmt(x.responses)],
        ["Median reply lag",        (x) => dur(x.medianResponseLagHours)],
        ["p90 reply lag",           (x) => dur(x.p90ResponseLagHours)],
        ["Issues closed",           (x) => fmt(x.closed)],
        ["…other people's",         (x) => fmt(x.closedForOthers)],
        ["…their own",              (x) => fmt(x.closedOwn)],
        ["…as completed",           (x) => fmt(x.closedCompleted)],
        ["…as declined or duplicate", (x) => fmt(x.closedUnresolved)],
        ["…by hand, no PR",         (x) => fmt(x.closedByHand)],
        ["…by a PR of theirs",      (x) => fmt(x.closedByTheirPR)],
        ["Median age at close",     (x) => dur(x.medianCloseLagHours)],
        ["Closed by their PR",      (x) => fmt(x.fixed)],
        ["Assigned",                (x) => fmt(x.assigned)],
        ["…still open",             (x) => fmt(x.assignedOpen)],
        ["Triage acts",             (x) => fmt(x.triage)],
        ["Repos touched",           (x) => fmt(x.repos)],
        ["People helped",           (x) => fmt(x.helped)],
      ]) +
        `<div class="hint" style="margin-top:14px">"Triage acts" is first replies plus closes of other people's issues — the two things a triager does that leave a trace. "Closed by their PR" is credited from the pull request that closed the issue, so it lands on whoever wrote the fix even when somebody else pressed the button. The same close can therefore appear in both columns, which is the honest reading: two people did two different jobs on it.</div>` +
        closerNotice(IIW());
    },
  },

  cTriage: {
    page: "contributor", label: "Triage", span: 6, twin: "rIssuePeople", fill: true,
    controls: ["window"],
    tabControls: ["filter"],
    sub: () => `where they answer and close, ${windowPhrase()}`,
    render(expanded) {
      if (!hasIssues()) return issueMissing();
      const rec = issuesOf(), w = activeWindow(), iw = IIW();

      const lists = duo(
        { title: "Answered first", rows: rec.answeredRepos?.[w] ?? [], color: "var(--purple)", ...byRepo },
        { title: "Closed", rows: rec.closedRepos?.[w] ?? [], color: "var(--good)", ...byRepo },
        { height: expanded ? "tall" : "short", stacked: !expanded, share: true }
      );

      const head = `<div class="kpis" style="margin:-14px -14px 14px">
        ${kpi("Triage acts", fmt(iw.triage), `${fmt(iw.responses)} replies, ${fmt(iw.closedForOthers)} closes`)}
        ${kpi("People helped", fmt(iw.helped), "distinct reporters")}
        ${kpi("Median age at close", dur(iw.medianCloseLagHours), `p90 ${dur(iw.p90CloseLagHours)}`)}
      </div>`;

      if (!expanded) return head + lists;

      const partners = duo(
        { title: "They help", rows: rec.helped ?? [], color: "var(--purple)", ...byLogin },
        { title: "Helped by", rows: rec.helpedBy ?? [], color: "var(--good)", ...byLogin },
        { height: "short" }
      );

      const rows = closedRows();
      const cols = [
        { key: "repo", label: "Repo", render: (r) => repoLink(r.repo) },
        { key: "title", label: "Issue", render: issueTitle },
        { key: "outcome", label: "Outcome", get: outcomeOrder, render: outcomePill },
        { key: "viaPR", label: "How", get: (r) => (r.viaPR ? 0 : 1),
          render: (r) => r.viaPR
            ? `<span class="pill ready">their PR</span>`
            : `<span class="pill unknown">by hand</span>` },
        { key: "own", label: "Whose", get: (r) => (r.own ? 0 : 1),
          render: (r) => (r.own ? "their own" : "somebody else's") },
        { key: "at", label: "Closed", get: (r) => r.at, render: (r) => age(daysSince(r.at)) },
      ];

      return head + lists +
        `<h3 style="font-size:13px;margin:26px 0 8px">Who they work with</h3>` + partners +
        `<h3 style="font-size:13px;margin:26px 0 8px">Everything they closed</h3>` +
        renderTable(sortRows(applyFilter(rows), cols), cols, { sortable: true }) +
        `<div class="hint" style="margin-top:12px">One row per close, whether they pressed the button, wrote the pull request that did, or both — the How column says which. "They help" and "Helped by" are all time rather than windowed: it's a relationship, and a month of it is mostly noise.</div>` +
        closerNotice(iw);
    },
  },

  cFiled: {
    page: "contributor", label: "Filed issues", span: 6, flush: true, twin: "rIssueTriage",
    controls: ["window"],
    tabControls: ["filter"],
    sub: () => `what they reported, ${windowPhrase()}`,
    render(expanded) {
      if (!hasIssues()) return issueMissing();
      const rows = filedRows();
      if (!rows.length)
        return `<div class="empty">Nothing filed in this period.</div>`;

      const cols = [
        { key: "repo", label: "Repo", render: (r) => repoLink(r.repo) },
        { key: "title", label: "Issue", render: issueTitle },
        { key: "outcome", label: "Outcome", get: outcomeOrder, render: outcomePill },
        { key: "waitDays", label: "Answered in", get: (r) => r.waitDays ?? -1,
          render: (r) => (r.waitDays == null
            ? `<span class="down">never</span>`
            : age(r.waitDays)) },
        { key: "comments", label: "Comments", render: (r) => `<span class="num">${fmt(r.comments)}</span>` },
        { key: "at", label: "Filed", get: (r) => r.at, render: (r) => age(daysSince(r.at)) },
      ];

      // Already newest-first from the build, and sortRows is a no-op until a
      // header is clicked, so that's the default order for free.
      const table = renderTable(sortRows(applyFilter(rows), cols), cols,
        { sortable: expanded, limit: expanded ? null : 8 });

      if (!expanded) return table;

      const s = issueSlice();
      const series = [
        { key: "filed", label: "Filed", color: "var(--accent)" },
        { key: "responses", label: "First replies given", color: "var(--purple)" },
        { key: "closed", label: "Closed by them", color: "var(--good)" },
        { key: "fixed", label: "Closed by their PR", color: "var(--pink)" },
      ];

      return table +
        `<h3 style="font-size:13px;margin:26px 0 8px">Issue activity by month</h3>` +
        (s.length
          ? legend(series) + barChart(s, series, { height: 260, everyLabel: true })
          : `<div class="empty">Not enough months to chart.</div>`) +
        `<div class="hint" style="margin-top:10px">"Answered in" is how long the report waited for a reply from anyone other than them — the number they experienced, not the one the tracker averages.</div>`;
    },
  },
};
