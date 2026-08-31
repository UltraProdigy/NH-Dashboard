/**
 * The drilldown's index and schema keys, from D1.
 *
 * This is not the whole drilldown and deliberately cannot be. The per-subject
 * payloads — 6,749 contributors and 298 repos — are a read-through cache
 * computed one subject at a time on the request, because building all of them
 * in one invocation fails on three separate limits: 35.3 MB of raw rows before
 * a single accumulator against a 128 MB isolate, ~35,000 queries against D1's
 * 1,000 per invocation, and 61.7 million writes a month against 50 million
 * included. See `handoff.md` for the measurements.
 *
 * What *is* here is the part that cannot be computed per subject: the two
 * picker indexes are an aggregate over every subject at once, and the schema
 * keys are constants. Together they are ~470 KB, which is an ordinary
 * `panel_cache` blob on the cron like every other panel.
 *
 * The index is therefore the only part of this panel rebuilt in SQL rather than
 * reused from `src/panels/drilldown.js`, and the risk it carries is not
 * arithmetic — every number here is a COUNT or a MAX. It is **which subjects
 * exist at all.** A login enters the Node panel's index because `person()` was
 * called for it, from six places with six different bot rules, and a
 * reimplementation that agrees on all six numbers while disagreeing about the
 * membership of the list produces a picker that looks entirely correct and is
 * missing people. So existence is assembled first, from every source, and the
 * counts are joined onto it afterwards.
 */

import { WINDOWS, isHumanSql } from "../../../src/shared/contributor-rules.js";
import { closerSql, fixerSql } from "../../../src/shared/issue-rules.js";
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
  byInvolvement,
} from "../../../src/shared/drilldown-rules.js";
import { BACKLOG_BUCKETS } from "../../../src/shared/analytics-rules.js";

/** `MAX` over a set of timestamps, ignoring the ones that are not there. */
const later = (a, b) => (!a ? (b ?? null) : !b ? a : a > b ? a : b);

/**
 * One approval per reviewer per pull request, dated to their earliest.
 *
 * Re-approving after a round of changes is one act of review, and counting it
 * twice would quietly reward churn — so the inner query collapses to the pair
 * and takes `MIN(submitted_at)`, which is also the timestamp the person's
 * `last` is allowed to move to.
 *
 * **Self-approvals are included, and that is not an oversight.** `approversOf`
 * in the Node panel excludes bots and nothing else, while `firstReviewAt` and
 * `latestReviewsOf` beside it exclude bots *and* the author. Three functions,
 * two rules, ten lines apart. Reproducing the wrong one of them here would move
 * 231 people's approval counts by an amount nothing in the output could
 * contradict.
 */
const APPROVALS = `
  SELECT author, COUNT(*) AS n, MAX(at) AS last
    FROM (
      SELECT author, repo, pr_number, MIN(submitted_at) AS at
        FROM reviews
       WHERE state = 'APPROVED'
         AND submitted_at IS NOT NULL
         AND ${isHumanSql("author")}
       GROUP BY repo, pr_number, author
    )
   GROUP BY author`;

/**
 * Every login that is a drilldown subject, and nothing about it yet.
 *
 * Six sources, because `person()` has six call sites. Three of them contribute
 * no number to the index at all and exist only to put a row in the list — a
 * login that appears solely as a review requestee, a current reviewer on an
 * open pull request, or an assignee lands with `n`, `a` and `i` all zero and a
 * null `last`. There are exactly three such people in the org today, and two
 * are Copilot accounts that `BOT_PATTERN` does not match, so this is a tail
 * worth reproducing rather than one worth rounding off.
 *
 * `review_requests` and `assignees` are JSON arrays, expanded in the isolate
 * rather than through `json_each` — the same trade the issue port measured,
 * where expanding 0.76 MB of JSON cost 9.3 ms against ~56 ms for the SQL route
 * and needed nothing D1 has never been asked to do.
 */
async function subjectLogins(db) {
  const logins = new Set();

  const add = (v) => {
    if (v) logins.add(v);
  };

  const [authors, approvers, reviewers, filed, responders, closers, assignees] =
    await Promise.all([
      db.prepare(`SELECT DISTINCT author FROM pull_requests WHERE ${isHumanSql("author")}`).all(),
      db.prepare(`SELECT DISTINCT author FROM (${APPROVALS})`).all(),
      // Only on a live pull request: the Node panel builds both halves of the
      // review queue inside `if (openNow)`, because both are things somebody is
      // still waiting on and nobody waits on a merged one. This half also
      // excludes self-review, which the approval query above does not.
      db
        .prepare(
          `SELECT DISTINCT r.author
             FROM reviews r
             JOIN pull_requests p ON p.repo = r.repo AND p.number = r.pr_number
            WHERE p.state = 'OPEN' AND p.merged_at IS NULL
              AND r.submitted_at IS NOT NULL
              AND r.author <> p.author
              AND ${isHumanSql("r.author")}`,
        )
        .all(),
      db.prepare(`SELECT DISTINCT author FROM issues WHERE ${isHumanSql("author")}`).all(),
      db
        .prepare(
          `SELECT DISTINCT first_responder AS author FROM issues
            WHERE first_responder IS NOT NULL AND ${isHumanSql("first_responder")}`,
        )
        .all(),
      db
        .prepare(
          `SELECT DISTINCT k AS author FROM (
             SELECT ${closerSql()} AS k FROM issues
             UNION
             SELECT ${fixerSql()} AS k FROM issues
           ) WHERE k IS NOT NULL`,
        )
        .all(),
      // Both stores, and the pull request side is not restricted to open ones —
      // the assignment log is "whatever became of it".
      db
        .prepare(
          `SELECT assignees FROM pull_requests WHERE assignees <> '[]'
           UNION ALL
           SELECT assignees FROM issues WHERE assignees <> '[]'`,
        )
        .all(),
    ]);

  for (const rows of [authors, approvers, reviewers, filed, responders, closers]) {
    for (const r of rows.results) add(r.author);
  }
  for (const r of assignees.results) {
    for (const login of JSON.parse(r.assignees)) add(login);
  }

  // The review-request queue, expanded the same way.
  const requested = await db
    .prepare(
      `SELECT review_requests FROM pull_requests
        WHERE state = 'OPEN' AND merged_at IS NULL AND review_requests <> '[]'`,
    )
    .all();
  for (const r of requested.results) {
    for (const login of JSON.parse(r.review_requests)) add(login);
  }

  return logins;
}

/**
 * The contributor picker.
 *
 * `n` is pull requests authored, `a` all-time approvals given, `i` issue
 * involvement — filed plus responses plus closed plus fixed — and `last` is a
 * MAX over exactly the five things the Node panel's `touch()` calls reach a
 * person from. A review that was not an approval does not move `last`, and
 * neither does an assignment; adding either would look like an improvement and
 * would be a divergence.
 */
async function contributorIndex(db) {
  const logins = await subjectLogins(db);

  const [prs, approvals, filed, responses, closed, fixed] = await Promise.all([
    db
      .prepare(
        `SELECT author, COUNT(*) AS n, MAX(created_at) AS last
           FROM pull_requests WHERE ${isHumanSql("author")} GROUP BY author`,
      )
      .all(),
    db.prepare(APPROVALS).all(),
    db
      .prepare(
        `SELECT author, COUNT(*) AS n, MAX(created_at) AS last
           FROM issues WHERE ${isHumanSql("author")} GROUP BY author`,
      )
      .all(),
    db
      .prepare(
        `SELECT first_responder AS author, COUNT(*) AS n, MAX(first_response_at) AS last
           FROM issues
          WHERE first_responder IS NOT NULL AND ${isHumanSql("first_responder")}
          GROUP BY first_responder`,
      )
      .all(),
    db
      .prepare(
        `SELECT ${closerSql()} AS author, COUNT(*) AS n, MAX(closed_at) AS last
           FROM issues WHERE ${closerSql()} IS NOT NULL GROUP BY 1`,
      )
      .all(),
    db
      .prepare(
        `SELECT ${fixerSql()} AS author, COUNT(*) AS n, MAX(closed_at) AS last
           FROM issues WHERE ${fixerSql()} IS NOT NULL GROUP BY 1`,
      )
      .all(),
  ]);

  const out = new Map();
  for (const id of logins) out.set(id, { id, n: 0, a: 0, i: 0, last: null });

  const fold = (rows, apply) => {
    for (const r of rows.results) {
      const s = out.get(r.author);
      // A login the counts know about and the existence pass did not is a bug
      // in the existence pass, not a row to invent — every source above is
      // already one of its six.
      if (s) apply(s, r);
    }
  };

  fold(prs, (s, r) => {
    s.n = r.n;
    s.last = later(s.last, r.last);
  });
  fold(approvals, (s, r) => {
    s.a = r.n;
    s.last = later(s.last, r.last);
  });
  fold(filed, (s, r) => {
    s.i += r.n;
    s.last = later(s.last, r.last);
  });
  fold(responses, (s, r) => {
    s.i += r.n;
    s.last = later(s.last, r.last);
  });
  // Closed and fixed both count towards involvement and both move `last` to the
  // close date — a person can be each, on one issue, and the Node panel counts
  // that as two.
  fold(closed, (s, r) => {
    s.i += r.n;
    s.last = later(s.last, r.last);
  });
  fold(fixed, (s, r) => {
    s.i += r.n;
    s.last = later(s.last, r.last);
  });

  return [...out.values()].sort(byInvolvement((s) => s.n + s.a + s.i));
}

/**
 * The repo picker.
 *
 * Simpler than the contributor side in one way that matters: a repo's pull
 * request count includes bots, because a repo is "a thing pull requests happen
 * to" and a bot's pull request happened to it. The contributor side excludes
 * them because a bot is not a contributor. Same word, two rules.
 */
async function repoIndex(db) {
  const [prs, issues] = await Promise.all([
    db
      .prepare(
        `SELECT repo,
                COUNT(*) AS n,
                SUM(state = 'OPEN' AND merged_at IS NULL) AS open,
                MAX(created_at) AS last
           FROM pull_requests GROUP BY repo`,
      )
      .all(),
    db
      .prepare(
        `SELECT repo,
                COUNT(*) AS i,
                SUM(state = 'OPEN') AS iOpen,
                MAX(created_at) AS created,
                MAX(closed_at) AS closed
           FROM issues GROUP BY repo`,
      )
      .all(),
  ]);

  const out = new Map();
  const at = (id) => {
    if (!out.has(id)) out.set(id, { id, n: 0, open: 0, i: 0, iOpen: 0, last: null });
    return out.get(id);
  };

  for (const r of prs.results) {
    const s = at(r.repo);
    s.n = r.n;
    s.open = r.open ?? 0;
    s.last = later(s.last, r.last);
  }
  for (const r of issues.results) {
    const s = at(r.repo);
    s.i = r.i;
    s.iOpen = r.iOpen ?? 0;
    s.last = later(later(s.last, r.created), r.closed);
  }

  return [...out.values()].sort(byInvolvement((s) => s.n + s.i));
}

/**
 * The cached half of the drilldown: both indexes, and the constants.
 *
 * The schema keys are stated once here and read by every payload the
 * read-through cache serves, so a row packed by the Worker and a row packed by
 * the build expand against the same column orders — which is the whole reason
 * those orders moved into `drilldown-rules.js`.
 */
export async function drilldown(db, now = Date.now()) {
  const [contributors, repos] = await Promise.all([
    contributorIndex(db),
    repoIndex(db),
  ]);

  return {
    windows: WINDOWS,
    seriesFields: SERIES_FIELDS,
    resolvedFields: RESOLVED_FIELDS,
    issueSeriesFields: ISSUE_SERIES_FIELDS,
    issueWindowFields: ISSUE_WINDOW_FIELDS,
    backlogBuckets: BACKLOG_BUCKETS.map((b) => b.label),
    filedFields: FILED_FIELDS,
    closedFields: CLOSED_FIELDS,
    issueOutcomes: ISSUE_OUTCOMES,
    reviewFields: REVIEW_FIELDS,
    reviewStates: REVIEW_STATES,
    assignedFields: ASSIGNED_FIELDS,
    prOutcomes: PR_OUTCOMES,
    generatedAt: new Date(now).toISOString(),
    index: { contributors, repos },
  };
}
