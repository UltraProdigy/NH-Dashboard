-- What the release workflow did with each release Releases & Tags made: the
-- dashboard's release id, when the workflow deleted it, when a release with the
-- same tag and another id appeared, and how the build on the tag ended. The
-- webhook Worker fills these in, and Make releases shows them on each row.
--
--   cd worker && npx wrangler d1 execute nh-dashboard --remote --file migrations/010-release-rebuilds.sql
ALTER TABLE release_tag_feedback ADD COLUMN release_id INTEGER;
ALTER TABLE release_tag_feedback ADD COLUMN removed_at TEXT;
ALTER TABLE release_tag_feedback ADD COLUMN rebuilt_at TEXT;
ALTER TABLE release_tag_feedback ADD COLUMN build_conclusion TEXT;
ALTER TABLE release_tag_feedback ADD COLUMN build_url TEXT;
ALTER TABLE release_tag_feedback ADD COLUMN build_at TEXT;
CREATE INDEX IF NOT EXISTS idx_release_tag_feedback_tag ON release_tag_feedback (repo, tag);
