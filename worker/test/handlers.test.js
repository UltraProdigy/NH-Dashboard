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
  prepare(sql) {
    const db = this.db;
    let bound = [];
    const api = {
      bind(...args) {
        bound = args;
        return api;
      },
      async run() {
        db.prepare(sql).run(...bound);
        return { success: true };
      },
      async first() {
        return db.prepare(sql).get(...bound) ?? null;
      },
    };
    return api;
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

console.log("\nunknown events are ignored, not errors");
check("unhandled event", await handleEvent(db, "star", {}), { ignored: "star" });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
