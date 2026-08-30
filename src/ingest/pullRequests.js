/**
 * All-time PR + review ingestion.
 *
 * Why this exists: review approvals are nested one level under each PR, so
 * there is no query that answers "how many reviews has X approved" directly.
 * The only way is to walk every PR in the org and read its review list. That's
 * far too slow to do live, so we do it once, store it, then update incrementally.
 *
 * Design notes:
 *   - Resumable. State is saved after every repo, so a run killed halfway
 *     picks up where it left off rather than starting over. Necessary when the
 *     first pass over 1400+ repos can take a while.
 *   - Incremental. Each repo records the newest PR update timestamp it has
 *     seen. Later runs walk PRs newest-first and stop early once they reach
 *     already-seen territory.
 *   - Upsert semantics. Records are keyed repo#number and written append-only;
 *     aggregation keeps the last record for a key. This is what makes late
 *     reviews on old PRs correct — the PR gets re-fetched and its newer record
 *     wins.
 */

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { graphql } from "../github/client.js";
import { ORG, isIngestExcluded } from "../config.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Overridable so tests can point at a scratch directory. Without this, a test
 * that writes fixtures to the store path destroys a real all-time ingest —
 * which is exactly what happened once.
 */
export const STORE_DIR =
  process.env.NH_STORE_DIR || path.join(ROOT, "data", "ingest");
export const STORE_FILE = path.join(STORE_DIR, "prs.ndjson");
const STATE_FILE = path.join(STORE_DIR, "state.json");

const REPOS = `
  query($org: String!, $cursor: String) {
    organization(login: $org) {
      repositories(first: 100, after: $cursor, orderBy: { field: PUSHED_AT, direction: DESC }) {
        pageInfo { hasNextPage endCursor }
        # Archived repos are included on purpose — their PR history still
        # counts toward all-time contributor totals.
        nodes { name pushedAt isArchived }
      }
    }
  }
`;

/** Shared by both PR queries so the two can't drift into different shapes. */
const PR_FIELDS = `
  number
  title
  createdAt
  updatedAt
  mergedAt
  state
  isDraft
  author { login }
  # Diff size and commit count. All scalars on the PR itself, so they cost
  # nothing in nodes — the expensive part of adding them was the one-time
  # re-walk to populate records that predate the field.
  additions
  deletions
  changedFiles
  commits { totalCount }
  # Issue comments on the PR. Review comments are counted separately via
  # reviews below; conflating the two would make a PR with one long review
  # thread look like a contentious one.
  comments { totalCount }
  # Who owns the PR, and who has been asked to look at it. The two behave
  # differently over a PR's life and the records have to reflect that:
  # assignment survives the close, so it's meaningful on every record, while a
  # review request is deleted by GitHub the moment the review lands. On
  # anything closed the request list is therefore empty, and that's the truth
  # rather than a gap — nobody is waiting on a merged PR.
  assignees(first: 10) { nodes { login } }
  # What the PR is tagged as. Ten is generous — the busiest PR in the org
  # carries four — and the connection is cheap next to reviews(first: 50).
  # The Dream Panel gets its labels from a search query instead, because it
  # only ever asks about a handful of tracked names and a search is one
  # request for all of them; these are for the drilldowns, which need whatever
  # happens to be on the PR in front of you.
  labels(first: 10) { nodes { name } }
  # Individual reviewers only. A team request resolves to a Team, which has a
  # name rather than a login, and attributing one to its members needs org
  # read that this token doesn't have — so it selects nothing here and drops
  # out below rather than landing as a null in somebody's queue.
  reviewRequests(first: 20) {
    nodes { requestedReviewer { ... on User { login } } }
  }
  # totalCount only, no nodes — a reaction connection with no pagination args
  # is a scalar as far as the node budget is concerned.
  reactions { totalCount }
  thumbsUp: reactions(content: THUMBS_UP) { totalCount }
  thumbsDown: reactions(content: THUMBS_DOWN) { totalCount }
  # 50 PRs x 50 reviews = 2500 nodes/query, still well inside limits.
  # At 20 this truncated ~90 heavily-reviewed PRs; 50 covers all but a
  # handful, and reviewsTruncated flags whatever still overflows.
  reviews(first: 50) {
    totalCount
    nodes {
      state
      submittedAt
      author { login }
    }
  }
`;

const PRS = `
  query($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequests(
        first: 50
        after: $cursor
        orderBy: { field: UPDATED_AT, direction: DESC }
      ) {
        pageInfo { hasNextPage endCursor }
        nodes { ${PR_FIELDS} }
      }
    }
  }
`;

/** Open PRs only — used by the draft backfill, which has no watermark to walk. */
const OPEN_PRS = `
  query($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequests(
        first: 50
        after: $cursor
        states: OPEN
        orderBy: { field: UPDATED_AT, direction: DESC }
      ) {
        pageInfo { hasNextPage endCursor }
        nodes { ${PR_FIELDS} }
      }
    }
  }
`;

/**
 * Titles are trimmed on the way in.
 *
 * They're the single largest field on the store — 28k of them — and a
 * ranked-list row ellipsises long past this anyway. 160 characters keeps every
 * normal title intact and clips only the handful that are really a paragraph.
 */
const MAX_TITLE = 160;

const toRecord = (repo, pr) => ({
  repo,
  number: pr.number,
  title: pr.title ? pr.title.slice(0, MAX_TITLE) : null,
  author: pr.author?.login ?? null,
  createdAt: pr.createdAt,
  updatedAt: pr.updatedAt,
  mergedAt: pr.mergedAt,
  state: pr.state,
  isDraft: pr.isDraft,
  // Diff size and effort. `changedFiles` is what separates "one generated file
  // regenerated" from "a real 4,000-line change" when the LoC numbers look
  // implausible, which on a modpack org they regularly do.
  additions: pr.additions,
  deletions: pr.deletions,
  changedFiles: pr.changedFiles,
  commits: pr.commits?.totalCount ?? 0,
  // Engagement. Review count is derived from the review list rather than
  // stored, but the comment and reaction totals have no other source.
  comments: pr.comments?.totalCount ?? 0,
  reactions: pr.reactions?.totalCount ?? 0,
  thumbsUp: pr.thumbsUp?.totalCount ?? 0,
  thumbsDown: pr.thumbsDown?.totalCount ?? 0,
  assignees: (pr.assignees?.nodes ?? []).map((a) => a.login).filter(Boolean),
  labels: (pr.labels?.nodes ?? []).map((l) => l.name).filter(Boolean),
  reviewRequests: (pr.reviewRequests?.nodes ?? [])
    .map((n) => n.requestedReviewer?.login)
    .filter(Boolean),
  // Truncation is recorded so aggregation can flag undercounts rather than
  // silently reporting wrong numbers.
  reviewsTruncated: pr.reviews.totalCount > pr.reviews.nodes.length,
  reviewCount: pr.reviews.totalCount,
  reviews: pr.reviews.nodes.map((r) => ({
    author: r.author?.login ?? null,
    state: r.state,
    submittedAt: r.submittedAt,
  })),
});

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    return { repos: {} };
  }
}

async function saveState(state) {
  await mkdir(STORE_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

async function listRepos() {
  const repos = [];
  let cursor = null;

  while (true) {
    const data = await graphql(REPOS, { org: ORG, cursor });
    const page = data.organization?.repositories;
    if (!page) break;
    // Excluded repos are dropped here so they are never walked at all — the
    // point of an ingest-level exclusion is that no later stage has to
    // remember, and a panel that forgets a predicate cannot leak them.
    repos.push(...page.nodes.filter((r) => !isIngestExcluded(r.name)));
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }

  return repos;
}

/** Walk one repo's PRs newest-first, stopping once we reach seen territory. */
async function ingestRepo(repo, seenThrough) {
  const records = [];
  let cursor = null;
  let newest = seenThrough;

  outer: while (true) {
    const data = await graphql(PRS, { owner: ORG, name: repo, cursor });
    const page = data.repository?.pullRequests;
    if (!page) break;

    for (const pr of page.nodes) {
      // Newest-first ordering means the first already-seen PR implies every
      // remaining PR is also already seen.
      if (seenThrough && pr.updatedAt <= seenThrough) break outer;

      if (!newest || pr.updatedAt > newest) newest = pr.updatedAt;

      records.push(toRecord(repo, pr));
    }

    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }

  return { records, newest };
}

/**
 * Re-fetch records that predate a field being added to the query.
 *
 * The incremental walk is watermark-driven: a PR that hasn't been updated
 * since the last run is never re-fetched, so adding a field to the query only
 * populates it for PRs that happen to change afterwards. Everything already in
 * the store keeps whatever shape it had.
 *
 * Rather than a bespoke pass per field, this takes a predicate for "records
 * that still need it" and a query to re-walk the repos holding them with. Two
 * shapes are in use:
 *
 *   - `OPEN_PRS`, for a field only meaningful on an open PR (draft status).
 *     Cheap: ~118 requests against the 570 a full re-walk costs.
 *   - `PRS`, for a field meaningful on every PR (diff size, comments,
 *     reactions, titles). That *is* the full re-walk, but it's paid once.
 *
 * Every pass is self-limiting for the same reason: the set it works on is
 * "records missing the field", so once they're filled in it costs one local
 * store read and zero requests. It's also naturally resumable — records
 * written before an interruption already carry the field, so the next run
 * picks up at the repos that didn't get there.
 */
async function backfillField({ label, query, needs }) {
  clearStoreCache(); // the main pass just appended; don't read a stale memo
  const stale = (await readStore()).filter(needs);
  if (!stale.length) return 0;

  const repos = [...new Set(stale.map((p) => p.repo))];
  console.log(`  backfilling ${label}: ${stale.length} PRs across ${repos.length} repos`);

  let written = 0;
  let done = 0;

  for (const repo of repos) {
    const records = [];
    let cursor = null;
    try {
      while (true) {
        const data = await graphql(query, { owner: ORG, name: repo, cursor });
        const page = data.repository?.pullRequests;
        if (!page) break;
        for (const pr of page.nodes) records.push(toRecord(repo, pr));
        if (!page.pageInfo.hasNextPage) break;
        cursor = page.pageInfo.endCursor;
      }
    } catch (err) {
      // Leave the records alone so the next run retries this repo.
      console.warn(`  ${repo}: ${err.message.split("\n")[0]}`);
      continue;
    }

    if (records.length) {
      // Appended per repo rather than batched at the end: this pass can run for
      // a while on its first outing, and a Ctrl-C should keep what it earned.
      await appendFile(
        STORE_FILE,
        records.map((r) => JSON.stringify(r)).join("\n") + "\n"
      );
      written += records.length;
    }

    if (++done % 25 === 0)
      console.log(`  ${done}/${repos.length} repos, ${written} records re-fetched`);
  }

  // These appends aren't in the memo either, and compaction reads it next.
  clearStoreCache();
  return written;
}

/**
 * Which backfills run, in order. Draft status first because it's the cheap one
 * and the expensive pass may well be interrupted.
 *
 * `additions` stands in for the whole diff-size/engagement/title group — they
 * were all added in the same change and are fetched by the same query, so one
 * of them being absent means all of them are.
 */
const BACKFILLS = [
  {
    label: "draft status",
    query: OPEN_PRS,
    needs: (p) => p.state === "OPEN" && p.isDraft === undefined,
  },
  // Pending review requests only exist on open PRs, so this is the cheap shape
  // even though the field is new to every record in the store.
  {
    label: "review requests",
    query: OPEN_PRS,
    needs: (p) => p.state === "OPEN" && p.reviewRequests === undefined,
  },
  {
    label: "diff size, comments, reactions and titles",
    query: PRS,
    needs: (p) => p.additions === undefined,
  },
  // Last, and deliberately: assignment outlives the close, so this one has no
  // cheap shape — it's the full re-walk. Putting it after the diff-size pass
  // means a store that needs both pays for one, since that pass re-fetches
  // with the same query and fills this field on its way through.
  {
    label: "assignees",
    query: PRS,
    needs: (p) => p.assignees === undefined,
  },
  // Labels are on every PR whatever state it's in, so this is the full re-walk
  // too — and it's last for the reason the assignees pass is second to last: by
  // the time it runs, any store that also needed one of the passes above has
  // already had these filled in on the way through, since they all re-fetch
  // through the same `toRecord`. On a store that needs only this one it costs a
  // walk of its own, which is the price of the field.
  {
    label: "labels",
    query: PRS,
    needs: (p) => p.labels === undefined,
  },
];

export async function ingest({ limit = Infinity } = {}) {
  const state = await loadState();
  await mkdir(STORE_DIR, { recursive: true });

  const repos = await listRepos();
  console.log(`  ${repos.length} repos in ${ORG}`);

  let processed = 0;
  let written = 0;

  for (const repo of repos) {
    if (processed >= limit) break;

    const prev = state.repos[repo.name];

    // Nothing pushed since we last looked — no PR activity possible.
    if (prev?.seenThrough && repo.pushedAt <= prev.seenThrough) {
      processed++;
      continue;
    }

    try {
      const { records, newest } = await ingestRepo(repo.name, prev?.seenThrough);

      if (records.length) {
        await appendFile(
          STORE_FILE,
          records.map((r) => JSON.stringify(r)).join("\n") + "\n"
        );
        written += records.length;
      }

      // A repo with no PRs at all yields no watermark, which would make every
      // future run re-walk it. Fall back to its pushedAt so the cheap
      // "nothing pushed since" skip above can catch it next time.
      state.repos[repo.name] = {
        seenThrough: newest ?? repo.pushedAt,
        at: new Date().toISOString(),
      };
    } catch (err) {
      console.warn(`  ${repo.name}: ${err.message.split("\n")[0]}`);
      // Leave state untouched so the next run retries this repo.
    }

    processed++;

    // Save often — this is what makes an interrupted run resumable.
    if (processed % 25 === 0) {
      await saveState(state);
      console.log(`  ${processed}/${repos.length} repos, ${written} PR records`);
    }
  }

  await saveState(state);

  // After the main pass, so anything it already refreshed is skipped.
  let backfilled = 0;
  for (const b of BACKFILLS) backfilled += await backfillField(b);

  const { before, after } = await compactStore();
  console.log(
    `  done: ${processed} repos, ${written} new/updated PR records` +
      (backfilled ? `, ${backfilled} backfilled` : "") +
      (before !== after ? `, compacted ${before} → ${after} lines` : "")
  );

  return { processed, written, backfilled };
}

/**
 * Rewrite the store deduplicated and sorted.
 *
 * Writes during a run are append-only so an interrupted run can't corrupt the
 * file. But the store is committed to git, and append-only means every updated
 * PR leaves a dead record behind — the file would grow without bound and each
 * commit would look like a huge diff.
 *
 * Sorting by repo then number makes the output deterministic, so git sees only
 * the lines that actually changed between runs rather than a reshuffled file.
 */
export async function compactStore() {
  // Copied before sorting: readStore memoizes and hands every caller the same
  // array, so sorting in place would reorder it underneath them.
  const records = [...(await readStore())]; // already dedupes, newest per key

  let before = 0;
  try {
    const raw = await readFile(STORE_FILE, "utf8");
    before = raw.trim() ? raw.trim().split("\n").length : 0;
  } catch {
    return { before: 0, after: 0 };
  }

  records.sort((a, b) =>
    a.repo === b.repo ? a.number - b.number : a.repo.localeCompare(b.repo)
  );

  // Write to a temp file then rename, so an interrupted compaction can't
  // leave a half-written store behind.
  const tmp = `${STORE_FILE}.tmp`;
  await writeFile(tmp, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  await rename(tmp, STORE_FILE);

  return { before, after: records.length };
}

/**
 * Memoized so a build that reads the store from three panels parses the 9.5 MB
 * file once instead of three times. Scoped to the process, so the ingest —
 * which mutates the file and then compacts it — is unaffected: it runs as its
 * own process and calls readStore exactly once, after the writes are done.
 */
let storeCache = null;

/** Drop the memo. Only tests need this, when they swap NH_STORE_DIR mid-run. */
export function clearStoreCache() {
  storeCache = null;
}

/**
 * Read the store back, keeping only the newest record per repo#number.
 * The file is append-only, so later lines supersede earlier ones.
 *
 * Callers must treat the result as read-only — they all share one array now.
 * The panels only ever read it, and `compactStore` sorts a copy for exactly
 * this reason.
 */
export async function readStore() {
  if (storeCache) return storeCache;
  const byKey = new Map();

  try {
    const rl = createInterface({
      input: createReadStream(STORE_FILE),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        // Filtered on the way out as well as on the way in. The exclusion list
        // can grow after a repo is already in the store, and re-walking all-time
        // history to honour it would take an hour — this makes the next build
        // clean without one, and makes a stale store safe to keep.
        if (isIngestExcluded(rec.repo)) continue;
        byKey.set(`${rec.repo}#${rec.number}`, rec);
      } catch {
        /* skip a torn line from an interrupted write */
      }
    }
  } catch (err) {
    // Not memoized: an absent store is cheap to re-check, and caching it would
    // make a build that runs straight after an ingest see nothing.
    if (err.code === "ENOENT") return [];
    throw err;
  }

  storeCache = [...byKey.values()];
  return storeCache;
}
