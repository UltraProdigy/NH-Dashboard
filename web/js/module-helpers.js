import { diff, dur, esc, fmt, pctFmt } from "./format.js";
import { kpi } from "./charts.js";
import { A, panel } from "./data.js";
import { CLOSED_LABEL, state } from "./state.js";

/* ---- controls that have two homes ---------------------------------------
   A `tabControls` entry sits in the page toolbar when its module has a tab to
   itself, and in the card's own header when the module is one of several
   stacked into a group tab. Same markup either way, so it lives here rather
   than inside the toolbar renderer. */

const CONTROL_HTML = {
  closedState: () => `<span class="seg" id="closedSeg">${
    Object.entries(CLOSED_LABEL).map(([id, label]) =>
      `<button data-closed="${id}" aria-pressed="${state.closedState === id}">${esc(label)}</button>`
    ).join("")}</span>`,
};

const controlHtml = (name) => CONTROL_HTML[name]?.() ?? "";

/* ---- draft status -------------------------------------------------------
   Tri-state. Records ingested before `isDraft` was added to the query carry
   null, which has to look different from "not a draft" — otherwise the column
   silently claims every old PR is ready for review. */

const draftPill = (v) =>
  v == null
    ? `<span class="pill unknown" title="Not ingested yet — run npm run ingest to backfill">unknown</span>`
    : v
      ? `<span class="pill draft">draft</span>`
      : `<span class="pill ready">ready</span>`;

/** Sort order: drafts, then ready, then unknown. */
const draftOrder = (v) => (v === true ? 0 : v === false ? 1 : 2);

/**
 * Shown when a window has PRs but no diff data behind them.
 *
 * Same shape as draftNotice, and the same reasoning: a tile reading "0 lines
 * changed" for someone who has opened forty PRs is a lie, and the fix is a
 * command, so say the command.
 */
const sizeNotice = (w) =>
  !w.opened || w.sizedPRs ? "" :
    `<div class="hint" style="padding:12px 14px 0">No diff data for these PRs yet. Run <code>npm run ingest</code> — it re-walks the store once to populate lines changed, commits, comments and reactions, then <code>npm run build</code>.</div>`;

const draftNotice = (backlog) =>
  backlog.draftsKnown ? "" :
    `<div class="hint" style="padding:12px 14px 0">Draft status is missing for PRs ingested before it was tracked. Run <code>npm run ingest</code> — it re-fetches just the open ones.</div>`;

/* ---- CI health ---------------------------------------------------------- */

/**
 * CI runs are minutes-scale, and `dur()` takes hours — round-tripping 4.5
 * minutes through it yields "5m", quietly throwing away the precision that
 * makes two workflows comparable. Format minutes directly and hand off to
 * dur() only once we're past an hour, where its unit-switching earns its keep.
 */
const ciDur = (m) =>
  m == null ? "—" : m < 60 ? `${m < 10 ? m.toFixed(1) : Math.round(m)}m` : dur(m / 60);

const CI_TONE = {
  success: "pass",
  failure: "fail", timed_out: "fail", startup_failure: "fail",
  cancelled: "neutral", skipped: "neutral", action_required: "neutral",
};

/**
 * Default-branch Actions health. Lives in dashboard.json rather than the
 * drilldown file because it's API-derived rather than store-derived, and it's
 * small enough that the split costs nothing.
 */
function ciSection(repo) {
  const p = panel("ciHealth");
  if (!p) return "";  // built before this panel existed
  if (!p.ok)
    return `<div class="hint" style="margin-top:18px">CI health unavailable — ${esc(p.error)}</div>`;

  // `{ repos, org }` since the org roll-up was added; the flat map is what
  // builds before that wrote. Tolerated rather than required, so a stale
  // dashboard.json renders instead of throwing while a rebuild is pending.
  const ci = (p.data.repos ?? p.data)[repo];
  if (!ci)
    return `<div class="hint" style="margin-top:18px">No completed Actions runs on this repo's default branch.</div>`;

  const c = ci.latest?.conclusion;
  const tone = CI_TONE[c] ?? "neutral";
  const badge = ci.latest
    ? `<a href="${ci.latest.url}" target="_blank" rel="noopener" class="pill ${tone}" style="font-size:12px">${esc(c ?? "unknown")}</a>`
    : `<span class="pill unknown">no verdict</span>`;

  const rate = ci.passRate;
  const rateCls = rate == null ? "" : rate > 0.9 ? "up" : rate > 0.7 ? "flat" : "down";

  return `<h3 style="font-size:13px;margin:22px 0 8px">CI on ${esc(ci.defaultBranch)}</h3>
    <div class="kpis" style="margin:0 -14px">
      ${kpi("Latest run", badge, ci.latest?.workflow ? esc(ci.latest.workflow) : "")}
      ${kpi("Pass rate", pctFmt(rate), `${fmt(ci.decisive)} decisive of ${fmt(ci.runs)} runs`, rateCls)}
      ${kpi("Median duration", ciDur(ci.medianMinutes), `${fmt(ci.failures)} failed`)}
      ${kpi("Actions time", ciDur(ci.totalMinutes),
            ci.timedRuns ? `across ${fmt(ci.timedRuns)} runs` : "no timing data")}
    </div>
    <div class="hint" style="margin-top:12px">Cancelled and skipped runs are excluded from the pass rate — they say something about the humans, not the code.</div>
    <div class="hint" style="margin-top:6px"><strong>Actions time is wall-clock, not GitHub's billable minutes.</strong> A run with eight matrix jobs in parallel bills roughly eight times what it took on the clock, and macOS bills 10x. Use it to compare repos against each other, not against an invoice — the real figure needs one API request per run, which would cost more than the rest of this dashboard combined.</div>`;
}

/** Cross-reference into the needsRelease panel, which already has this data. */
function releaseFor(repo) {
  const p = panel("needsRelease");
  return p?.ok ? p.data.find(r => r.repo === repo) ?? null : null;
}

const missingIngest = () =>
  `<div class="error">Analytics needs the local PR store. Run <code>npm run ingest</code>, then <code>npm run build</code>.</div>`;

export {
  ciDur,
  ciSection,
  controlHtml,
  draftNotice,
  draftOrder,
  draftPill,
  missingIngest,
  releaseFor,
  sizeNotice,
};
