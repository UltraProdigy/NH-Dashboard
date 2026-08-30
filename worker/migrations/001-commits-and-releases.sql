-- Apply once to a database created before the release cards existed:
--
--   cd worker && npx wrangler d1 execute nh-dashboard --remote \
--     --file migrations/001-commits-and-releases.sql
--
-- The tables come from schema.sql, which is idempotent and can simply be re-run.
-- This file exists for the one change that is not: `CREATE TABLE IF NOT EXISTS`
-- sees an existing pull_requests and leaves it exactly as it found it, so a new
-- column in that definition reaches a fresh database and never an old one.
--
-- SQLite has no `ADD COLUMN IF NOT EXISTS`. Re-running this errors with
-- "duplicate column name: merge_commit_sha", which is safe and means the
-- migration was already applied — the statement does not partially apply.

ALTER TABLE pull_requests ADD COLUMN merge_commit_sha TEXT;

CREATE INDEX IF NOT EXISTS idx_pr_merge_sha ON pull_requests (merge_commit_sha)
  WHERE merge_commit_sha IS NOT NULL;

-- Backfilling the column is the daily build's job, not this file's. It is read
-- through COALESCE and an unfilled column means "no PR matched", which the
-- panels already treat as a direct commit — so the cards are conservative until
-- the build has run, rather than wrong in a way that needs this to be atomic.
