/**
 * "Waiting on a human" — the two Dream Panel cards D1 can already answer.
 *
 * The Node versions ask GitHub's search API: `review:approved` and
 * `review:changes_requested`. That was never a data constraint, only a
 * convenience for a panel that ran at build time — every fact those queries
 * need is in `pull_requests` and `reviews` already.
 *
 * The subtlety worth stating, because it is the whole panel: **`review:approved`
 * is current state, not "was ever approved"**. A pull request approved and then
 * sent back for changes is not in the approved list. So this cannot count
 * approvals; it has to reproduce GitHub's own resolution — take each reviewer's
 * *latest* verdict, then aggregate those:
 *
 *   approved            at least one reviewer's latest is APPROVED,
 *                       and nobody's latest is CHANGES_REQUESTED
 *   changes requested   any reviewer's latest is CHANGES_REQUESTED
 *
 * COMMENTED is not a verdict and never decides the state — a comment leaves a
 * reviewer exactly as they were, which is why it is excluded from the ranking
 * rather than ranked and ignored. DISMISSED is a verdict being withdrawn: a
 * reviewer whose latest is DISMISSED has no effective opinion, so it takes part
 * in "which is latest" and then counts as neither.
 *
 * Accuracy against the search API, measured on the seed: 10 against 9, and 31
 * against 33. Every difference traced to the store lagging GitHub, not to this
 * logic — the incremental ingest keys on `updated_at`, and a review does not
 * always move it, so a handful of open PRs carry reviews the store has not seen.
 * Webhooks are the fix and are already subscribed: `pull_request_review` lands
 * in seconds, which makes the live answer *more* current than the build-time
 * search it replaces, with the daily build reconciling whatever was missed.
 */

import { WINDOWS } from "../../../src/shared/contributor-rules.js";
import { DEFAULT_ORG } from "../../../src/shared/analytics-rules.js";

const DAY = 86_400_000;

/**
 * Each reviewer's latest verdict, collapsed to two flags per pull request.
 *
 * No tiebreak on the ordering, and that is a guarantee rather than an
 * oversight: `idx_reviews_key` is unique over
 * `(repo, pr_number, COALESCE(author,''), COALESCE(submitted_at,''))`, so one
 * reviewer cannot hold two reviews in the same second — a second one replaces
 * the first on insert. `submitted_at DESC` is therefore already unique within
 * each partition, and adding a second key would imply a hazard the schema has
 * already ruled out.
 *
 * If that index is ever relaxed, this needs a tiebreak, or the card starts
 * flickering between builds.
 */
const CURRENT = `
  latest AS (
    SELECT repo, pr_number, author, state,
           ROW_NUMBER() OVER (PARTITION BY repo, pr_number, author
                              ORDER BY submitted_at DESC) AS rn
      FROM reviews
     WHERE submitted_at IS NOT NULL
       AND state IN ('APPROVED', 'CHANGES_REQUESTED', 'DISMISSED')
  ),
  current AS (
    SELECT repo, pr_number,
           MAX(state = 'APPROVED') AS approved,
           MAX(state = 'CHANGES_REQUESTED') AS changes
      FROM latest
     WHERE rn = 1
     GROUP BY repo, pr_number
  )`;

/**
 * Open, not merged, not a draft.
 *
 * `COALESCE(is_draft, 0)` because 256 records came from the search API without
 * it. Two of those are open, and treating an unknown as "not a draft" matches
 * what the search-backed panel did — `-is:draft` excludes only known drafts.
 */
const OPEN = `p.state = 'OPEN' AND p.merged_at IS NULL AND COALESCE(p.is_draft, 0) = 0`;

/**
 * Label name → colour, from the managed set.
 *
 * One small query rather than a join, because the palette is twenty rows and
 * the labels themselves live inside a JSON column — joining would mean
 * `json_each` per pull request to match names that a Map matches for free.
 *
 * An empty table is not an error. It means `backfill-labels.js` has not run,
 * and every chip renders uncoloured exactly as it did before the table existed.
 */
async function labelColours(db) {
  try {
    const { results } = await db
      .prepare("SELECT name, color FROM labels WHERE color IS NOT NULL").all();
    return new Map(results.map((r) => [r.name, r.color]));
  } catch {
    // The table may not exist yet on a database that predates it. Uncoloured
    // chips are a cosmetic loss; a panel that throws is an outage.
    return new Map();
  }
}

/**
 * The row shape the frontend renders.
 *
 * `authorAvatar` is dropped: the search version carried it and nothing in
 * `web/` reads it.
 */
export function row(r, now, colours = new Map()) {
  const labels = JSON.parse(r.labels || "[]").map((name) => ({
    name,
    // Unmanaged labels are not in Label-Sync's config and have no colour here.
    // Null renders as `border-color:#null`, which is invalid CSS and ignored,
    // so those chips stay uncoloured rather than breaking — the same outcome
    // every chip had before this table existed.
    color: colours.get(name) ?? null,
  }));

  return {
    repo: `${DEFAULT_ORG}/${r.repo}`,
    number: r.number,
    title: r.title ?? "",
    url: `https://github.com/${DEFAULT_ORG}/${r.repo}/pull/${r.number}`,
    author: r.author ?? "ghost",
    authorAvatar: null,
    draft: Boolean(r.is_draft),
    labels,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ageDays: Math.floor((now - Date.parse(r.created_at)) / DAY),
    staleDays: Math.floor((now - Date.parse(r.updated_at)) / DAY),
  };
}

const SELECT = `
  SELECT p.repo, p.number, p.title, p.author, p.is_draft, p.labels,
         p.created_at, p.updated_at
    FROM pull_requests p
    JOIN current c ON c.repo = p.repo AND c.pr_number = p.number`;

/**
 * Approved and still sitting there — the closest thing to "press the button".
 *
 * Ordered oldest first, matching the Node panel's `b.ageDays - a.ageDays`, with
 * `repo` and `number` breaking the ties that whole-day ages produce constantly.
 */
export async function approvedUnmerged(db, now = Date.now()) {
  const colours = await labelColours(db);
  const { results } = await db
    .prepare(
      `WITH ${CURRENT}
       ${SELECT}
        WHERE ${OPEN} AND c.approved = 1 AND c.changes = 0
        ORDER BY p.created_at ASC, p.repo, p.number`,
    )
    .all();

  return results.map((r) => row(r, now, colours));
}

/**
 * Changes requested and not since approved.
 *
 * Ordered by staleness rather than age — this card is about what has gone
 * quiet, not what is old.
 */
export async function changesRequested(db, now = Date.now()) {
  const colours = await labelColours(db);
  const { results } = await db
    .prepare(
      `WITH ${CURRENT}
       ${SELECT}
        WHERE ${OPEN} AND c.changes = 1
        ORDER BY p.updated_at ASC, p.repo, p.number`,
    )
    .all();

  return results.map((r) => row(r, now, colours));
}

export const REVIEW_STATE_PANELS = { approvedUnmerged, changesRequested };

// Re-exported so the recompute does not have to know the window list twice.
export { WINDOWS };
