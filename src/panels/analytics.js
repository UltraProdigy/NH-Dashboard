/**
 * Org-wide analytics, aggregated from the ingested PR store.
 *
 * Like the contributors panel, this is pure local computation — no API calls.
 * The ingest store already holds every PR in the org with its review list, so
 * anything shaped like "how has the org behaved over time" can be answered here
 * for free, at whatever granularity we feel like emitting.
 *
 * Output is deliberately pre-bucketed rather than raw: shipping 28k PRs to the
 * browser to pivot client-side would be a multi-megabyte payload for charts
 * that only ever need a few hundred points.
 */

import { readStore } from "../ingest/pullRequests.js";
import { BOT_PATTERN, ORG } from "../config.js";
import { WINDOWS } from "./contributors.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;

/**
 * How stale an open PR has to be before it lands in each backlog bucket.
 * Exported so the per-repo drilldown buckets identically — two copies of this
 * list would drift, and then the org total wouldn't equal the sum of the repos.
 */
export const BACKLOG_BUCKETS = [
  { label: "< 1 week", max: 7 },
  { label: "1–4 weeks", max: 30 },
  { label: "1–3 months", max: 90 },
  { label: "3–12 months", max: 365 },
  { label: "> 1 year", max: Infinity },
];

const isBot = (login) => !login || BOT_PATTERN.test(login);

/** Linear-interpolation-free percentile. Good enough for a dashboard. */
function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

/** ISO-ish week key: 2026-W32. Weeks start Monday, matching GitHub's charts. */
function weekKey(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (t.getUTCDay() + 6) % 7; // Mon = 0
  t.setUTCDate(t.getUTCDate() - dow + 3); // nearest Thursday defines the year
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round((t - firstThu) / (7 * DAY));
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

const monthKey = (d) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

/**
 * Accumulator for one time bucket. `authors` is a Set while building and gets
 * flattened to a count on the way out — the identities are only needed to
 * dedupe.
 */
function blankBucket(key, start) {
  return {
    b: key,
    t: start,
    opened: 0,
    merged: 0,
    closed: 0,
    _authors: new Set(),
    newAuthors: 0,
    _mergeHours: [],
    _reviewHours: [],
  };
}

function finishBucket(b) {
  const merge = b._mergeHours.sort((x, y) => x - y);
  const review = b._reviewHours.sort((x, y) => x - y);
  return {
    b: b.b,
    t: b.t,
    opened: b.opened,
    merged: b.merged,
    closed: b.closed,
    authors: b._authors.size,
    newAuthors: b.newAuthors,
    mergeMedianH: round1(pct(merge, 50)),
    mergeP90H: round1(pct(merge, 90)),
    reviewMedianH: round1(pct(review, 50)),
    mergeN: merge.length,
    reviewN: review.length,
  };
}

/** First review of any kind — the thing an author is actually waiting on. */
function firstReviewAt(pr) {
  let best = null;
  for (const r of pr.reviews ?? []) {
    if (!r.submittedAt || isBot(r.author) || r.author === pr.author) continue;
    if (!best || r.submittedAt < best) best = r.submittedAt;
  }
  return best;
}

export async function analytics() {
  const prs = await readStore();

  if (!prs.length) {
    throw new Error(
      "No ingested data. Run `npm run ingest` first — the all-time backfill " +
        "takes a while, but later runs are incremental."
    );
  }

  const now = Date.now();

  const weeks = new Map();
  const months = new Map();
  const firstSeen = new Map(); // login -> earliest createdAt, for "new contributors"
  const repos = new Set();

  // Pass 1: earliest PR per author. Needed before bucketing so a PR can be
  // labelled "this person's first" without depending on store ordering.
  for (const pr of prs) {
    if (isBot(pr.author) || !pr.createdAt) continue;
    const prev = firstSeen.get(pr.author);
    if (!prev || pr.createdAt < prev) firstSeen.set(pr.author, pr.createdAt);
  }

  const totals = { prs: 0, merged: 0, open: 0, closed: 0, approvals: 0 };
  const openPRs = [];

  /**
   * Every window gets a second, equal-length accumulator covering the period
   * immediately before it — that's what the "vs. previous" deltas compare
   * against. A 3-month view compares to the 3 months before it, not to last
   * month, which is what you'd actually expect from the label.
   *
   * "All time" has nothing to compare to, so it gets no prev period.
   */
  const periods = [];
  for (const w of WINDOWS) {
    periods.push({
      key: w.id,
      from: w.days == null ? -Infinity : now - w.days * DAY,
      to: Infinity,
    });
    if (w.days != null) {
      periods.push({
        key: `prev:${w.id}`,
        from: now - 2 * w.days * DAY,
        to: now - w.days * DAY,
      });
    }
  }

  const blankPeriod = () => ({
    opened: 0,
    merged: 0,
    closed: 0,
    mergedWithApproval: 0,
    authors: new Map(),
    reviewers: new Map(),
    repos: new Map(),
    mergeHours: [],
    reviewHours: [],
    newContributors: 0,
  });

  const win = Object.fromEntries(periods.map((p) => [p.key, blankPeriod()]));

  const inPeriod = (p, ts) => {
    if (!ts) return false;
    const t = new Date(ts).getTime();
    return t >= p.from && t < p.to;
  };

  // Weekday × hour of PR creation over the last year, UTC. Cheap to compute and
  // it makes the "when is this org awake" question answerable at a glance.
  const heat = Array.from({ length: 7 }, () => new Array(24).fill(0));

  const bucketFor = (map, key, start) => {
    if (!map.has(key)) map.set(key, blankBucket(key, start));
    return map.get(key);
  };

  for (const pr of prs) {
    if (!pr.createdAt) continue;
    const bot = isBot(pr.author);
    repos.add(pr.repo);

    totals.prs++;
    if (pr.mergedAt) totals.merged++;
    else if (pr.state === "OPEN") totals.open++;
    else totals.closed++;

    const created = new Date(pr.createdAt);
    const mergeHours = pr.mergedAt
      ? (new Date(pr.mergedAt) - created) / HOUR
      : null;
    const fr = firstReviewAt(pr);
    const reviewHours = fr ? (new Date(fr) - created) / HOUR : null;

    // One approval per reviewer per PR, dated to their first — re-approving
    // after a round of changes shouldn't count twice.
    const approvers = new Map();
    for (const r of pr.reviews ?? []) {
      if (r.state !== "APPROVED" || isBot(r.author) || !r.submittedAt) continue;
      const prev = approvers.get(r.author);
      if (!prev || r.submittedAt < prev) approvers.set(r.author, r.submittedAt);
    }
    totals.approvals += approvers.size;

    const isFirstEver = !bot && firstSeen.get(pr.author) === pr.createdAt;

    // ---- time series (opened bucket) ----
    for (const [map, key] of [
      [weeks, weekKey(created)],
      [months, monthKey(created)],
    ]) {
      const b = bucketFor(map, key, pr.createdAt);
      if (pr.createdAt < b.t) b.t = pr.createdAt;
      b.opened++;
      if (!bot) b._authors.add(pr.author);
      if (isFirstEver) b.newAuthors++;
      if (mergeHours != null) b._mergeHours.push(mergeHours);
      if (reviewHours != null) b._reviewHours.push(reviewHours);
    }

    // ---- time series (merged/closed bucket, by the date it happened) ----
    const endedAt = pr.mergedAt ?? (pr.state === "CLOSED" ? pr.updatedAt : null);
    if (endedAt) {
      const ended = new Date(endedAt);
      for (const [map, key] of [
        [weeks, weekKey(ended)],
        [months, monthKey(ended)],
      ]) {
        const b = bucketFor(map, key, endedAt);
        if (endedAt < b.t) b.t = endedAt;
        if (pr.mergedAt) b.merged++;
        else b.closed++;
      }
    }

    // ---- open backlog ----
    if (pr.state === "OPEN" && !pr.mergedAt) {
      openPRs.push({
        repo: pr.repo,
        number: pr.number,
        author: pr.author,
        url: `https://github.com/${ORG}/${pr.repo}/pull/${pr.number}`,
        ageDays: Math.floor((now - created) / DAY),
        staleDays: pr.updatedAt
          ? Math.floor((now - new Date(pr.updatedAt)) / DAY)
          : null,
        reviewed: fr != null,
      });
    }

    // ---- heatmap (last 365 days only) ----
    if (now - created <= 365 * DAY && !bot) {
      heat[(created.getUTCDay() + 6) % 7][created.getUTCHours()]++;
    }

    // ---- per-period rollups ----
    // Each event is counted against the period *its own timestamp* falls in,
    // so "merged in the last 3 months" doesn't quietly drop a PR that was
    // opened before the window started.
    for (const p of periods) {
      const acc = win[p.key];

      if (inPeriod(p, pr.createdAt)) {
        acc.opened++;
        if (!bot) {
          acc.authors.set(pr.author, (acc.authors.get(pr.author) ?? 0) + 1);
          if (isFirstEver) acc.newContributors++;
        }
        const r = acc.repos.get(pr.repo) ?? { repo: pr.repo, opened: 0, merged: 0 };
        r.opened++;
        if (pr.mergedAt) r.merged++;
        acc.repos.set(pr.repo, r);
        if (reviewHours != null) acc.reviewHours.push(reviewHours);
      }

      if (inPeriod(p, pr.mergedAt)) {
        acc.merged++;
        if (approvers.size) acc.mergedWithApproval++;
        if (mergeHours != null) acc.mergeHours.push(mergeHours);
      }

      if (!pr.mergedAt && pr.state === "CLOSED" && inPeriod(p, pr.updatedAt)) {
        acc.closed++;
      }

      for (const [login, at] of approvers) {
        if (inPeriod(p, at)) acc.reviewers.set(login, (acc.reviewers.get(login) ?? 0) + 1);
      }
    }
  }

  const topN = (map, key, n = 8) =>
    [...map.entries()]
      .map(([k, v]) => (typeof v === "number" ? { [key]: k, count: v } : v))
      .sort((a, b) => (b.count ?? b.opened) - (a.count ?? a.opened))
      .slice(0, n);

  /** Scalar metrics only — the shape both a window and its prev period share. */
  function summarize(a) {
    const merge = a.mergeHours.sort((x, y) => x - y);
    const review = a.reviewHours.sort((x, y) => x - y);
    const reviewerTotal = [...a.reviewers.values()].reduce((n, v) => n + v, 0);
    const top5 = [...a.reviewers.values()]
      .sort((x, y) => y - x)
      .slice(0, 5)
      .reduce((n, v) => n + v, 0);

    return {
      opened: a.opened,
      merged: a.merged,
      closed: a.closed,
      activeAuthors: a.authors.size,
      activeReviewers: a.reviewers.size,
      activeRepos: a.repos.size,
      newContributors: a.newContributors,
      approvals: reviewerTotal,
      // Of everything that reached a terminal state in this period, what
      // fraction landed? Ignores still-open PRs, which have no outcome yet.
      mergeRate: a.merged + a.closed ? a.merged / (a.merged + a.closed) : null,
      // Merged without a single human approval — the number an admin
      // probably wants to see trending down.
      approvedShare: a.merged ? a.mergedWithApproval / a.merged : null,
      unapprovedMerges: a.merged - a.mergedWithApproval,
      reviewConcentration: reviewerTotal ? top5 / reviewerTotal : null,
      medianMergeHours: round1(pct(merge, 50)),
      p90MergeHours: round1(pct(merge, 90)),
      medianFirstReviewHours: round1(pct(review, 50)),
    };
  }

  const byWindow = Object.fromEntries(
    WINDOWS.map((w) => {
      const a = win[w.id];
      return [
        w.id,
        {
          ...summarize(a),
          topRepos: topN(a.repos, "repo"),
          topAuthors: topN(a.authors, "login"),
          topReviewers: topN(a.reviewers, "login"),
          // Equal-length period immediately before this one. Null for all-time.
          prev: w.days == null ? null : summarize(win[`prev:${w.id}`]),
          prevLabel: w.days == null ? null : `previous ${w.label.toLowerCase()}`,
        },
      ];
    })
  );

  const backlogCounts = BACKLOG_BUCKETS.map((b) => ({ label: b.label, count: 0 }));
  for (const pr of openPRs) {
    const i = BACKLOG_BUCKETS.findIndex((b) => pr.ageDays < b.max);
    backlogCounts[i === -1 ? BACKLOG_BUCKETS.length - 1 : i].count++;
  }

  const series = (map) =>
    [...map.values()].map(finishBucket).sort((a, b) => a.b.localeCompare(b.b));

  return {
    windows: WINDOWS,
    totals: {
      ...totals,
      contributors: firstSeen.size,
      repos: repos.size,
      firstPR: [...firstSeen.values()].sort()[0] ?? null,
    },
    series: { week: series(weeks), month: series(months) },
    byWindow,
    backlog: {
      total: openPRs.length,
      unreviewed: openPRs.filter((p) => !p.reviewed).length,
      buckets: backlogCounts,
      oldest: openPRs.sort((a, b) => b.ageDays - a.ageDays).slice(0, 25),
    },
    heatmap: heat,
  };
}
