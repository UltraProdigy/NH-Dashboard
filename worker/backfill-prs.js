/**
 * Reconcile pull requests and reviews in D1 against GitHub.
 *
 *   node --env-file-if-exists=.env worker/backfill-prs.js --since 2026-08-29 --out worker/prs.sql
 *   cd worker && npx wrangler d1 execute nh-dashboard --remote --file prs.sql
 *
 * Why this exists, and why it is not the seed:
 *
 * `seed.js` loaded D1 once from the NDJSON store and every row since has come
 * from a webhook delivery. That makes the store forward-only — GitHub does not
 * re-send a delivery it has already made, `handleWebhook` answers 200 even when
 * the handler threw, and the daily workflow writes `data/*.json` rather than
 * D1. So a delivery that never arrives, or arrives and fails, leaves a row
 * wrong permanently and silently. `index.js` promises "the reconcile sweep will
 * correct whatever was missed". This is that sweep; until now it did not exist.
 *
 * The gap that made it necessary is on the record: the crawl behind the seed
 * ran around 18:35–19:00 UTC on 2026-08-29, the seed loaded at ~19:20, and the
 * webhook only went live at ~19:52. Three PRs merged inside that window —
 * Variable-Horizons#11, GT5-Unofficial#7891, Applied-Energistics-2-Unofficial
 * #1558 — and stayed OPEN in D1 for days, sitting on the "approved, not merged"
 * card long after they were merged. The panel SQL was right the whole time.
 *
 * Correctness notes that would be easy to get wrong:
 *
 *   **Upsert, not INSERT OR REPLACE.** `seed.js` uses the latter because it
 *   writes into an empty table. Here the rows already exist and carry columns
 *   GraphQL does not return — `merge_commit_sha` above all, which the commit
 *   join depends on. Replacing a row would null it, and the commits it orphans
 *   would quietly start reading as direct pushes. So the conflict clause names
 *   its columns, exactly as `onPullRequest` does.
 *
 *   **Reviews are replaced per PR, not merged.** A review can be dismissed or
 *   deleted, and `review:approved` is current state rather than history — an
 *   upsert alone can only ever add, so a review GitHub no longer reports would
 *   keep a PR on the approved card forever. The delete is skipped when the
 *   list came back truncated, because deleting fifty-one reviews to reinsert
 *   fifty would lose one.
 */

import { createWriteStream } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { graphql, stats } from "../src/github/client.js";
import { ORG, isIngestExcluded } from "../src/config.js";

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (!arg.startsWith("--")) continue;
  const [key, inline] = arg.slice(2).split("=");
  const next = process.argv[i + 1];
  if (inline !== undefined) args.set(key, inline);
  else if (next && !next.startsWith("--")) args.set(key, process.argv[++i]);
  else args.set(key, true);
}

const OUT = args.get("out") ?? "worker/prs.sql";
const PARTIAL = `${OUT}.partial`;
const DAYS = Number(args.get("days") ?? 7);

/**
 * The window, as an ISO instant.
 *
 * A PR enters it by `updatedAt`, and a merge always moves `updatedAt`, so any
 * PR whose state changed inside the window is reachable. What the window cannot
 * reach is a row that went wrong and has been quiet ever since — for that,
 * widen it. `--since` covering the whole life of the store is a legitimate run;
 * it is just a slow one.
 */
const SINCE = args.get("since")
  ? new Date(String(args.get("since"))).toISOString()
  : new Date(Date.now() - DAYS * 86_400_000).toISOString();

if (Number.isNaN(Date.parse(SINCE))) {
  console.error(`\n  --since is not a date: ${args.get("since")}\n`);
  process.exit(1);
}

const MAX_TITLE = 160;
const ROWS_PER_STATEMENT = 200;

function q(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replace(/'/g, "''")}'`;
}

const jsonList = (value) => q(JSON.stringify(value ?? []));

const REPOS = `
  query($org: String!, $cursor: String) {
    organization(login: $org) {
      repositories(first: 100, after: $cursor, orderBy: { field: PUSHED_AT, direction: DESC }) {
        pageInfo { hasNextPage endCursor }
        nodes { name }
      }
    }
  }
`;

/**
 * `closedAt` is here and absent from the ingest's own field list, which is why
 * every seeded row carries a null one. A PR closed without merging is not
 * merged and not open, and the store had no column answering that.
 */
const PR_FIELDS = `
  number
  title
  createdAt
  updatedAt
  mergedAt
  closedAt
  state
  isDraft
  author { login }
  additions
  deletions
  changedFiles
  commits { totalCount }
  comments { totalCount }
  assignees(first: 10) { nodes { login } }
  labels(first: 10) { nodes { name } }
  reviewRequests(first: 20) {
    nodes { requestedReviewer { ... on User { login } } }
  }
  reactions { totalCount }
  thumbsUp: reactions(content: THUMBS_UP) { totalCount }
  thumbsDown: reactions(content: THUMBS_DOWN) { totalCount }
  reviews(first: 50) {
    totalCount
    nodes { state submittedAt author { login } }
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

const PR_COLUMNS = [
  "repo", "number", "title", "author", "created_at", "updated_at", "merged_at",
  "closed_at", "state", "is_draft", "additions", "deletions", "changed_files",
  "commits", "comments", "reactions", "thumbs_up", "thumbs_down",
  "review_count", "reviews_truncated", "labels", "assignees", "review_requests",
];

/** Everything but the key. `merge_commit_sha` is not here on purpose. */
const PR_UPDATES = PR_COLUMNS.slice(2)
  .map((c) => `  ${c} = excluded.${c}`)
  .join(",\n");

const REVIEW_COLUMNS = ["repo", "pr_number", "author", "state", "submitted_at"];

export function prRow(repo, pr) {
  return [
    q(repo),
    q(pr.number),
    q(pr.title ? pr.title.slice(0, MAX_TITLE) : null),
    q(pr.author?.login ?? null),
    q(pr.createdAt),
    q(pr.updatedAt),
    q(pr.mergedAt ?? null),
    q(pr.closedAt ?? null),
    q(pr.state),
    q(pr.isDraft ?? null),
    q(pr.additions ?? null),
    q(pr.deletions ?? null),
    q(pr.changedFiles ?? null),
    q(pr.commits?.totalCount ?? null),
    q(pr.comments?.totalCount ?? null),
    q(pr.reactions?.totalCount ?? null),
    q(pr.thumbsUp?.totalCount ?? null),
    q(pr.thumbsDown?.totalCount ?? null),
    q(pr.reviews?.totalCount ?? null),
    q((pr.reviews?.totalCount ?? 0) > (pr.reviews?.nodes?.length ?? 0)),
    jsonList((pr.labels?.nodes ?? []).map((l) => l.name).filter(Boolean)),
    jsonList((pr.assignees?.nodes ?? []).map((a) => a.login).filter(Boolean)),
    jsonList(
      (pr.reviewRequests?.nodes ?? [])
        .map((n) => n.requestedReviewer?.login)
        .filter(Boolean),
    ),
  ];
}

export const prUpsert = (rows) =>
  `INSERT INTO pull_requests (${PR_COLUMNS.join(",")}) VALUES\n` +
  rows.join(",\n") +
  `\nON CONFLICT (repo, number) DO UPDATE SET\n${PR_UPDATES};\n`;

export const reviewUpsert = (rows) =>
  `INSERT OR REPLACE INTO reviews (${REVIEW_COLUMNS.join(",")}) VALUES\n` +
  rows.join(",\n") +
  ";\n";

export const clearReviewsSql = (repo, number) =>
  `DELETE FROM reviews WHERE repo = ${q(repo)} AND pr_number = ${q(number)};\n`;

class Writer {
  constructor(stream) {
    this.stream = stream;
    this.prs = [];
    this.reviews = [];
    this.counts = { prs: 0, reviews: 0, cleared: 0 };
  }

  pr(values) {
    this.prs.push(`(${values.join(",")})`);
    this.counts.prs++;
    if (this.prs.length >= ROWS_PER_STATEMENT) this.flushPrs();
  }

  clearReviews(repo, number) {
    this.flushReviews();
    this.stream.write(clearReviewsSql(repo, number));
    this.counts.cleared++;
  }

  review(values) {
    this.reviews.push(`(${values.join(",")})`);
    this.counts.reviews++;
    if (this.reviews.length >= ROWS_PER_STATEMENT) this.flushReviews();
  }

  flushPrs() {
    if (!this.prs.length) return;
    this.stream.write(prUpsert(this.prs));
    this.prs = [];
  }

  flushReviews() {
    if (!this.reviews.length) return;
    this.stream.write(reviewUpsert(this.reviews));
    this.reviews = [];
  }

  flush() {
    this.flushPrs();
    this.flushReviews();
  }
}

/** `--repos=A,B` narrows the walk. The exclusion still applies to the names. */
const ONLY = args.get("repos")
  ? new Set(String(args.get("repos")).split(",").map((s) => s.trim()).filter(Boolean))
  : null;

async function listRepos() {
  if (ONLY) return [...ONLY].filter((name) => !isIngestExcluded(name));

  const repos = [];
  let cursor = null;

  for (;;) {
    const data = await graphql(REPOS, { org: ORG, cursor });
    const page = data.organization.repositories;
    for (const node of page.nodes ?? []) {
      if (!node?.name || isIngestExcluded(node.name)) continue;
      repos.push(node.name);
    }
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }

  return repos;
}

/**
 * Walk one repo newest-first and stop at the window.
 *
 * The ordering is what makes this cheap: the first PR older than `SINCE` means
 * every PR after it is older too, so a quiet repo costs one query.
 */
async function walkRepo(name, w, tally) {
  let cursor = null;

  for (;;) {
    const data = await graphql(PRS, { owner: ORG, name, cursor });
    const page = data.repository?.pullRequests;
    if (!page) return;

    for (const pr of page.nodes ?? []) {
      if (!pr?.number) continue;
      if (pr.updatedAt < SINCE) return;

      w.pr(prRow(name, pr));
      tally[pr.state] = (tally[pr.state] ?? 0) + 1;

      const nodes = pr.reviews?.nodes ?? [];
      const truncated = (pr.reviews?.totalCount ?? 0) > nodes.length;
      if (!truncated) w.clearReviews(name, pr.number);
      for (const rv of nodes) {
        w.review([
          q(name),
          q(pr.number),
          q(rv.author?.login ?? null),
          q(rv.state),
          q(rv.submittedAt ?? null),
        ]);
      }
    }

    if (!page.pageInfo.hasNextPage) return;
    cursor = page.pageInfo.endCursor;
  }
}

async function main() {
  console.log(`\nReconciling ${ORG} pull requests updated since ${SINCE}\n`);

  const repos = await listRepos();
  console.log(`  ${repos.length} repos to walk\n`);

  // Written aside and renamed at the end. A run killed halfway would otherwise
  // leave a file that parses, applies cleanly, and covers an arbitrary prefix
  // of the org — and nothing in it says which repos it reached.
  const out = createWriteStream(PARTIAL);
  out.write(`-- Generated by worker/backfill-prs.js on ${new Date().toISOString()}\n`);
  out.write(`-- ${ORG} pull requests updated since ${SINCE}\n\n`);

  const w = new Writer(out);
  const tally = {};
  let done = 0;

  for (const name of repos) {
    await walkRepo(name, w, tally);
    if (++done % 25 === 0) console.log(`  ${done}/${repos.length} repos`);
  }

  w.flush();
  await new Promise((resolve) => out.end(resolve));
  await rename(PARTIAL, OUT);

  const states = Object.entries(tally)
    .map(([state, n]) => `${n} ${state.toLowerCase()}`)
    .join(", ");

  console.log(
    `\n  ${w.counts.prs} pull requests (${states || "none"})\n` +
      `  ${w.counts.reviews} reviews, ${w.counts.cleared} review lists replaced\n` +
      `  ${stats.requests} API requests\n\n` +
      `  wrote ${OUT}\n\n` +
      `  npx wrangler d1 execute nh-dashboard --remote --file ${OUT.replace(/^worker\//, "")}\n` +
      `  (run from the worker/ directory)\n`,
  );
}

// Guarded so the test can import the statement builders without walking the
// org. Everything above this line is pure.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (err) => {
    await unlink(PARTIAL).catch(() => {});
    console.error(`\n  failed: ${err.message}\n  D1 keeps whatever it already had.\n`);
    process.exit(1);
  });
}
