-- Teams asked to review a pull request, as GitHub team ids (ids rather than
-- slugs, so a renamed team still matches). Only the webhook fills it.
--
--   cd worker && npx wrangler d1 execute nh-dashboard --remote --file migrations/013-team-review-requests.sql
--
-- Until it runs, the webhook skips the column and Team Management shows no team
-- review requests.
ALTER TABLE pull_requests ADD COLUMN team_review_requests TEXT NOT NULL DEFAULT '[]';
