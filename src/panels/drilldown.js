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
 * Size is the design constraint throughout. 1,200 contributors x 5 windows x a
 * top-N list each is millions of small objects, so the top-N lists are emitted
 * at the granularity where they earn their bytes:
 *
 *   repos        295 subjects  -> top authors/reviewers for every window
 *   contributors 1,200 subjects -> top repos for 1-year and all-time only
 *
 * The frontend picks the closer of the two for whatever window is selected and
 * says which one it's showing, rather than silently mislabelling it.
 */

import { readStore } from "../ingest/pullRequests.js";
import { BOT_PATTERN } from "../config.js";
import { WINDOWS } from "./contributors.js";
import { BACKLOG_BUCKETS } from "./analytics.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** How much history the per-subject charts carry. */
const SERIES_MONTHS = 24;

/** Cap on every ranked list. Enough to be interesting, small enough to ship. */
const TOP_N = 10;

/** The two windows contributors get repo breakdowns for. See the header. */
const CONTRIBUTOR_REPO_WINDOWS = ["y1", "all"];

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
  };
}

function summarize(a) {
  const merge = a.mergeHours.sort((x, y) => x - y);
  const review = a.reviewHours.sort((x, y) => x - y);
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
  };
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
    _counts: new Map(), // windowed ranked lists, keyed `${windowId}\n${name}`
    _partners: new Map(), // contributor only: reviewedBy / reviewsFor
    open: [],
  };
}

const bumpMap = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by);

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

    const repo = repository(pr.repo);
    repo.total++;
    touch(repo, pr.createdAt);

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
          if (CONTRIBUTOR_REPO_WINDOWS.includes(id))
            bumpMap(author._counts, `${id}\n${pr.repo}`);
          if (reviewHours != null) aw.reviewHours.push(reviewHours);
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

    /* ---- open backlog ---- */
    if (pr.state === "OPEN" && !pr.mergedAt) {
      const entry = {
        number: pr.number,
        ageDays: Math.floor((now - created) / DAY),
        staleDays: pr.updatedAt
          ? Math.floor((now - new Date(pr.updatedAt)) / DAY)
          : null,
        reviewed: fr != null,
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
      buckets,
      oldest: [...open].sort((a, b) => b.ageDays - a.ageDays).slice(0, 25),
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
      // Keyed by window id so the frontend can say which slice it's showing.
      topRepos: Object.fromEntries(
        CONTRIBUTOR_REPO_WINDOWS.map((id) => [id, rankedFor(s._counts, id, "repo")])
      ),
      reviewedBy: partners("by"),
      reviewsFor: partners("for"),
      backlog: backlogOf(s.open),
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
