-- Snapshots keep their branch and tags only. The bump, Not latest and
-- Pre-release are chosen when releasing, so 008's columns for them go.
--
--   cd worker && npx wrangler d1 execute nh-dashboard --remote --file migrations/009-snapshot-tags-only.sql
ALTER TABLE release_snapshots DROP COLUMN bump;
ALTER TABLE release_snapshots DROP COLUMN not_latest;
ALTER TABLE release_snapshots DROP COLUMN pre;
