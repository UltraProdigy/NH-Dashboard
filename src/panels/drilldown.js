/**
 * Per-entity drilldown data: one record per contributor, one per repo.
 *
 * The other panels answer "how is the org doing". This one answers "how is
 * *this* person doing" and "how is *this* repo doing" — same questions, pivoted
 * onto a single subject. Like contributors and analytics it's pure local
 * computation over the ingest store, so adding a subject costs nothing at
 * build time and every time window is equally cheap.
 *
 * Output goes to its own file rather than into dashboard.json. It's several
 * megabytes and only two of the five pages ever need it, so the frontend
 * fetches it lazily on first visit and the pages people actually live on stay
 * as fast as they are today.
 *
 * Ranked lists are emitted in full rather than truncated. That was measured,
 * not assumed: capping at 10 gave 2.54 MB, capping at 100 gave 3.11 MB, and
 * uncapped gives 3.18 MB — 0.36 MB over the wire once Pages gzips it. The
 * distributions are steep (median repo has 10 distinct authors, p90 has 45),
 * so the cap was only ever truncating the handful of subjects where the long
 * tail is the interesting part.
 *
 * Contributor repo breakdowns are still per-window like everything else; the
 * earlier two-window compromise existed to bound exactly the cost that turned
 * out not to matter.
 */

import { readStore } from "../ingest/pullRequests.js";
import { BOT_PATTERN } from "../config.js";
import { WINDOWS } from "./contributors.js";
import { BACKLOG_BUCKETS } from "./analytics.js";
import { grossingLists, hasEngagement } from "./grossing.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;

/**
 * Upper bound on how much history the per-subject charts carry.
 *
 * The one time control now drives the charts as well as the numbers, so a
 * 5-year or all-time selection has to have buckets behind it. This is only a
 * ceiling: finishSeries trims each subject to its own first month, so someone
 * who started last year still gets a dozen buckets rather than a decade of
 * leading zeroes.
 */
const SERIES_MONTHS = 240;

/**
 * Ranked lists are uncapped — see the header for the measurements. Kept as a
 * named constant so there's an obvious lever if the org grows enough to change
 * the arithmetic.
 */
const TOP_N = Infinity;

const isBot = (login) => !login || BOT_PATTERN.test(login);

const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

/**
 * Ratios are rendered as whole percentages, so full float precision is 15
 * characters of noise per value. Across ~7,400 window records that alone was
 * most of a megabyte.
 */
const round3 = (n) => (n == null ? null : Math.round(n * 1000) / 1000);

const monthKey = (d) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

/** Nearest-rank percentile over a pre-sorted array. */
function pct(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** First review by anyone other than the author — what the author waits on. */
function firstReviewAt(pr) {
  let best = null;
  for (const r of pr.reviews ?? []) {
    if (!r.submittedAt || isBot(r.author) || r.author === pr.author) continue;
    if (!best || r.submittedAt < best) best = r.submittedAt;
  }
  return best;
}

/**
 * One approval per reviewer per PR, dated to their earliest. Re-approving after
 * a round of changes is one act of review, not two, and counting it twice would
 * quietly reward churn.
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

/* ==========================================================================
   Per-window accumulator

   Deliberately the same shape for both subject types: a repo and a person are
   both "a thing PRs happen to", and keeping one shape means one summarize(),
   one set of KPI tiles, and no chance of the two drifting apart.
   ========================================================================== */

function blankWindow() {
  return {
    opened: 0,
    merged: 0,
    closed: 0,
    approvals: 0,
    mergedWithApproval: 0,
    mergeHours: [],
    reviewHours: [],
    people: new Set(), // repo: authors who opened here. contributor: repos touched.
    reviewers: new Set(),
    // Diff size and effort, summed over PRs *opened* in the window. Attributing
    // them to the open date rather than the merge date keeps them on the same
    // clock as `opened`, so "lines per PR" divides two numbers that describe
    // the same set of PRs.
    additions: 0,
    deletions: 0,
    filesChanged: 0,
    commits: 0,
    comments: 0,
    // Lines changed per PR, for a median. The mean is useless here — one
    // regenerated lang file drags it past every real number in the list.
    sizes: [],
  };
}

function summarize(a) {
  const merge = a.mergeHours.sort((x, y) => x - y);
  const review = a.reviewHours.sort((x, y) => x - y);
  const sizes = a.sizes.sort((x, y) => x - y);
  return {
    opened: a.opened,
    merged: a.merged,
    closed: a.closed,
    approvals: a.approvals,
    // Of everything that reached a terminal state, what fraction landed?
    // Still-open PRs have no outcome yet and are excluded rather than counted
    // as failures.
    mergeRate: round3(a.merged + a.closed ? a.merged / (a.merged + a.closed) : null),
    approvedShare: round3(a.merged ? a.mergedWithApproval / a.merged : null),
    unapprovedMerges: a.merged - a.mergedWithApproval,
    medianMergeHours: round1(pct(merge, 50)),
    p90MergeHours: round1(pct(merge, 90)),
    medianFirstReviewHours: round1(pct(review, 50)),
    people: a.people.size,
    reviewers: a.reviewers.size,
    additions: a.additions,
    deletions: a.deletions,
    filesChanged: a.filesChanged,
    commits: a.commits,
    comments: a.comments,
    // Null rather than 0 when no PR in the window carries diff data — that's
    // "the ingest hasn't backfilled yet", which must not render as "nobody
    // wrote any code".
    medianPRLines: sizes.length ? pct(sizes, 50) : null,
    p90PRLines: sizes.length ? pct(sizes, 90) : null,
    sizedPRs: sizes.length,
  };
}

/**
 * Pack a contributor's resolved PRs into `{ repos, rows }`.
 *
 * 25,660 of these across the org, so the naive `{repo, number, at, merged}`
 * object costs about 1.9 MB in repeated key names and repeated repo strings —
 * more than every other contributor field combined. Rows become positional
 * arrays and the repo name is replaced by an index into a per-contributor
 * list, which is short because people work in a handful of repos even when
 * they have hundreds of PRs.
 *
 * Sorted newest-first here so the frontend doesn't re-sort on every render to
 * get back to the tab's default order.
 *
 * Diff size, commit and comment counts ride along on the same rows rather than
 * living in a separate "biggest PRs" list. A precomputed top-15 per contributor
 * would have been barely smaller (17,835 rows against 25,660) and could only
 * ever answer one question; carrying the numbers here means Biggest PRs, the
 * Closed PRs table and the merged/dropped toggle all read the same array and
 * every one of them follows the period control for free.
 *
 * `null`, not `0`, for records the ingest hasn't backfilled yet — "we haven't
 * asked" and "this PR changed nothing" have to render differently.
 */
export const RESOLVED_FIELDS =
  ["repo", "number", "at", "merged", "additions", "deletions", "commits", "comments", "title"];

const orNull = (v) => (typeof v === "number" ? v : null);

function packResolved(list) {
  const repos = [];
  const seen = new Map();
  const rows = list
    .sort((a, b) => b.at.localeCompare(a.at))
    .map((r) => {
      let i = seen.get(r.repo);
      if (i === undefined) {
        i = repos.length;
        seen.set(r.repo, i);
        repos.push(r.repo);
      }
      return [
        i, r.number, r.at, r.merged ? 1 : 0,
        orNull(r.additions), orNull(r.deletions),
        orNull(r.commits), orNull(r.comments),
        r.title ?? "",
      ];
    });
  return { repos, rows };
}

/** Ranked list from a login/name -> count map. */
const topN = (map, key, n = TOP_N) =>
  [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, count]) => ({ [key]: k, count }));


/* ==========================================================================
   Subject scaffolding
   ========================================================================== */

function blankSubject(id, idKey) {
  return {
    [idKey]: id,
    first: null,
    last: null,
    total: 0,
    _w: Object.fromEntries(WINDOWS.map((w) => [w.id, blankWindow()])),
    _months: new Map(),
    // Windowed ranked lists, keyed `${windowId}\n${kind}\n${name}`. The kind
    // segment is what lets one map carry several independent rankings — a
    // repo's authors and reviewers, a contributor's authored and reviewed
    // repos — without a second Map per subject.
    _counts: new Map(),
    _partners: new Map(), // contributor only: reviewedBy / reviewsFor
    _gross: [],   // repo only: PRs that drew comments or reactions
    open: [],
    resolved: [], // contributor only: their merged and closed-unmerged PRs
  };
}

const bumpMap = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by);

/**
 * Fold one PR's diff size and effort into a window accumulator.
 *
 * `lines` is null on records the ingest hasn't backfilled, and those are
 * skipped entirely rather than added as zeroes — a half-backfilled store
 * should report a smaller sample, not a smaller codebase.
 */
function addSize(w, pr, lines) {
  w.comments += pr.comments ?? 0;
  if (lines == null) return;
  w.additions += pr.additions;
  w.deletions += pr.deletions;
  w.filesChanged += pr.changedFiles ?? 0;
  w.commits += pr.commits ?? 0;
  w.sizes.push(lines);
}

function monthBucket(subject, key, field, by = 1) {
  let b = subject._months.get(key);
  if (!b) {
    b = { b: key, opened: 0, merged: 0, closed: 0, approvals: 0, _people: new Set() };
    subject._months.set(key, b);
  }
  b[field] += by;
  return b;
}

/**
 * Trim to the last N months, filling gaps so charts don't lie about pauses.
 *
 * Emitted as `{ from, v: [[opened, merged, closed, approvals, people], …] }`
 * rather than an array of named objects, with quiet months as `null`. Most of
 * the 1,189 contributors are inactive in any given month, and repeating six key
 * names 24 times each cost more than every other field combined. The frontend
 * rehydrates this back into the named shape the chart helpers expect — a loop
 * over ~28k numbers, which is nothing.
 */
export const SERIES_FIELDS = ["opened", "merged", "closed", "approvals", "people"];

function finishSeries(months, oldestKey) {
  const now = new Date();
  const v = [];
  let from = null;

  for (let i = SERIES_MONTHS - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = monthKey(d);
    // Don't invent empty months before the subject existed — a repo created
    // last March shouldn't show a year of flat zeroes leading up to it.
    if (oldestKey && key < oldestKey.slice(0, 7)) continue;
    if (!from) from = key;

    const b = months.get(key);
    const row = b
      ? [b.opened, b.merged, b.closed, b.approvals, b._people.size]
      : null;
    // A month the subject existed through but did nothing in is still a real
    // zero, not a gap — null here means "no record", and rehydrates to zeroes.
    v.push(row && row.some(Boolean) ? row : null);
  }

  return { from, v };
}

/** Pull the ranked lists for one window back out of the flat count map. */
function rankedFor(counts, windowId, key) {
  const prefix = `${windowId}\n`;
  const slice = new Map();
  for (const [k, v] of counts) {
    if (k.startsWith(prefix)) slice.set(k.slice(prefix.length), v);
  }
  return topN(slice, key);
}

/* ==========================================================================
   Main
   ========================================================================== */

export async function drilldown() {
  const prs = await readStore();

  if (!prs.length) {
    throw new Error(
      "No ingested data. Run `npm run ingest` first — the all-time backfill " +
        "takes a while, but later runs are incremental."
    );
  }

  const now = Date.now();

  // Precomputed window bounds. Recomputing `now - days * DAY` inside the PR
  // loop would be 28k x 5 pointless subtractions.
  const bounds = WINDOWS.map((w) => ({
    id: w.id,
    from: w.days == null ? -Infinity : now - w.days * DAY,
  }));
  const inWindow = (from, ts) => ts != null && new Date(ts).getTime() >= from;

  const contributors = new Map();
  const repos = new Map();

  const person = (login) => {
    if (!contributors.has(login))
      contributors.set(login, blankSubject(login, "login"));
    return contributors.get(login);
  };
  const repository = (name) => {
    if (!repos.has(name)) repos.set(name, blankSubject(name, "repo"));
    return repos.get(name);
  };

  const touch = (s, when) => {
    if (!when) return;
    if (!s.first || when < s.first) s.first = when;
    if (!s.last || when > s.last) s.last = when;
  };

  for (const pr of prs) {
    if (!pr.createdAt) continue;

    const created = new Date(pr.createdAt);
    const cKey = monthKey(created);
    const authorIsBot = isBot(pr.author);

    const mergeHours = pr.mergedAt ? (new Date(pr.mergedAt) - created) / HOUR : null;
    const fr = firstReviewAt(pr);
    const reviewHours = fr ? (new Date(fr) - created) / HOUR : null;
    const approvers = approversOf(pr);
    const closedUnmerged = !pr.mergedAt && pr.state === "CLOSED";
    const endedAt = pr.mergedAt ?? (closedUnmerged ? pr.updatedAt : null);

    // Absent on records ingested before diff data was queried. Kept as null so
    // the window rollups can tell "no data yet" from a genuinely empty PR.
    const sized = typeof pr.additions === "number";
    const lines = sized ? pr.additions + pr.deletions : null;

    const repo = repository(pr.repo);
    repo.total++;
    touch(repo, pr.createdAt);
    if (hasEngagement(pr)) {
      repo._gross.push({
        number: pr.number,
        title: pr.title ?? "",
        author: authorIsBot ? null : pr.author,
        comments: pr.comments ?? 0,
        thumbsUp: pr.thumbsUp ?? 0,
        thumbsDown: pr.thumbsDown ?? 0,
      });
    }

    const author = authorIsBot ? null : person(pr.author);
    if (author) {
      author.total++;
      touch(author, pr.createdAt);
    }

    /* ---- monthly series ---- */
    const repoMonth = monthBucket(repo, cKey, "opened");
    if (!authorIsBot) repoMonth._people.add(pr.author);
    if (author) monthBucket(author, cKey, "opened")._people.add(pr.repo);
    if (endedAt) {
      const eKey = monthKey(new Date(endedAt));
      const field = pr.mergedAt ? "merged" : "closed";
      monthBucket(repo, eKey, field);
      if (author) monthBucket(author, eKey, field);
    }

    /* ---- windowed rollups ---- */
    for (const { id, from } of bounds) {
      const openedIn = inWindow(from, pr.createdAt);
      const mergedIn = inWindow(from, pr.mergedAt);
      const closedIn = closedUnmerged && inWindow(from, pr.updatedAt);

      const rw = repo._w[id];
      if (openedIn) {
        rw.opened++;
        if (!authorIsBot) {
          rw.people.add(pr.author);
          bumpMap(repo._counts, `${id}\nauthor\n${pr.author}`);
        }
        if (reviewHours != null) rw.reviewHours.push(reviewHours);
        addSize(rw, pr, lines);
      }
      if (mergedIn) {
        rw.merged++;
        if (approvers.size) rw.mergedWithApproval++;
        if (mergeHours != null) rw.mergeHours.push(mergeHours);
      }
      if (closedIn) rw.closed++;

      if (author) {
        const aw = author._w[id];
        if (openedIn) {
          aw.opened++;
          aw.people.add(pr.repo);
          bumpMap(author._counts, `${id}\nopened\n${pr.repo}`);
          if (reviewHours != null) aw.reviewHours.push(reviewHours);
          addSize(aw, pr, lines);
        }
        if (mergedIn) {
          aw.merged++;
          if (approvers.size) aw.mergedWithApproval++;
          if (mergeHours != null) aw.mergeHours.push(mergeHours);
        }
        if (closedIn) aw.closed++;
      }

      /* ---- approvals, credited to the reviewer at the time they gave it ---- */
      for (const [login, at] of approvers) {
        if (!inWindow(from, at)) continue;
        rw.approvals++;
        rw.reviewers.add(login);
        bumpMap(repo._counts, `${id}\nreviewer\n${login}`);

        const rev = person(login);
        rev._w[id].approvals++;
        // Where this person's reviewing effort goes. Counted per repo the same
        // way their authoring is, so the two lists on the Repos card answer the
        // same question about the same period.
        bumpMap(rev._counts, `${id}\nreviewed\n${pr.repo}`);
        // For a person this set means "authors I reviewed for", so a bot's PRs
        // shouldn't inflate it the way they don't inflate anything else.
        if (!authorIsBot) rev._w[id].reviewers.add(pr.author);
      }
    }

    /* ---- approval bookkeeping outside the window loop ---- */
    for (const [login, at] of approvers) {
      const rev = person(login);
      touch(rev, at);
      monthBucket(rev, monthKey(new Date(at)), "approvals");
      // Who this person reviews for, and who reviews this person. All-time:
      // it's a relationship, and slicing it by window mostly produces noise.
      if (!authorIsBot && pr.author !== login) {
        bumpMap(rev._partners, `for\n${pr.author}`);
        if (author) bumpMap(author._partners, `by\n${login}`);
      }
    }

    /* ---- resolved PRs, for the contributor's Closed PRs tab ----
       Dated by the event that ended them, and stored as a plain date: the list
       is sorted by recency and rendered as "3 days ago", so the time of day is
       28,000 records' worth of bytes nobody reads. */
    if (author && endedAt) {
      author.resolved.push({
        repo: pr.repo,
        number: pr.number,
        at: endedAt.slice(0, 10),
        merged: !!pr.mergedAt,
        title: pr.title,
        additions: pr.additions,
        deletions: pr.deletions,
        commits: pr.commits,
        comments: pr.comments,
      });
    }

    /* ---- open backlog ---- */
    if (pr.state === "OPEN" && !pr.mergedAt) {
      const entry = {
        number: pr.number,
        title: pr.title ?? "",
        // Same fields the resolved rows carry, so Biggest PRs can concatenate
        // the two lists without special-casing which half a row came from.
        additions: orNull(pr.additions),
        deletions: orNull(pr.deletions),
        commits: orNull(pr.commits),
        comments: orNull(pr.comments),
        ageDays: Math.floor((now - created) / DAY),
        staleDays: pr.updatedAt
          ? Math.floor((now - new Date(pr.updatedAt)) / DAY)
          : null,
        reviewed: fr != null,
        // null, not false, for records ingested before isDraft was queried.
        // "not a draft" and "we don't know yet" have to render differently or
        // the column quietly lies until the backfill runs.
        draft: pr.isDraft ?? null,
      };
      repo.open.push({ ...entry, author: pr.author });
      if (author) author.open.push({ ...entry, repo: pr.repo });
    }
  }

  /* ---- flatten ---- */

  /**
   * Windows with nothing in them are omitted rather than emitted as a dozen
   * zeroes. Most contributors did nothing in the last month, and "absent means
   * empty" is both smaller and unambiguous — the frontend substitutes a blank
   * window, which is what a zeroed record would have said anyway.
   */
  const windowsOut = (s) => {
    const out = {};
    for (const w of WINDOWS) {
      const a = s._w[w.id];
      if (!a.opened && !a.merged && !a.closed && !a.approvals) continue;
      out[w.id] = summarize(a);
    }
    return out;
  };

  const backlogOf = (open) => {
    const buckets = BACKLOG_BUCKETS.map((b) => ({ label: b.label, count: 0 }));
    for (const pr of open) {
      const i = BACKLOG_BUCKETS.findIndex((b) => pr.ageDays < b.max);
      buckets[i === -1 ? BACKLOG_BUCKETS.length - 1 : i].count++;
    }
    return {
      total: open.length,
      unreviewed: open.filter((p) => !p.reviewed).length,
      drafts: open.filter((p) => p.draft === true).length,
      // Distinguishes "no drafts" from "haven't ingested draft status yet".
      draftsKnown: open.every((p) => p.draft !== null),
      buckets,
      // Full list, sorted oldest first. It's bounded by the repo's open PR
      // count, and truncating it made the Backlog tab's own filter lie.
      oldest: [...open].sort((a, b) => b.ageDays - a.ageDays),
    };
  };

  const contributorsOut = {};
  for (const [login, s] of contributors) {
    const partners = (kind) => {
      const slice = new Map();
      for (const [k, v] of s._partners) {
        if (k.startsWith(`${kind}\n`)) slice.set(k.slice(kind.length + 1), v);
      }
      return topN(slice, "login");
    };

    contributorsOut[login] = {
      login,
      first: s.first,
      last: s.last,
      totalPRs: s.total,
      windows: windowsOut(s),
      series: finishSeries(s._months, s.first),
      topRepos: Object.fromEntries(
        WINDOWS.map((w) => [w.id, rankedFor(s._counts, `${w.id}\nopened`, "repo")])
      ),
      reviewRepos: Object.fromEntries(
        WINDOWS.map((w) => [w.id, rankedFor(s._counts, `${w.id}\nreviewed`, "repo")])
      ),
      reviewedBy: partners("by"),
      reviewsFor: partners("for"),
      backlog: backlogOf(s.open),
      resolved: packResolved(s.resolved),
    };
  }

  const reposOut = {};
  for (const [name, s] of repos) {
    reposOut[name] = {
      repo: name,
      first: s.first,
      last: s.last,
      totalPRs: s.total,
      windows: windowsOut(s),
      series: finishSeries(s._months, s.first),
      topAuthors: Object.fromEntries(
        WINDOWS.map((w) => [
          w.id,
          rankedFor(s._counts, `${w.id}\nauthor`, "login"),
        ])
      ),
      topReviewers: Object.fromEntries(
        WINDOWS.map((w) => [
          w.id,
          rankedFor(s._counts, `${w.id}\nreviewer`, "login"),
        ])
      ),
      grossing: grossingLists(s._gross),
      backlog: backlogOf(s.open),
    };
  }

  /**
   * Search index. Separated from the records so typing in the combobox filters
   * a 1,500-entry array of four-key objects rather than walking the full
   * multi-megabyte structure on every keystroke.
   */
  const index = {
    contributors: [...contributors.values()]
      .map((s) => ({
        id: s.login,
        n: s.total,
        a: s._w.all.approvals,
        last: s.last,
      }))
      .sort((a, b) => b.n + b.a - (a.n + a.a)),
    repos: [...repos.values()]
      .map((s) => ({ id: s.repo, n: s.total, open: s.open.length, last: s.last }))
      .sort((a, b) => b.n - a.n),
  };

  return {
    windows: WINDOWS,
    seriesFields: SERIES_FIELDS,
    resolvedFields: RESOLVED_FIELDS,
    generatedAt: new Date().toISOString(),
    index,
    contributors: contributorsOut,
    repos: reposOut,
  };
}

/**
 * Serialize the payload with one entity per line.
 *
 * `JSON.stringify(x, null, 2)` would roughly double the biggest file we ship.
 * The fully-compact form is a single multi-megabyte line, which no editor,
 * pager or `grep` handles gracefully when you want to look at one subject. One
 * line per contributor and per repo costs about 2% over compact and makes the
 * file greppable: `grep '^"Dream-Master"' data/drilldown.json`.
 *
 * (The file is gitignored, so diff readability isn't the motivation — being
 * able to inspect it by hand is.)
 */
export function serializeDrilldown(d) {
  const { contributors, repos, ...head } = d;
  const pairs = (obj) =>
    Object.entries(obj)
      .map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`)
      .join(",\n");

  return (
    "{\n" +
    pairs(head) +
    ',\n"contributors":{\n' +
    pairs(contributors) +
    '\n},\n"repos":{\n' +
    pairs(repos) +
    "\n}\n}\n"
  );
}
