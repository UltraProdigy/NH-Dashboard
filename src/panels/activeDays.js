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
 *
 * The raw day sets are what's cached, not the rolled-up counts, because the
 * two callers ask for different windows. Rolling up is a walk over ~500,000
 * strings, which is nothing next to reading the stores.
 */
let cache = null;

/** Only tests need this, when they swap NH_STORE_DIR mid-run. */
export function clearActiveDayCache() {
  cache = null;
}

async function daySets() {
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

  cache = sets;
  return cache;
}

/**
 * login -> { first, last, windows: { <id>: { days, denom } } }.
 *
 * Every period runs to **today**, never to the person's last active day. That
 * one choice is the whole difference between a number that means something and
 * one that doesn't.
 *
 * The first version divided by `last - first`, which sounds equivalent and
 * isn't: it freezes the clock on the day somebody stopped, so leaving is
 * invisible to the arithmetic. Somebody who opened four pull requests in one
 * afternoon of 2023 and never came back had a one-day span, scored a perfect
 * 100%, and outranked a decade of work. Over half the people in the store are
 * that contributor — 3,727 of 6,789 have a single active day — and all 3,864
 * hundred-percenters had a span under a month.
 *
 * Running the denominator to today fixes it at the root rather than by
 * threshold: the gap since somebody's last commit is now *in* the denominator,
 * so it grows every day they stay away. Nobody in the store scores 100% under
 * it, and nobody scores 90%.
 *
 * Two flavours of period, one rule:
 *
 *   - A fixed window is `[today - N, today]`, so `denom` is N for everybody and
 *     the column is directly comparable and sortable.
 *   - All-time is `[their first active day, today]`, so `denom` is their own
 *     tenure — the "how much of your run have you been working" reading, and
 *     the one that can't be shared because people started at different times.
 *
 * The denominator ships alongside the count rather than being recomputed in the
 * browser. Two pages divide these numbers and a second implementation of "how
 * long is the period" is exactly how they'd come to disagree.
 */
export async function activeDayIndex(windows) {
  const sets = await daySets();
  const DAY = 86_400_000;
  // Today as a date key, so every comparison is a string compare against the
  // same ISO dates the sets hold and no timezone gets a say.
  const today = new Date().toISOString().slice(0, 10);
  const dayNo = (key) => Math.round(Date.parse(key) / DAY);

  const periods = windows.map((w) => ({
    id: w.id,
    from: w.days == null ? null : new Date(Date.now() - w.days * DAY).toISOString().slice(0, 10),
    days: w.days,
  }));

  const out = new Map();
  for (const [login, s] of sets) {
    // Sorted lexically, which for ISO dates is chronological.
    const keys = [...s].sort();
    const first = keys[0];

    const byWindow = {};
    for (const p of periods) {
      byWindow[p.id] = p.from == null
        ? { days: keys.length, denom: dayNo(today) - dayNo(first) + 1 }
        : { days: keys.filter((k) => k >= p.from).length, denom: p.days };
    }

    out.set(login, { first, last: keys[keys.length - 1], windows: byWindow });
  }
  return out;
}
