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
import { ORG } from "../config.js";

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
  createdAt
  updatedAt
  mergedAt
  state
  isDraft
  author { login }
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

const toRecord = (repo, pr) => ({
  repo,
  number: pr.number,
  author: pr.author?.login ?? null,
  createdAt: pr.createdAt,
  updatedAt: pr.updatedAt,
  mergedAt: pr.mergedAt,
  state: pr.state,
  isDraft: pr.isDraft,
  // Truncation is recorded so aggregation can flag undercounts rather than
  // silently reporting wrong numbers.
  reviewsTruncated: pr.reviews.totalCount > pr.reviews.nodes.length,
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
    repos.push(...page.nodes);
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
 * Re-fetch open PRs that predate a field being added to the query.
 *
 * The incremental walk is watermark-driven: a PR that hasn't been updated
 * since the last run is never re-fetched, so adding a field to the query only
 * populates it for PRs that happen to change afterwards. Everything already in
 * the store keeps whatever shape it had.
 *
 * This closes that gap for `isDraft` without a full 28k-PR re-walk. It's
 * scoped to open PRs because draft status is meaningless on a merged or closed
 * one, and scoped to repos that actually hold such a PR, which is ~100 of the
 * org's repos rather than all 1,400.
 *
 * Self-limiting: the set it works on is "open records missing the field", so
 * once they're filled in this costs one local store read and zero requests.
 */
async function backfillOpenDrafts() {
  clearStoreCache(); // the main pass just appended; don't read a stale memo
  const stale = (await readStore()).filter(
    (p) => p.state === "OPEN" && p.isDraft === undefined
  );
  if (!stale.length) return 0;

  const repos = [...new Set(stale.map((p) => p.repo))];
  console.log(
    `  backfilling draft status: ${stale.length} open PRs across ${repos.length} repos`
  );

  let written = 0;
  for (const repo of repos) {
    const records = [];
    let cursor = null;
    try {
      while (true) {
        const data = await graphql(OPEN_PRS, { owner: ORG, name: repo, cursor });
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
      await appendFile(
        STORE_FILE,
        records.map((r) => JSON.stringify(r)).join("\n") + "\n"
      );
      written += records.length;
    }
  }

  // These appends aren't in the memo either, and compaction reads it next.
  clearStoreCache();
  return written;
}

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
  const backfilled = await backfillOpenDrafts();

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
