import { state } from "./state.js";
import { age, avatar, daysSince, dur, esc, fmt, kfmt, pctFmt } from "./format.js";
import {
  backlogOf,
  drillKey,
  linesIn,
  seriesOf,
  sliceMonths,
  subjectEntry,
  windowOf,
} from "./drilldown-data.js";
import { issueBacklogOf, issueSeriesOf, issueWindowOf, issuesOf } from "./issue-data.js";

/* ==========================================================================
   Head to head

   The drilldowns answer "how is this one doing". The question that follows is
   always "compared to whom", and until now the only way to ask it was two
   browser tabs and a lot of scrolling.

   The comparison is deliberately made of the numbers that already exist on the
   page rather than a new set: a lineup should say the same thing about a person
   as their own profile does, or one of the two is wrong.
   ========================================================================== */

/**
 * Four opponents plus the subject. Five columns fit a table without either
 * scrolling sideways or shrinking the numbers past reading, and a comparison of
 * ten things is not a comparison, it's a leaderboard — which the People and
 * Repos pages already are.
 */
const MAX_OPPONENTS = 4;

const COLORS = [
  "var(--accent)", "var(--good)", "var(--purple)", "var(--warn)", "var(--pink)",
];

const vsList = () => state.vs[state.page] ?? [];

/**
 * An opponent is a subject, and gets fetched like one.
 *
 * This card used to read `state.drill[bucket][id]` — the whole build file was
 * in hand, so every one of the 7,047 subjects was already there and adding an
 * opponent cost a property lookup. Now a subject is one fetch, so an opponent
 * is one fetch too: `ensureSubjects` in render.js asks for the lineup, and this
 * reads whatever has landed.
 *
 * Which means a lineup is drawn from the opponents that have *arrived*, not the
 * ones that were asked for, and it grows as they do. That is the same rule this
 * already had for an opponent the file did not carry, so no case is new — the
 * list is just briefly shorter than it will be.
 */
const opponentOf = (id) => subjectEntry(drillKey(), id)?.s ?? null;

/** Opponents that actually exist in the payload, deduped, minus the subject. */
function opponents() {
  const seen = new Set([state.subject]);
  const out = [];
  for (const id of vsList()) {
    if (seen.has(id) || !opponentOf(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.slice(0, MAX_OPPONENTS);
}

/** The subject first, then the opponents. The subject is never removable. */
function lineup() {
  const ids = [state.subject, ...opponents()].filter((id) => id && opponentOf(id));
  return ids.map((id, i) => ({
    id,
    s: opponentOf(id),
    color: COLORS[i % COLORS.length],
    pinned: i === 0,
  }));
}

function addOpponent(id) {
  if (!id || id === state.subject) return;
  const list = state.vs[state.page];
  if (list.includes(id) || list.length >= MAX_OPPONENTS) return;
  list.push(id);
}

const removeOpponent = (id) => {
  const list = state.vs[state.page];
  const i = list.indexOf(id);
  if (i !== -1) list.splice(i, 1);
};

const clearOpponents = () => { state.vs[state.page] = []; };

/* ==========================================================================
   The metric catalogue

   `dir` is what gets highlighted: "low" for the metrics where less is plainly
   better (latency), "high" for the ones where more plainly is (throughput,
   people helped), and null where leading means nothing at all — nobody is
   winning at having been here since 2015. Volume rows are marked "high" and the
   card says in as many words that leading a volume row is not the same as being
   better at anything.
   ========================================================================== */

const num = (f) => (v) => (v == null ? "—" : f(v));

const M = (label, get, { fmt: f = fmt, dir = "high", hint = "" } = {}) =>
  ({ label, get, fmt: num(f), dir, hint });

const CONTRIBUTOR_METRICS = [
  {
    title: "Pull requests",
    rows: [
      M("PRs opened", (r) => r.w.opened),
      M("Merged", (r) => r.w.merged),
      M("Merge rate", (r) => r.w.mergeRate, { fmt: pctFmt }),
      M("Median time to merge", (r) => r.w.medianMergeHours, { fmt: dur, dir: "low" }),
      M("Median first review", (r) => r.w.medianFirstReviewHours, { fmt: dur, dir: "low" }),
      M("Approvals given", (r) => r.w.approvals),
      M("Repos touched", (r) => r.w.people),
      M("Lines changed", (r) => linesIn(r.w), { fmt: kfmt }),
      M("Median PR size", (r) => (r.w.sizedPRs ? r.w.medianPRLines : null), { fmt: kfmt, dir: null }),
      M("Commits", (r) => r.w.commits),
      M("Open PRs", (r) => r.backlog.total, { dir: null }),
      M("…never reviewed", (r) => r.backlog.unreviewed, { dir: "low" }),
    ],
  },
  {
    title: "Issues filed",
    rows: [
      M("Filed", (r) => r.iw.filed),
      M("Accepted share", (r) => r.iw.acceptedShare, { fmt: pctFmt }),
      M("Their reports answered", (r) => r.iw.answeredShare, { fmt: pctFmt }),
      M("Median wait for a reply", (r) => r.iw.medianWaitHours, { fmt: dur, dir: "low" }),
      M("Comments received", (r) => r.iw.commentsReceived, { dir: null }),
      M("Open filed", (r) => r.ibacklog.total, { dir: null }),
    ],
  },
  {
    title: "Triage",
    rows: [
      M("First replies given", (r) => r.iw.responses),
      M("Median reply lag", (r) => r.iw.medianResponseLagHours, { fmt: dur, dir: "low" }),
      M("Issues closed", (r) => r.iw.closed),
      M("…other people's", (r) => r.iw.closedForOthers),
      M("…by hand", (r) => r.iw.closedByHand),
      M("Closed by their PR", (r) => r.iw.fixed),
      M("Triage acts", (r) => r.iw.triage),
      M("People helped", (r) => r.iw.helped),
      M("Assigned, still open", (r) => r.iw.assignedOpen, { dir: null }),
    ],
  },
  {
    title: "History",
    rows: [
      M("First seen", (r) => r.s.first, { fmt: (v) => esc(String(v).slice(0, 10)), dir: null }),
      M("Last active", (r) => daysSince(r.s.last), { fmt: (v) => age(v), dir: "low" }),
      M("PRs, all time", (r) => r.s.totalPRs, { dir: null }),
      M("Issues filed, all time", (r) => issuesOf(r.s)?.totals?.filed ?? 0, { dir: null }),
    ],
  },
];

const REPO_METRICS = [
  {
    title: "Pull requests",
    rows: [
      M("PRs opened", (r) => r.w.opened),
      M("Merged", (r) => r.w.merged),
      M("Merge rate", (r) => r.w.mergeRate, { fmt: pctFmt }),
      M("Median time to merge", (r) => r.w.medianMergeHours, { fmt: dur, dir: "low" }),
      M("Median first review", (r) => r.w.medianFirstReviewHours, { fmt: dur, dir: "low" }),
      M("Contributors", (r) => r.w.people),
      M("Reviewers", (r) => r.w.reviewers),
      M("Approved before merge", (r) => r.w.approvedShare, { fmt: pctFmt }),
      M("Merged unapproved", (r) => r.w.unapprovedMerges, { dir: "low" }),
      M("Lines changed", (r) => linesIn(r.w), { fmt: kfmt }),
      M("Open backlog", (r) => r.backlog.total, { dir: null }),
      M("…never reviewed", (r) => r.backlog.unreviewed, { dir: "low" }),
    ],
  },
  {
    title: "Issues",
    rows: [
      M("Opened", (r) => r.iw.opened),
      M("Closed", (r) => r.iw.closed),
      M("Backlog moved", (r) => r.iw.net, { fmt: (v) => (v > 0 ? `+${fmt(v)}` : fmt(v)), dir: "low" }),
      M("Median first response", (r) => r.iw.medianFirstResponseHours, { fmt: dur, dir: "low" }),
      M("Median time to close", (r) => r.iw.medianCloseHours, { fmt: dur, dir: "low" }),
      M("Answered at all", (r) => r.iw.answeredShare, { fmt: pctFmt }),
      M("Resolved rather than declined", (r) => r.iw.completedShare, { fmt: pctFmt }),
      M("Labeled on arrival", (r) => r.iw.labeledShare, { fmt: pctFmt }),
      M("Reporters", (r) => r.iw.reporters),
      M("People answering", (r) => r.iw.responders),
      M("People closing", (r) => r.iw.closers),
      M("Closes that came from a PR", (r) => r.iw.closedByPR),
    ],
  },
  {
    title: "Open right now",
    rows: [
      M("Open issues", (r) => r.ibacklog.total, { dir: null }),
      M("…unanswered", (r) => r.ibacklog.unanswered, { dir: "low" }),
      M("…unlabeled", (r) => r.ibacklog.unlabeled, { dir: "low" }),
      M("…unassigned", (r) => r.ibacklog.unassigned, { dir: null }),
      M("…untouched for months", (r) => r.ibacklog.stale, { dir: "low" }),
    ],
  },
  {
    title: "History",
    rows: [
      M("First PR", (r) => r.s.first, { fmt: (v) => esc(String(v).slice(0, 10)), dir: null }),
      M("Last active", (r) => daysSince(r.s.last), { fmt: (v) => age(v), dir: "low" }),
      M("PRs, all time", (r) => r.s.totalPRs, { dir: null }),
      M("Issues, all time", (r) => issuesOf(r.s)?.totals?.filed ?? 0, { dir: null }),
    ],
  },
];

const metricGroups = () =>
  state.page === "contributor" ? CONTRIBUTOR_METRICS : REPO_METRICS;

/** Everything a metric reads, gathered once per subject per render. */
const readingsFor = (entry) => ({
  ...entry,
  w: windowOf(entry.s),
  iw: issueWindowOf(entry.s),
  backlog: backlogOf(entry.s),
  ibacklog: issueBacklogOf(entry.s),
});

/**
 * The chartable comparison: one line per subject over the union of their
 * months. Keys are positional rather than the subject's name, because a login
 * can contain anything and these become property lookups.
 */
function overlay(entries, { issues = false, field }) {
  const seriesFor = (s) => (issues ? issueSeriesOf(s) : seriesOf(s));
  const months = new Set();
  const byId = entries.map((e) => {
    const rows = sliceMonths(seriesFor(e.s));
    const map = new Map(rows.map((r) => [r.b, r[field] ?? 0]));
    for (const r of rows) months.add(r.b);
    return map;
  });

  const buckets = [...months].sort().map((b) => {
    const cell = { b };
    byId.forEach((m, i) => { cell[`s${i}`] = m.get(b) ?? 0; });
    return cell;
  });

  const series = entries.map((e, i) => ({
    key: `s${i}`,
    label: e.id,
    color: e.color,
  }));

  return { buckets, series };
}

/* ---- the add-a-subject picker ------------------------------------------- */

/**
 * Its own combobox rather than the toolbar's.
 *
 * The toolbar's picker changes which subject the page is about; this one adds a
 * column to one card. Sharing the widget would have meant one input with two
 * meanings depending on where the caret was.
 */
/**
 * How many rows the popup offers, which depends on where the card is.
 *
 * The popup is drawn inside the card, and a card is `overflow: hidden` so its
 * table can have rounded corners — so the card has to be tall enough to hold
 * the list rather than the list being free to overhang. On the tab there's a
 * whole page to spend and forty is a real search. On the overview the card is
 * one of eleven, and a card that grew to 320px every time you clicked into the
 * box would shove the rest of the grid down the page. Three rows keeps it close
 * to the height it already had, and typing two letters narrows a thousand
 * contributors to fewer than three anyway.
 */
const VS_LIMIT = () => (state.tab === null ? 3 : 40);

function vsOptions() {
  const q = state.vs.q.trim().toLowerCase();
  // Everything picked, not everything arrived: an opponent whose fetch is still
  // in flight has been chosen, and offering it again in the search list is how
  // you end up picking it twice.
  const chosen = new Set([state.subject, ...vsList()]);
  const list = (state.drill?.index?.[drillKey()] ?? []).filter((o) => !chosen.has(o.id));
  const n = VS_LIMIT();
  if (!q) return list.slice(0, n);
  const hits = [];
  for (const r of list) {
    const i = r.id.toLowerCase().indexOf(q);
    if (i !== -1) hits.push({ ...r, i });
  }
  return hits.sort((a, b) => (a.i === 0 ? 0 : 1) - (b.i === 0 ? 0 : 1)).slice(0, n);
}

function vsPopHtml() {
  const opts = vsOptions();
  const what = state.page === "contributor" ? "contributor" : "repo";
  if (!opts.length)
    return `<div class="combo-none">No other ${what} matching “${esc(state.vs.q)}”.</div>`;

  const q = state.vs.q.trim().toLowerCase();
  // Only on the overview, where the list is three rows long and a full one is
  // far more likely to be hiding somebody than to be the whole answer.
  const more = state.tab === null && opts.length === VS_LIMIT()
    ? `<div class="combo-none">Keep typing to narrow this, or open the tab for the full list.</div>`
    : "";
  return more + opts.map((o, i) => {
    const at = q ? o.id.toLowerCase().indexOf(q) : -1;
    const name = at === -1 ? esc(o.id)
      : esc(o.id.slice(0, at)) + `<mark>${esc(o.id.slice(at, at + q.length))}</mark>` +
        esc(o.id.slice(at + q.length));
    return `<div class="combo-opt" role="option" data-vsadd="${esc(o.id)}"
      aria-selected="${i === state.vs.active}">${
        state.page === "contributor" ? avatar(o.id, 18) : ""}<span class="n">${name}</span><span class="c">${
        fmt((o.n ?? 0) + (o.i ?? 0))} events</span></div>`;
  }).join("");
}

/** Repaint just the popup — typing must not redraw the charts on the page. */
function updateVsPop() {
  const pop = document.getElementById("vsPop");
  if (!pop) return;
  pop.hidden = !state.vs.open;
  pop.innerHTML = state.vs.open ? vsPopHtml() : "";
  if (state.vs.open)
    pop.querySelector('.combo-opt[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
}

const closeVs = () => { state.vs.open = false; state.vs.q = ""; state.vs.active = 0; };

export {
  COLORS,
  MAX_OPPONENTS,
  addOpponent,
  clearOpponents,
  closeVs,
  lineup,
  metricGroups,
  opponents,
  overlay,
  readingsFor,
  removeOpponent,
  updateVsPop,
  vsList,
  vsOptions,
  vsPopHtml,
};
