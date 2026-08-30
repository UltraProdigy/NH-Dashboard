/**
 * Handler tests against a real SQLite database.
 *
 *   node --experimental-sqlite worker/test/handlers.test.js
 *
 * D1's query API is a thin wrapper over SQLite, so a shim over node:sqlite runs
 * the same SQL the Worker will run. What this cannot check is D1's own limits
 * and latency; what it can check — and what actually matters — is that the
 * upserts touch the columns they should and leave the rest alone.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { handleEvent } from "../src/handlers.js";

// --- minimal D1 shim --------------------------------------------------------

class Shim {
  constructor(db) {
    this.db = db;
  }
  /**
   * `bind` returns a *new* statement, which is D1's actual contract and not a
   * detail worth glossing.
   *
   * A shim whose bind mutated one shared object read identically for every
   * chained `prepare().bind().run()` in this file, and silently broke the one
   * caller that prepares once and binds per row to build a batch — every row
   * would have run with the last row's parameters, writing one commit N times.
   */
  prepare(sql, bound = []) {
    const db = this.db;
    const shim = this;
    return {
      sql,
      bound,
      bind: (...args) => shim.prepare(sql, args),
      async run() {
        db.prepare(sql).run(...bound);
        return { success: true };
      },
      async first() {
        return db.prepare(sql).get(...bound) ?? null;
      },
      async all() {
        return { results: db.prepare(sql).all(...bound) };
      },
    };
  }
  async batch(statements) {
    for (const statement of statements) {
      this.db.prepare(statement.sql).run(...statement.bound);
    }
    return statements.map(() => ({ success: true }));
  }
}

// --- harness ----------------------------------------------------------------

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failed++;
  console.log(
    `  ${ok ? "ok  " : "FAIL"}  ${name}` +
      (ok ? "" : `\n          expected ${JSON.stringify(expected)}\n          got      ${JSON.stringify(actual)}`),
  );
}

const raw = new DatabaseSync(":memory:");
raw.exec(readFileSync("worker/schema.sql", "utf8"));
const db = new Shim(raw);

const row = (sql, ...args) => raw.prepare(sql).get(...args);

// A record as the seed would have written it: carries reconcile-only fields
// that no webhook payload contains.
raw
  .prepare(
    `INSERT INTO pull_requests
     (repo, number, title, author, created_at, updated_at, state, review_count,
      reactions, thumbs_up, thumbs_down, reviews_truncated, labels)
     VALUES ('GT5-Unofficial', 4821, 'Fix crash on world load', 'someone',
             '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', 'OPEN', 3,
             7, 5, 2, 1, '["bug"]')`,
  )
  .run();

raw
  .prepare(
    `INSERT INTO issues
     (repo, number, title, author, created_at, updated_at, state, comments,
      first_response_at, first_responder, response_unknown, closed_via_kind,
      closed_via_repo, closed_via_number, reactions)
     VALUES ('GT5-Unofficial', 991, 'Recipe conflict', 'reporter',
             '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', 'OPEN', 4,
             '2026-07-01T06:00:00Z', 'helper', 0, 'pull_request',
             'GT5-Unofficial', 4700, 12)`,
  )
  .run();

console.log("\npull_request: merging a PR");
await handleEvent(db, "pull_request", {
  action: "closed",
  repository: { name: "GT5-Unofficial", full_name: "GTNewHorizons/GT5-Unofficial" },
  pull_request: {
    number: 4821,
    title: "Fix crash on world load",
    state: "closed",
    merged: true,
    merged_at: "2026-08-29T12:00:00Z",
    closed_at: "2026-08-29T12:00:00Z",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-29T12:00:00Z",
    user: { login: "someone" },
    additions: 12,
    deletions: 3,
    changed_files: 2,
    commits: 1,
    comments: 5,
    labels: [{ name: "bug" }, { name: "ready" }],
    assignees: [{ login: "maintainer" }],
    requested_reviewers: [],
  },
});

let pr = row("SELECT * FROM pull_requests WHERE repo='GT5-Unofficial' AND number=4821");
check("state becomes MERGED", pr.state, "MERGED");
check("merged_at written", pr.merged_at, "2026-08-29T12:00:00Z");
check("labels updated", pr.labels, '["bug","ready"]');
check("assignees updated", pr.assignees, '["maintainer"]');
check("additions written", pr.additions, 12);

console.log("\n  reconcile-only fields must survive the upsert");
check("review_count preserved", pr.review_count, 3);
check("reactions preserved", pr.reactions, 7);
check("thumbs_up preserved", pr.thumbs_up, 5);
check("thumbs_down preserved", pr.thumbs_down, 2);
check("reviews_truncated preserved", pr.reviews_truncated, 1);
check("no duplicate row", row("SELECT COUNT(*) n FROM pull_requests").n, 1);

console.log("\npull_request_review: an approval arrives");
await handleEvent(db, "pull_request_review", {
  action: "submitted",
  repository: { name: "GT5-Unofficial" },
  pull_request: { number: 4821 },
  review: {
    user: { login: "reviewer-one" },
    state: "approved",
    submitted_at: "2026-08-29T11:00:00Z",
  },
});
check("review inserted", row("SELECT COUNT(*) n FROM reviews").n, 1);
check(
  "state upper-cased",
  row("SELECT state FROM reviews").state,
  "APPROVED",
);

console.log("\n  the same review delivered twice must not duplicate");
await handleEvent(db, "pull_request_review", {
  action: "submitted",
  repository: { name: "GT5-Unofficial" },
  pull_request: { number: 4821 },
  review: {
    user: { login: "reviewer-one" },
    state: "approved",
    submitted_at: "2026-08-29T11:00:00Z",
  },
});
check("still one review", row("SELECT COUNT(*) n FROM reviews").n, 1);

console.log("\n  a dismissal is recorded as DISMISSED, not the stale state");
await handleEvent(db, "pull_request_review", {
  action: "dismissed",
  repository: { name: "GT5-Unofficial" },
  pull_request: { number: 4821 },
  review: {
    user: { login: "reviewer-one" },
    state: "approved",
    submitted_at: "2026-08-29T11:00:00Z",
  },
});
check("state now DISMISSED", row("SELECT state FROM reviews").state, "DISMISSED");
check("replaced, not added", row("SELECT COUNT(*) n FROM reviews").n, 1);

console.log("\nissues: closing an issue");
await handleEvent(db, "issues", {
  action: "closed",
  repository: { name: "GT5-Unofficial" },
  sender: { login: "a-maintainer" },
  issue: {
    number: 991,
    title: "Recipe conflict",
    state: "closed",
    state_reason: "completed",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-08-29T13:00:00Z",
    closed_at: "2026-08-29T13:00:00Z",
    user: { login: "reporter" },
    labels: [{ name: "bug" }],
    assignees: [],
    comments: 6,
  },
});

let issue = row("SELECT * FROM issues WHERE repo='GT5-Unofficial' AND number=991");
check("state CLOSED", issue.state, "CLOSED");
check("closed_by from sender", issue.closed_by, "a-maintainer");
check("closer_known set", issue.closer_known, 1);
check("state_reason written", issue.state_reason, "completed");

console.log("\n  reconcile-only fields must survive");
check("first_response_at preserved", issue.first_response_at, "2026-07-01T06:00:00Z");
check("first_responder preserved", issue.first_responder, "helper");
check("closed_via_kind preserved", issue.closed_via_kind, "pull_request");
check("closed_via_number preserved", issue.closed_via_number, 4700);
check("reactions preserved", issue.reactions, 12);

console.log("\n  a later edit must not erase closed_by");
await handleEvent(db, "issues", {
  action: "edited",
  repository: { name: "GT5-Unofficial" },
  sender: { login: "someone-else" },
  issue: {
    number: 991,
    title: "Recipe conflict in the assembler",
    state: "closed",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-08-29T14:00:00Z",
    closed_at: "2026-08-29T13:00:00Z",
    user: { login: "reporter" },
    labels: [{ name: "bug" }],
    assignees: [],
    comments: 6,
  },
});
issue = row("SELECT * FROM issues WHERE number=991");
check("title updated", issue.title, "Recipe conflict in the assembler");
check("closed_by still the closer", issue.closed_by, "a-maintainer");
check("closer_known still 1", issue.closer_known, 1);

console.log("\nissue_comment: routes PR comments to pull_requests");
await handleEvent(db, "issue_comment", {
  action: "created",
  repository: { name: "GT5-Unofficial" },
  issue: {
    number: 4821,
    comments: 9,
    updated_at: "2026-08-29T15:00:00Z",
    pull_request: { url: "https://api.github.com/..." },
  },
});
check(
  "pr comment count updated",
  row("SELECT comments FROM pull_requests WHERE number=4821").comments,
  9,
);
check(
  "issue untouched",
  row("SELECT comments FROM issues WHERE number=991").comments,
  6,
);

// --- push -------------------------------------------------------------------

console.log("\npush writes default-branch commits");

const REPO = {
  name: "GT5-Unofficial",
  full_name: "GTNewHorizons/GT5-Unofficial",
  default_branch: "master",
  private: false,
  archived: false,
};

const push = (over = {}) => ({
  ref: "refs/heads/master",
  deleted: false,
  repository: REPO,
  commits: [],
  ...over,
});

await handleEvent(
  db,
  "push",
  push({
    commits: [
      {
        id: "a".repeat(40),
        message: "fix the thing\n\nwith a body",
        timestamp: "2026-08-29T12:00:00+02:00",
        author: { username: "alice", name: "Alice" },
      },
      {
        id: "b".repeat(40),
        message: "second",
        timestamp: "2026-08-29T13:00:00Z",
        author: { name: "No Account" },
      },
    ],
  }),
);

check(
  "both commits stored",
  row("SELECT COUNT(*) AS n FROM commits").n,
  2,
);
// The property both release panels order by. An offset left unnormalised sorts
// below every Z value sharing its date, and MAX(committed_at) quietly stops
// meaning "newest".
check(
  "an offset timestamp is normalised to Z",
  row("SELECT committed_at FROM commits WHERE sha=?", "a".repeat(40)).committed_at,
  "2026-08-29T10:00:00Z",
);
check(
  "only the message headline is kept",
  row("SELECT message FROM commits WHERE sha=?", "a".repeat(40)).message,
  "fix the thing",
);
check(
  "the account login is preferred over the git name",
  row("SELECT author FROM commits WHERE sha=?", "a".repeat(40)).author,
  "alice",
);
check(
  "a commit with no account falls back to the git name",
  row("SELECT author FROM commits WHERE sha=?", "b".repeat(40)).author,
  "No Account",
);
// The whole reason via_pr is nullable. A push payload has no pull-request
// field, so 0 would be an assertion this handler cannot make.
check(
  "via_pr is null, not zero",
  row("SELECT via_pr FROM commits WHERE sha=?", "a".repeat(40)).via_pr,
  null,
);

await handleEvent(
  db,
  "push",
  push({
    ref: "refs/heads/some-feature",
    commits: [{ id: "c".repeat(40), message: "x", timestamp: "2026-08-29T14:00:00Z" }],
  }),
);
check("a topic branch is skipped", row("SELECT COUNT(*) AS n FROM commits").n, 2);

await handleEvent(
  db,
  "push",
  push({
    ref: "refs/tags/v1.2.3",
    commits: [{ id: "d".repeat(40), message: "x", timestamp: "2026-08-29T14:00:00Z" }],
  }),
);
check("a tag push is skipped", row("SELECT COUNT(*) AS n FROM commits").n, 2);

await handleEvent(
  db,
  "push",
  push({
    deleted: true,
    commits: [{ id: "e".repeat(40), message: "x", timestamp: "2026-08-29T14:00:00Z" }],
  }),
);
check("a deleted ref is skipped", row("SELECT COUNT(*) AS n FROM commits").n, 2);

// A force-push replays commits already stored. The one thing that must survive
// is a via_pr the daily build has since resolved.
raw.prepare("UPDATE commits SET via_pr = 1 WHERE sha = ?").run("a".repeat(40));
await handleEvent(
  db,
  "push",
  push({
    commits: [
      { id: "a".repeat(40), message: "fix the thing", timestamp: "2026-08-29T12:00:00+02:00" },
    ],
  }),
);
check(
  "a redelivered commit does not clobber a resolved via_pr",
  row("SELECT via_pr FROM commits WHERE sha=?", "a".repeat(40)).via_pr,
  1,
);

check(
  "a commit with an unparseable timestamp is dropped, not stored unsorted",
  (
    await handleEvent(
      db,
      "push",
      push({ commits: [{ id: "f".repeat(40), message: "x", timestamp: "not a date" }] }),
    )
  ).written,
  0,
);

// A push payload sends repository.pushed_at as an epoch integer where every
// other event sends an ISO string. Stored raw it becomes '1756568400', which
// sorts below every ISO date, so the repo fails `pushed_at >= <a year ago>` and
// reads as dormant — dropping the most actively pushed repos out of both
// release panels, one webhook after they were correct.
await handleEvent(
  db,
  "push",
  push({
    repository: { ...REPO, pushed_at: 1788027873, updated_at: 1788027873 },
    commits: [{ id: "9".repeat(40), message: "x", timestamp: "2026-08-30T13:00:00Z" }],
  }),
);
check(
  "an epoch pushed_at is stored as an ISO date",
  row("SELECT pushed_at FROM repos WHERE name='GT5-Unofficial'").pushed_at,
  "2026-08-29T18:24:33Z",
);
// The property the whole stale-repo filter rests on.
check(
  "and it therefore sorts above a year-old bound",
  row("SELECT pushed_at FROM repos WHERE name='GT5-Unofficial'").pushed_at >
    "2025-08-30T00:00:00Z",
  true,
);

await handleEvent(
  db,
  "push",
  push({
    repository: { ...REPO, pushed_at: "2026-08-29T10:00:00Z" },
    commits: [],
  }),
);
check(
  "an ISO pushed_at still passes through",
  row("SELECT pushed_at FROM repos WHERE name='GT5-Unofficial'").pushed_at,
  "2026-08-29T10:00:00Z",
);

// --- release ----------------------------------------------------------------

console.log("\nrelease writes tags");

const release = (over = {}, action = "published") => ({
  action,
  repository: REPO,
  release: {
    tag_name: "v1.0.0",
    published_at: "2026-08-20T10:00:00Z",
    created_at: "2026-08-20T09:00:00Z",
    draft: false,
    prerelease: false,
    ...over,
  },
});

await handleEvent(db, "release", release());
check(
  "the release is stored",
  row("SELECT published_at, draft, prerelease FROM releases WHERE tag_name='v1.0.0'"),
  { published_at: "2026-08-20T10:00:00Z", draft: 0, prerelease: 0 },
);

// A draft published later arrives as a second delivery on the same tag, which
// is why drafts are stored rather than filtered on the way in.
await handleEvent(db, "release", release({ tag_name: "v2.0.0", draft: true, published_at: null }));
check(
  "a draft is stored with no published_at",
  row("SELECT draft, published_at FROM releases WHERE tag_name='v2.0.0'"),
  { draft: 1, published_at: null },
);
await handleEvent(db, "release", release({ tag_name: "v2.0.0" }));
check(
  "publishing a draft updates the same row",
  row("SELECT draft, published_at FROM releases WHERE tag_name='v2.0.0'"),
  { draft: 0, published_at: "2026-08-20T10:00:00Z" },
);

await handleEvent(db, "release", release({ tag_name: "v2.0.0" }, "deleted"));
check(
  "a deleted release is removed, not tombstoned",
  row("SELECT COUNT(*) AS n FROM releases WHERE tag_name='v2.0.0'").n,
  0,
);

// --- merge_commit_sha -------------------------------------------------------

console.log("\nmerge_commit_sha is the link back to a pull request");

await handleEvent(db, "pull_request", {
  action: "closed",
  repository: REPO,
  pull_request: {
    number: 4821,
    title: "Fix crash on world load",
    user: { login: "someone" },
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-29T16:00:00Z",
    merged_at: "2026-08-29T16:00:00Z",
    merged: true,
    state: "closed",
    merge_commit_sha: "a".repeat(40),
  },
});
check(
  "merge_commit_sha is recorded",
  row("SELECT merge_commit_sha FROM pull_requests WHERE number=4821").merge_commit_sha,
  "a".repeat(40),
);

// GitHub sends null on a later edit. Overwriting would orphan every commit the
// PR produced, and they would silently start reading as direct pushes.
await handleEvent(db, "pull_request", {
  action: "edited",
  repository: REPO,
  pull_request: {
    number: 4821,
    title: "Fix crash on world load (edited)",
    user: { login: "someone" },
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-29T17:00:00Z",
    merged_at: "2026-08-29T16:00:00Z",
    merged: true,
    state: "closed",
    merge_commit_sha: null,
  },
});
check(
  "a null merge_commit_sha does not erase the stored one",
  row("SELECT merge_commit_sha FROM pull_requests WHERE number=4821").merge_commit_sha,
  "a".repeat(40),
);

console.log("\nunknown events are ignored, not errors");
check("unhandled event", await handleEvent(db, "star", {}), { ignored: "star" });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
