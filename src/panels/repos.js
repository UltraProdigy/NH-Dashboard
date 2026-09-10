/**
 * Repo activity, aggregated from the ingested pull request and issue stores.
 *
 * Pure local computation like the panels either side of it — no API calls. This
 * is the org-wide counterpart to the repo drilldown: one row per repo rather
 * than every card for the repo you named.
 *
 * Two stores rather than one, which is what makes this its own panel instead of
 * a block inside `analytics`. That panel reads pull requests and can say nothing
 * about the trackers, and 237 of the 299 repos here have never had an issue —
 * so an issue column is mostly empty, and mostly empty is still the difference
 * between a tracker nobody is on top of and a repo that does not use issues.
 *
 * The definitions follow `shared/drilldown-fold.js` wherever the same word
 * appears, because a reader clicks from this table into that page and the two
 * have to agree: `opened` counts bots, `people` does not, an approval is one per
 * reviewer per pull request dated to their earliest. The one deliberate
 * departure is documented at `closedIn` below.
 */

import { readStore } from "../ingest/pullRequests.js";
import { readStore as readIssueStore } from "../ingest/issues.js";
import { WINDOWS } from "./contributors.js";
import { isBot } from "../shared/contributor-rules.js";
import { pct, round1 } from "../shared/analytics-rules.js";
import { isUnanswered } from "./issueMetrics.js";
import {
  CONCENTRATION_N,
  LIFECYCLE,
  STALE_OPEN_PR_DAYS,
  byActivityThenRepo,
  lifecycleOf,
} from "../shared/repo-activity-rules.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;

const round3 = (n) => (n == null ? null : Math.round(n * 1000) / 1000);

/**
 * One approval per reviewer per pull request, dated to their earliest.
 *
 * Bots excluded, self-approval not — the same pair of choices `approversOf` in
 * `drilldown-fold.js` makes, and the reason is the same: a bot is not a
 * reviewer, while a maintainer approving their own pull request is a real act
 * this org performs and hiding it would flatter the numbers.
 */
function approversOf(pr) {
  const out = new Map();
  for (const r of pr.reviews ?? []) {
    if (r.state !== "APPROVED" || isBot(r.author) || !r.submittedAt) continue;
    const prev = out.get(r.author);
    if (!prev || r.submittedAt < prev) out.set(r.author, r.submittedAt);
  }
  return out;
}

/**
 * The per-window metrics, in the order the packed rows carry them.
 *
 * Shipped positionally against this list rather than as ten named keys per
 * window per repo — the same deal `issues.js` gives its `people` block, and for
 * the same reason. Named, the payload is 387 KB of which most is the string
 * "medianMergeHours" written 2,093 times; packed it is 140 KB. The frontend
 * expands a window on first use and memoizes it onto the panel data.
 */
const WINDOW_FIELDS = [
  "opened",
  "merged",
  "closed",
  "mergeRate",
  "approvals",
  "people",
  "reviewers",
  "medianMergeHours",
  "issuesOpened",
  "issuesClosed",
];

const blankWindow = () => ({
  opened: 0,
  merged: 0,
  closed: 0,
  approvals: 0,
  issuesOpened: 0,
  issuesClosed: 0,
  people: new Set(),
  reviewers: new Set(),
  mergeHours: [],
});

export async function repos(now = Date.now()) {
  const [prs, issues] = await Promise.all([readStore(), readIssueStore()]);

  if (!prs.length) {
    throw new Error(
      "No ingested data. Run `npm run ingest` first — the all-time backfill " +
        "takes a while, but later runs are incremental."
    );
  }

  const bounds = WINDOWS.map((w) => ({
    id: w.id,
    from: w.days == null ? -Infinity : now - w.days * DAY,
  }));

  const byRepo = new Map();
  const entry = (repo) => {
    let r = byRepo.get(repo);
    if (!r) {
      r = {
        repo,
        totalPRs: 0,
        totalIssues: 0,
        openPRs: 0,
        staleOpenPRs: 0,
        unreviewedOpenPRs: 0,
        openIssues: 0,
        unansweredIssues: 0,
        first: null,
        last: null,
        _w: Object.fromEntries(WINDOWS.map((w) => [w.id, blankWindow()])),
      };
      byRepo.set(repo, r);
    }
    return r;
  };

  /**
   * First and last activity, from acts rather than touches.
   *
   * `updatedAt` moves when somebody comments on a two-year-old pull request,
   * which is a fact about a conversation and not about the repo being worked
   * on. The drilldown's picker takes the same view. Measured both ways the
   * lifecycle split barely moves, so this is a choice about meaning rather than
   * one the numbers force.
   */
  const touch = (r, when) => {
    if (!when) return;
    if (!r.first || when < r.first) r.first = when;
    if (!r.last || when > r.last) r.last = when;
  };

  const inWindow = (from, when) => when != null && Date.parse(when) >= from;

  for (const pr of prs) {
    const r = entry(pr.repo);
    r.totalPRs++;

    const closedUnmerged = !pr.mergedAt && pr.state === "CLOSED";

    /**
     * `closedAt` where the backfill has reached it, `updatedAt` where it has
     * not — the fallback `analytics.js` adopted when the field was added.
     *
     * This is the one place the panel departs from `drilldown-fold.js`, which
     * still dates the closed side by `updatedAt` alone. That is wrong by
     * however long a pull request kept drawing comments after it was shut, and
     * the analytics side was fixed rather than the drilldown only because
     * fixing one half of a parity pair breaks it. The drilldown should follow;
     * until it does, `closed` here can differ from the same repo's drilldown
     * for pull requests closed long before they stopped being discussed.
     */
    const closedAt = closedUnmerged ? pr.closedAt ?? pr.updatedAt : null;

    const approvers = approversOf(pr);
    const authorIsBot = isBot(pr.author);
    const mergeHours =
      pr.mergedAt ? (Date.parse(pr.mergedAt) - Date.parse(pr.createdAt)) / HOUR : null;

    touch(r, pr.createdAt);
    touch(r, pr.mergedAt);
    touch(r, closedAt);

    if (pr.state === "OPEN") {
      r.openPRs++;
      const ageDays = (now - Date.parse(pr.createdAt)) / DAY;
      if (ageDays >= STALE_OPEN_PR_DAYS) r.staleOpenPRs++;
      if (!(pr.reviews ?? []).some((v) => v.submittedAt)) r.unreviewedOpenPRs++;
    }

    for (const { id, from } of bounds) {
      const w = r._w[id];
      if (inWindow(from, pr.createdAt)) {
        w.opened++;
        if (!authorIsBot && pr.author) w.people.add(pr.author);
      }
      if (inWindow(from, pr.mergedAt)) {
        w.merged++;
        if (mergeHours != null) w.mergeHours.push(mergeHours);
      }
      if (inWindow(from, closedAt)) w.closed++;
      for (const [login, at] of approvers) {
        if (!inWindow(from, at)) continue;
        w.approvals++;
        w.reviewers.add(login);
      }
    }
  }

  for (const i of issues) {
    const r = entry(i.repo);
    r.totalIssues++;

    touch(r, i.createdAt);
    touch(r, i.closedAt);

    if (i.state === "OPEN") {
      r.openIssues++;
      if (isUnanswered(i)) r.unansweredIssues++;
    }

    for (const { id, from } of bounds) {
      const w = r._w[id];
      if (inWindow(from, i.createdAt)) w.issuesOpened++;
      if (inWindow(from, i.closedAt)) w.issuesClosed++;
    }
  }

  const finishWindow = (w) => [
    w.opened,
    w.merged,
    w.closed,
    round3(w.merged + w.closed ? w.merged / (w.merged + w.closed) : null),
    w.approvals,
    w.people.size,
    w.reviewers.size,
    round1(pct(w.mergeHours.sort((a, b) => a - b), 50)),
    w.issuesOpened,
    w.issuesClosed,
  ];

  const rows = [...byRepo.values()].map((r) => {
    const idleDays = r.last == null ? null : Math.floor((now - Date.parse(r.last)) / DAY);
    const out = {
      repo: r.repo,
      totalPRs: r.totalPRs,
      totalIssues: r.totalIssues,
      openPRs: r.openPRs,
      staleOpenPRs: r.staleOpenPRs,
      unreviewedOpenPRs: r.unreviewedOpenPRs,
      openIssues: r.openIssues,
      unansweredIssues: r.unansweredIssues,
      first: r.first,
      last: r.last,
      idleDays,
      lifecycle: lifecycleOf(idleDays),
    };
    for (const w of WINDOWS) out[w.id] = finishWindow(r._w[w.id]);
    return out;
  });

  const OPENED = WINDOW_FIELDS.indexOf("opened");
  const ISSUES_OPENED = WINDOW_FIELDS.indexOf("issuesOpened");
  const activityIn = (r, id) => r[id][OPENED] + r[id][ISSUES_OPENED];

  rows.sort(byActivityThenRepo((r) => activityIn(r, "all")));

  /**
   * How much of the org's activity sits in its busiest few repos.
   *
   * Per window, because the answer moves: a repo that carried a release quarter
   * is not carrying the decade. Activity is pull requests plus issues opened,
   * which is the same total the rows are ranked on, so the share is a share of
   * something the reader can see rather than of a hidden composite.
   */
  const org = {
    repos: rows.length,
    byLifecycle: LIFECYCLE.map((b) => ({
      id: b.id,
      label: b.label,
      detail: b.detail,
      count: rows.filter((r) => r.lifecycle === b.id).length,
    })),
    openPRs: rows.reduce((n, r) => n + r.openPRs, 0),
    staleOpenPRs: rows.reduce((n, r) => n + r.staleOpenPRs, 0),
    openIssues: rows.reduce((n, r) => n + r.openIssues, 0),
    unansweredIssues: rows.reduce((n, r) => n + r.unansweredIssues, 0),
    byWindow: Object.fromEntries(
      WINDOWS.map((w) => {
        const activity = rows.map((r) => activityIn(r, w.id)).sort((a, b) => b - a);
        const total = activity.reduce((n, v) => n + v, 0);
        const top = activity.slice(0, CONCENTRATION_N).reduce((n, v) => n + v, 0);
        return [
          w.id,
          {
            activeRepos: activity.filter((v) => v > 0).length,
            opened: rows.reduce((n, r) => n + r[w.id][OPENED], 0),
            issuesOpened: rows.reduce((n, r) => n + r[w.id][ISSUES_OPENED], 0),
            concentration: round3(total ? top / total : null),
          },
        ];
      })
    ),
  };

  return {
    windows: WINDOWS,
    windowFields: WINDOW_FIELDS,
    concentrationN: CONCENTRATION_N,
    org,
    rows,
  };
}
