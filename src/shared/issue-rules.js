/**
 * What the issue panels agree an issue means, in both languages.
 *
 * Three places aggregate the issue store in JavaScript — the org panel, the
 * per-repo drilldown and the per-person drilldown — and a fourth now reads the
 * same records as SQL rows inside a Worker. If the contributor page counts a
 * duplicate as a resolved close and the issue page does not, the two disagree
 * about the same person and nothing says which is lying.
 *
 * The JavaScript definitions live in `panels/issueMetrics.js`, close to the
 * accumulators that use them. What lives here is the pair: each rule and the
 * SQL that has to mean the same thing, generated side by side so they cannot
 * drift, and asserted against each other in the parity test.
 *
 * The translation is not mechanical, because the two see different shapes. A
 * JavaScript record carries a nested `closedVia: {kind, repo, number, author}`;
 * D1 flattened that into four columns when the schema was written, precisely so
 * closer attribution could be queried. So these are not the same expression in
 * two syntaxes — they are two readings of one rule, which is the whole reason
 * to keep them in one file.
 *
 * Dependency-free, because a Worker bundles it.
 */

import { isHumanSql } from "./contributor-rules.js";

/**
 * Close reasons that mean "this was never fixed".
 *
 * GitHub has grown the list over time — DUPLICATE arrived after NOT_PLANNED —
 * and anything not in here counts as completed, so a reason added later fails
 * towards the flattering side. Worth re-checking against live data rather than
 * trusting this to stay exhaustive.
 */
export const UNRESOLVED = ["NOT_PLANNED", "DUPLICATE"];

const quoted = UNRESOLVED.map((r) => `'${r}'`).join(", ");

/** `state_reason` says this close resolved nothing. */
export const unresolvedSql = (col = "state_reason") =>
  `(${col} IN (${quoted}))`;

/**
 * Completed is the *absence* of an unresolved reason, not `= 'COMPLETED'`.
 *
 * A close reason has been recorded on every closed issue GitHub has returned so
 * far, including ones closed years before the feature existed — it appears to
 * have backfilled COMPLETED onto them. A NULL reason therefore counts as
 * completed, and `unknownReason` counts how many landed there so the assumption
 * is visible if it ever starts firing.
 */
export const completedSql = (col = "state_reason") =>
  `(NOT ${unresolvedSql(col)} OR ${col} IS NULL)`;

/** Closed, with a reason that is neither unresolved nor explicitly COMPLETED. */
export const unknownReasonSql = (col = "state_reason") =>
  `(${completedSql(col)} AND (${col} IS NULL OR ${col} <> 'COMPLETED'))`;

/**
 * An issue nobody outside the reporter ever replied to.
 *
 * `response_unknown` records exhausted the ingest's comment sample without
 * finding a human reply, which is a different thing from silence — those are
 * excluded from both sides rather than counted as unanswered.
 */
export const unansweredSql = () =>
  `(first_response_at IS NULL AND response_unknown = 0)`;

/* ==========================================================================
   Credit for a close

   Two people can reasonably be said to have closed an issue: whoever pressed
   the button, and whoever wrote the pull request that made pressing it
   possible. Both are counted, separately and by name, because on this org they
   are usually different people doing different jobs — one triages, one fixes —
   and collapsing them into a single "closes" number would flatter the first and
   erase the second.
   ========================================================================== */

/** Who pressed the button, or NULL when that was a bot or is unknown. */
export const closerSql = () =>
  `(CASE WHEN ${isHumanSql("closed_by")} THEN closed_by END)`;

/** The close came from a pull request. `commit` and `projectv2` also occur. */
export const closedByPrSql = () => `(closed_via_kind = 'pr')`;

/** Author of the closing pull request — "my PR closed this ticket". */
export const fixerSql = () =>
  `(CASE WHEN ${closedByPrSql()} AND ${isHumanSql("closed_via_author")}
         THEN closed_via_author END)`;

/**
 * True when the store cannot say who closed this.
 *
 * Only a record that explicitly says it asked counts as known. Records written
 * before the ingest learned the question carry no flag, and reading their
 * silence as "closed by nobody" would report a store awaiting a re-walk as a
 * team that never closes anything — so the test is `closer_known` being
 * anything other than true, not `closed_by` being null.
 */
export const closerUnknownSql = () =>
  `(closed_at IS NOT NULL AND closer_known <> 1)`;

/**
 * Labels on the modpack follow a "Prefix: Value" convention — `Mod: GT`,
 * `Status: Stale`, `Type: Recipe` — and the prefixes are different questions,
 * not one long list. Flattening them into one ranked chart buries the nine
 * labels describing where work is stuck under a hundred describing what it is
 * about.
 *
 * Kept as a regex rather than a SQL expression on purpose: labels are a JSON
 * column, the panel reads them as whole lists, and splitting a prefix is
 * something to do once per distinct label in the isolate rather than once per
 * row in the database.
 */
const LABEL_PREFIX = /^([A-Za-z0-9][A-Za-z0-9 ]*):\s*(.+)$/;

export function splitLabel(name) {
  const m = LABEL_PREFIX.exec(name);
  return m ? { group: m[1], short: m[2] } : { group: "Other", short: name };
}

/**
 * Groups in the order they answer an admin's questions: where is it stuck, how
 * bad is it, what kind of thing is it, which component, everything else.
 * Anything unlisted sorts after these, alphabetically.
 */
export const GROUP_ORDER = ["Status", "Bug", "Type", "Platform", "Mod", "Other"];

export const groupRank = (g) => {
  const i = GROUP_ORDER.indexOf(g);
  return i === -1 ? GROUP_ORDER.length : i;
};

/**
 * An empty JSON array, tested as a string.
 *
 * `labels` and `assignees` are JSON columns, and "has none" is the only
 * question the core panel asks of them. Every empty value in the store is
 * exactly `[]` — 8,389 issues with no labels and 22,336 with no assignee — so
 * this needs no JSON support at all, which keeps the whole core port
 * independent of whether D1 provides `json_each`. The label breakdown does need
 * it, and finds out separately.
 */
export const emptyJsonSql = (col) => `(${col} = '[]')`;
