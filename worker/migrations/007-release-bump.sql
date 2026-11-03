-- How each release's tag was chosen on the Releases & Tags page.
--
--   cd worker && npx wrangler d1 execute nh-dashboard --remote --file migrations/007-release-bump.sql
--
-- `predicted` is the predictor's own guess (the only rows it learns from or
-- counts in "Predictions kept as-is"); `patch`, `minor`, `major` and `super`
-- are bumps the admin picked, and `pattern` a tag typed for many repos at once.
-- Rows from before this column were all Release All predictions.
ALTER TABLE release_tag_feedback ADD COLUMN bump TEXT NOT NULL DEFAULT 'predicted';
