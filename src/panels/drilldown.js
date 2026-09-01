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
 * PR-side ranked lists are emitted in full rather than truncated. That was
 * measured, not assumed: capping at 10 gave 2.54 MB, capping at 100 gave 3.11
 * MB, and uncapped gives 3.18 MB — 0.36 MB over the wire once Pages gzips it.
 * The distributions are steep (median repo has 10 distinct authors, p90 has
 * 45), so the cap was only ever truncating the handful of subjects where the
 * long tail is the interesting part. Issue-side lists are capped, because their
 * distribution is not remotely the same shape — see ISSUE_TOP_N.
 *
 * Adding the issue store took the file from 6.3 MB to 19 MB, which was worth
 * bounding rather than shrugging at. Four things did most of that:
 *
 *   - Issue window records are packed positionally (12.9 MB → 2.0 MB). Named
 *     objects meant `medianResponseLagHours` written 21,000 times.
 *   - Issue series are sparse month maps rather than padded arrays, and an
 *     empty series is null rather than 240 nulls in a row.
 *   - Backlogs are null when empty and carry bucket counts without their
 *     labels, which the payload states once at the top.
 *   - The 3,900 people whose entire footprint is one or two bug reports get a
 *     slim record — see `substantial`.
 *
 * 19 MB is 3.4 MB gzipped, on a file two of six pages fetch once per session.
 *
 * Labels are the same economy applied a fifth time: every row that carries them
 * carries indexes into one table at the head of the payload rather than the
 * names, which is what makes putting them on tens of thousands of rows cost half
 * a megabyte rather than several. See `packLabels`.
 *
 * Contributor repo breakdowns are still per-window like everything else; the
 * earlier two-window compromise existed to bound exactly the cost that turned
 * out not to matter.
 *
 * Both stores feed this. Pull requests answer "what did they build"; issues
 * answer "what did they sort out", and on this org those are frequently
 * different people — several contributors' entire contribution is triage, and
 * before the issue store was folded in here they showed up on their own
 * drilldown as someone who does nothing. A subject can therefore exist because
 * of issue activity alone, with an empty PR side, and vice versa.
 */

import { readStore } from "../ingest/pullRequests.js";
import { readStore as readIssueStore } from "../ingest/issues.js";
import { isBot, WINDOWS } from "../shared/contributor-rules.js";
import { foldDrilldown } from "../shared/drilldown-fold.js";
import { activeDayIndex } from "./activeDays.js";

export { subjectRows, subjectPayload } from "../shared/drilldown-fold.js";

/**
 * The whole store, folded.
 *
 * All this does is read the three things the fold cannot get for itself and
 * hand them over. The fold moved to `shared/drilldown-fold.js` so the Worker
 * can import it — everything below this line is the part that needs a
 * filesystem, which is exactly the part a Worker does not have.
 */
export async function drilldown(now = Date.now()) {
  const prs = await readStore();

  if (!prs.length) {
    throw new Error(
      "No ingested data. Run `npm run ingest` first — the all-time backfill " +
        "takes a while, but later runs are incremental."
    );
  }

  const issues = await readIssueStore();
  const activeDays = await activeDayIndex(WINDOWS);

  // Earliest issue per reporter, over the whole store. The fold takes this
  // rather than deriving it because a subject scoped to one repo would date
  // each reporter's first to the first one they filed there — see the note at
  // its use, and `subjectPayload`, which refuses to guess it.
  const firstIssueBy = new Map();
  for (const i of issues) {
    if (isBot(i.author) || !i.createdAt) continue;
    const id = `${i.repo}#${i.number}`;
    const prev = firstIssueBy.get(i.author);
    if (!prev || i.createdAt < prev.at || (i.createdAt === prev.at && id < prev.id))
      firstIssueBy.set(i.author, { at: i.createdAt, id });
  }

  return foldDrilldown(now, { prs, issues, activeDays, firstIssueBy });
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
