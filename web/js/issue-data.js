import { state } from "./state.js";
import { esc } from "./format.js";
import { activeWindow } from "./data.js";
import { bucketRows, drillKey, sliceMonths, subject } from "./drilldown-data.js";

/* ==========================================================================
   Issue drilldown accessors

   Everything the build packs for size, unpacked here and memoized onto the
   record it came from. The build's side of each of these is documented where it
   packs them; this file is the mirror image and nothing more.
   ========================================================================== */

/** Metric names for the current page's packed issue windows. */
const issueFields = (kind = drillKey()) =>
  state.drill?.issueWindowFields?.[kind] ?? [];

/**
 * A missing window means the subject did nothing in that period. Counts read
 * back as zero; medians and shares read back as null, because "half an hour"
 * and "nothing to average" must not render the same way.
 */
const emptyIssueWindow = (kind) => {
  const key = `_empty_${kind}`;
  if (state.drill?.[key]) return state.drill[key];
  const out = {};
  for (const f of issueFields(kind))
    out[f] = /^(median|p90)|Share$/.test(f) ? null : 0;
  if (state.drill) state.drill[key] = out;
  return out;
};

const expandIssueWindow = (kind, row) => {
  const out = {};
  issueFields(kind).forEach((f, i) => { out[f] = row[i] ?? null; });
  // Counts come back as null only on a payload written before the field
  // existed; zero is the honest reading of "this window has no such number".
  for (const f of issueFields(kind))
    if (out[f] == null && !/^(median|p90)|Share$/.test(f)) out[f] = 0;
  return out;
};

/** The issue record for a subject, or null if they've never touched one. */
const issuesOf = (s = subject()) => s?.issues ?? null;

/** One subject's issue window, expanded and memoized. */
function issueWindowOf(s, id = activeWindow(), kind = drillKey()) {
  const rec = issuesOf(s);
  if (!rec) return emptyIssueWindow(kind);
  const cache = (rec._w ??= {});
  if (cache[id]) return cache[id];
  const packed = rec.windows?.[id];
  return (cache[id] = packed ? expandIssueWindow(kind, packed) : emptyIssueWindow(kind));
}

/** The selected subject's selected window — the issue equivalent of SW(). */
const IIW = () => issueWindowOf(subject());

/**
 * Expand the sparse month map into the gap-filled array the chart helpers
 * expect. Months between the first and last entry that carry nothing are real
 * zeroes; anything outside that span never existed and isn't invented.
 */
function issueSeriesOf(s, kind = drillKey()) {
  const rec = issuesOf(s);
  if (!rec?.series) return [];
  if (rec._series) return rec._series;

  const fields = state.drill?.issueSeriesFields?.[kind] ?? [];
  const keys = Object.keys(rec.series).sort();
  const [y0, m0] = keys[0].split("-").map(Number);
  const [y1, m1] = keys.at(-1).split("-").map(Number);
  const months = (y1 - y0) * 12 + (m1 - m0);

  const out = [];
  for (let i = 0; i <= months; i++) {
    const d = new Date(Date.UTC(y0, m0 - 1 + i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const row = rec.series[key];
    const cell = { b: key };
    fields.forEach((f, j) => { cell[f] = row ? row[j] : 0; });
    out.push(cell);
  }
  return (rec._series = out);
}

const issueSlice = (s = subject()) => sliceMonths(issueSeriesOf(s));

/* ---- backlogs ----------------------------------------------------------- */

const EMPTY_ISSUE_BACKLOG = {
  total: 0, unanswered: 0, unlabeled: 0, unassigned: 0, stale: 0,
  staleDays: 0, buckets: [], staleBuckets: [], oldest: [],
};

/** Open issues for a subject, bucket labels restored. */
function issueBacklogOf(s = subject()) {
  const rec = issuesOf(s);
  const b = rec?.backlog;
  if (!b) return EMPTY_ISSUE_BACKLOG;
  return b._rows ? b._rows : (b._rows = {
    ...b,
    buckets: bucketRows(b.buckets),
    staleBuckets: bucketRows(b.staleBuckets),
  });
}

/* ---- packed logs -------------------------------------------------------- */

function expandRows(packed, fields, extra) {
  if (!packed) return [];
  if (packed._rows) return packed._rows;
  const { repos, rows } = packed;
  return (packed._rows = rows.map((row) => {
    const out = {};
    fields.forEach((f, i) => { out[f] = row[i] ?? null; });
    out.repo = repos[out.repo] ?? "";
    return extra ? extra(out) : out;
  }));
}

const OUTCOME_LABEL = { completed: "completed", notPlanned: "not planned", duplicate: "duplicate" };
const OUTCOME_CLASS = { completed: "merged", notPlanned: "dropped", duplicate: "unknown" };

/** The close reason, as a pill. Open issues get one too, so a column never blanks. */
function outcomePill(r) {
  if (r.open) return `<span class="pill draft">open</span>`;
  const name = state.drill?.issueOutcomes?.[r.outcome] ?? "completed";
  return `<span class="pill ${OUTCOME_CLASS[name] ?? "unknown"}">${esc(OUTCOME_LABEL[name] ?? name)}</span>`;
}

/** Sort key for the column above: open, then resolved, then the rest. */
const outcomeOrder = (r) => (r.open ? 0 : (r.outcome ?? 0) + 1);

/** Every issue this contributor filed, newest first. */
const filedAll = (s = subject()) =>
  expandRows(issuesOf(s)?.filed, state.drill?.filedFields ?? [], (r) => ({
    ...r, open: r.open === 1,
  }));

/** Every issue they closed or fixed, newest first. */
const closedAll = (s = subject()) =>
  expandRows(issuesOf(s)?.closed, state.drill?.closedFields ?? [], (r) => ({
    ...r, viaPR: r.viaPR === 1, own: r.own === 1, open: false,
  }));

/** Trim a log to the selected period. Both logs carry a plain `at` date. */
function inWindow(rows) {
  const days = (state.drill?.windows ?? []).find((w) => w.id === activeWindow())?.days;
  if (days == null) return rows;
  const cutoff = Date.now() - days * 86400000;
  return rows.filter((r) => new Date(r.at).getTime() >= cutoff);
}

const filedRows = () => inWindow(filedAll());
const closedRows = () => inWindow(closedAll());

/* ---- messaging ---------------------------------------------------------- */

/**
 * What to say when there's nothing to show, which is three different things:
 * the store is missing, this subject has never touched an issue, or the repo has
 * no tracker. Each one has a different fix, so each one says so.
 */
function issueMissing() {
  if (state.drill && state.drill.issueData === false)
    return `<div class="error">No issue data in the drilldown build. Run <code>npm run ingest</code>, then <code>npm run build</code>.</div>`;
  return state.page === "contributor"
    ? `<div class="empty">This contributor has never filed, answered or closed an issue.</div>`
    : `<div class="empty">This repo has no issue tracker, or nothing has ever been filed on it.</div>`;
}

/**
 * How much of the close data is attributable.
 *
 * Records written before the ingest learned to ask who closed an issue, and
 * records filled by a REST bulk load, can't say. Without this note a triage
 * board full of zeroes looks like a team that does nothing rather than a store
 * that hasn't been re-walked.
 */
function closerNotice(w) {
  // A tracker window counts its own unattributed closes. A person's can't —
  // "closes nobody was credited for" is a fact about the store, not about them —
  // so those fall back to the figure the build records for the whole store.
  const unknown = w?.unknownCloser ?? state.drill?.closerCoverage?.unknown ?? 0;
  if (!unknown) return "";
  const scope = w?.unknownCloser ? "in this period" : "in the store";
  return `<div class="hint" style="margin-top:10px">${unknown.toLocaleString()} closed issues ${scope} don't record who closed them — those records predate the closer field or came from a bulk load. Run <code>npm run ingest</code> to backfill them; until then, read every "closed by" figure as a floor rather than a count.</div>`;
}

/** Every window side by side, the issue equivalent of windowTable(). */
function issueWindowTable(rows, s = subject()) {
  const ws = state.drill?.windows ?? [];
  return `<div class="tscroll"><table>
    <thead><tr><th style="cursor:default">Metric</th>${ws.map((x) =>
      `<th style="cursor:default" class="num">${esc(x.label)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map(([lab, f]) =>
      `<tr><td>${lab}</td>${ws.map((x) =>
        `<td class="num">${f(issueWindowOf(s, x.id))}</td>`).join("")}</tr>`).join("")}</tbody>
  </table></div>`;
}

/** True when the subject has any issue record at all. */
const hasIssues = (s = subject()) => !!issuesOf(s);

export {
  IIW,
  closedAll,
  closedRows,
  closerNotice,
  filedAll,
  filedRows,
  hasIssues,
  issueBacklogOf,
  issueFields,
  issueMissing,
  issueSeriesOf,
  issueSlice,
  issueWindowOf,
  issueWindowTable,
  issuesOf,
  outcomeOrder,
  outcomePill,
};
