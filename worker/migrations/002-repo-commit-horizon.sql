-- Apply after 001, to a database that already has a repos table:
--
--   cd worker && npx wrangler d1 execute nh-dashboard --remote \
--     --file migrations/002-repo-commit-horizon.sql
--
-- Same reason 001 exists: CREATE TABLE IF NOT EXISTS leaves an existing repos
-- exactly as it found it, so a column added to that definition only ever
-- reaches a fresh database.
--
-- Re-running errors with "duplicate column name: commits_since", which is safe
-- and means it was already applied.
--
-- Until the backfill fills it, commits_since is NULL everywhere. Both panels
-- read NULL as "no backfill has run for this repo" and fall back to the oldest
-- stored commit, which is the honest answer when the webhook capture window is
-- genuinely all we have.

ALTER TABLE repos ADD COLUMN commits_since TEXT;
