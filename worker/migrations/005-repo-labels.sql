-- Per-repo label palettes.
--
--   cd worker && npx wrangler d1 execute nh-dashboard --remote --file migrations/005-repo-labels.sql
--
-- Issues and pull requests store label *names* — see the note on `labels` in
-- schema.sql for why the arrays stay JSON — so a chip has never had a colour to
-- render unless the name happened to be one of the twenty in `labels`. That
-- table is the managed set out of Label-Sync-GTNH and is deliberately not this:
-- it answers "which labels does the org manage", which `byLabel` reads as its
-- definitive column list, and widening it to 292 names nobody manages would
-- change what that panel means.
--
-- Keyed on (repo, name) rather than name alone. The same label name is a
-- different colour in different repos, and every row that needs a colour knows
-- which repo it came from — so there is nothing to guess and no reason to pick
-- a winner. ~4,500 rows across ~300 repos.
CREATE TABLE IF NOT EXISTS repo_labels (
  repo              TEXT NOT NULL,
  name              TEXT NOT NULL,
  color             TEXT,
  description       TEXT,
  PRIMARY KEY (repo, name)
);

-- The read is "the palette for these repos", which is the primary key's own
-- prefix, so no second index. Colour is never a predicate.
