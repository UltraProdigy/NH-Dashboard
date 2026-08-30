/**
 * "Open pull requests by label" — the fifth Dream Panel card.
 *
 * This was the one genuinely blocked on missing data rather than on a wrong
 * assumption. The other four turned out to need facts the store already had or
 * could be told; this one needs the *managed label set*, which lives in
 * Label-Sync-GTNH and is not something a Worker can go and read. The `labels`
 * table is that gap closed, filled by `worker/backfill-labels.js`.
 *
 * The Node version spends one search request per label —
 * `org:X is:pr is:open label:"L"` — which is why `MAX_TRACKED_LABELS` exists at
 * all. Here the whole card is one query, because every open pull request in the
 * org is a few hundred rows and each already carries its labels.
 *
 * **No `json_each`.** The obvious SQL is to expand `pull_requests.labels` and
 * join it against `labels`, and that would be the right shape at scale. It is
 * not the right shape here: `json_each` is the one D1 feature this store has
 * never exercised, the whole open set is ~450 rows, and grouping them in
 * JavaScript costs nothing measurable. A local SQLite replica proves logic,
 * not dialect — a six-arm UNION passed every local test and failed on the first
 * real recompute — so an untested D1 feature is a deploy spent finding out.
 *
 * The cap is kept even though the cost that motivated it is gone. It decides
 * *which labels the card contains*, and a card whose columns depend on which
 * implementation answered would be worse than one that is bounded.
 */

import { MAX_TRACKED_LABELS } from "../../../src/config.js";
import { row } from "./review-state.js";

/**
 * Open, and that is the whole predicate — no draft exclusion.
 *
 * The two review cards both carry `-is:draft` and this one does not. Sharing
 * their `OPEN` constant would silently drop every draft from the card, which is
 * exactly the kind of difference that looks like a tidy-up and reads as data
 * loss.
 */
const OPEN = `state = 'OPEN' AND merged_at IS NULL`;

export async function byLabel(db, now = Date.now()) {
  const { results: managed } = await db
    .prepare(
      `SELECT name, color FROM labels
        ORDER BY position, name
        LIMIT ?1`,
    )
    .bind(MAX_TRACKED_LABELS ?? -1)
    .all();

  // No managed labels means the backfill has not run. An empty card is the
  // honest answer, and the frontend's `trackedLabels` goes empty with it —
  // visible, unlike a card quietly missing half its columns.
  if (!managed.length) return {};

  const colours = new Map(managed.map((l) => [l.name, l.color]));

  // Every managed label gets a key, including the ones nothing is tagged with.
  // The Node version keeps its empty search results and the frontend reads
  // `Object.keys` as the tracked-label list, so an absent key is not "no open
  // PRs", it is "this label is not tracked".
  const groups = Object.fromEntries(managed.map((l) => [l.name, []]));

  const { results } = await db
    .prepare(
      `SELECT repo, number, title, author, is_draft, labels, created_at, updated_at
         FROM pull_requests
        WHERE ${OPEN} AND labels != '[]'
        ORDER BY created_at ASC, repo, number`,
    )
    .all();

  for (const r of results) {
    let names;
    try {
      names = JSON.parse(r.labels || "[]");
    } catch {
      continue; // A malformed row is one PR missing, not a broken card.
    }

    // Built once per pull request rather than once per label it carries: a PR
    // with four managed labels appears in four groups and they are the same
    // object, which is what the Node version's shared `normalize` result is too.
    let built = null;
    for (const name of names) {
      if (!(name in groups)) continue;
      built ??= row(r, now, colours);
      groups[name].push(built);
    }
  }

  return groups;
}
