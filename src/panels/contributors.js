/**
 * Contributor activity, aggregated from the ingested PR store.
 *
 * Everything here is local computation — no API calls. That's the whole point
 * of the ingestion step: once the data is on disk, every time window becomes
 * cheap, and "all-time" costs the same as "last 30 days".
 */

import { readStore } from "../ingest/pullRequests.js";
import { activeDayIndex } from "./activeDays.js";
import { BOT_PATTERN, CONTRIBUTOR_MIN_ACTIVITY } from "../config.js";

const DAY = 86_400_000;

/**
 * `short` is for the segmented control on the drilldowns, `label` for prose
 * ("last 3 months") and table headers.
 *
 * All-time leads because it's the drilldowns' default and the answer you
 * usually want first about a single subject. Order here drives the control,
 * the dropdown, and the column order of the all-window comparison tables.
 */
export const WINDOWS = [
  { id: "all", label: "All time", short: "All", days: null },
  { id: "m1", label: "1 month", short: "1m", days: 30 },
  { id: "m3", label: "3 months", short: "3m", days: 90 },
  { id: "m6", label: "6 months", short: "6m", days: 180 },
  { id: "y1", label: "1 year", short: "1y", days: 365 },
  { id: "y2", label: "2 years", short: "2y", days: 730 },
  { id: "y5", label: "5 years", short: "5y", days: 1825 },
];

const isBot = (login) => !login || BOT_PATTERN.test(login);

export async function contributors() {
  const prs = await readStore();

  if (!prs.length) {
    throw new Error(
      "No ingested data. Run `npm run ingest` first — the all-time backfill " +
        "takes a while, but later runs are incremental."
    );
  }

  const now = Date.now();
  const people = new Map();
  let truncated = 0;

  const entry = (login) => {
    if (!people.has(login)) {
      const blank = Object.fromEntries(
        WINDOWS.map((w) => [w.id, { prs: 0, merged: 0, approvals: 0 }])
      );
      people.set(login, { login, ...blank, firstSeen: null, lastSeen: null });
    }
    return people.get(login);
  };

  /** Add 1 to every window a timestamp falls inside. */
  const bump = (login, field, when) => {
    if (isBot(login) || !when) return;
    const rec = entry(login);
    const ageDays = (now - new Date(when)) / DAY;

    for (const w of WINDOWS) {
      if (w.days === null || ageDays <= w.days) rec[w.id][field]++;
    }

    if (!rec.firstSeen || when < rec.firstSeen) rec.firstSeen = when;
    if (!rec.lastSeen || when > rec.lastSeen) rec.lastSeen = when;
  };

  for (const pr of prs) {
    if (pr.reviewsTruncated) truncated++;

    bump(pr.author, "prs", pr.createdAt);
    if (pr.mergedAt) bump(pr.author, "merged", pr.mergedAt);

    // Count one approval per reviewer per PR — re-approving after changes
    // shouldn't inflate someone's numbers.
    const approvers = new Set();
    for (const r of pr.reviews) {
      if (r.state !== "APPROVED" || !r.author) continue;
      if (approvers.has(r.author)) continue;
      approvers.add(r.author);
      bump(r.author, "approvals", r.submittedAt);
    }
  }

  /**
   * How much of their own run they were actually working.
   *
   * Both numbers come from the shared index rather than from the counters
   * above, and deliberately: this panel only reads the PR store, so a triager's
   * span computed here would end the day they stopped opening pull requests
   * even though they answered issues for another two years. It would also
   * disagree with the same person's drilldown, which is the failure that
   * matters most — two pages, one person, two percentages, no way to tell which
   * is wrong from either.
   */
  const active = await activeDayIndex();

  const rows = [...people.values()]
    .filter((p) => p.all.prs + p.all.approvals >= CONTRIBUTOR_MIN_ACTIVITY)
    .map((p) => {
      const a = active.get(p.login);
      return { ...p, activeDays: a?.days ?? 0, activeSpan: a?.span ?? 0 };
    })
    .sort((a, b) => b.all.prs + b.all.approvals - (a.all.prs + a.all.approvals));

  if (truncated) {
    console.warn(
      `  note: ${truncated} PRs exceeded the per-PR review fetch limit; approval counts for those are slightly undercounted`
    );
  }

  return { windows: WINDOWS, rows, totalPRs: prs.length, truncated };
}
