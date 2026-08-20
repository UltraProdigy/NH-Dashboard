/**
 * How many distinct days each person actually did something.
 *
 * This exists as its own module rather than living in whichever panel wanted it
 * first, because two of them want it and they read different stores. The
 * drilldown reads pull requests and issues; the contributors panel reads pull
 * requests alone. If each computed its own version, the Leaderboard would say
 * 62% and that person's own profile would say 74%, and there'd be no way to
 * tell which was wrong from either page.
 *
 * So both take their numerator *and* their denominator from here. The span is
 * derived from the day set itself — first day acted to last day acted — rather
 * than from either panel's own notion of when somebody started, which means
 * `days <= span` holds by construction and the percentage cannot exceed 100 no
 * matter what the two stores disagree about.
 *
 * What counts as a day worked:
 *
 *   - opening a pull request
 *   - submitting a review of any verdict, not just an approval — a day spent
 *     reading a diff and asking for changes is a day worked whatever came out
 *     of it, and on this org the people who do most of that reading approve
 *     comparatively little of it
 *   - filing an issue, being first to reply to one, closing one, or writing the
 *     pull request that closed one
 *
 * What doesn't: their own pull request being merged by somebody else. That's a
 * day *they* had, not a day they worked, and counting it would credit people
 * for other people's Tuesdays.
 */

import { readStore } from "../ingest/pullRequests.js";
import { readStore as readIssueStore } from "../ingest/issues.js";
import { BOT_PATTERN } from "../config.js";
import { closerOf, fixerOf } from "./issueMetrics.js";

const isBot = (login) => !login || BOT_PATTERN.test(login);

/**
 * Memoized for the same reason the stores are: a build reads this from two
 * panels and the walk is 55,000 records. Scoped to the process, so the ingest —
 * which runs as its own — is unaffected.
 */
let cache = null;

/** Only tests need this, when they swap NH_STORE_DIR mid-run. */
export function clearActiveDayCache() {
  cache = null;
}

/** login -> { days, first, last, span }. Absent means they never acted. */
export async function activeDayIndex() {
  if (cache) return cache;

  const [prs, issues] = await Promise.all([readStore(), readIssueStore()]);
  const sets = new Map();

  const mark = (login, when) => {
    if (!when || isBot(login)) return;
    let s = sets.get(login);
    if (!s) sets.set(login, (s = new Set()));
    s.add(when.slice(0, 10));
  };

  for (const pr of prs) {
    mark(pr.author, pr.createdAt);
    for (const r of pr.reviews ?? []) mark(r.author, r.submittedAt);
  }

  for (const i of issues) {
    mark(i.author, i.createdAt);
    mark(i.firstResponder, i.firstResponseAt);
    // Borrowed rather than reimplemented. Who closed a thing and whose fix
    // closed it are attribution rules with real subtleties in them, and a
    // second copy here would drift from the one every other panel uses.
    mark(closerOf(i), i.closedAt);
    mark(fixerOf(i), i.closedAt);
  }

  cache = new Map();
  for (const [login, s] of sets) {
    // Sorted lexically, which for ISO dates is chronological.
    const keys = [...s].sort();
    const first = keys[0];
    const last = keys[keys.length - 1];
    cache.set(login, {
      days: s.size,
      first,
      last,
      span: Math.round((Date.parse(last) - Date.parse(first)) / 86_400_000) + 1,
    });
  }
  return cache;
}
