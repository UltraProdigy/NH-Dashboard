-- Every custom property change: values per repo, and definitions (repo NULL).
-- The Custom Properties page writes its rows as `pending` before each GitHub
-- call and marks them `done` after; the webhook Worker adds changes made on
-- GitHub, skipping Org-Manager's echoes of the page's own.
--
--   cd worker && npx wrangler d1 execute nh-dashboard --remote --file migrations/011-property-history.sql
--
-- Until it runs, the page says history is off and everything else works.
CREATE TABLE IF NOT EXISTS property_history (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  at                TEXT NOT NULL,
  repo              TEXT,
  property          TEXT NOT NULL,
  before            TEXT,
  after             TEXT,
  by                TEXT NOT NULL,
  source            TEXT NOT NULL,
  note              TEXT,
  batch             TEXT,
  step              INTEGER,
  state             TEXT NOT NULL DEFAULT 'done'
);

CREATE INDEX IF NOT EXISTS idx_property_history_match ON property_history (property, at);
CREATE INDEX IF NOT EXISTS idx_property_history_batch ON property_history (batch, step);
