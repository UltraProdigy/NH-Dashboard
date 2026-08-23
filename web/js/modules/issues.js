import { state } from "../state.js";
import {
  age,
  avatar,
  bucketLabel,
  contribHref,
  contribLink,
  contribName,
  dur,
  esc,
  fmt,
  pctFmt,
  repoHref,
  repoLink,
} from "../format.js";
import {
  barChart,
  hbars,
  kpi,
  legend,
  lineChart,
  trio,
} from "../charts.js";
import { applyFilter, renderTable, sortRows } from "../table.js";
import {
  I,
  IW,
  dayLimitNote,
  delta,
  issuePeople,
  seriesSlice,
  windowLabel,
  windowPhrase,
} from "../data.js";

const missing = () =>
  `<div class="error">Issue analytics needs the local issue store. Run <code>npm run ingest</code>, then <code>npm run build</code>.</div>`;

/** Backlog movement reads as a direction, not a magnitude. */
const signed = (n) =>
  n == null ? "—" : n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(Math.abs(n))}` : "0";

/** Growing backlog is bad news, shrinking is good — the opposite of a count. */
const netClass = (n) => (n == null || n === 0 ? "" : n > 0 ? "down" : "up");

const issueUrl = (r) =>
  `https://github.com/${state.data.org}/${encodeURIComponent(r.repo)}/issues/${r.number}`;

const issueTitle = (r) =>
  `<a href="${r.url ?? issueUrl(r)}" target="_blank" rel="noopener">${
    esc(r.title || `#${r.number}`)}</a> <span class="repo">#${r.number}</span>`;

const labelChips = (names) =>
  names?.length
    ? names.map((n) => `<span class="label">${esc(n)}</span>`).join("")
    : `<span class="pill unknown">none</span>`;

/** The open-issue table, shared by every triage list. */
const TRIAGE_COLS = [
  { key: "repo", label: "Repo", render: (r) => repoLink(r.repo) },
  { key: "title", label: "Issue", render: issueTitle },
  { key: "author", label: "Reporter", render: (r) => contribName(r.author ?? "ghost") },
  { key: "labels", label: "Labels", sortable: false, render: (r) => labelChips(r.labels) },
  { key: "ageDays", label: "Opened", render: (r) => age(r.ageDays) },
  { key: "staleDays", label: "Updated", render: (r) => age(r.staleDays) },
  {
    key: "answered",
    label: "Answered?",
    get: (r) => (r.answered ? 1 : 0),
    render: (r) => (r.answered ? "yes" : `<span class="down">never</span>`),
  },
];

/** Three boxes of open issues, ranked by whichever day count each one is about. */
const attentionBoxes = (t) => [
  {
    title: "Oldest open",
    unit: "days old",
    rows: (t.oldest ?? []).map((r) => ({ ...r, count: r.ageDays })),
  },
  {
    title: "Quietest",
    unit: "days untouched",
    rows: (t.quietest ?? []).map((r) => ({ ...r, count: r.staleDays ?? 0 })),
  },
  {
    title: "Never answered",
    unit: "days old",
    rows: (t.ignored ?? []).map((r) => ({ ...r, count: r.ageDays })),
  },
];


/* ---- label view -------------------------------------------------------- */

/** Which repo's labels are on screen. Null state means the configured focus. */
const labelRepo = () => state.issueLabelRepo ?? I()?.labelFocus ?? null;

/**
 * Rows bucketed by prefix, in the order the panel declared.
 *
 * Exported alongside groupSection and LABEL_COLS because the repo drilldown
 * shows one repo's label mix with the same three-part treatment — bars for
 * what's open, a table for the rest, grouped by prefix. Two copies of that
 * would drift in a week.
 */
function groupLabels(d, rows) {
  const order = d.labelGroupOrder ?? [];
  const by = new Map();
  for (const l of rows) {
    if (!by.has(l.group)) by.set(l.group, []);
    by.get(l.group).push(l);
  }
  return [...by.entries()]
    .map(([name, rs]) => ({ name, rows: rs }))
    .sort((a, b) => {
      const ai = order.indexOf(a.name), bi = order.indexOf(b.name);
      return (ai === -1 ? order.length : ai) - (bi === -1 ? order.length : bi) ||
        a.name.localeCompare(b.name);
    });
}

function repoPicker(d, repo) {
  const repos = Object.keys(d.labelsByRepo ?? {}).sort(
    (a, b) => (d.labelsByRepo[b]?.length ?? 0) - (d.labelsByRepo[a]?.length ?? 0)
  );
  return `<label class="minlabel" style="margin-bottom:16px;display:inline-flex">repo
    <select id="issueLabelRepo">${repos.map((r) =>
      `<option value="${esc(r)}"${r === repo ? " selected" : ""}>${esc(r)} (${fmt(d.labelsByRepo[r].length)})</option>`
    ).join("")}</select></label>`;
}

const LABEL_COLS = [
  { key: "short", label: "Label", render: (l) => `<span class="label">${esc(l.short)}</span>` },
  { key: "open", label: "Open", render: (l) => `<span class="num">${fmt(l.open)}</span>` },
  { key: "closed", label: "Closed", render: (l) => `<span class="num">${fmt(l.closed)}</span>` },
  { key: "total", label: "All time", render: (l) => `<span class="num">${fmt(l.total)}</span>` },
  { key: "unanswered", label: "Unanswered", render: (l) => `<span class="num ${l.unanswered ? "down" : ""}">${fmt(l.unanswered)}</span>` },
  { key: "medianFirstResponseHours", label: "Median response", get: (l) => l.medianFirstResponseHours ?? -1, render: (l) => `<span class="num">${dur(l.medianFirstResponseHours)}</span>` },
  { key: "medianCloseHours", label: "Median close", get: (l) => l.medianCloseHours ?? -1, render: (l) => `<span class="num">${dur(l.medianCloseHours)}</span>` },
];

/** Filter on the bare label, not the prefixed name — you type "GT", not "Mod: GT". */
const filterLabels = (rows) => {
  const q = state.filter.trim().toLowerCase();
  return q ? rows.filter((l) => l.short.toLowerCase().includes(q) || l.name.toLowerCase().includes(q)) : rows;
};

function groupSection(g, repo) {
  const rows = filterLabels(g.rows);
  if (!rows.length) return "";
  const open = rows.filter((l) => l.open);
  const openTotal = open.reduce((n, l) => n + l.open, 0);

  return `<h3 style="font-size:13px;margin:26px 0 8px">${esc(g.name)}
      <span class="sub" style="font-weight:400">${fmt(rows.length)} labels · ${fmt(openTotal)} open</span></h3>` +
    (open.length
      ? hbars(open.slice(0, 10).sort((a, b) => b.open - a.open), {
          label: (l) => l.short, value: (l) => l.open, color: "var(--warn)", share: true,
        })
      : `<div class="empty" style="padding:8px 0">Nothing open under ${esc(g.name)}.</div>`) +
    renderTable(sortRows(rows, LABEL_COLS), LABEL_COLS, { sortable: true, limit: 12 });
}

/**
 * Monthly opened/closed for one label.
 *
 * Only the focus repo carries series, and only labels above the panel's
 * threshold — a trend line for a label with four issues is two dots and a gap.
 */
function trendSection(d, repo) {
  if (repo !== d.labelFocus) {
    return `<div class="hint" style="margin-top:26px">Monthly trends are kept for <strong>${esc(d.labelFocus)}</strong> only — that's the tracker whose labels carry enough volume to trend. Change <code>ISSUE_LABEL_REPO</code> in <code>src/config.js</code> to move them.</div>`;
  }

  const names = Object.keys(d.labelSeries ?? {});
  if (!names.length) return "";

  const byTotal = new Map((d.labelsByRepo[repo] ?? []).map((l) => [l.name, l.total]));
  names.sort((a, b) => (byTotal.get(b) ?? 0) - (byTotal.get(a) ?? 0));
  const pick = names.includes(state.issueLabel) ? state.issueLabel : names[0];

  const buckets = Object.entries(d.labelSeries[pick] ?? {})
    .map(([b, [opened, closed]]) => ({ b, opened, closed }))
    .sort((a, b) => a.b.localeCompare(b.b));

  const series = [
    { key: "opened", label: "Opened", color: "var(--accent)" },
    { key: "closed", label: "Closed", color: "var(--good)" },
  ];

  return `<h3 style="font-size:13px;margin:30px 0 8px">Trend</h3>
    <label class="minlabel" style="margin-bottom:12px;display:inline-flex">label
      <select id="issueLabelPick">${names.map((n) =>
        `<option value="${esc(n)}"${n === pick ? " selected" : ""}>${esc(n)} (${fmt(byTotal.get(n) ?? 0)})</option>`
      ).join("")}</select></label>` +
    legend(series) + barChart(buckets, series, { height: 240 }) +
    `<div class="hint" style="margin-top:10px">Last five years, monthly. Only labels with ${fmt(d.labelSeriesMin)}+ issues get a trend — the rest are in the tables above.</div>`;
}


export { LABEL_COLS, groupLabels, groupSection, issueTitle, labelChips, TRIAGE_COLS };

export const issueModules = {
  /* ---------------- Issue Analytics ---------------- */

  iPulse: {
    page: "issues", label: "Pulse", span: 12, flush: true,
    sub: () => IW()?.prevLabel
      ? `${windowPhrase()} vs. ${IW().prevLabel}`
      : windowLabel().toLowerCase(),
    render(expanded) {
      const d = I(), w = IW();
      if (!w) return missing();
      const t = d.triage;

      if (!expanded) {
        return `<div class="kpis">
          ${kpi("Opened", fmt(w.opened), delta("opened", { w, fallback: `across ${fmt(w.activeRepos)} repos` }))}
          ${kpi("Closed", fmt(w.closed), delta("closed", { w, fallback: `${fmt(w.unresolved)} resolved nothing` }))}
          ${/* No delta on this one. It's a signed quantity, and a percentage
                change against a period that closed more than it opened comes
                out backwards — "▼ 150%" on a backlog that grew. */""}
          ${kpi("Backlog moved", signed(w.net), `${fmt(t.open)} open now`, netClass(w.net))}
          ${kpi("Median time to close", dur(w.medianCloseHours), delta("medianCloseHours", { w, invert: true, fallback: `p90 ${dur(w.p90CloseHours)}` }))}
          ${kpi("Median first response", dur(w.medianFirstResponseHours), delta("medianFirstResponseHours", { w, invert: true, fallback: `${fmt(w.responses)} replies` }))}
          ${kpi("Never answered", fmt(w.neverAnswered), delta("neverAnswered", { w, invert: true, fallback: `of ${fmt(w.opened)} opened` }), w.opened && w.neverAnswered > w.opened / 2 ? "down" : "")}
          ${kpi("Reporters", fmt(w.reporters), delta("reporters", { w, fallback: `${fmt(w.responders)} of them answered one` }))}
          ${kpi("Unlabeled", fmt(t.unlabeled), `of ${fmt(t.open)} open`, t.open && t.unlabeled > t.open / 3 ? "down" : "")}
        </div>`;
      }

      const rows = [
        ["Opened",                  (x) => fmt(x.opened)],
        ["Closed",                  (x) => fmt(x.closed)],
        ["Closed as completed",     (x) => fmt(x.completed)],
        ["Closed as not planned",   (x) => fmt(x.notPlanned)],
        ["Closed as duplicate",     (x) => fmt(x.duplicate)],
        ["Completed share",         (x) => pctFmt(x.completedShare)],
        ["Backlog moved",           (x) => signed(x.net)],
        ["Median time to close",    (x) => dur(x.medianCloseHours)],
        ["p90 time to close",       (x) => dur(x.p90CloseHours)],
        ["Median first response",   (x) => dur(x.medianFirstResponseHours)],
        ["p90 first response",      (x) => dur(x.p90FirstResponseHours)],
        ["Answered at all",         (x) => pctFmt(x.answeredShare)],
        ["Never answered",          (x) => fmt(x.neverAnswered)],
        ["Labeled on arrival",      (x) => pctFmt(x.labeledShare)],
        ["Unlabeled",               (x) => fmt(x.unlabeled)],
        ["Reporters",               (x) => fmt(x.reporters)],
        ["First-time reporters",    (x) => fmt(x.newReporters)],
        ["People answering",        (x) => fmt(x.responders)],
        ["Repos touched",           (x) => fmt(x.activeRepos)],
        ["Comments",                (x) => fmt(x.comments)],
      ];

      return `<table>
        <thead><tr><th style="cursor:default">Metric</th>${d.windows.map(x => `<th style="cursor:default" class="num">${esc(x.label)}</th>`).join("")}</tr></thead>
        <tbody>${rows.map(([lab, f]) =>
          `<tr><td>${lab}</td>${d.windows.map(x => `<td class="num">${f(d.byWindow[x.id])}</td>`).join("")}</tr>`).join("")}</tbody>
      </table>
      <div class="hint" style="margin-top:14px">"Labeled on arrival" is measured against issues opened in the period, so it drifts down as the newest arrivals wait for triage — a low number on the 1-month column is normal, a low number on the 1-year column is not.</div>
      <div class="hint" style="margin-top:8px">Completed share is everything closed that wasn't marked not-planned or duplicate. ${d.totals.unknownReason ? `${fmt(d.totals.unknownReason)} of ${fmt(d.totals.closed)} closed issues carry no recorded reason at all and count as completed by default — read the all-time column with that in mind.` : `Every closed issue in the store carries a recorded reason, so nothing here is inferred.`}</div>`;
    },
  },

  iVolume: {
    page: "issues", label: "Issue volume", span: 8,
    sub: () => `by ${state.gran}, ${windowPhrase()}`,
    controls: ["gran"],
    render(expanded) {
      const d = I();
      if (!d) return missing();
      const s = seriesSlice(d);
      const series = [
        { key: "opened", label: "Opened", color: "var(--accent)" },
        { key: "closed", label: "Closed", color: "var(--good)" },
        { key: "unresolved", label: "Closed unresolved", color: "var(--warn)" },
      ];
      const tot = (k) => s.reduce((n, b) => n + (b[k] ?? 0), 0);
      const net = tot("opened") - tot("closed");

      const head = `<div class="kpis" style="margin:-14px -14px 14px">
        ${kpi("Opened in range", fmt(tot("opened")), `${s.length} ${state.gran}s`)}
        ${kpi("Closed in range", fmt(tot("closed")), `${fmt(tot("unresolved"))} resolved nothing`)}
        ${kpi("Net backlog", signed(net), net > 0 ? "the pile grew" : net < 0 ? "the pile shrank" : "broke even", netClass(net))}
      </div>`;

      const table = () => {
        const cols = [
          { key: "b", label: state.gran === "month" ? "Month" : state.gran === "week" ? "Week" : "Day", render: (r) => esc(bucketLabel(r.b)) },
          { key: "opened", label: "Opened", render: (r) => `<span class="num">${fmt(r.opened)}</span>` },
          { key: "closed", label: "Closed", render: (r) => `<span class="num">${fmt(r.closed)}</span>` },
          { key: "net", label: "Net", render: (r) => `<span class="num ${netClass(r.net)}">${signed(r.net)}</span>` },
          { key: "reporters", label: "Reporters", render: (r) => `<span class="num">${fmt(r.reporters)}</span>` },
          { key: "closeMedianH", label: "Median close", render: (r) => `<span class="num">${dur(r.closeMedianH)}</span>` },
        ];
        return `<h3 style="font-size:13px;margin:22px 0 8px">By ${state.gran}</h3>` +
          renderTable(sortRows([...s].reverse(), cols), cols, { sortable: true });
      };

      return head + legend(series) + barChart(s, series, { height: expanded ? 380 : 210 }) +
        dayLimitNote(d) + (expanded ? table() : "");
    },
  },

  iTriage: {
    page: "issues", label: "Triage state", span: 4,
    sub: () => "open issues, right now",
    tabControls: ["filter"],
    render(expanded) {
      const d = I();
      if (!d) return missing();
      const t = d.triage;
      const colors = ["var(--good)", "var(--accent)", "var(--warn)", "#e8823a", "var(--bad)"];
      const max = Math.max(1, ...t.ageBuckets.map((x) => x.count));

      const bars = `<div class="hbars">${t.ageBuckets.map((x, i) => `
        <div class="hbar">
          <span class="lab">${esc(x.label)}</span>
          <span class="track"><span class="fill" style="width:${(x.count / max) * 100}%;background:${colors[i]}"></span></span>
          <span class="val">${fmt(x.count)}</span>
        </div>`).join("")}</div>`;

      const stat = (k, v, cls = "") =>
        `<div><div class="k" style="color:var(--muted);font-size:11px">${esc(k)}</div><div style="font-size:22px;font-weight:600" class="${cls}">${fmt(v)}</div></div>`;

      const summary = `<div style="display:flex;gap:18px;margin-bottom:12px;flex-wrap:wrap">
        ${stat("OPEN", t.open)}
        ${stat("UNLABELED", t.unlabeled, t.open && t.unlabeled > t.open / 3 ? "down" : "")}
        ${stat("UNANSWERED", t.unanswered, t.open && t.unanswered > t.open / 2 ? "down" : "")}
        ${stat("UNASSIGNED", t.unassigned)}
      </div>`;

      if (!expanded) return summary + bars;

      const stale = `<h3 style="font-size:13px;margin:22px 0 8px">By last activity</h3>` +
        `<div class="hbars">${t.staleBuckets.map((x, i) => `
          <div class="hbar">
            <span class="lab">${esc(x.label)}</span>
            <span class="track"><span class="fill" style="width:${(x.count / Math.max(1, ...t.staleBuckets.map(y => y.count))) * 100}%;background:${colors[i]}"></span></span>
            <span class="val">${fmt(x.count)}</span>
          </div>`).join("")}</div>`;

      return summary + `<h3 style="font-size:13px;margin:22px 0 8px">By age</h3>` + bars + stale +
        `<div class="hint" style="margin-top:12px">${fmt(t.stale)} open issues have had no activity at all in ${t.staleDays} days. "Unanswered" means nobody except the reporter ever commented — a label or an assignment doesn't count, because neither of those is visible to the person waiting.</div>` +
        `<h3 style="font-size:13px;margin:26px 0 8px">Oldest open issues</h3>` +
        renderTable(sortRows(applyFilter(t.oldest), TRIAGE_COLS), TRIAGE_COLS, { sortable: true });
    },
  },

  iResponse: {
    page: "issues", label: "Response and resolution", span: 6,
    sub: () => `median hours, by ${state.gran}`,
    render(expanded) {
      const d = I();
      if (!d) return missing();
      const w = IW();
      // Same guard the PR latency chart uses: a bucket with two closes swings
      // the median hard enough to make the line meaningless.
      const s = seriesSlice(d).filter((b) => b.closeN > 3 || b.responseN > 3);
      const series = [
        { key: "responseMedianH", label: "To first response (median)", color: "var(--purple)" },
        { key: "closeMedianH", label: "To close (median)", color: "var(--good)" },
        { key: "closeP90H", label: "To close (p90)", color: "var(--warn)" },
      ];

      const head = `<div class="kpis" style="margin:-14px -14px 14px">
        ${kpi("Median first response", dur(w?.medianFirstResponseHours), `p90 ${dur(w?.p90FirstResponseHours)}`)}
        ${kpi("Answered at all", pctFmt(w?.answeredShare), `${fmt(w?.neverAnswered)} never were`)}
        ${kpi("Median time to close", dur(w?.medianCloseHours), `${fmt(w?.closedN)} closed in range`)}
      </div>`;

      return head + legend(series) +
        lineChart(s, series, { height: expanded ? 380 : 200, fmtV: dur }) +
        `<div class="hint" style="margin-top:10px">Response time is dated to the issue that was opened, not the reply — a slow month is a month whose arrivals waited, wherever the answer eventually landed.</div>` +
        dayLimitNote(d);
    },
  },

  iLabels: {
    page: "issues", label: "Label mix", span: 6,
    tabControls: ["filter"],
    sub: () => {
      const d = I();
      if (!d) return "";
      const r = labelRepo();
      return r === d.labelFocus ? `${r}, by status` : r ?? "";
    },
    render(expanded) {
      const d = I();
      if (!d) return missing();
      const repo = labelRepo();
      const rows = d.labelsByRepo?.[repo] ?? [];
      if (!rows.length) return `<div class="empty">No labels on ${esc(repo ?? "any repo")}.</div>`;

      const groups = groupLabels(d, rows);

      if (!expanded) {
        // The Status group is the triage pipeline — where work is stuck, not
        // what it's about — so it's what the card shows. Repos without one
        // fall back to whatever they use most.
        const status = groups.find((g) => g.name === "Status");
        const show = status ?? { name: null, rows: [...rows].sort((a, b) => b.open - a.open) };
        const bars = show.rows.filter((l) => l.open).slice(0, 9);
        if (!bars.length) return `<div class="empty">Nothing labeled and open.</div>`;
        return (status ? "" : `<div class="hint" style="margin-bottom:10px">No <code>Status:</code> labels on this repo — showing its busiest instead.</div>`) +
          hbars(bars, {
            label: (l) => l.short, value: (l) => l.open, color: "var(--warn)",
          });
      }

      return repoPicker(d, repo) +
        groups.map((g) => groupSection(g, repo)).join("") +
        trendSection(d, repo);
    },
  },

  iRepos: {
    page: "issues", label: "Where the issues are", span: 6,
    sub: () => "open issues per repo",
    tabControls: ["filter"],
    render(expanded) {
      const d = I();
      if (!d) return missing();
      const rows = d.repos.filter((r) => r.open);
      if (!rows.length) return `<div class="empty">No open issues anywhere.</div>`;

      const openTotal = rows.reduce((n, r) => n + r.open, 0);
      const head = `<div class="kpis" style="margin:-14px -14px 14px">
        ${kpi("Repos with open issues", fmt(rows.length), `of ${fmt(d.repos.length)} with any`)}
        ${kpi("Open issues", fmt(openTotal), `${fmt(d.totals.closed)} closed all time`)}
        ${kpi("In the busiest repo", pctFmt(openTotal ? rows[0].open / openTotal : null), esc(rows[0].repo))}
      </div>`;

      if (!expanded)
        return head + hbars(rows.slice(0, 6), {
          label: (r) => r.repo, value: (r) => r.open,
          href: (r) => repoHref(r.repo), internal: true, share: true,
        });

      const cols = [
        { key: "repo", label: "Repo", render: (r) => repoLink(r.repo) },
        { key: "open", label: "Open", render: (r) => `<span class="num">${fmt(r.open)}</span>` },
        { key: "closed", label: "Closed", render: (r) => `<span class="num">${fmt(r.closed)}</span>` },
        { key: "total", label: "All time", render: (r) => `<span class="num">${fmt(r.total)}</span>` },
        { key: "unanswered", label: "Unanswered", render: (r) => `<span class="num ${r.unanswered ? "down" : ""}">${fmt(r.unanswered)}</span>` },
        { key: "unlabeled", label: "Unlabeled", render: (r) => `<span class="num">${fmt(r.unlabeled)}</span>` },
        { key: "medianFirstResponseHours", label: "Median response", get: (r) => r.medianFirstResponseHours ?? -1, render: (r) => `<span class="num">${dur(r.medianFirstResponseHours)}</span>` },
        { key: "medianCloseHours", label: "Median close", get: (r) => r.medianCloseHours ?? -1, render: (r) => `<span class="num">${dur(r.medianCloseHours)}</span>` },
      ];

      return head + hbars(rows.slice(0, 12), {
        label: (r) => r.repo, value: (r) => r.open,
        href: (r) => repoHref(r.repo), internal: true, share: true,
      }) +
        `<h3 style="font-size:13px;margin:26px 0 8px">Every repo with issues</h3>` +
        renderTable(sortRows(applyFilter(d.repos), cols), cols, { sortable: true });
    },
  },

  iReporters: {
    page: "issues", label: "Who files, answers and closes", span: 6,
    sub: () => windowPhrase(),
    render(expanded) {
      const w = IW();
      if (!w) return missing();
      const n = expanded ? 12 : 6;
      const list = (rows, color) =>
        rows?.length
          ? hbars(rows.slice(0, n), {
              label: (r) => r.login, value: (r) => r.count, color,
              href: contribHref, internal: true, icon: (r) => avatar(r.login, 16),
            })
          : `<div class="empty" style="padding:8px 0">Nothing recorded in this period.</div>`;

      return `<div class="kpis" style="margin:-14px -14px 14px">
          ${kpi("Reporters", fmt(w.reporters), `${fmt(w.newReporters)} filing their first`)}
          ${kpi("People answering", fmt(w.responders), `${fmt(w.responses)} first replies`)}
          ${kpi("People closing", fmt(w.closers), `${fmt(w.closedByPR)} closes came from a PR`)}
        </div>` +
        `<h3 style="font-size:13px;margin:0 0 8px">Most issues filed</h3>` +
        list(w.topReporters, "var(--accent)") +
        `<h3 style="font-size:13px;margin:22px 0 8px">First to reply</h3>` +
        list(w.topResponders, "var(--purple)") +
        `<h3 style="font-size:13px;margin:22px 0 8px">Closed the most</h3>` +
        list(w.topClosers, "var(--good)") +
        (expanded
          ? `<h3 style="font-size:13px;margin:22px 0 8px">Assigned the most</h3>` +
            list(w.topAssignees, "var(--warn)")
          : "") +
        `<div class="hint" style="margin-top:12px">Credit for a reply goes to whoever spoke first and isn't the reporter or a bot. Closing credit goes to whoever pressed the button, which is often not who wrote the fix — the table below splits those apart.${
          w.unknownCloser
            ? ` ${fmt(w.unknownCloser)} closes in this period record no actor at all; run <code>npm run ingest</code> to backfill them.`
            : ""
        }</div>`;
    },
  },

  /**
   * The by-contributor breakdown.
   *
   * The card next door ranks reporters and first responders, which was the
   * whole of what this page could say about people — and it left out the two
   * things that matter most on this org: who closes tickets, and whose pull
   * requests do the closing. Those are different jobs, done by different
   * people, and neither of them shows up in a PR count.
   *
   * One row per person, every column sortable, so "who is doing the triage" and
   * "who files the most" are the same table read two ways rather than two cards
   * that have to be kept in step.
   */
  iPeople: {
    page: "issues", label: "By contributor", span: 12, flush: true,
    tabControls: ["filter"],
    sub: () => `filing, answering and closing, ${windowPhrase()}`,
    render(expanded) {
      const d = I();
      if (!d) return missing();
      const rows = issuePeople();
      if (!rows.length)
        return `<div class="empty">Nobody touched an issue in this period.</div>`;

      const w = IW();
      const closedTotal = rows.reduce((n, r) => n + r.closed, 0);
      const triageTotal = rows.reduce((n, r) => n + r.triage, 0);
      const top5 = [...rows].sort((a, b) => b.triage - a.triage).slice(0, 5)
        .reduce((n, r) => n + r.triage, 0);

      // No negative pull on this one: the card is `flush`, so the body has no
      // padding for the strip to escape — the -14px every other KPI strip uses
      // would drag it past the card's border, where overflow:hidden cuts it.
      const head = `<div class="kpis" style="margin-bottom:14px">
        ${kpi("People involved", fmt(rows.length),
              d.peopleCap && rows.length >= d.peopleCap ? `top ${fmt(d.peopleCap)} of ${fmt(w?.reporters ?? 0)}` : "in this period")}
        ${kpi("Triage acts", fmt(triageTotal), `${fmt(closedTotal)} closes, the rest first replies`)}
        ${/* Concentration is the number an admin actually acts on: if five
              people are doing four fifths of the triage, the queue has a bus
              problem regardless of how healthy the medians look. */""}
        ${kpi("Done by the top five", pctFmt(triageTotal ? top5 / triageTotal : null), "of all triage acts",
              triageTotal && top5 / triageTotal > 0.8 ? "down" : "")}
        ${kpi("Closes from a PR", fmt(w?.closedByPR), `of ${fmt(w?.closed)} closed`)}
      </div>`;

      const n = (r, k, cls = "") => `<span class="num ${cls}">${fmt(r[k])}</span>`;
      const cols = [
        { key: "login", label: "Contributor", render: (r) => contribLink(r.login) },
        { key: "filed", label: "Filed", render: (r) => n(r, "filed") },
        { key: "responses", label: "First replies", render: (r) => n(r, "responses") },
        { key: "closed", label: "Closed", render: (r) => n(r, "closed") },
        { key: "closedForOthers", label: "…for others", render: (r) => n(r, "closedForOthers") },
        { key: "fixed", label: "Closed by their PR", render: (r) => n(r, "fixed") },
        { key: "triage", label: "Triage acts", render: (r) => `<span class="num" style="font-weight:600">${fmt(r.triage)}</span>` },
        { key: "medianResponseLagHours", label: "Median reply lag",
          get: (r) => r.medianResponseLagHours ?? -1,
          render: (r) => `<span class="num">${dur(r.medianResponseLagHours)}</span>` },
        { key: "medianCloseLagHours", label: "Median age at close",
          get: (r) => r.medianCloseLagHours ?? -1,
          render: (r) => `<span class="num">${dur(r.medianCloseLagHours)}</span>` },
        { key: "helped", label: "People helped", render: (r) => n(r, "helped") },
        { key: "assignedOpen", label: "Assigned, open", render: (r) => n(r, "assignedOpen") },
        { key: "repos", label: "Repos", render: (r) => n(r, "repos") },
      ];

      const preview = [cols[0], cols[1], cols[2], cols[3], cols[5], cols[6]];

      return head +
        renderTable(sortRows(applyFilter(rows), expanded ? cols : preview),
          expanded ? cols : preview,
          { sortable: expanded, limit: expanded ? null : 10 }) +
        (expanded
          ? `<div class="hint" style="margin-top:12px">Ranked by triage acts — first replies plus closes of somebody else's issue — because that's the work this page exists to make visible. "Closed" is whoever pressed the button; "closed by their PR" is whoever wrote the fix, credited from the pull request that closed the issue, so a single close can appear in both columns for two different people. ${
              d.peopleCap ? `Only the ${fmt(d.peopleCap)} busiest people per period are carried here; everyone else has a complete record on their own drilldown.` : ""}</div>` +
            `<div class="hint" style="margin-top:6px">Median reply lag is measured from when the issue was filed, not from when they picked it up, so somebody who answers old threads will look slow. It's a property of the queue as much as of the person.</div>` +
            (d.totals.unknownCloser
              ? `<div class="hint" style="margin-top:6px">${fmt(d.totals.unknownCloser)} of ${fmt(d.totals.closed)} closed issues in the store don't record who closed them — those records predate the closer field. Run <code>npm run ingest</code> to backfill them; until then read the close columns as a floor rather than a count.</div>`
              : "")
          : "");
    },
  },

  iOldest: {
    page: "issues", label: "Needs attention", span: 12,
    sub: () => "open issues by three different kinds of neglect",
    render(expanded) {
      const d = I();
      if (!d) return missing();
      return trio(attentionBoxes(d.triage), {
        height: expanded ? "tall" : "short",
        kind: "issues",
      }) +
        `<div class="hint" style="margin-top:12px">Oldest is when it was filed, quietest is when anyone last touched it, and never answered is nobody but the reporter having said a word. An issue can sit in all three at once, and those are the ones worth opening first.</div>`;
    },
  },

  iDiscussed: {
    page: "issues", label: "Most discussed", span: 12,
    sub: () => "the issues the org argued about most, all time",
    tabControls: ["filter"],
    render(expanded) {
      const d = I();
      if (!d) return missing();
      const rows = d.mostDiscussed ?? [];
      if (!rows.length) return `<div class="empty">No commented issues in the store.</div>`;

      const cols = [
        { key: "repo", label: "Repo", render: (r) => repoLink(r.repo) },
        { key: "title", label: "Issue", render: issueTitle },
        { key: "author", label: "Reporter", render: (r) => contribName(r.author ?? "ghost") },
        { key: "comments", label: "Comments", render: (r) => `<span class="num">${fmt(r.comments)}</span>` },
        { key: "ageDays", label: "Opened", render: (r) => age(r.ageDays) },
        {
          key: "open", label: "State", get: (r) => (r.open ? 1 : 0),
          render: (r) => r.open
            ? `<span class="pill draft">open</span>`
            : `<span class="pill ready">closed</span>`,
        },
      ];

      return renderTable(sortRows(applyFilter(rows), cols), cols, {
        sortable: expanded, limit: expanded ? null : 8,
      }) +
        `<div class="hint" style="margin-top:12px">Ranked by comment count, which is the only engagement signal the store carries — 👍 and 👎 were dropped from the ingest when GitHub's abuse limit refused the query on the modpack. A long thread means contested or confusing, not necessarily important.</div>`;
    },
  },
};

