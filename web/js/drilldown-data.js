import { DRILL, state } from "./state.js";
import { avatar, contribHref, esc, fmt, linesOf, repoHref } from "./format.js";
import { hbars } from "./charts.js";
import { activeWindow, windowDays } from "./data.js";

/* ==========================================================================
   Drilldown accessors — everything that reads a single subject.

   The head lives in `state.drill` and one payload per subject in
   `state.subjects`. The fetches themselves live in render.js, beside the view
   that triggers them.
   ========================================================================== */

const drillKey = () => DRILL[state.page];
const subjectList = () => state.drill?.index?.[drillKey()] ?? [];

/**
 * The cache entry for one subject, or null.
 *
 * Version-checked nowhere here on purpose: a payload folded one version ago is
 * up to ten minutes old, which is what `cron` means and what the card already
 * says. Serving it while a fresher one is fetched is the difference between a
 * page that updates and a page that blanks itself every ten minutes.
 * `subjectStale` is what decides whether to go and get another.
 */
const subjectEntry = (kind = drillKey(), id = state.subject) =>
  (id && state.subjects?.[kind]?.[id]) || null;

const subject = () => subjectEntry()?.s ?? null;

/**
 * True when a cached subject was folded against a version that has since moved.
 *
 * One rule for both sources, which is why an entry out of the build file
 * records the version the *page* was on when it was served rather than a null.
 * The file has no version of its own, but "the version has moved since" is
 * still the signal wanted: it means the Worker is alive and answering, so a
 * subject sitting on build-file numbers should go and ask it again.
 *
 * A bump is at most every ten minutes, so that retry cannot become a loop the
 * way "stale while the API is reachable" would have — that reads true on every
 * render, and a failed refetch leaves the entry exactly as it found it.
 *
 * `version: null` therefore means only one thing: the page has never reached
 * `/api/version`, so there is no number to compare and nothing to be gained by
 * asking. `refreshLazy` covers that case from the other end when the head
 * comes back.
 */
const subjectStale = (kind = drillKey(), id = state.subject) => {
  const e = subjectEntry(kind, id);
  return !!e && e.version != null && e.version !== state.version;
};

/**
 * The label table a row's interned indexes point into.
 *
 * **A subject payload carries its own, and this is the one thing about the
 * live drilldown that fails silently if you get it wrong.** A cached payload
 * cannot point into a global table: the recompute renumbers that table
 * underneath the cached row at any tick, and an index into a renumbered table
 * resolves to *the wrong name* rather than to nothing. So every payload brings
 * its own, and resolution has to happen against the table belonging to the
 * subject being rendered.
 *
 * The fall through to `state.drill.labelNames` is the build file, where there
 * is one global table and it is correct — the file is a single consistent
 * snapshot, which is exactly what a cached row is not.
 */
const labelTable = (kind, id) =>
  subjectEntry(kind, id)?.labelNames ?? state.drill?.labelNames ?? [];

/**
 * The label names on a row, whatever shape its labels arrived in.
 *
 * Three stores put labels on rows and none of them agree. The drilldown interns
 * them, so a row carries indexes into a `labelNames` table — the subject's own,
 * see above. The issues panel in dashboard.json carries plain names. The Dream
 * Panel's PR rows carry `{ name, color }` objects, straight from the search
 * query. One reader for all three, because the filter runs over rows from every
 * one of them and shouldn't have to be told which.
 *
 * `names` defaults to the selected subject's table because that is the only
 * drilldown subject whose rows ever reach a table or a filter — head-to-head
 * compares numbers and draws no chips. A caller that ever does render another
 * subject's rows has to pass that subject's table, and cannot be right by
 * accident.
 */
const labelText = (l, names = labelTable()) =>
  typeof l === "number" ? names?.[l] ?? "" : l?.name ?? l ?? "";

const labelsOf = (r, names = labelTable()) =>
  (r?.labels ?? []).map((l) => labelText(l, names)).filter(Boolean);

/**
 * True when the store has never been asked what a PR's labels are.
 *
 * The same distinction the review queue makes: "this PR has no labels" and
 * "we have never looked" are different facts, and the second one is a command
 * the reader can run.
 */
const prLabelsMissing = () => {
  const c = state.drill?.prFieldCoverage;
  return !!c && c.total > 0 && !c.labels;
};

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
  s._resolved = rows.map(([r, number, at, merged, additions, deletions, commits, comments, title, ageDays, labels]) => ({
    repo: repos[r], number, at, merged: merged === 1,
    labels: labels ?? null,
    additions: additions ?? null,
    deletions: deletions ?? null,
    commits: commits ?? null,
    comments: comments ?? null,
    title: title ?? "",
    ageDays: ageDays ?? null,
    open: false,
  }));
  return s._resolved;
}

/**
 * Expand one of the packed lists the build emits, restoring the repo names.
 *
 * The review queue and the assignment log are both `{ repos, rows }` against a
 * field list in the payload head, the same as the issue logs, so one reader
 * does all of them. Memoized onto the record under a key of its own — the card
 * re-reads three lists on every render and re-expanding them each time is work
 * for nothing.
 */
function packedRows(s, key, list, fields) {
  if (!list) return [];
  const memo = s._packed ?? (s._packed = {});
  if (memo[key]) return memo[key];
  const names = state.drill?.[fields] ?? [];
  return (memo[key] = list.rows.map((row) => {
    const out = {};
    names.forEach((f, i) => { out[f] = f === "repo" ? list.repos[row[i]] : row[i] ?? null; });
    return out;
  }));
}

/**
 * The review queue and the assignment log, as one deduplicated list.
 *
 * A PR can be in more than one of them at once and frequently is — you get
 * assigned something and asked to review it, or you review it and then get
 * re-requested after another round. Three rows for one PR would make the card
 * read as three times the work, so they're merged into one row per PR carrying
 * every reason it's there. `why` is what the card draws pills from and what the
 * filter matches against.
 */
function reviewRows() {
  const s = subject();
  if (!s) return [];
  const q = s.reviewQueue;
  const by = new Map();
  const add = (r, why) => {
    const k = `${r.repo}#${r.number}`;
    const prev = by.get(k);
    if (prev) { prev.why.push(why); return prev; }
    by.set(k, { ...r, why: [why] });
    return by.get(k);
  };

  for (const r of packedRows(s, "requested", q?.requested, "reviewFields"))
    add(r, "requested");
  for (const r of packedRows(s, "reviewing", q?.reviewing, "reviewFields")) {
    // The verdict rides on the merged row rather than replacing it: a PR
    // that's both requested and reviewed still wants to say which way the
    // review went.
    const row = add(r, "reviewing");
    row.reviewState = state.drill?.reviewStates?.[r.state] ?? null;
    row.at = r.at;
  }
  for (const r of packedRows(s, "assigned", s.assigned, "assignedFields"))
    add({ ...r, outcome: r.outcome ?? 0 }, "assigned");

  const rows = [...by.values()].map((r) => ({
    ...r,
    // Everything in the two review lists is open by construction; the
    // assignment log is the only half that carries resolved PRs.
    outcome: r.outcome ?? 0,
    // Packed as 1/0/null to keep the rows small. Back to the tri-state
    // boolean the rest of the app means by "draft", where null is "the ingest
    // hasn't told us" and has to render differently from "not a draft".
    draft: r.draft == null ? null : r.draft === 1,
  }));

  // Two independent axes. `why` is what put the PR on their plate; the state is
  // where the PR itself ended up, and the two used to be tangled: picking
  // "Assigned" handed you a list that was mostly PRs closed years ago, because
  // the assignment log is the only half that keeps resolved rows. Now every
  // `why` is read against whichever state you asked for, and the state opens on
  // the live ones.
  const kind = state.reviewKind;
  const byKind = kind === "all" ? rows : rows.filter((r) => r.why.includes(kind));
  const st = REVIEW_OUTCOME[state.reviewState];
  const wanted = st == null ? byKind : byKind.filter((r) => r.outcome === st);
  // Live PRs first, then oldest first within each half — the order in which
  // this is a queue rather than a log.
  return [...wanted].sort((a, b) =>
    (a.outcome === 0 ? 0 : 1) - (b.outcome === 0 ? 0 : 1) || (b.ageDays ?? 0) - (a.ageDays ?? 0));
}

/**
 * The Reviews state toggle, as the `outcome` code the packed rows carry. Null
 * is "don't filter", which is what All means — the payload's `prOutcomes` is
 * `["open", "merged", "closed"]` and this is that list read backwards.
 */
const REVIEW_OUTCOME = { all: null, open: 0, merged: 1, dropped: 2 };

const EMPTY_QUEUE = { requested: 0, reviewing: 0, assigned: 0, assignedOpen: 0, waiting: 0 };

/** Headline counts for the Reviews card, independent of its filter. */
function queueCounts() {
  const s = subject();
  if (!s) return EMPTY_QUEUE;
  const q = s.reviewQueue;
  const requested = packedRows(s, "requested", q?.requested, "reviewFields");
  const reviewing = packedRows(s, "reviewing", q?.reviewing, "reviewFields");
  const assigned = packedRows(s, "assigned", s.assigned, "assignedFields");
  return {
    requested: requested.length,
    reviewing: reviewing.length,
    assigned: assigned.length,
    assignedOpen: assigned.filter((r) => (r.outcome ?? 0) === 0).length,
    // What the tab badge shows: the two lists that mean somebody is waiting.
    // Deduplicated, since a re-request lands a PR in both.
    waiting: new Set(
      [...requested, ...reviewing].map((r) => `${r.repo}#${r.number}`)
    ).size,
  };
}

/**
 * True when the ingest has never been asked for these fields at all.
 *
 * Each is checked against the population it's meaningful over, and only when
 * that population is non-empty: an org with no open pull requests would
 * otherwise be told forever that its review-request backfill hadn't run.
 */
const queueDataMissing = () => {
  const c = state.drill?.prFieldCoverage;
  if (!c) return { requests: true, assignees: true };
  return {
    requests: c.openPRs > 0 && !c.reviewRequests,
    assignees: c.total > 0 && !c.assignees,
  };
};

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

  // resolvedAll(), not prRows(): the latter also applies the Pull requests
  // card's state toggle, which isn't shown here. Reusing it would let a setting
  // made two tabs ago quietly halve this list.
  const resolved = resolvedAll().filter(
    r => cutoff == null || new Date(r.at).getTime() >= cutoff
  );

  return [...resolved, ...open]
    .filter(r => linesOf(r) != null)
    .sort((a, b) => linesOf(b) - linesOf(a));
}

/**
 * Every PR of theirs the current filter admits — open and resolved in one list.
 *
 * These were two cards, and the split was arbitrary in a way that showed: an
 * open PR and a merged one are the same object at different points, the two
 * tables shared five of six columns, and answering "what have they got going in
 * GT5-Unofficial" meant reading one table, scrolling, and reading the other.
 * One table with a four-way state filter says the same thing in one place, and
 * "All" is a thing you couldn't previously ask for at all.
 *
 * The two halves are windowed by the only date each has — open PRs by when they
 * were opened, resolved ones by when they ended. That's what the Backlog and
 * Closed cards each did separately, so no row changes which window it lands in.
 */
function prRows() {
  const days = windowDays();
  const cutoff = days == null ? null : Date.now() - days * 86400000;
  const st = state.prState;
  const out = [];

  if (st === "all" || st === "open") {
    for (const r of backlogOf().oldest) {
      if (days != null && r.ageDays > days) continue;
      out.push({ ...r, open: true, merged: false, at: null });
    }
  }

  if (st !== "open") {
    for (const r of resolvedAll()) {
      if (st === "merged" && !r.merged) continue;
      if (st === "dropped" && r.merged) continue;
      if (cutoff != null && new Date(r.at).getTime() < cutoff) continue;
      out.push(r);
    }
  }

  // Open first, oldest first within them; then resolved, newest first — which
  // is the order both halves already arrived in, so this costs one pass and no
  // comparisons in the common case.
  return out;
}

/** Sort order for the merged State column: draft, ready, unknown, merged, closed. */
const prStateOrder = (r) =>
  r.open ? (r.draft === true ? 0 : r.draft === false ? 1 : 2) : r.merged ? 3 : 4;

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
  href: contribHref, internal: true, icon: r => avatar(r.login, 16) };

/* No icon here on purpose. Every repo in the org shares one avatar, so a
   column of identical GTNH marks would be twenty copies of a fact the page
   already establishes — noise where the contributor lists get signal. */
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
  return `<div class="tscroll"><table>
    <thead><tr><th style="cursor:default">Metric</th>${ws.map(x =>
      `<th style="cursor:default" class="num">${esc(x.label)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map(([lab, f]) =>
      `<tr><td>${lab}</td>${ws.map(x => `<td class="num">${f(at(x.id))}</td>`).join("")}</tr>`).join("")}</tbody>
  </table></div>`;
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
  labelTable,
  labelsOf,
  linesIn,
  prLabelsMissing,
  prRows,
  prStateOrder,
  queueCounts,
  queueDataMissing,
  reviewRows,
  seriesOf,
  sliceMonths,
  subject,
  subjectEntry,
  subjectList,
  subjectSeries,
  subjectSlice,
  subjectStale,
  windowOf,
  subjectUrl,
  windowTable,
};
