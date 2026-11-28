-- Lets Team Management find each person's newest reply, close and commit with
-- one index step each instead of scanning the table once per person.
--
--   cd worker && npx wrangler d1 execute nh-dashboard --remote --file migrations/014-activity-indexes.sql
--
-- Until it runs, those three are left out of last active and the page says so.
CREATE INDEX IF NOT EXISTS idx_issues_responder ON issues (first_responder, first_response_at) WHERE first_responder IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_issues_closed_by ON issues (closed_by, closed_at) WHERE closed_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_commits_author ON commits (author, committed_at) WHERE author IS NOT NULL;
