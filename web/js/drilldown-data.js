import { DRILL, state } from "./state.js";
import { contribHref, esc, fmt, linesOf, repoHref } from "./format.js";
import { hbars } from "./charts.js";
import { activeWindow, windowDays } from "./data.js";

/* ==========================================================================
   Drilldown accessors — everything that reads a single subject out of
   drilldown.json. The fetch itself lives in render.js, beside the view that
   triggers it.
   ========================================================================== */

const drillKey = () => DRILL[state.page];
const subjectList = () => state.drill?.index?.[drillKey()] ?? [];
const subject = () => state.drill?.[drillKey()]?.[state.subject] ?? null;

/** Absent windows mean "nothing happened", which is what a zeroed one says. */
const EMPTY_WINDOW = {
  opened: 0, merged: 0, closed: 0, approvals: 0,
  mergeRate: null, approvedShare: null, unapprovedMerges: 0,
  medianMergeHours: null, p90MergeHours: null, medianFirstReviewHours: null,
  people: 0, reviewers: 0,
  additions: 0, deletions: 0, filesChanged: 0, commits: 0, comments: 0,
  medianPRLines: null, p90PRLines: null, sizedPRs: 0,
};
const SW = () => subject()?.windows?.[activeWindow()] ?? EMPTY_WINDOW;

/**
 * Bucket labels live once at the top of the payload rather than on every
 * subject's backlog, so putting them back is the reader's job.
 */
const bucketRows = (counts) =>
  (counts ?? []).map((count, i) => ({
    label: state.drill?.backlogBuckets?.[i] ?? "",
    count,
  }));

/** An empty backlog reads the same as an absent one, which is what null means. */
const EMPTY_BACKLOG = {
  total: 0, unreviewed: 0, drafts: 0, draftsKnown: true,
  buckets: [], oldest: [],
};

/**
 * A subject's PR backlog, with the bucket labels restored.
 *
 * Absent entirely on subjects with nothing open — most of them, once issue
 * reporters became subjects too — so every reader goes through here rather than
 * reaching for `s.backlog.total` and finding null.
 */
function backlogOf(s = subject()) {
  const b = s?.backlog;
  if (!b) return EMPTY_BACKLOG;
  return b._rows ? b._rows : (b._rows = { ...b, buckets: bucketRows(b.buckets) });
}

/**
 * Total lines a window touched, or null if the data isn't there.
 *
 * `w.additions + w.deletions` on a window built before these fields existed is
 * `NaN`, which formats as "NaNM" — a number-shaped thing that is not a number.
 * A dashboard.json and a drilldown.json are built separately and either can be
 * the stale one, so this has to hold for a while rather than until the next
 * build.
 */
const linesIn = (w) => (w?.additions == null ? null : w.additions + (w.deletions ?? 0));

/**
 * Expand the column-oriented series the build emits back into the named
 * objects the chart helpers expect. Memoized onto the record — a subject's
 * series is re-read on every render, and re-expanding 24 rows each time for a
 * page that also draws three charts adds up.
 */
const subjectSeries = () => seriesOf(subject());

/**
 * The contributor's merged and closed PRs, newest first.
 *
 * Stored packed (positional rows, repo names interned per contributor) because
 * there are 25,660 of them org-wide; expanded on first use and memoized onto
 * the record, the same deal as the series.
 */
function resolvedAll() {
  const s = subject();
  // Null on the slim records the build emits for people whose whole footprint
  // is a bug report or two — they have no pull requests to resolve.
  if (!s?.resolved) return [];
  if (s._resolved) return s._resolved;
  const { repos, rows } = s.resolved;
  // Positional destructuring against RESOLVED_FIELDS in the build. Rows written
  // before the size columns existed are four long, so the tail destructures to
  // undefined — normalised to null here, which is what "not ingested yet" means
  // everywhere else and renders as an em dash rather than a zero.
  s._resolved = rows.map(([r, number, at, merged, additions, deletions, commits, comments, title]) => ({
    repo: repos[r], number, at, merged: merged === 1,
    additions: additions ?? null,
    deletions: deletions ?? null,
    commits: commits ?? null,
    comments: comments ?? null,
    title: title ?? "",
  }));
  return s._resolved;
}

/**
 * Every PR of theirs that carries a diff size, resolved and open together,
 * biggest first — the backing list for Biggest PRs.
 *
 * Resolved PRs are windowed by when they ended, open ones by when they were
 * opened. Those are the only dates each half has, and they're the same dates
 * the Closed PRs tab and the Open PRs tab already window by, so the three
 * cards agree about what "last 6 months" contains.
 *
 * PRs with no diff data are dropped rather than sorted to the bottom as zeroes:
 * on a store that hasn't been backfilled that would be the whole list, ranked
 * by nothing.
 */
function biggestRows() {
  const s = subject();
  if (!s) return [];
  const days = windowDays();
  const cutoff = days == null ? null : Date.now() - days * 86400000;

  const open = (s.backlog?.oldest ?? [])
    .filter(r => days == null || r.ageDays <= days)
    .map(r => ({ ...r, open: true }));

  // resolvedAll(), not resolvedRows(): the latter also applies the Closed PRs
  // tab's merged/dropped toggle, which isn't shown on this card. Reusing it
  // would let a setting made two tabs ago quietly halve this list.
  const resolved = resolvedAll().filter(
    r => cutoff == null || new Date(r.at).getTime() >= cutoff
  );

  return [...resolved, ...open]
    .filter(r => linesOf(r) != null)
    .sort((a, b) => linesOf(b) - linesOf(a));
}

/** Filtered by the merged/closed toggle and the window picker. */
function resolvedRows() {
  const days = (state.drill?.windows ?? []).find(w => w.id === activeWindow())?.days;
  const cutoff = days == null ? null : Date.now() - days * 86400000;
  return resolvedAll().filter(r => {
    if (state.closedState === "merged" && !r.merged) return false;
    if (state.closedState === "dropped" && r.merged) return false;
    return cutoff == null || new Date(r.at).getTime() >= cutoff;
  });
}

/**
 * Series trimmed to the selected window.
 *
 * The drilldowns used to carry a second control for this, which meant two time
 * pickers on one toolbar answering slightly different questions. Now the
 * window scopes the charts and the numbers together.
 */
/**
 * Trim any monthly series to the selected window. Split out from subjectSlice
 * so head-to-head can do the same to four other subjects' series.
 */
function sliceMonths(all) {
  const days = (state.drill?.windows ?? []).find(w => w.id === activeWindow())?.days;
  // Monthly buckets, so a 1-month window is a single bar. Honest, if sparse.
  return days == null ? all : all.slice(-Math.max(1, Math.ceil(days / 30.4)));
}

function subjectSlice() {
  return sliceMonths(subjectSeries());
}

/** Any subject's PR window, not just the selected one — for head-to-head. */
const windowOf = (s) => s?.windows?.[activeWindow()] ?? EMPTY_WINDOW;

/** Any subject's expanded monthly PR series. Memoized onto the record. */
function seriesOf(s) {
  if (!s?.series?.from) return [];
  if (s._series) return s._series;

  const fields = state.drill.seriesFields;
  const [y, m] = s.series.from.split("-").map(Number);
  s._series = s.series.v.map((row, i) => {
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    const out = { b: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}` };
    fields.forEach((f, j) => { out[f] = row ? row[j] : 0; });
    return out;
  });
  return s._series;
}

/**
 * Two ranked lists in side-by-side boxes. Each scrolls independently, so a
 * 400-entry list and a 3-entry one sit next to each other without either
 * dictating the height of the card.
 */
function duo(left, right, { height = "tall", stacked = false, share = false } = {}) {
  const box = ({ title, rows, color, href, internal, label, value }) => `
    <section class="duo-box">
      <h3>${esc(title)}<span class="n">${fmt(rows.length)}</span></h3>
      <div class="scroll ${height}">${
        rows.length
          ? hbars(rows, { label, value, color, href, internal, share })
          : `<div class="empty" style="padding:18px 0">Nothing here.</div>`
      }</div>
    </section>`;
  return `<div class="duo${stacked ? " stacked" : ""}">${box(left)}${box(right)}</div>`;
}

const byLogin = { label: r => r.login, value: r => r.count,
  href: contribHref, internal: true };

/** The repo-side equivalent, now that repo names route to their drilldown. */
const byRepo = { label: r => r.repo, value: r => r.count,
  href: r => repoHref(r.repo), internal: true };

/** URL for whatever the current page's subjects are on GitHub. */
const subjectUrl = (id) =>
  state.page === "contributor"
    ? `https://github.com/${encodeURIComponent(id)}`
    : `https://github.com/${state.data.org}/${encodeURIComponent(id)}`;


/** Every window side by side — the expanded form of both Profile modules. */
function windowTable(rows) {
  const ws = state.drill?.windows ?? [];
  const s = subject();
  const at = id => s.windows[id] ?? EMPTY_WINDOW;
  return `<table>
    <thead><tr><th style="cursor:default">Metric</th>${ws.map(x =>
      `<th style="cursor:default" class="num">${esc(x.label)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map(([lab, f]) =>
      `<tr><td>${lab}</td>${ws.map(x => `<td class="num">${f(at(x.id))}</td>`).join("")}</tr>`).join("")}</tbody>
  </table>`;
}

export {
  EMPTY_WINDOW,
  SW,
  backlogOf,
  biggestRows,
  bucketRows,
  byLogin,
  byRepo,
  drillKey,
  duo,
  linesIn,
  resolvedRows,
  seriesOf,
  sliceMonths,
  subject,
  subjectList,
  subjectSeries,
  subjectSlice,
  windowOf,
  subjectUrl,
  windowTable,
};
