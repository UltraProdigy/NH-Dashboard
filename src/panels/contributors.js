/**
 * Contributor activity, aggregated from the ingested PR store.
 *
 * Everything here is local computation — no API calls. That's the whole point
 * of the ingestion step: once the data is on disk, every time window becomes
 * cheap, and "all-time" costs the same as "last 30 days".
 */

import { readStore } from "../ingest/pullRequests.js";
import { activeDayIndex } from "./activeDays.js";
import { CONTRIBUTOR_MIN_ACTIVITY } from "../config.js";
import {
  WINDOWS,
  isBot,
  byActivityThenLogin,
} from "../shared/contributor-rules.js";

const DAY = 86_400_000;

// Re-exported because analytics.js and drilldown.js have always imported
// WINDOWS from here.
export { WINDOWS };

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
   * Distinct days each person did something, per window, with the number of
   * days in the period beside it.
   *
   * From the shared index rather than counted here, and deliberately: this
   * panel only reads the PR store, so a triager's days computed locally would
   * stop the moment they stopped opening pull requests even though they
   * answered issues for another two years — and it would disagree with the same
   * person's drilldown, which is the failure that matters most.
   *
   * Both halves land inside the per-window records beside `prs` and
   * `approvals`, which is what makes the Leaderboard column follow the time
   * control for free and what stops the browser inventing its own denominator.
   */
  const active = await activeDayIndex(WINDOWS);

  const rows = [...people.values()]
    .filter((p) => p.all.prs + p.all.approvals >= CONTRIBUTOR_MIN_ACTIVITY)
    .map((p) => {
      const a = active.get(p.login);
      const out = { ...p };
      for (const w of WINDOWS) {
        const d = a?.windows[w.id];
        out[w.id] = { ...p[w.id], activeDays: d?.days ?? 0, activeDenom: d?.denom ?? 0 };
      }
      return out;
    })
    .sort(byActivityThenLogin);

  if (truncated) {
    console.warn(
      `  note: ${truncated} PRs exceeded the per-PR review fetch limit; approval counts for those are slightly undercounted`
    );
  }

  return { windows: WINDOWS, rows, totalPRs: prs.length, truncated };
}
