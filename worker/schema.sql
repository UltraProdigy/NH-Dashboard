-- D1 schema.
--
-- Mirrors the record shapes already in data/ingest/*.ndjson so the seed is a
-- straight load with no re-crawl. Column names are snake_case; the mapping back
-- to the camelCase record fields lives in worker/seed.js.
--
-- Two rules shape everything here:
--
--   Every write is an upsert. A PR that is opened, reviewed, updated and merged
--   is four events landing on one row, and the reconcile sweep writing the same
--   row again must be a no-op rather than a duplicate. Natural keys throughout,
--   no autoincrement ids.
--
--   Arrays stay JSON rather than becoming link tables. Labels, assignees and
--   review requests are read as whole lists and almost never joined against.
--   As columns they cost 58,222 fewer rows on the initial seed, which is the
--   difference between 96,654 (under the 100,000/day free ceiling, one pass)
--   and 154,876 (two days, or a month of Workers Paid). Promoting them to real
--   tables later is a pure in-database rewrite with no API calls, so this is
--   reversible if a panel ever needs to filter by label at scale.

-- ---------------------------------------------------------------- repositories

-- commits_since records how far back the backfill actually swept this repo's
-- history, and it is per repo rather than per run because the sweep is not
-- uniform: most repos get the flat lookback, while a repo whose last release
-- predates that gets walked back to the release instead, so its commit count
-- can be a count rather than "however many the window caught".
--
-- Both release panels read it as "how far back can we see here", which is a
-- different question from "how far back do this repo's rows go". A repo with a
-- gap in its history is not a repo we cannot see into, and reading the oldest
-- stored row as the horizon reported a 102-day floor where the truth was 365.
CREATE TABLE IF NOT EXISTS repos (
  name              TEXT PRIMARY KEY,
  full_name         TEXT NOT NULL,
  private           INTEGER NOT NULL DEFAULT 0,
  archived          INTEGER NOT NULL DEFAULT 0,
  default_branch    TEXT,
  pushed_at         TEXT,
  updated_at        TEXT,
  commits_since     TEXT
);

-- Restricted repos are opted *into* by queries rather than filtered out, so a
-- panel that forgets the predicate returns public data instead of leaking.
CREATE INDEX IF NOT EXISTS idx_repos_public ON repos (private) WHERE private = 0;

-- ------------------------------------------------------------- pull requests

CREATE TABLE IF NOT EXISTS pull_requests (
  repo              TEXT NOT NULL,
  number            INTEGER NOT NULL,
  title             TEXT,
  author            TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  merged_at         TEXT,
  closed_at         TEXT,
  state             TEXT NOT NULL,
  is_draft          INTEGER,
  additions         INTEGER,
  deletions         INTEGER,
  changed_files     INTEGER,
  commits           INTEGER,
  comments          INTEGER,
  reactions         INTEGER,
  thumbs_up         INTEGER,
  thumbs_down       INTEGER,
  review_count      INTEGER,
  reviews_truncated INTEGER NOT NULL DEFAULT 0,
  labels            TEXT NOT NULL DEFAULT '[]',
  assignees         TEXT NOT NULL DEFAULT '[]',
  review_requests   TEXT NOT NULL DEFAULT '[]',
  merge_commit_sha  TEXT,
  PRIMARY KEY (repo, number)
);

-- merge_commit_sha exists to answer "did this commit come from a pull request"
-- without a GitHub call. The push payload has no such field, so a delivered
-- commit joins back to the PR that produced it through this column. Exact for
-- squash merges and merge commits; a rebase merge replays commits under fresh
-- SHAs and matches nothing, which the read path treats as "direct".
--
-- ┌─ "no such column: merge_commit_sha" when running this file? ──────────────┐
-- │ This file is being applied to a database created before that column       │
-- │ existed. CREATE TABLE IF NOT EXISTS saw pull_requests already there and   │
-- │ left it exactly as it found it, so the column above was never added and   │
-- │ the index below has nothing to index.                                     │
-- │                                                                           │
-- │ Run migrations/001-commits-and-releases.sql FIRST, then this file again.  │
-- │ wrangler applies a file atomically, so the failure left nothing behind.   │
-- └───────────────────────────────────────────────────────────────────────────┘
CREATE INDEX IF NOT EXISTS idx_pr_merge_sha ON pull_requests (merge_commit_sha)
  WHERE merge_commit_sha IS NOT NULL;

-- 256 of 29,029 records carry only the fields the search API returns — no
-- title, no diff stats. Nullable rather than absent so they still count in
-- totals; panels reading a stat must tolerate NULL.

CREATE INDEX IF NOT EXISTS idx_pr_author  ON pull_requests (author, created_at);
CREATE INDEX IF NOT EXISTS idx_pr_created ON pull_requests (created_at);
CREATE INDEX IF NOT EXISTS idx_pr_merged  ON pull_requests (merged_at) WHERE merged_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pr_open    ON pull_requests (repo, updated_at) WHERE state = 'OPEN';

-- -------------------------------------------------------------------- reviews

-- No stable id: reviews arrive nested inside PR records from the sweep, where
-- GitHub's review id is not carried. The natural key is who reviewed and when.
--
-- That key cannot be a PRIMARY KEY. SQLite permits NULL in the primary key of a
-- rowid table, and 31 reviews have a null author (deleted accounts) while 3 have
-- no submitted_at (still PENDING) — so a composite PK would let those rows
-- duplicate without complaint on every re-sync. A unique index over coalesced
-- expressions enforces what is actually meant while leaving NULL visible to
-- panels, which need to tell a deleted account from an empty string.
--
-- Writes use INSERT OR REPLACE: the six exact duplicates already in the store
-- collapse rather than abort the seed, and a re-read of a PR rewrites its
-- reviews wholesale.
CREATE TABLE IF NOT EXISTS reviews (
  repo              TEXT NOT NULL,
  pr_number         INTEGER NOT NULL,
  author            TEXT,
  state             TEXT NOT NULL,
  submitted_at      TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_key ON reviews (
  repo, pr_number, COALESCE(author, ''), COALESCE(submitted_at, '')
);

CREATE INDEX IF NOT EXISTS idx_reviews_author ON reviews (author, submitted_at);
CREATE INDEX IF NOT EXISTS idx_reviews_pr     ON reviews (repo, pr_number);

-- --------------------------------------------------------------------- issues

CREATE TABLE IF NOT EXISTS issues (
  repo              TEXT NOT NULL,
  number            INTEGER NOT NULL,
  v                 INTEGER NOT NULL DEFAULT 3,
  title             TEXT,
  author            TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  closed_at         TEXT,
  state             TEXT NOT NULL,
  state_reason      TEXT,
  labels            TEXT NOT NULL DEFAULT '[]',
  labels_truncated  INTEGER NOT NULL DEFAULT 0,
  assignees         TEXT NOT NULL DEFAULT '[]',
  comments          INTEGER,
  first_response_at TEXT,
  first_responder   TEXT,
  response_unknown  INTEGER NOT NULL DEFAULT 0,
  closed_by         TEXT,
  closer_known      INTEGER NOT NULL DEFAULT 0,
  closed_via_kind   TEXT,
  closed_via_repo   TEXT,
  closed_via_number INTEGER,
  closed_via_author TEXT,
  reactions         INTEGER,
  thumbs_up         INTEGER,
  thumbs_down       INTEGER,
  PRIMARY KEY (repo, number)
);

-- `v` is the record schema version, kept so a newly-added field can be
-- backfilled by selecting rows below the current version rather than re-walking
-- everything. Every row today is v3.
--
-- closedVia is flattened rather than stored as JSON because closer attribution
-- is queried. Two shapes exist: a full {kind, repo, number, author} for 4,738
-- issues and a bare {kind} for 386.
--
-- reactions/thumbs are present on 7.1% of records — they were added after the
-- bulk of the ingest and have no webhook event, so they only refresh when the
-- reconcile sweep touches a record. NULL means unknown, not zero.

CREATE INDEX IF NOT EXISTS idx_issues_author  ON issues (author, created_at);
CREATE INDEX IF NOT EXISTS idx_issues_created ON issues (created_at);
CREATE INDEX IF NOT EXISTS idx_issues_open    ON issues (repo, updated_at) WHERE state = 'OPEN';
CREATE INDEX IF NOT EXISTS idx_issues_closer  ON issues (closed_by) WHERE closed_by IS NOT NULL;

-- -------------------------------------------------------------------- commits

-- Default-branch commits only, and that is the panels' definition rather than a
-- storage economy: both cards ask about the branch a release is cut from, and a
-- topic branch's commits would answer a question nobody asked while inflating
-- "commits ahead" with work that was later squashed into one.
--
-- Two writers with different confidence land here. The daily build carries
-- GitHub's own `associatedPullRequests` answer; a `push` delivery carries no
-- pull-request field at all, so it writes NULL and the read resolves it against
-- pull_requests.merge_commit_sha. See src/shared/commit-rules.js for why the
-- distinction is a column rather than a guess made at write time.
--
-- No URL column. It is `https://github.com/{org}/{repo}/commit/{sha}` for every
-- row, and D1 bills index and row writes by size — the review-state panel
-- already derives its URLs for the same reason.
CREATE TABLE IF NOT EXISTS commits (
  repo              TEXT NOT NULL,
  sha               TEXT NOT NULL,
  committed_at      TEXT NOT NULL,
  author            TEXT,
  message           TEXT,
  via_pr            INTEGER,
  PRIMARY KEY (repo, sha)
);

-- Both panels scan one repo's history newest-first within a date bound, which
-- is exactly this index. `committed_at` is Z-normalised whole seconds so the
-- bound is a string compare — a push payload's timestamps arrive with the
-- committer's UTC offset and are normalised on the way in, because `+02:00`
-- sorts below `Z` and would quietly break MAX().
CREATE INDEX IF NOT EXISTS idx_commits_repo_time ON commits (repo, committed_at DESC);

-- ------------------------------------------------------------------- releases

-- A release payload carries `tag_name` and `target_commitish`, and no SHA for
-- the tagged commit — `target_commitish` is usually a branch name. So the port
-- cannot reproduce the Node panel's `tagCommit.oid === head.oid` test, and does
-- not try: "is any default-branch commit newer than the latest release" is the
-- same question asked of data this store actually holds.
--
-- Drafts are stored rather than filtered on the way in. A draft that is later
-- published arrives as a second delivery on the same tag, and a row that was
-- never written cannot be updated by one.
CREATE TABLE IF NOT EXISTS releases (
  repo              TEXT NOT NULL,
  tag_name          TEXT NOT NULL,
  published_at      TEXT,
  created_at        TEXT,
  draft             INTEGER NOT NULL DEFAULT 0,
  prerelease        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo, tag_name)
);

-- Prereleases are deliberately not excluded here or in the panel: a repo that
-- just cut an rc is not a repo needing a release.
CREATE INDEX IF NOT EXISTS idx_releases_repo ON releases (repo, published_at DESC);

-- -------------------------------------------------------------- workflow runs

-- Default-branch Actions runs, one row per run.
--
-- Only **completed** runs are written, and that is a volume decision rather
-- than a modelling one. `workflow_run` fires three times for every run —
-- requested, in_progress, completed — and it is by a distance the noisiest
-- event this webhook subscribes to. A run that has not finished has no
-- conclusion and no end timestamp, so it contributes to nothing the panel
-- computes; storing it would triple the write rate to hold rows that are read
-- as NULL and then overwritten. There is deliberately no `status` column for
-- the same reason: it would read 'completed' on every row in the table.
--
-- `head_branch` is stored rather than filtered on the way in, because the
-- default branch is a property of the repo and repos rename theirs. Filtering
-- at write time against the branch of the day would leave rows that can never
-- match again, and no query would look wrong.
--
-- Two columns exist only to be believed cautiously. `updated_at` is the run's
-- last-touched time, not its end time — GitHub bumps it on log expiry and on a
-- job re-run, months or years later — so the duration derived from it passes
-- through the ceiling in shared/ci-rules.js. And `run_started_at` is absent on
-- very old runs, where `created_at` is the only start there is; the handler
-- resolves that before writing so the column holds one kind of value.
--
-- Timestamps are Z-normalised whole seconds like every other time column here,
-- so ordering is a string compare.
CREATE TABLE IF NOT EXISTS workflow_runs (
  repo              TEXT NOT NULL,
  run_id            INTEGER NOT NULL,
  name              TEXT,
  head_branch       TEXT,
  event             TEXT,
  conclusion        TEXT,
  run_started_at    TEXT,
  updated_at        TEXT,
  html_url          TEXT,
  PRIMARY KEY (repo, run_id)
);

-- The panel reads one repo's newest runs and nothing else, which is exactly
-- this index. Kept DESC to match the read rather than relying on SQLite to walk
-- it backwards.
CREATE INDEX IF NOT EXISTS idx_workflow_runs_repo_time
  ON workflow_runs (repo, run_started_at DESC);

-- --------------------------------------------------------------------- labels

-- The managed label set from Label-Sync-GTNH, which is the org's source of
-- truth for labels and lives in another repo entirely.
--
-- This table exists because a Worker cannot go and read that file. It is the
-- one input in this store that is neither a webhook payload nor derivable from
-- one — GitHub does not deliver an event when a label config is edited in a
-- repo the dashboard does not watch — so it is written by a script and read by
-- everything else.
--
-- It answers two questions that were previously stuck. `byLabel` needs to know
-- which labels are worth a column at all, and every panel rendering a label
-- chip needs its colour: D1 stores label *names* on pull requests and issues,
-- so live chips have been rendering uncoloured since the port.
--
-- `position` preserves the order the config declares, because MAX_TRACKED_LABELS
-- takes the first N and "first" has to mean something stable. Sorting by name
-- would silently change which labels get tracked when the cap bites.
CREATE TABLE IF NOT EXISTS labels (
  name              TEXT PRIMARY KEY,
  color             TEXT,
  description       TEXT,
  position          INTEGER NOT NULL DEFAULT 0
);

-- -------------------------------------------------------------------- traffic

CREATE TABLE IF NOT EXISTS traffic_daily (
  repo              TEXT NOT NULL,
  date              TEXT NOT NULL,
  views             INTEGER NOT NULL DEFAULT 0,
  view_uniques      INTEGER NOT NULL DEFAULT 0,
  clones            INTEGER NOT NULL DEFAULT 0,
  clone_uniques     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo, date)
);

CREATE INDEX IF NOT EXISTS idx_traffic_date ON traffic_daily (date);

-- --------------------------------------------------------- materialized reads

-- The 22 MB drilldown payload is 18.5 MB of one map keyed by login, averaging
-- 2.7 KB across 6,818 contributors. Building all of it in a Worker is out of
-- reach; building one row of it is not. The debounced recompute writes these,
-- and /api/contributor/{login} serves a single row.
--
-- Kept as opaque JSON on purpose: the shape is the frontend's contract, not a
-- thing the database needs to understand, and freezing it into columns would
-- mean a migration every time a tile changes.

CREATE TABLE IF NOT EXISTS drilldown_contributors (
  login             TEXT PRIMARY KEY,
  payload           TEXT NOT NULL,
  version           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS drilldown_repos (
  repo              TEXT PRIMARY KEY,
  payload           TEXT NOT NULL,
  version           INTEGER NOT NULL
);

-- ----------------------------------------------------------------- bookkeeping

-- Per-repo watermarks, moved out of data/ingest/state.json. The sweep must
-- resume from these and write deltas: a reconcile pass that re-upserts
-- everything is 96,654 writes in one run, which is the whole daily budget.
CREATE TABLE IF NOT EXISTS ingest_state (
  repo              TEXT PRIMARY KEY,
  seen_through      TEXT,
  at                TEXT
);

-- Holds `version` (bumped by the recompute, polled by the browser) and `dirty`
-- (set by webhook handlers, cleared when the recompute runs).
CREATE TABLE IF NOT EXISTS meta (
  key               TEXT PRIMARY KEY,
  value             TEXT NOT NULL
);

INSERT OR IGNORE INTO meta (key, value) VALUES ('version', '0');
INSERT OR IGNORE INTO meta (key, value) VALUES ('dirty', '0');

-- One row per panel, holding its rendered JSON.
--
-- A blob rather than materialised rows, and that is a write-cost decision. The
-- contributors panel is 1,214 people; writing them as rows would be ~1,200
-- writes plus indexes on every recompute, and a recompute every half hour is
-- then the entire daily free budget spent on one panel. As a blob it is one
-- write. D1 caps a row at 2 MB, which the largest panel here (720 KB) sits
-- comfortably under — but that is the ceiling to watch, and `drilldown` at
-- 23 MB cannot use this table at all. It gets its own materialised tables,
-- which is why those already exist above.
CREATE TABLE IF NOT EXISTS panel_cache (
  name              TEXT PRIMARY KEY,
  json              TEXT NOT NULL,
  computed_at       TEXT NOT NULL,
  ms                INTEGER
);
