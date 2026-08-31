/**
 * Shared issue arithmetic.
 *
 * Three places now aggregate the issue store — the org panel, the per-repo
 * drilldown and the per-person drilldown — and they have to agree. If the
 * contributor page counts a duplicate as a resolved close and the issue page
 * doesn't, the two pages disagree about the same person and there is no way to
 * tell which one is lying. So the definitions live here once: what counts as
 * unanswered, what counts as resolved, who gets credit for a close, and how a
 * window's worth of either is rolled up.
 *
 * Two accumulator shapes, because a subject can be the thing issues happen *to*
 * (a repo, the org) or the person doing things *to* issues (filing, answering,
 * closing). Those are different questions and forcing one shape on both would
 * mean half the fields are always null.
 */

import { isBot } from "../shared/contributor-rules.js";
import {
  dayKey,
  monthKey,
  pct,
  round1,
  weekKey,
} from "../shared/analytics-rules.js";

export const DAY = 86_400_000;
export const HOUR = 3_600_000;

// The percentile, the rounding and the three bucket keys used to be defined
// again here, identically. They agreed — checked across every day from 2005 to
// 2035 before they were merged — but two copies of a definition is a bet that
// nobody ever edits one of them, and both are about to gain a SQL twin that
// only one copy can own.
export { isBot, pct, round1, monthKey, weekKey, dayKey };

// The label taxonomy went the same way, and had already drifted into a second
// copy here before anyone noticed — identical to the one in `issue-rules.js`,
// which is where the Worker reads it from. Two identical copies is the state
// just before two different ones.
export { GROUP_ORDER, groupRank, splitLabel } from "../shared/issue-rules.js";

/**
 * Close reasons that mean "this was never fixed".
 *
 * GitHub has grown the list over time — DUPLICATE arrived after NOT_PLANNED —
 * and anything not in here counts as completed, so a reason added later fails
 * towards the flattering side. Worth re-checking against the live data
 * occasionally rather than trusting this to stay exhaustive.
 */
export const UNRESOLVED = new Set(["NOT_PLANNED", "DUPLICATE"]);

/**
 * An issue nobody outside the reporter ever replied to.
 *
 * `responseUnknown` records exhausted the ingest's comment sample without
 * finding a human reply, which is a different thing from silence — those are
 * excluded from both sides rather than counted as unanswered.
 */
export const isUnanswered = (i) => !i.firstResponseAt && !i.responseUnknown;

export const round3 = (n) => (n == null ? null : Math.round(n * 1000) / 1000);

const sorted = (a) => a.sort((x, y) => x - y);
export const median = (arr) => round1(pct(sorted(arr), 50));

/* ==========================================================================
   Credit for a close

   Two people can reasonably be said to have closed an issue: whoever pressed
   the button, and whoever wrote the pull request that made pressing it
   possible. Both are counted, separately and by name, because on this org they
   are usually different people doing different jobs — one triages, one fixes —
   and collapsing them into a single "closes" number would flatter the first and
   erase the second.
   ========================================================================== */

/** Who pressed the button, or null if the store doesn't know. */
export const closerOf = (i) => (isBot(i.closedBy) ? null : i.closedBy ?? null);

/** The pull request that closed it, if one did. */
export const closingPR = (i) =>
  i.closedVia?.kind === "pr" ? i.closedVia : null;

/** Author of the closing pull request — "my PR closed this ticket". */
export const fixerOf = (i) => {
  const pr = closingPR(i);
  return pr && !isBot(pr.author) ? pr.author ?? null : null;
};

/**
 * True when the store can't say who closed this.
 *
 * Only a record that explicitly says it asked counts as known. Records written
 * before the ingest learned the question carry no flag at all, and reading their
 * silence as "closed by nobody" would report a store awaiting a re-walk as a
 * team that never closes anything.
 */
export const closerUnknown = (i) => !!i.closedAt && i.closerKnown !== true;

/**
 * Every window plus the equal-length period immediately before it, which is what
 * the "vs. previous" deltas compare against. "All time" has nothing before it.
 */
export function periodsFor(windows, now) {
  const out = [];
  for (const w of windows) {
    out.push({ key: w.id, from: w.days == null ? -Infinity : now - w.days * DAY, to: Infinity });
    if (w.days != null)
      out.push({ key: `prev:${w.id}`, from: now - 2 * w.days * DAY, to: now - w.days * DAY });
  }
  return out;
}

export const inPeriod = (p, ts) => {
  if (!ts) return false;
  const t = new Date(ts).getTime();
  return t >= p.from && t < p.to;
};

/* ==========================================================================
   Tracker-shaped rollup — the org, or one repo
   ========================================================================== */

export const blankTrackerPeriod = () => ({
  opened: 0,
  closed: 0,
  completed: 0,
  notPlanned: 0,
  duplicate: 0,
  labeled: 0,
  answered: 0,
  unanswered: 0,
  comments: 0,
  reporters: new Map(),
  responders: new Map(),
  closers: new Map(),
  assignees: new Map(),
  repos: new Map(),
  labels: new Map(),
  newReporters: 0,
  closedByPR: 0,
  closedByHand: 0,
  unknownCloser: 0,
  closeHours: [],
  responseHours: [],
});

export function summarizeTrackerPeriod(a) {
  const close = sorted(a.closeHours);
  const resp = sorted(a.responseHours);
  const decided = a.answered + a.unanswered;

  return {
    opened: a.opened,
    closed: a.closed,
    completed: a.completed,
    notPlanned: a.notPlanned,
    duplicate: a.duplicate,
    // Not planned and duplicate together — the closes that resolved nothing.
    unresolved: a.notPlanned + a.duplicate,
    // Positive means the backlog grew. Deliberately opened-minus-closed rather
    // than a ratio: "12 more than we closed" is a number you can act on,
    // "1.04" is not.
    net: a.opened - a.closed,
    // Of everything closed in this period, what fraction was actually resolved
    // rather than declined or abandoned.
    completedShare: a.closed ? a.completed / a.closed : null,
    medianCloseHours: round1(pct(close, 50)),
    p90CloseHours: round1(pct(close, 90)),
    medianFirstResponseHours: round1(pct(resp, 50)),
    p90FirstResponseHours: round1(pct(resp, 90)),
    // Both shares are over issues *opened* in the period, so they describe the
    // same set the counts above do.
    labeledShare: a.opened ? a.labeled / a.opened : null,
    unlabeled: a.opened - a.labeled,
    answeredShare: decided ? a.answered / decided : null,
    neverAnswered: a.unanswered,
    reporters: a.reporters.size,
    newReporters: a.newReporters,
    responders: a.responders.size,
    responses: [...a.responders.values()].reduce((n, v) => n + v, 0),
    // People who closed something here, and how much of the closing was done by
    // a pull request rather than by hand. On a healthy tracker those are close
    // to complementary: everything else is triage.
    closers: a.closers.size,
    closedByPR: a.closedByPR,
    closedByHand: a.closedByHand,
    // Says how much of the period the store can't attribute, so a low
    // `closedByHand` on a half-backfilled store doesn't read as "nobody
    // triages".
    unknownCloser: a.unknownCloser,
    assignees: a.assignees.size,
    activeRepos: a.repos.size,
    comments: a.comments,
    closedN: close.length,
    respondedN: resp.length,
  };
}

/**
 * Fold one issue into a tracker period. `ctx` carries the facts the caller has
 * already derived once for this issue, so a seven-window loop doesn't recompute
 * them seven times.
 */
export function foldTracker(acc, i, p, ctx) {
  const { open, labels, closeHours, responseHours, isFirstEver, bot, closedBy, fixer } = ctx;

  if (inPeriod(p, i.createdAt)) {
    acc.opened++;
    acc.comments += i.comments ?? 0;
    if (labels.length) acc.labeled++;
    if (isUnanswered(i)) acc.unanswered++;
    else if (i.firstResponseAt) acc.answered++;
    if (!bot) {
      acc.reporters.set(i.author, (acc.reporters.get(i.author) ?? 0) + 1);
      if (isFirstEver) acc.newReporters++;
    }
    const rr = acc.repos.get(i.repo) ?? { repo: i.repo, opened: 0, closed: 0 };
    rr.opened++;
    if (i.closedAt) rr.closed++;
    acc.repos.set(i.repo, rr);
    for (const name of labels) {
      const ll = acc.labels.get(name) ?? { name, opened: 0 };
      ll.opened++;
      acc.labels.set(name, ll);
    }
    for (const a of i.assignees ?? [])
      if (!isBot(a)) acc.assignees.set(a, (acc.assignees.get(a) ?? 0) + 1);
    if (responseHours != null) acc.responseHours.push(responseHours);
  }

  // Closes are counted against the period they happened in, not the one the
  // issue was opened in — otherwise clearing a five-year-old backlog shows up
  // as nothing at all.
  if (inPeriod(p, i.closedAt)) {
    acc.closed++;
    if (i.stateReason === "NOT_PLANNED") acc.notPlanned++;
    else if (i.stateReason === "DUPLICATE") acc.duplicate++;
    else acc.completed++;
    if (closeHours != null) acc.closeHours.push(closeHours);
    if (closedBy) acc.closers.set(closedBy, (acc.closers.get(closedBy) ?? 0) + 1);
    if (fixer || closingPR(i)) acc.closedByPR++;
    else if (closerUnknown(i)) acc.unknownCloser++;
    else acc.closedByHand++;
  }

  // First responders are credited when they replied, for the same reason.
  if (i.firstResponder && !isBot(i.firstResponder) && inPeriod(p, i.firstResponseAt)) {
    acc.responders.set(i.firstResponder, (acc.responders.get(i.firstResponder) ?? 0) + 1);
  }
}

/* ==========================================================================
   Person-shaped rollup — what one contributor did to issues

   Four distinct jobs, kept apart: filing them, answering them, closing them,
   and fixing them with a pull request. Someone who only triages and someone who
   only writes fixes both look busy on this org, and a single "issues" number
   would describe neither.
   ========================================================================== */

export const blankPersonPeriod = () => ({
  filed: 0,
  filedOpen: 0,
  filedClosed: 0,
  filedCompleted: 0,
  filedUnresolved: 0,
  filedLabeled: 0,
  filedAnswered: 0,
  filedUnanswered: 0,
  commentsReceived: 0,
  waitHours: [],          // how long their own reports waited for a reply
  responses: 0,           // first replies they gave to somebody else
  responseLagHours: [],   // how old the issue was when they replied
  closed: 0,              // closes where they pressed the button
  closedCompleted: 0,
  closedUnresolved: 0,
  closedOwn: 0,           // …of their own issues, which isn't triage
  closedByTheirPR: 0,     // …that a pull request of theirs closed
  closedByHand: 0,        // …that nothing but the button closed
  closeLagHours: [],      // how old the issues were when they closed them
  fixed: 0,               // issues closed by a PR they authored, whoever pressed it
  assigned: 0,
  assignedOpen: 0,
  repos: new Set(),       // every repo they touched an issue in
  filedRepos: new Set(),
  helped: new Set(),      // distinct reporters they answered or closed for
});

export function summarizePersonPeriod(a) {
  const wait = sorted(a.waitHours);
  const lag = sorted(a.responseLagHours);
  const close = sorted(a.closeLagHours);
  const decided = a.filedAnswered + a.filedUnanswered;

  return {
    filed: a.filed,
    filedOpen: a.filedOpen,
    filedClosed: a.filedClosed,
    filedCompleted: a.filedCompleted,
    filedUnresolved: a.filedUnresolved,
    // How often what they file turns into a fix rather than a decline. Read it
    // as a property of the reports, not of the person: a good bug report about
    // a mod nobody maintains still ends up not-planned.
    acceptedShare: a.filedClosed ? a.filedCompleted / a.filedClosed : null,
    filedLabeledShare: a.filed ? a.filedLabeled / a.filed : null,
    filedAnswered: a.filedAnswered,
    filedUnanswered: a.filedUnanswered,
    answeredShare: decided ? a.filedAnswered / decided : null,
    commentsReceived: a.commentsReceived,
    medianWaitHours: round1(pct(wait, 50)),
    p90WaitHours: round1(pct(wait, 90)),
    responses: a.responses,
    medianResponseLagHours: round1(pct(lag, 50)),
    p90ResponseLagHours: round1(pct(lag, 90)),
    closed: a.closed,
    closedCompleted: a.closedCompleted,
    closedUnresolved: a.closedUnresolved,
    closedOwn: a.closedOwn,
    // Closes of other people's issues that weren't resolved by a pull request:
    // the closest this data gets to "hours spent triaging".
    closedForOthers: a.closed - a.closedOwn,
    closedByTheirPR: a.closedByTheirPR,
    closedByHand: a.closedByHand,
    medianCloseLagHours: round1(pct(close, 50)),
    p90CloseLagHours: round1(pct(close, 90)),
    fixed: a.fixed,
    assigned: a.assigned,
    assignedOpen: a.assignedOpen,
    // One number for "how much issue work is this person doing", for ranking a
    // leaderboard by. Deliberately a sum of acts and not a score: filing,
    // answering and closing are all work, and weighting them against each other
    // would be inventing a judgement the data can't support.
    triage: a.responses + (a.closed - a.closedOwn),
    involvement: a.filed + a.responses + a.closed + a.fixed,
    repos: a.repos.size,
    filedRepos: a.filedRepos.size,
    helped: a.helped.size,
  };
}

/**
 * How many people the by-contributor table carries per window.
 *
 * The store holds 6,450 distinct issue participants, nearly all of them someone
 * who filed one bug in 2019 — a full per-window table of those would be most of
 * a megabyte in dashboard.json, which every page pays for on load. Two hundred
 * is deep enough that the whole triage crew and every regular reporter is on it,
 * and anyone who falls off still has a complete record on their own drilldown,
 * which is where you go when you want one person rather than a ranking.
 */
export const PEOPLE_CAP = 200;

/**
 * Column order for the packed per-window people rows. Positional to keep the
 * table affordable — the same trick the drilldown's resolved-PR rows use, and
 * for the same reason: thirty repeated key names per person per window is most
 * of the cost of shipping this at all.
 */
export const PERSON_FIELDS = [
  "filed", "filedOpen", "filedClosed", "filedCompleted", "filedUnresolved",
  "acceptedShare", "filedAnswered", "filedUnanswered", "answeredShare",
  "commentsReceived", "medianWaitHours", "p90WaitHours",
  "responses", "medianResponseLagHours", "p90ResponseLagHours",
  "closed", "closedCompleted", "closedUnresolved", "closedOwn",
  "closedForOthers", "closedByTheirPR", "closedByHand",
  "medianCloseLagHours", "p90CloseLagHours",
  "fixed", "assigned", "assignedOpen",
  "triage", "involvement", "repos", "filedRepos", "helped",
];

/** Shares are rendered as whole percentages, so full float precision is noise. */
const SHARE_FIELDS = new Set([
  "acceptedShare", "answeredShare", "filedLabeledShare",
]);

/**
 * One person's window as a positional row.
 *
 * Lives here rather than in the org panel because the Worker packs the same
 * rows from the same accumulators, and a column order that existed twice would
 * be a silent reshuffle of every number in the table the first time one copy
 * gained a field.
 */
export const packPerson = (login, s) => [
  login,
  ...PERSON_FIELDS.map((f) => (SHARE_FIELDS.has(f) ? round3(s[f]) : s[f] ?? null)),
];

/**
 * Fold one issue into one person's period, from whichever side they were on.
 * A person can be several of these at once on the same issue — reporter and
 * closer is common — so every branch is independent.
 */
export function foldPerson(acc, i, p, login, ctx) {
  const { labels, closeHours, responseHours, closedBy, fixer } = ctx;
  const mine = i.author === login;

  if (mine && inPeriod(p, i.createdAt)) {
    acc.filed++;
    acc.filedRepos.add(i.repo);
    acc.repos.add(i.repo);
    if (i.state === "OPEN") acc.filedOpen++;
    else {
      acc.filedClosed++;
      if (UNRESOLVED.has(i.stateReason)) acc.filedUnresolved++;
      else acc.filedCompleted++;
    }
    if (labels.length) acc.filedLabeled++;
    if (isUnanswered(i)) acc.filedUnanswered++;
    else if (i.firstResponseAt) acc.filedAnswered++;
    acc.commentsReceived += i.comments ?? 0;
    if (responseHours != null) acc.waitHours.push(responseHours);
  }

  if (i.firstResponder === login && inPeriod(p, i.firstResponseAt)) {
    acc.responses++;
    acc.repos.add(i.repo);
    if (!mine && !isBot(i.author)) acc.helped.add(i.author);
    if (responseHours != null) acc.responseLagHours.push(responseHours);
  }

  if (closedBy === login && inPeriod(p, i.closedAt)) {
    acc.closed++;
    acc.repos.add(i.repo);
    if (UNRESOLVED.has(i.stateReason)) acc.closedUnresolved++;
    else acc.closedCompleted++;
    if (mine) acc.closedOwn++;
    else if (!isBot(i.author)) acc.helped.add(i.author);
    if (fixer === login) acc.closedByTheirPR++;
    else if (!closingPR(i)) acc.closedByHand++;
    if (closeHours != null) acc.closeLagHours.push(closeHours);
  }

  // Credited separately from the button press, and dated to the close: "a PR of
  // mine closed this ticket" is the metric for the people who fix things
  // without ever touching the tracker themselves.
  if (fixer === login && inPeriod(p, i.closedAt)) {
    acc.fixed++;
    acc.repos.add(i.repo);
    if (!mine && !isBot(i.author)) acc.helped.add(i.author);
  }

  // Assignment carries no date of its own, so it's dated by the issue. An open
  // assigned issue is a commitment outstanding; a closed one is work done.
  if ((i.assignees ?? []).includes(login) && inPeriod(p, i.createdAt)) {
    acc.assigned++;
    acc.repos.add(i.repo);
    if (i.state === "OPEN") acc.assignedOpen++;
  }
}
