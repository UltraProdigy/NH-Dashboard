/**
 * Contributor activity, aggregated from the ingested PR store.
 *
 * Everything here is local computation — no API calls. That's the whole point
 * of the ingestion step: once the data is on disk, every time window becomes
 * cheap, and "all-time" costs the same as "last 30 days".
 */

import { readStore } from "../ingest/pullRequests.js";
import { BOT_PATTERN, CONTRIBUTOR_MIN_ACTIVITY } from "../config.js";

const DAY = 86_400_000;

export const WINDOWS = [
  { id: "m1", label: "1 month", days: 30 },
  { id: "m3", label: "3 months", days: 90 },
  { id: "m6", label: "6 months", days: 180 },
  { id: "y1", label: "1 year", days: 365 },
  { id: "all", label: "All time", days: null },
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

  const rows = [...people.values()]
    .filter((p) => p.all.prs + p.all.approvals >= CONTRIBUTOR_MIN_ACTIVITY)
    .sort((a, b) => b.all.prs + b.all.approvals - (a.all.prs + a.all.approvals));

  if (truncated) {
    console.warn(
      `  note: ${truncated} PRs had more than 20 reviews; approval counts for those are undercounted`
    );
  }

  return { windows: WINDOWS, rows, totalPRs: prs.length, truncated };
}
