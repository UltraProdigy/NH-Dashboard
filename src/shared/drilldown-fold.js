/**
 * The drilldown fold: every subject's record, computed from rows in memory.
 *
 * Here rather than in `panels/drilldown.js` because the Worker has to be able
 * to import it. Every module the Worker reaches lives under `src/shared`, and
 * the panel's own import graph pulls in `node:fs` twice over through the two
 * ingest stores — so the fold moved and the store reads stayed behind. Nothing
 * in this file touches a store, a token or a clock it was not handed.
 *
 * That split is what makes the per-subject payloads possible at all. The build
 * folds the whole store; the Worker folds one subject's rows through the same
 * code, so the two agree structurally rather than because a test says they do.
 * See `subjectRows` at the bottom for what "one subject's rows" means, and
 * `handoff.md` for why materialising all 7,047 of them in the recompute is not
 * merely expensive but impossible.
 *
 * The design notes that were in the panel header and describe the *shape* of
 * the output — the packing, the interning, the slim records — are still there,
 * because they are about the file that gets written rather than about the fold.
 */

import { isBot, WINDOWS } from "./contributor-rules.js";
import { ISSUE_STALE_DAYS } from "./issue-rules.js";
import {
  ASSIGNED_FIELDS,
  CLOSED_FIELDS,
  FILED_FIELDS,
  ISSUE_OUTCOMES,
  ISSUE_SERIES_FIELDS,
  ISSUE_WINDOW_FIELDS,
  PR_OUTCOMES,
  RESOLVED_FIELDS,
  REVIEW_FIELDS,
  REVIEW_STATES,
  SERIES_FIELDS,
  byAge,
  byCount,
  byInvolvement,
  byRecency,
} from "./drilldown-rules.js";
import { BACKLOG_BUCKETS, monthKey, pct, round1 } from "./analytics-rules.js";
import { grossingLists, hasEngagement } from "../panels/grossing.js";
import {
  blankPersonPeriod,
  blankTrackerPeriod,
  closerOf,
  closerUnknown,
  fixerOf,
  foldPerson,
  foldTracker,
  isUnanswered,
  summarizePersonPeriod,
  summarizeTrackerPeriod,
} from "../panels/issueMetrics.js";

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

/**
 * Issue-side ranked lists *are* capped, because the distribution is nothing
 * like the PR one. The median repo has ten distinct PR authors; the modpack has
 * 5,086 distinct issue reporters, nearly all of them one bug each. Uncapped,
 * that single repo's reporter lists were 400 KB of people who filed one thing
 * in 2019 — and no reader scrolls to rank 3,000.
 */
const ISSUE_TOP_N = 200;


/**
 * Ratios are rendered as whole percentages, so full float precision is 15
 * characters of noise per value. Across ~7,400 window records that alone was
 * most of a megabyte.
 */
const round3 = (n) => (n == null ? null : Math.round(n * 1000) / 1000);


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
 * The last thing each reviewer said on a PR, and when.
 *
 * approversOf next door takes the *earliest* approval because it's counting an
 * act that happened. This is answering a different question — "where does this
 * review stand" — and there the newest verdict is the only one that's still
 * true: someone who requested changes and then approved is not blocking
 * anything, and the reverse very much is.
 */
function latestReviewsOf(pr) {
  const out = new Map();
  for (const r of pr.reviews ?? []) {
    if (!r.submittedAt || isBot(r.author) || r.author === pr.author) continue;
    const prev = out.get(r.author);
    if (!prev || r.submittedAt > prev.at) out.set(r.author, { at: r.submittedAt, state: r.state });
  }
  return out;
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

const orNull = (v) => (typeof v === "number" ? v : null);

function packResolved(list) {
  const repos = [];
  const seen = new Map();
  const rows = list
    .sort(byRecency((r) => r.at))
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
        // Appended for the merged Pull requests card, which shows resolved and
        // open PRs in one table and needs both halves to be able to say how
        // old they are. Open rows have carried ageDays since the backlog
        // existed; this is the resolved half catching up.
        r.ageDays,
        // Indexes into the payload's label table, or null. Null also covers
        // "this record predates the ingest asking for labels", which is every
        // record until the backfill has run — see prFieldCoverage.labels.
        r.labels ?? null,
      ];
    });
  return { repos, rows };
}

/**
 * Ranked list from a login/name -> count map.
 *
 * Mapped to objects before sorting rather than after, because the comparator is
 * shared with the SQL side and reads the shape the list actually ships in. The
 * slice happens last: a tail cut before the tiebreak is a cut on the wrong
 * order.
 */
const topN = (map, key, n = TOP_N) =>
  [...map.entries()]
    .map(([k, count]) => ({ [key]: k, count }))
    .sort(byCount(key))
    .slice(0, n);

/**
 * The window-keyed ranked lists, with empty windows left out.
 *
 * Every one of these maps used to carry all seven windows whether or not the
 * subject did anything in them, and there are now thousands of subjects who did
 * something once in 2019 — seven keys and six empty arrays each, repeated
 * across nine maps per subject, was megabytes of punctuation. The frontend
 * already reads these as `map[window] ?? []`, so absent and empty are the same
 * statement to it.
 */
const rankedWindows = (counts, kind, key, n = TOP_N) => {
  const out = {};
  for (const w of WINDOWS) {
    const rows = rankedFor(counts, `${w.id}\n${kind}`, key, n);
    if (rows.length) out[w.id] = rows;
  }
  return out;
};


/* ==========================================================================
   Subject scaffolding
   ========================================================================== */

function blankSubject(id, idKey, kind) {
  return {
    [idKey]: id,
    kind,
    first: null,
    last: null,
    total: 0,
    _w: Object.fromEntries(WINDOWS.map((w) => [w.id, blankWindow()])),
    _months: new Map(),
    // Issue accumulators, in the shape that suits the subject: a repo is a
    // tracker things happen to, a person is somebody doing things to trackers.
    _iw: Object.fromEntries(
      WINDOWS.map((w) => [
        w.id,
        kind === "repo" ? blankTrackerPeriod() : blankPersonPeriod(),
      ])
    ),
    _imonths: new Map(),
    _ipartners: new Map(), // contributor only: helped / helped by
    _iopen: [],   // open issues: filed by this person, or living in this repo
    _ifiled: [],  // contributor only: every issue they filed
    _iclosed: [], // contributor only: every issue they closed or fixed
    _itotals: { filed: 0, responses: 0, closed: 0, fixed: 0 },
    // Windowed ranked lists, keyed `${windowId}\n${kind}\n${name}`. The kind
    // segment is what lets one map carry several independent rankings — a
    // repo's authors and reviewers, a contributor's authored and reviewed
    // repos — without a second Map per subject.
    _counts: new Map(),
    _partners: new Map(), // contributor only: reviewedBy / reviewsFor
    _gross: [],   // repo only: PRs that drew comments or reactions
    // Contributor only, and all three about PRs somebody else usually wrote:
    // open PRs awaiting their review, open PRs they've already reviewed, and
    // every PR they were assigned whatever became of it.
    _requested: [],
    _reviewing: [],
    _assigned: [],
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
 * The issue series, as a sparse month map rather than a padded array.
 *
 * The PR series pads because its subjects are people who have opened pull
 * requests, and they tend to have done so across many consecutive months. Issue
 * subjects are dominated by the opposite case — one bug report, once — and for
 * those a `from` plus sixty nulls costs ten times what the data does. The
 * frontend fills the gaps when it draws, which it has to do either way.
 */
function sparseSeries(months, row) {
  if (!months.size) return null;
  const out = {};
  for (const key of [...months.keys()].sort()) {
    const cells = row(months.get(key));
    if (cells.some(Boolean)) out[key] = cells;
  }
  return Object.keys(out).length ? out : null;
}

/** The issue equivalent. `field` is one of the subject's ISSUE_SERIES_FIELDS. */
function issueMonth(subject, key, field, by = 1) {
  let b = subject._imonths.get(key);
  if (!b) {
    b = { b: key, filed: 0, opened: 0, closed: 0, responses: 0, fixed: 0, _people: new Set() };
    subject._imonths.set(key, b);
  }
  if (field) b[field] += by;
  return b;
}

/**
 * Pack a list of rows against a field list, interning the repo name.
 *
 * Same reasoning as packResolved next door: there are 26,000 issues in the
 * store and a person's log of them repeats one of a handful of repo names on
 * every row. Positional rows against an exported field list, newest first, so
 * the frontend renders in the tab's default order without re-sorting.
 *
 * `sortBy` exists for the assignment log, whose `at` is a resolution date and
 * so is null on everything still open. Descending on the empty string puts
 * those first, which is the order that list wants anyway.
 */
function packRows(list, fields, sortBy = (r) => r.at ?? "") {
  const repos = [];
  const seen = new Map();
  const rows = list
    .sort(byRecency(sortBy))
    .map((r) => {
      let i = seen.get(r.repo);
      if (i === undefined) {
        i = repos.length;
        seen.set(r.repo, i);
        repos.push(r.repo);
      }
      return fields.map((f) => (f === "repo" ? i : r[f] ?? null));
    });
  return { repos, rows };
}

/** Shares are drawn as whole percentages, so full float precision is noise. */
const SHARE = /Share$/;

const packWindow = (kind, s) =>
  ISSUE_WINDOW_FIELDS[kind].map((f) =>
    SHARE.test(f) ? round3(s[f]) : (s[f] ?? null)
  );

const outcomeOf = (i) =>
  i.stateReason === "NOT_PLANNED" ? 1 : i.stateReason === "DUPLICATE" ? 2 : 0;

function finishSeries(months, oldestKey, row, now) {
  // Nothing to chart. Emitted as null rather than 240 nulls in a row: with
  // issue reporters now among the subjects there are thousands of people with
  // no pull request history at all, and an empty chart's worth of padding each
  // was the single largest thing in this file.
  if (!months.size) return null;

  const asOf = new Date(now);
  const v = [];
  let from = null;

  for (let i = SERIES_MONTHS - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - i, 1));
    const key = monthKey(d);
    // Don't invent empty months before the subject existed — a repo created
    // last March shouldn't show a year of flat zeroes leading up to it.
    if (oldestKey && key < oldestKey.slice(0, 7)) continue;
    if (!from) from = key;

    const b = months.get(key);
    const cells = b ? row(b) : null;
    // A month the subject existed through but did nothing in is still a real
    // zero, not a gap — null here means "no record", and rehydrates to zeroes.
    v.push(cells && cells.some(Boolean) ? cells : null);
  }

  return { from, v };
}

/** Pull the ranked lists for one window back out of the flat count map. */
function rankedFor(counts, windowId, key, n = TOP_N) {
  const prefix = `${windowId}\n`;
  const slice = new Map();
  for (const [k, v] of counts) {
    if (k.startsWith(prefix)) slice.set(k.slice(prefix.length), v);
  }
  return topN(slice, key, n);
}

/* ==========================================================================
   Main
   ========================================================================== */

export function foldDrilldown(now, opts = {}) {
  const only = opts.only ?? null;
  const prs = opts.prs ?? [];


  // Precomputed window bounds. Recomputing `now - days * DAY` inside the PR
  // loop would be 28k x 5 pointless subtractions.
  // `to` is only read by the issue folds, which take a period rather than a
  // lower bound — the drilldown has no "previous period" to be the upper one.
  const bounds = WINDOWS.map((w) => ({
    id: w.id,
    from: w.days == null ? -Infinity : now - w.days * DAY,
    to: Infinity,
  }));
  const inWindow = (from, ts) => ts != null && new Date(ts).getTime() >= from;

  /* ---- labels, interned ----------------------------------------------------
     Every row that can carry labels carries indexes into one table at the head
     of the payload instead of the names themselves. There are a few hundred
     distinct labels in the org and tens of thousands of rows to put them on, so
     writing `"Mod: GT"` out each time would be most of the cost of the feature;
     `[3,17]` is six bytes and a row with none is `null`.

     One table for both stores. A PR label and an issue label with the same name
     are the same string as far as this is concerned, and keeping two tables
     would mean the frontend having to know which one a row came from. */
  const labelNames = [];
  const labelIx = new Map();
  const packLabels = (names) => {
    if (!names?.length) return null;
    return names.map((n) => {
      let i = labelIx.get(n);
      if (i === undefined) {
        i = labelNames.length;
        labelIx.set(n, i);
        labelNames.push(n);
      }
      return i;
    });
  };

  const contributors = new Map();
  const repos = new Map();

  /**
   * Scoped to one subject, every other subject's accumulator is this.
   *
   * The fold reaches a subject through fourteen call sites and three of them
   * exist only to put a row in the picker, so narrowing it by skipping calls
   * would mean auditing all fourteen and getting it right — and a missed one is
   * a smaller number rather than an error, which is the failure mode this panel
   * has produced nine times. Instead every call still happens and the writes for
   * everyone else land here and are dropped, so the scoped run and the whole
   * one execute the same statements in the same order.
   *
   * It accumulates garbage, which is why it is only ever handed one subject's
   * rows. On the unscoped build there is no sink at all.
   *
   * One per kind, and not one shared: a person's `_iw` holds person periods and
   * a repo's holds tracker periods, so a repo's writes landing on a person's
   * sink throw on the first `reporters.set`. Which is the good version of that
   * mistake — the same confusion between the two shapes anywhere it is *read*
   * would have produced a number instead.
   */
  const personSink = only ? blankSubject("", "login", "person") : null;
  const repoSink = only ? blankSubject("", "repo", "repo") : null;
  const wantPerson = only?.kind === "contributors" ? (login) => login === only.id : () => !only;
  const wantRepo = only?.kind === "repos" ? (name) => name === only.id : () => !only;

  const person = (login) => {
    if (!wantPerson(login)) return personSink;
    if (!contributors.has(login))
      contributors.set(login, blankSubject(login, "login", "person"));
    return contributors.get(login);
  };
  const repository = (name) => {
    if (!wantRepo(name)) return repoSink;
    if (!repos.has(name)) repos.set(name, blankSubject(name, "repo", "repo"));
    return repos.get(name);
  };

  const touch = (s, when) => {
    if (!when) return;
    if (!s.first || when < s.first) s.first = when;
    if (!s.last || when > s.last) s.last = when;
  };

  /**
   * Distinct days each person did something, for the Active since tile.
   *
   * Computed in its own module and shared with the contributors panel, because
   * the Leaderboard shows the same percentage and the two disagreeing about one
   * person would be worse than neither showing it. It's also a map beside the
   * subjects rather than a Set on each of them: the only complete source of
   * review dates is every review on every PR, and `person()` creates a subject
   * as a side effect, so marking days through it would promote several thousand
   * people whose entire trace is one drive-by review comment into full
   * drilldown subjects. Read here by the subjects that exist for their own
   * reasons; the rest is thrown away.
   *
   * The first of the two things a scoped run cannot derive from the rows it is
   * given: this counts every review on every pull request in the org, so one
   * subject's rows would answer a smaller question with the same shape. The
   * caller supplies it.
   */
  const activeDays = opts.activeDays ?? new Map();

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
    const openNow = pr.state === "OPEN" && !pr.mergedAt;
    const ageDays = Math.floor((now - created) / DAY);
    const staleDays = pr.updatedAt
      ? Math.floor((now - new Date(pr.updatedAt)) / DAY)
      : null;

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
        ageDays,
        labels: packLabels(pr.labels),
      });
    }

    /* ---- open backlog ---- */
    if (openNow) {
      const entry = {
        number: pr.number,
        title: pr.title ?? "",
        // Same fields the resolved rows carry, so Biggest PRs can concatenate
        // the two lists without special-casing which half a row came from.
        additions: orNull(pr.additions),
        deletions: orNull(pr.deletions),
        commits: orNull(pr.commits),
        comments: orNull(pr.comments),
        ageDays,
        staleDays,
        reviewed: fr != null,
        // null, not false, for records ingested before isDraft was queried.
        // "not a draft" and "we don't know yet" have to render differently or
        // the column quietly lies until the backfill runs.
        draft: pr.isDraft ?? null,
        labels: packLabels(pr.labels),
      };
      repo.open.push({ ...entry, author: pr.author });
      if (author) author.open.push({ ...entry, repo: pr.repo });
    }

    /* ---- the review queue ----
       Only while the PR is live. Both halves are things somebody is still
       waiting on, and nobody waits on a merged PR. */
    if (openNow) {
      const queueRow = {
        repo: pr.repo,
        number: pr.number,
        author: authorIsBot ? null : pr.author,
        ageDays,
        staleDays,
        draft: pr.isDraft == null ? null : pr.isDraft ? 1 : 0,
        title: pr.title ?? "",
        labels: packLabels(pr.labels),
      };

      for (const login of pr.reviewRequests ?? []) {
        if (isBot(login)) continue;
        person(login)._requested.push({
          ...queueRow,
          // The PR's own open date. A request has no date of its own in the
          // API, and how long the PR has been sitting there is the number
          // anyone reading this list actually wants.
          at: pr.createdAt.slice(0, 10),
          state: null,
        });
      }

      for (const [login, r] of latestReviewsOf(pr)) {
        person(login)._reviewing.push({
          ...queueRow,
          at: r.at.slice(0, 10),
          state: REVIEW_STATES.indexOf(r.state),
        });
      }
    }

    /* ---- assignments, whatever became of them ---- */
    for (const login of pr.assignees ?? []) {
      if (isBot(login)) continue;
      person(login)._assigned.push({
        repo: pr.repo,
        number: pr.number,
        at: endedAt ? endedAt.slice(0, 10) : null,
        outcome: openNow ? 0 : pr.mergedAt ? 1 : 2,
        author: authorIsBot ? null : pr.author,
        ageDays,
        staleDays,
        // Only meaningful while it's open, and the card only reads it then —
        // but carrying it means an assigned open PR shows the same state as it
        // does on the Pull requests card rather than falling back to "unknown".
        draft: pr.isDraft == null ? null : pr.isDraft ? 1 : 0,
        title: pr.title ?? "",
        labels: packLabels(pr.labels),
      });
    }
  }

  /* ==========================================================================
     Issues

     A second pass over a second store, folded onto the same subjects. Repos
     that only have a tracker and people who only ever triage get created here,
     which is the point: the PR store cannot see them at all.

     Every credit is dated by its own event — filed at creation, answered at the
     reply, closed at the close — so a person's window says what they did during
     it rather than what happened to things they touched once.
     ========================================================================== */

  const issueRecords = opts.issues ?? [];
  const hasIssueData = issueRecords.length > 0;

  /**
   * How much of the store can say who closed an issue.
   *
   * The person-shaped windows can't carry this themselves — "closes nobody was
   * credited for" is a fact about the store, not about a contributor — so it
   * lives at the top of the payload and every card that shows a close count
   * reads it. Without it, a triage board full of zeroes looks like a team that
   * does nothing rather than a store awaiting a re-walk.
   */
  const closerCoverage = { closed: 0, unknown: 0 };

  // Earliest issue per reporter, so a repo can count first-time reporters the
  // same way the org panel does — including the part where "the same way" means
  // matching on `repo#number` rather than on the timestamp. GitHub stamps to the
  // second and two issues filed in the same one would both look like somebody's
  // first. See the note in src/panels/issues.js.
  //
  // The second thing a scoped run cannot derive, and only for a repo: "first
  // ever" is a fact about the org, and a repo's own issues would date each
  // reporter's first to the first one they filed *here*, turning every returning
  // reporter into a new one. A contributor's rows already contain every issue
  // they authored, so theirs is self-sufficient and `foldPerson` never reads it
  // anyway — the flag is only consumed by `foldTracker`.
  const issueId = (i) => `${i.repo}#${i.number}`;
  const firstIssueBy = opts.firstIssueBy ?? new Map();
  if (!opts.firstIssueBy) {
    for (const i of issueRecords) {
      if (isBot(i.author) || !i.createdAt) continue;
      const prev = firstIssueBy.get(i.author);
      const id = issueId(i);
      if (!prev || i.createdAt < prev.at || (i.createdAt === prev.at && id < prev.id))
        firstIssueBy.set(i.author, { at: i.createdAt, id });
    }
  }

  for (const i of issueRecords) {
    if (!i.createdAt) continue;

    const created = new Date(i.createdAt);
    const authorIsBot = isBot(i.author);
    const labels = i.labels ?? [];
    const open = i.state === "OPEN";
    const closeHours = i.closedAt ? (new Date(i.closedAt) - created) / HOUR : null;
    const responseHours = i.firstResponseAt
      ? (new Date(i.firstResponseAt) - created) / HOUR
      : null;
    const closedBy = closerOf(i);
    const fixer = fixerOf(i);
    const staleDays = i.updatedAt
      ? Math.floor((now - new Date(i.updatedAt)) / DAY)
      : null;
    const ctx = {
      open,
      labels,
      closeHours,
      responseHours,
      isFirstEver: !authorIsBot && firstIssueBy.get(i.author)?.id === issueId(i),
      bot: authorIsBot,
      closedBy,
      fixer,
    };

    const cKey = monthKey(created);
    const closedKey = i.closedAt ? monthKey(new Date(i.closedAt)) : null;
    const respKey = i.firstResponseAt ? monthKey(new Date(i.firstResponseAt)) : null;
    const outcome = i.closedAt ? outcomeOf(i) : null;

    if (i.closedAt) {
      closerCoverage.closed++;
      if (closerUnknown(i)) closerCoverage.unknown++;
    }
    const openEntry = {
      number: i.number,
      title: i.title ?? "",
      ageDays: Math.floor((now - created) / DAY),
      staleDays,
      answered: !isUnanswered(i),
      assigned: (i.assignees ?? []).length > 0,
      comments: i.comments ?? 0,
      stale: (staleDays ?? 0) >= ISSUE_STALE_DAYS,
      // Interned, like every other label list in this file. These used to be
      // written out as names on the repo's copy and left off the contributor's
      // altogether, which meant the same open issue had labels on one page and
      // not on the other.
      labels: packLabels(labels),
    };

    /* ---- the tracker ---- */
    const repo = repository(i.repo);
    touch(repo, i.createdAt);
    touch(repo, i.closedAt);
    repo._itotals.filed++;
    if (i.closedAt) repo._itotals.closed++;
    if (i.firstResponseAt) repo._itotals.responses++;

    issueMonth(repo, cKey, "opened");
    if (!authorIsBot) issueMonth(repo, cKey, null)._people.add(i.author);
    if (closedKey) issueMonth(repo, closedKey, "closed");
    if (respKey) issueMonth(repo, respKey, "responses");

    for (const p of bounds) {
      foldTracker(repo._iw[p.id], i, p, ctx);
      if (!authorIsBot && inWindow(p.from, i.createdAt))
        bumpMap(repo._counts, `${p.id}\nireporter\n${i.author}`);
      if (i.firstResponder && !isBot(i.firstResponder) && inWindow(p.from, i.firstResponseAt))
        bumpMap(repo._counts, `${p.id}\niresponder\n${i.firstResponder}`);
      if (closedBy && inWindow(p.from, i.closedAt))
        bumpMap(repo._counts, `${p.id}\nicloser\n${closedBy}`);
      if (fixer && inWindow(p.from, i.closedAt))
        bumpMap(repo._counts, `${p.id}\nifixer\n${fixer}`);
      if (inWindow(p.from, i.createdAt))
        for (const a of i.assignees ?? [])
          if (!isBot(a)) bumpMap(repo._counts, `${p.id}\niassignee\n${a}`);
    }

    if (open) {
      repo._iopen.push({ ...openEntry, author: authorIsBot ? null : i.author });
    }

    /* ---- the people ---- */
    // Everyone who touched it in one of the ways that count. Usually one or two.
    const involved = new Set();
    if (!authorIsBot) involved.add(i.author);
    if (i.firstResponder && !isBot(i.firstResponder)) involved.add(i.firstResponder);
    if (closedBy) involved.add(closedBy);
    if (fixer) involved.add(fixer);
    for (const a of i.assignees ?? []) if (!isBot(a)) involved.add(a);

    for (const login of involved) {
      const s = person(login);
      const mine = i.author === login;
      const answered = i.firstResponder === login;
      const shut = closedBy === login;
      const fixed = fixer === login;

      if (mine) touch(s, i.createdAt);
      if (answered) touch(s, i.firstResponseAt);
      if (shut || fixed) touch(s, i.closedAt);

      for (const p of bounds) foldPerson(s._iw[p.id], i, p, login, ctx);

      if (mine) {
        s._itotals.filed++;
        issueMonth(s, cKey, "filed");
        s._ifiled.push({
          repo: i.repo,
          number: i.number,
          at: i.createdAt.slice(0, 10),
          open: open ? 1 : 0,
          outcome,
          comments: i.comments ?? 0,
          waitDays: responseHours == null ? null : Math.round(responseHours / 24),
          title: i.title ?? "",
          labels: packLabels(labels),
        });
        if (open) s._iopen.push({ ...openEntry, repo: i.repo });
      }

      if (answered) {
        s._itotals.responses++;
        if (respKey) issueMonth(s, respKey, "responses");
      }

      if (shut || fixed) {
        if (shut) s._itotals.closed++;
        if (fixed) s._itotals.fixed++;
        if (closedKey) {
          if (shut) issueMonth(s, closedKey, "closed");
          if (fixed) issueMonth(s, closedKey, "fixed");
        }
        // One row whether they pressed the button, wrote the pull request that
        // did, or both — the row says which, and two rows for one close would
        // double-count the log against the counts beside it.
        s._iclosed.push({
          repo: i.repo,
          number: i.number,
          at: (i.closedAt ?? i.updatedAt ?? i.createdAt).slice(0, 10),
          outcome,
          viaPR: fixed ? 1 : 0,
          own: mine ? 1 : 0,
          title: i.title ?? "",
          labels: packLabels(labels),
        });
      }

      for (const p of bounds) {
        if (mine && inWindow(p.from, i.createdAt))
          bumpMap(s._counts, `${p.id}\nifiled\n${i.repo}`);
        if (answered && inWindow(p.from, i.firstResponseAt))
          bumpMap(s._counts, `${p.id}\niresponded\n${i.repo}`);
        if ((shut || fixed) && inWindow(p.from, i.closedAt))
          bumpMap(s._counts, `${p.id}\niclosed\n${i.repo}`);
      }

      // Who helps whom, all time — a relationship, so slicing it by window
      // mostly produces noise. Answering and closing count as the same kind of
      // help, because from the reporter's side they are.
      if (!mine && !authorIsBot && (answered || shut || fixed)) {
        bumpMap(s._ipartners, `ifor\n${i.author}`);
        bumpMap(person(i.author)._ipartners, `iby\n${login}`);
      }
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

  /**
   * The same omit-the-empty rule for issue windows. `involvement` on a person
   * and `opened + closed` on a tracker cover every way either can be non-empty,
   * so a window that fails both really did contain nothing.
   */
  const issueWindowsOut = (s) => {
    const kind = s.kind === "repo" ? "repos" : "contributors";
    const out = {};
    for (const w of WINDOWS) {
      const a = s._iw[w.id];
      const sum = s.kind === "repo" ? summarizeTrackerPeriod(a) : summarizePersonPeriod(a);
      if (s.kind === "repo") {
        if (!sum.opened && !sum.closed && !sum.responses) continue;
      } else if (!sum.involvement && !sum.assigned) continue;
      out[w.id] = packWindow(kind, sum);
    }
    return out;
  };

  /**
   * The open-issue side of backlogOf. Same buckets as the PR backlog so the two
   * cards on a repo page can be read against each other, plus the three things
   * that make an open issue somebody's job: nobody has answered it, nobody has
   * labelled it, nobody owns it.
   */
  const issueBacklogOf = (open) => {
    // Null, not an object of noughts. Two thirds of the subjects in this file
    // have no open issues, and the bucket labels alone were 220 bytes each.
    if (!open.length) return null;
    const buckets = BACKLOG_BUCKETS.map(() => 0);
    const stale = BACKLOG_BUCKETS.map(() => 0);
    for (const it of open) {
      const a = BACKLOG_BUCKETS.findIndex((b) => it.ageDays < b.max);
      buckets[a === -1 ? BACKLOG_BUCKETS.length - 1 : a]++;
      if (it.staleDays != null) {
        const q = BACKLOG_BUCKETS.findIndex((b) => it.staleDays < b.max);
        stale[q === -1 ? BACKLOG_BUCKETS.length - 1 : q]++;
      }
    }
    return {
      total: open.length,
      unanswered: open.filter((i) => !i.answered).length,
      unlabeled: open.filter((i) => !(i.labels?.length ?? 0)).length,
      unassigned: open.filter((i) => !i.assigned).length,
      stale: open.filter((i) => i.stale).length,
      staleDays: ISSUE_STALE_DAYS,
      buckets,
      staleBuckets: stale,
      // Full list, oldest first — same reasoning as the PR backlog: truncating
      // it makes the tab's own filter lie about what it searched.
      oldest: [...open].sort(byAge),
    };
  };

  // Null when there's nothing open, and bucket counts without their labels —
  // same two economies as the issue backlog beside it, for the same reason:
  // most subjects in this file have an empty one and were each paying 220 bytes
  // to say so. The frontend's `backlogOf` accessor puts the labels back.
  const backlogOf = (open) => {
    if (!open.length) return null;
    const buckets = BACKLOG_BUCKETS.map(() => 0);
    for (const pr of open) {
      const i = BACKLOG_BUCKETS.findIndex((b) => pr.ageDays < b.max);
      buckets[i === -1 ? BACKLOG_BUCKETS.length - 1 : i]++;
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
      oldest: [...open].sort(byAge),
    };
  };

  const prRow = (b) => [b.opened, b.merged, b.closed, b.approvals, b._people.size];
  const contribIssueRow = (b) => [b.filed, b.closed, b.responses, b.fixed];
  const repoIssueRow = (b) => [b.opened, b.closed, b.responses, b._people.size];

  /**
   * The subject's own first month, so a padded series starts where they do.
   * Read from the buckets rather than from `first`, which now takes issue dates
   * into account as well and would prepend years of empty PR months to anyone
   * who filed a bug before they wrote one.
   */
  const firstMonth = (months) => [...months.keys()].sort()[0] ?? null;

  const partnersOf = (map, kind, n = TOP_N) => {
    const slice = new Map();
    for (const [k, v] of map) {
      if (k.startsWith(`${kind}\n`)) slice.set(k.slice(kind.length + 1), v);
    }
    return topN(slice, "login", n);
  };

  /**
   * Does this person warrant a full record?
   *
   * Folding the issue store in took the subject count from 1,200 to 6,700,
   * because five and a half thousand people have filed one bug report and done
   * nothing else. They are still counted in every aggregate — a repo's reporter
   * list, the org's tables — and they still get a page, because a ranked list
   * that links to a page that doesn't exist is worse than either. But the page
   * for someone with one bug report to their name needs their name, their dates
   * and that one row: the ranked-repo maps, the partner lists and the monthly
   * series all describe a single event, at eight times the cost of describing
   * it. Anyone who has written code, reviewed it, answered anybody, closed
   * anything, been assigned anything, or filed enough to have a pattern gets
   * the full treatment.
   */
  const substantial = (s) =>
    s.total > 0 ||
    s._w.all.approvals > 0 ||
    s.open.length > 0 ||
    s._itotals.responses > 0 ||
    s._itotals.closed > 0 ||
    s._itotals.fixed > 0 ||
    s._iw.all.assigned > 0 ||
    s._itotals.filed >= 3 ||
    // Anything on their plate right now. A slim record has no room for a
    // queue, and a page that can't show somebody the review they were asked
    // for is the one case where slimming costs more than it saves.
    s._requested.length > 0 ||
    s._reviewing.length > 0 ||
    s._assigned.length > 0;

  const contributorsOut = {};
  for (const [login, s] of contributors) {
    const iw = issueWindowsOut(s);
    const touchedIssues = s._itotals.filed || s._itotals.responses ||
      s._itotals.closed || s._itotals.fixed || s._iopen.length;

    if (!substantial(s)) {
      contributorsOut[login] = {
        login,
        first: s.first,
        last: s.last,
        totalPRs: 0,
        activeDays: activeDays.get(login)?.windows.all.days ?? 0,
        activeSpan: activeDays.get(login)?.windows.all.denom ?? 0,
        slim: true,
        windows: {},
        series: null,
        topRepos: {},
        reviewRepos: {},
        reviewedBy: [],
        reviewsFor: [],
        backlog: null,
        resolved: null,
        reviewQueue: null,
        assigned: null,
        issues: {
          totals: s._itotals,
          windows: iw,
          series: null,
          backlog: issueBacklogOf(s._iopen),
          filed: s._ifiled.length ? packRows(s._ifiled, FILED_FIELDS) : null,
        },
      };
      continue;
    }

    contributorsOut[login] = {
      login,
      first: s.first,
      last: s.last,
      totalPRs: s.total,
      // Distinct days they did something, over the days since their first —
      // counting up to today, not to their last. The gap since somebody
      // stopped belongs in the denominator; leaving out to their final commit
      // gave a one-afternoon contributor a perfect score. Both halves come
      // from the shared index so this page and the Leaderboard can't drift.
      activeDays: activeDays.get(login)?.windows.all.days ?? 0,
      activeSpan: activeDays.get(login)?.windows.all.denom ?? 0,
      windows: windowsOut(s),
      series: finishSeries(s._months, firstMonth(s._months), prRow, now),
      topRepos: rankedWindows(s._counts, "opened", "repo"),
      reviewRepos: rankedWindows(s._counts, "reviewed", "repo"),
      reviewedBy: partnersOf(s._partners, "by"),
      reviewsFor: partnersOf(s._partners, "for"),
      backlog: backlogOf(s.open),
      resolved: packResolved(s.resolved),
      // Null when nobody is waiting on them for anything, which is the normal
      // case and the one the card says "nothing on your plate" to.
      reviewQueue: s._requested.length || s._reviewing.length
        ? {
            requested: packRows(s._requested, REVIEW_FIELDS),
            reviewing: packRows(s._reviewing, REVIEW_FIELDS),
          }
        : null,
      assigned: s._assigned.length ? packRows(s._assigned, ASSIGNED_FIELDS) : null,
      // Null rather than an object of zeroes for someone who has never touched
      // an issue: the frontend says "nothing here" instead of drawing eight
      // tiles of nought.
      issues: touchedIssues
        ? {
            totals: s._itotals,
            windows: iw,
            series: sparseSeries(s._imonths, contribIssueRow),
            filedRepos: rankedWindows(s._counts, "ifiled", "repo", ISSUE_TOP_N),
            answeredRepos: rankedWindows(s._counts, "iresponded", "repo", ISSUE_TOP_N),
            closedRepos: rankedWindows(s._counts, "iclosed", "repo", ISSUE_TOP_N),
            helpedBy: partnersOf(s._ipartners, "iby", ISSUE_TOP_N),
            helped: partnersOf(s._ipartners, "ifor", ISSUE_TOP_N),
            backlog: issueBacklogOf(s._iopen),
            filed: s._ifiled.length ? packRows(s._ifiled, FILED_FIELDS) : null,
            closed: s._iclosed.length ? packRows(s._iclosed, CLOSED_FIELDS) : null,
          }
        : null,
    };
  }

  const reposOut = {};
  for (const [name, s] of repos) {
    const iw = issueWindowsOut(s);

    reposOut[name] = {
      repo: name,
      first: s.first,
      last: s.last,
      totalPRs: s.total,
      windows: windowsOut(s),
      series: finishSeries(s._months, firstMonth(s._months), prRow, now),
      topAuthors: rankedWindows(s._counts, "author", "login"),
      topReviewers: rankedWindows(s._counts, "reviewer", "login"),
      grossing: grossingLists(s._gross),
      backlog: backlogOf(s.open),
      // Absent on the repos in the store with no tracker at all, which is a
      // different statement from a tracker with nothing in it.
      issues: s._itotals.filed
        ? {
            totals: s._itotals,
            windows: iw,
            series: sparseSeries(s._imonths, repoIssueRow),
            topReporters: rankedWindows(s._counts, "ireporter", "login", ISSUE_TOP_N),
            topResponders: rankedWindows(s._counts, "iresponder", "login", ISSUE_TOP_N),
            topClosers: rankedWindows(s._counts, "icloser", "login", ISSUE_TOP_N),
            topFixers: rankedWindows(s._counts, "ifixer", "login", ISSUE_TOP_N),
            topAssignees: rankedWindows(s._counts, "iassignee", "login", ISSUE_TOP_N),
            backlog: issueBacklogOf(s._iopen),
          }
        : null,
    };
  }

  /**
   * Search index. Separated from the records so typing in the combobox filters
   * a 1,500-entry array of four-key objects rather than walking the full
   * multi-megabyte structure on every keystroke.
   */
  // `i` is issue involvement, and it's in the ranking rather than beside it for
  // a reason: a full-time triager has no PRs and no approvals, so ranking on
  // those two buried the people doing the most visible work in the org below
  // everyone who ever opened a one-line fix.
  const involvementOf = (s) =>
    s._itotals.filed + s._itotals.responses + s._itotals.closed + s._itotals.fixed;

  // A scoped run stops here. Everything below is the index and the coverage
  // counts, which are facts about the whole store and belong to the cached
  // index blob rather than to a subject.
  if (only) {
    const payload = only.kind === "contributors" ? contributorsOut[only.id] : reposOut[only.id];
    return { payload: payload ?? null, labelNames };
  }

  const index = {
    contributors: [...contributors.values()]
      .map((s) => ({
        id: s.login,
        n: s.total,
        a: s._w.all.approvals,
        i: involvementOf(s),
        last: s.last,
      }))
      .sort(byInvolvement((s) => s.n + s.a + s.i)),
    repos: [...repos.values()]
      .map((s) => ({
        id: s.repo,
        n: s.total,
        open: s.open.length,
        i: s._itotals.filed,
        iOpen: s._iopen.length,
        last: s.last,
      }))
      .sort(byInvolvement((s) => s.n + s.i)),
  };

  let openTotal = 0, reviewRequestsKnown = 0, assigneesKnown = 0, labelsKnown = 0;
  for (const pr of prs) {
    if (pr.assignees !== undefined) assigneesKnown++;
    if (pr.labels !== undefined) labelsKnown++;
    if (pr.state !== "OPEN" || pr.mergedAt) continue;
    openTotal++;
    if (pr.reviewRequests !== undefined) reviewRequestsKnown++;
  }

  return {
    windows: WINDOWS,
    seriesFields: SERIES_FIELDS,
    resolvedFields: RESOLVED_FIELDS,
    issueSeriesFields: ISSUE_SERIES_FIELDS,
    issueWindowFields: ISSUE_WINDOW_FIELDS,
    // The issue backlogs carry bucket counts only; the labels live here once
    // rather than on every subject.
    backlogBuckets: BACKLOG_BUCKETS.map((b) => b.label),
    // Every label either store has ever put on a row, stated once. Rows carry
    // indexes into this — see packLabels.
    labelNames,
    filedFields: FILED_FIELDS,
    closedFields: CLOSED_FIELDS,
    issueOutcomes: ISSUE_OUTCOMES,
    reviewFields: REVIEW_FIELDS,
    reviewStates: REVIEW_STATES,
    assignedFields: ASSIGNED_FIELDS,
    prOutcomes: PR_OUTCOMES,
    /**
     * How much of the store carries the two fields the review queue is built
     * from, so an empty card can say which of the two things it means.
     *
     * "Nobody has asked you to review anything" and "the ingest has never
     * asked GitHub who was asked" are wildly different messages to put in front
     * of an admin, and the second one is a command they can run. Counted
     * against the population each field is meaningful over: requests only exist
     * on live PRs, assignment outlives the close.
     */
    prFieldCoverage: {
      openPRs: openTotal,
      reviewRequests: reviewRequestsKnown,
      total: prs.length,
      assignees: assigneesKnown,
      // Zero until the label backfill has run, which is the difference between
      // "this PR has no labels" and "we have never asked what its labels are".
      labels: labelsKnown,
    },
    // False when the issue store is missing entirely, which is a different
    // message from "this subject has no issue activity" and gets a different one.
    issueData: hasIssueData,
    closerCoverage,
    generatedAt: new Date(now).toISOString(),
    index,
    contributors: contributorsOut,
    repos: reposOut,
  };
}

/**
 * Every row that can reach one subject.
 *
 * The Worker computes a subject on the request rather than materialising all
 * 7,047 — a full pass is not expensive but impossible, on three limits
 * independently, and the numbers are in `handoff.md`. So it fetches one
 * subject's rows and hands them to `drilldown` scoped, which runs the same fold
 * the build runs. This is the selection, and its SQL twin is
 * `subjectRowsSql` in `src/shared/drilldown-rules.js` for the reason every rule
 * here is paired: a selection that is right in JavaScript and narrower in SQL
 * loses rows in production and nowhere else.
 *
 * A repo is the easy half — everything filed against it. A contributor is
 * reached six ways, and three of them contribute no number at all and exist
 * only to put a row in the picker. Reasoning from "what did they do" drops
 * those three people entirely, which is why the list is written out rather than
 * derived.
 */
export function subjectRows(kind, id, prs, issues) {
  if (kind === "repos") {
    return {
      prs: prs.filter((pr) => pr.repo === id),
      issues: issues.filter((i) => i.repo === id),
    };
  }

  const touchesPr = (pr) => {
    if (pr.author === id) return true;
    if ((pr.assignees ?? []).includes(id)) return true;
    for (const r of pr.reviews ?? []) if (r.author === id) return true;
    const openNow = pr.state === "OPEN" && !pr.mergedAt;
    if (openNow && (pr.reviewRequests ?? []).includes(id)) return true;
    return false;
  };

  const touchesIssue = (i) =>
    i.author === id ||
    i.firstResponder === id ||
    closerOf(i) === id ||
    fixerOf(i) === id ||
    (i.assignees ?? []).includes(id);

  return { prs: prs.filter(touchesPr), issues: issues.filter(touchesIssue) };
}

/**
 * One subject, computed from its own rows.
 *
 * Reuses the Node fold rather than translating it. That trade was rejected for
 * the whole store at 96 MB against a 128 MB isolate ceiling; one subject is
 * 5.9 MB at the worst, so the same argument runs the other way and the
 * agreement with the build is structural instead of tested.
 *
 * `activeDays` and `firstIssueBy` are the two things the rows cannot answer —
 * see the comments at their use. The second is only read for a repo.
 */
export function subjectPayload(kind, id, rows, ctx = {}) {
  // Refused rather than derived. Built from a repo's own issues this dates each
  // reporter's first to the first one they filed here, so every returning
  // reporter counts as a new one and `newReporters` reads high — a number
  // nothing in the panel's own output could contradict, which is how the last
  // nine defects in this port hid.
  if (kind === "repos" && !ctx.firstIssueBy) {
    throw new Error(
      "a repo subject needs firstIssueBy — first-ever is a fact about the org, " +
        "and deriving it from one repo's issues inflates newReporters silently"
    );
  }

  return foldDrilldown(ctx.now ?? Date.now(), {
    only: { kind, id },
    prs: rows.prs,
    issues: rows.issues,
    activeDays: ctx.activeDays,
    firstIssueBy: ctx.firstIssueBy,
  });
}
