-- Release snapshots on the Releases & Tags page: a named list of repo -> tag
-- that a release line (2.9.x after 2.9.0) is released from and kept current by.
--
--   cd worker && npx wrangler d1 execute nh-dashboard --remote --file migrations/008-release-snapshots.sql
--
-- Until it runs, the Snapshots card says so and everything else works without
-- snapshots.
CREATE TABLE IF NOT EXISTS release_snapshots (
  name              TEXT PRIMARY KEY,
  branch            TEXT,
  bump              TEXT NOT NULL DEFAULT 'patch',
  not_latest        INTEGER NOT NULL DEFAULT 1,
  pre               INTEGER NOT NULL DEFAULT 0,
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_by        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS release_snapshot_tags (
  snapshot          TEXT NOT NULL,
  repo              TEXT NOT NULL,
  tag               TEXT NOT NULL,
  base_tag          TEXT NOT NULL,
  series            TEXT,
  since             TEXT NOT NULL,
  updated_by        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (snapshot, repo)
);

CREATE INDEX IF NOT EXISTS idx_release_snapshot_tags_repo ON release_snapshot_tags (repo);

CREATE TABLE IF NOT EXISTS release_snapshot_changes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot          TEXT NOT NULL,
  change            TEXT NOT NULL,
  kind              TEXT NOT NULL,
  repo              TEXT NOT NULL,
  before_tag        TEXT,
  after_tag         TEXT,
  base_tag          TEXT,
  since             TEXT,
  reverts           TEXT,
  changed_by        TEXT NOT NULL,
  changed_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_release_snapshot_changes ON release_snapshot_changes (snapshot, change);
