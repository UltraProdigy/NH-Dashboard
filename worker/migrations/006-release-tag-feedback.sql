-- Every tag the Dream Panel's Release All created, with what it predicted.
--
--   cd worker && npx wrangler d1 execute nh-dashboard --remote --file migrations/006-release-tag-feedback.sql
--
-- `wrong` is the admin's own "the prediction was wrong" tick. Only those rows
-- teach the predictor; an edit left unticked was an intentional bump.
CREATE TABLE IF NOT EXISTS release_tag_feedback (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  repo              TEXT NOT NULL,
  previous_tag      TEXT,
  predicted_tag     TEXT,
  tag               TEXT NOT NULL,
  sha               TEXT NOT NULL,
  wrong             INTEGER NOT NULL DEFAULT 0,
  released_by       TEXT NOT NULL,
  released_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_release_tag_feedback_wrong
  ON release_tag_feedback (wrong, repo, released_at);
