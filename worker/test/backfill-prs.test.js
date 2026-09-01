/**
 * The reconciler's SQL, applied to a real SQLite database.
 *
 *   node --experimental-sqlite worker/test/backfill-prs.test.js
 *
 * This is written against the failure it exists to repair. A PR merged between
 * the seed's crawl and the webhook going live stayed OPEN in D1 with a null
 * `merged_at`, and `approvedUnmerged` went on listing it for days because the
 * panel's own SQL was correct — it was answering truthfully about a row that
 * was not. So the assertions are the two halves of that: the row flips, and the
 * columns GitHub cannot tell us about survive the flip.
 *
 * `merge_commit_sha` is the one that would fail silently. It is absent from the
 * GraphQL field list, so an INSERT OR REPLACE — which is what the seed uses and
 * the obvious thing to copy — would null it, and the commits it orphans would
 * start reading as direct pushes on a card nobody would think to check.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

import { prRow, prUpsert, clearReviewsSql, reviewUpsert } from "../backfill-prs.js";
import { approvedUnmerged } from "../src/panels/review-state.js";

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failed++;
  console.log(
    `  ${ok ? "ok  " : "FAIL"}  ${name}` +
      (ok
        ? ""
        : `\n          expected ${JSON.stringify(expected)}\n          got      ${JSON.stringify(actual)}`),
  );
}

const raw = new DatabaseSync(":memory:");
raw.exec(readFileSync("worker/schema.sql", "utf8"));

const db = {
  prepare(sql, bound = []) {
    return {
      sql,
      bound,
      bind: (...args) => db.prepare(sql, args),
      async first() {
        return raw.prepare(sql).get(...bound) ?? null;
      },
      async all() {
        return { results: raw.prepare(sql).all(...bound) };
      },
    };
  },
};

// The stuck row, exactly as production held it: approved, merged on GitHub an
// hour later, and frozen at the approval because the merge delivery landed in
// the gap before the webhook was live.
raw.exec(`
  INSERT INTO pull_requests
    (repo, number, title, author, created_at, updated_at, state, is_draft,
     labels, merge_commit_sha)
  VALUES ('Variable-Horizons', 11, 'Implement Superflat Variant', 'LazyFlesh',
          '2026-08-26T05:57:41Z', '2026-08-29T18:32:22Z', 'OPEN', 0,
          '["Enhancement"]', 'b6f5644aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

  INSERT INTO reviews (repo, pr_number, author, state, submitted_at)
  VALUES ('Variable-Horizons', 11, 'GDCloudstrike', 'APPROVED', '2026-08-29T18:32:22Z');
`);

const before = await approvedUnmerged(db, Date.parse("2026-08-31T00:00:00Z"));
check("the stuck PR is on the card before the reconcile", before.map((r) => r.number), [11]);

// What GitHub actually reports for it.
const truth = {
  number: 11,
  title: "Implement Superflat Variant",
  createdAt: "2026-08-26T05:57:41Z",
  updatedAt: "2026-08-29T19:43:47Z",
  mergedAt: "2026-08-29T19:43:47Z",
  closedAt: "2026-08-29T19:43:47Z",
  state: "MERGED",
  isDraft: false,
  author: { login: "LazyFlesh" },
  additions: 900,
  deletions: 120,
  changedFiles: 31,
  commits: { totalCount: 35 },
  comments: { totalCount: 2 },
  assignees: { nodes: [] },
  labels: { nodes: [{ name: "Enhancement" }, { name: "New Feature" }] },
  reviewRequests: { nodes: [] },
  reactions: { totalCount: 0 },
  thumbsUp: { totalCount: 0 },
  thumbsDown: { totalCount: 0 },
  reviews: {
    totalCount: 1,
    nodes: [
      {
        state: "APPROVED",
        submittedAt: "2026-08-29T18:32:22Z",
        author: { login: "GDCloudstrike" },
      },
    ],
  },
};

raw.exec(prUpsert([`(${prRow("Variable-Horizons", truth).join(",")})`]));
raw.exec(clearReviewsSql("Variable-Horizons", 11));
raw.exec(
  reviewUpsert([
    `('Variable-Horizons',11,'GDCloudstrike','APPROVED','2026-08-29T18:32:22Z')`,
  ]),
);

const after = await approvedUnmerged(db, Date.parse("2026-08-31T00:00:00Z"));
check("the card is empty after the reconcile", after, []);

const stored = raw
  .prepare("SELECT state, merged_at, closed_at, merge_commit_sha, labels FROM pull_requests")
  .get();

check("state", stored.state, "MERGED");
check("merged_at", stored.merged_at, "2026-08-29T19:43:47Z");
check("closed_at", stored.closed_at, "2026-08-29T19:43:47Z");
check(
  "merge_commit_sha survives the upsert",
  stored.merge_commit_sha,
  "b6f5644aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
);
check("labels are refreshed", stored.labels, '["Enhancement","New Feature"]');

// A review GitHub no longer reports has to disappear, or the PR stays approved
// forever. An upsert alone can only add, which is why the delete is there.
raw.exec(`
  INSERT INTO pull_requests (repo, number, created_at, updated_at, state, is_draft)
  VALUES ('GuideNH', 65, '2026-08-30T17:45:00Z', '2026-08-31T15:21:41Z', 'OPEN', 0);

  INSERT INTO reviews (repo, pr_number, author, state, submitted_at)
  VALUES ('GuideNH', 65, 'someone', 'APPROVED', '2026-08-30T18:00:00Z');
`);

check(
  "a since-dismissed approval keeps the PR on the card",
  (await approvedUnmerged(db, Date.parse("2026-08-31T00:00:00Z"))).map((r) => r.number),
  [65],
);

raw.exec(clearReviewsSql("GuideNH", 65));
raw.exec(reviewUpsert([`('GuideNH',65,'someone','DISMISSED','2026-08-30T18:00:00Z')`]));

check(
  "and drops off once the review list is replaced",
  await approvedUnmerged(db, Date.parse("2026-08-31T00:00:00Z")),
  [],
);

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
