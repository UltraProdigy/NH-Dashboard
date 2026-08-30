# Handoff — going live

Paste the opening line at the bottom into a fresh conversation. This file is the
map; `going-live-status.md` is the territory and wins where they disagree. Both
are temporary and get deleted when the migration lands.

Rewritten 2026-08-30, after the `ciHealth` port.

---

## Do this first — nothing from this session is deployed or applied

The ciHealth port is committed on `main` and none of its effects exist
anywhere yet. The
oracle needs rebuilding, the table needs creating, the history needs sweeping,
and the Worker needs deploying — in that order, because each step depends on the
one above it.

**All of it from the repo root.** The `cd worker` lines are on their own on
purpose: chaining `cd worker &&` onto the first line of a block means pasting it
while already inside `worker/` silently skips that step, which has now cost
three rounds across two sessions.

```
npm run rebuild:ci
```

~2 minutes, ~260 requests. Rewrites only `dashboard.json`'s `ciHealth` key with
the corrected duration rule and prints the before/after. **`hoursPerMonth`
should collapse** from ~33,654 to the low hundreds; **`runsPerMonth` should
barely move** — the ceiling drops durations, not runs. If runs move, something
other than the ceiling changed and the rest of this block should wait.

```
cd worker
npx wrangler d1 execute nh-dashboard --remote --file schema.sql
cd ..
```

`workflow_runs` is a **new table**, so `schema.sql` is enough and there is no
migration file. (`CREATE TABLE IF NOT EXISTS` cannot add a *column* to an
existing table — that is what `migrations/` is for — but a new table needs
nothing.)

```
npm run backfill:runs -- --out worker/runs.sql
cd worker
npx wrangler d1 execute nh-dashboard --remote --file runs.sql
npx wrangler deploy
curl -X POST "https://nh-dashboard.gtnh.workers.dev/api/recompute?force=1"
```

Then reconcile — the section below says against what — and only then add
`ciHealth` to `LIVE_PANELS` in `web/js/live.js` and push.

**`wrangler deploy` and `git push` are independent and neither implies the
other.** Deploying without pushing means the page never asks for the new panel;
pushing without deploying means it asks and gets a 404. `origin/main` being
current says nothing about what the Worker is running.

## Read production through /api/health, and bust the cache

**`/api/health` will serve you a stale cached response.** This session opened by
reading it and getting the four-table shape from months ago — no `scope`, no
`repos`, no `commits` — and briefly concluded the Worker was far behind. A
cache-busting query string or `cache: "no-store"` gives the real answer. That is
twice this has sent an investigation down a blind alley.

`wrangler` cannot help here: **`--command` is refused by this account** (code
7403 on `/query`) and **`--file` goes through the import endpoint, which
executes statements and discards result rows.** There is no wrangler path to a
SELECT result against production. `--file` still applies migrations fine.

## What is live

Seven panels served from D1. `ciHealth` is built but deliberately not listed.

| Panel | Tier | Latency |
|---|---|---|
| `approvedUnmerged` | instant | seconds — rebuilt on the webhook delivery |
| `changesRequested` | instant | seconds — same |
| `contributors` | cron | ≤10 min |
| `analytics` | cron | ≤10 min |
| `needsRelease` | cron | ≤10 min |
| `depUpdates` | cron | ≤10 min |
| `byLabel` | cron | ≤10 min |
| `ciHealth` | cron | **built, not in `LIVE_PANELS`** |

Two panels still come from the daily build, and they are 32 of the 53 cards.

| Panel | Cards | Blocked on |
|---|---|---|
| `drilldown` | 22 — both drilldown pages | No `worker/src/panels/drilldown.js`. `drilldown_contributors` and `drilldown_repos` are already in `schema.sql` |
| `issues` | 10 — Issue Analytics | No `worker/src/panels/issues.js`. The `issues` table is in the schema and `worker/test/issues.parity.test.js` is written and skipping politely until the panel exists |

`issues` is next: the parity test is already written against it, which is the
order all seven of the others went in.

## Why ciHealth is not in LIVE_PANELS

The webhook captures forward only, and every figure on this card is computed
over the newest twenty completed runs per repo. Before the backfill, a quiet
repo shows one run and a pass rate of 100% — not stale data but a confidently
wrong answer, tinted **blue**, which is the one thing the tint exists to
prevent. Amber and red are the same stale data with opposite meanings; blue
asserts *this is current*, so a wrong blue is worse than the amber it replaces.

Adding it is one entry in `LIVE_PANELS`, after it reconciles.

## What the reconciliation has to check

Not a row count. Two of these would pass one.

- **252 repos** in the build's `ciHealth`. Materially fewer live means the
  backfill did not reach some repos, not that they have no CI.
- **`runsPerMonth` barely moves.** If it does, the sample *selection* differs,
  which is a different bug from the duration one.
- **`hoursPerMonth` collapses** from ~33,654 to the low hundreds. If it has not,
  the ceiling is not being applied on the live side.
- **`timedRuns < runs` on most repos, by about a seventh.** Equality means the
  ceiling is not firing.
- **`web/js/dream.js`'s `orgRepos()` reads `ciHealth.data.repos` as the org's
  repo list** for the exclusion popup. It is the only consumer of this panel
  that is not about CI, and a shorter list quietly shortens that menu.

## The card tint

Every card carries its state on its border. `web/js/data.js` → `freshness()`.

- **green** — instant
- **blue** — cron
- **amber** — from the static build, by design
- **red** — should have been live, the API did not answer

The tier travels as an `x-refresh` header the Worker sets, not a list in the
frontend, so a card retints itself when a panel moves between tiers.

## Live infrastructure

| Thing | Value |
|---|---|
| Worker | `https://nh-dashboard.gtnh.workers.dev` |
| D1 database | `nh-dashboard`, id `ed20adc3-f434-4f0a-8832-80862af30201` |
| GitHub App | `NH-Dashbot`, App ID `4745300` |
| Plan | Workers Paid |
| Cron | `*/10 * * * *` (recompute), plus a daily `0 5 * * *` CI build |

Endpoints: `/webhook`, `/api/health`, `/api/version`, `/api/panel/:name`,
`POST /api/recompute?force=1`.

## Filling the store

Four writers, on four different clocks. Each emits SQL; apply with
`wrangler d1 execute nh-dashboard --remote --file`.

```
npm run backfill:commits -- --out worker/backfill.sql   # history; slow, ~15k rows
npm run backfill:runs    -- --out worker/runs.sql       # ~260 requests, one per repo
npm run backfill:labels  -- --out worker/labels.sql     # 20 rows; when labels change
node worker/seed.js --out worker/seed.sql               # from the local ingest store
```

None needs Cloudflare credentials to *generate*, which is why CI can never run
them — the daily workflow has no Cloudflare secret at all, and adding one is a
decision nobody has made.

`backfill-runs.js` writes `repos` rows but deliberately **not `commits_since`**:
that column is the release panels' record of how far back *their* sweep walked,
and this sweep walks no commits. Writing NULL over it would shallow the
`depUpdates` floors — the exact bug that card already had once, arriving from a
script with nothing to do with it.

## Next: the remaining Node panels

`issues`, `issueMetrics`, `activeDays`, `drilldown`.

`issues` has its groundwork committed: `src/shared/issue-rules.js` pairs every
rule with its SQL twin, and `worker/test/issues.parity.test.js` passes 8
assertions comparing per issue rather than per total. The core needs **no JSON
support** — `unlabelled`/`unassigned` are the only questions asked of those
columns and every empty value is exactly `[]`. Only the label breakdown needs
`json_each`, still untested on D1.

`drilldown` is 23 MB and cannot use `panel_cache` — a D1 row caps at 2 MB. It
gets `drilldown_contributors` and `drilldown_repos`, already in the schema.

## The bug this port keeps producing

Every defect found while going live made the org look **healthier** than it was
— until this session, which found one pointing the other way.

- `commitsAhead` counted the sweep window, not commits — 20 where the truth was
  106, on the repos furthest behind
- `depUpdates` floors read 102 days where the truth was 365
- Seven private repos were withheld from a page that publishes them
- A stale-repo cutoff dropped 25 repos with commits from last week
- Repos with no commits at all vanished entirely
- **`ciHealth` durations read ~580,000 minutes where the truth was five**, which
  made the org look busier and more expensive rather than healthier

The direction changed; the cause did not. None was visible from the panel's own
output, and every one needed a second implementation, or the API, to disagree
with. **Keep the Node panels after porting; do not delete them.**

## Things that will bite again

**Check what a payload or a parameter actually carries.** Three times now: the
push payload's non-existent PR field, the release payload's non-existent tag
SHA, and `exclude_pull_requests`, which returns a byte-identical set of runs and
only empties each one's `pull_requests` array. The branch filter is what leaves
PR runs out. Each was documented confidently before being checked.

**`updated_at` on a workflow run is not an end time.** GitHub bumps it on log
expiry and job re-runs, months later. Durations over `CI_MAX_RUN_MINUTES` are
discarded, so `timedRuns < runs` is normal.

**`strftime` parses a date per row per call** — 43ms against 7ms for the
equivalent string comparison. Timestamps are fixed-width whole seconds, so
lexical order is chronological order. Compare strings, ceil the bound with
`isoBound`, normalise anything from a payload with `utcSeconds`. The one
legitimate use is a *duration*, which arithmetic requires and a string compare
cannot do — and even there the `CAST` is mandatory, because `strftime` returns
TEXT and SQLite orders every TEXT value above every number.

**±Infinity cannot cross the D1 wire.** Parameters serialise as JSON and
`Infinity` becomes `null`. Bind finite sentinels.

**A window frame defaults to RANGE, and RANGE cannot count.** Percentiles rank
with `ROWS UNBOUNDED PRECEDING`; without it, rows tied on a value share one
running total and the lookup returns NULL.

**A local SQLite replica proves logic, not dialect.** A six-arm `UNION` passed
every local test and failed on the first real recompute. **But it does predict
cost: D1 runs about 2.2× the local replica.**

**Write the parity test before the port, then try to break it.** The ciHealth
one was green on its first run, which meant nothing until eight deliberate
mutations of the panel were each confirmed to fail it.

**Do not name a CTE after a real table.** `worker/src/scope.js` rewrites
`FROM commits`, `FROM workflow_runs` and friends into filtered subqueries. For
the same reason, a **write** must use the raw handle: `DELETE FROM (SELECT …)`
is not a statement, which is why `pruneWorkflowRuns` takes `env.DB`.

**`CREATE TABLE IF NOT EXISTS` will not add a column.** New columns need a file
in `worker/migrations/`, applied before `schema.sql`. New *tables* need nothing.

## Known divergences from the build

**`needsRelease`** — three repos, one cause: a release webhook carries no tag
SHA, so the panel compares commit *dates* against `published_at` where the Node
version compares *ancestry*. They agree until a tag is cut from an older commit.

| Repo | Build | Live |
|---|---|---|
| BugTorch | 79 ahead | 35 |
| TinkersGregworks | 50 ahead | absent |
| Variable-Horizons | 2 ahead | absent |

Two fail by dropping a repo silently. The fix is to have the daily build resolve
each tag to its commit and store it; deliberately not done at three repos.

**`depUpdates` reconciles at 279, not the 276 this file predicted.** The
prediction was made before the deploy and assumed six repos with no commits;
there are nine. Live is a strict superset of the build, and the three extra —
`Mobile-Issues-Tracker`, `ao-issue-tracker`, `nac-issue-tracker` — are
issue-only repos holding no code, which is exactly the noise `releases.js`
predicted the `LEFT JOIN` would add. 244 exact rows + 35 floors = 279, and
`withCommitsInWindow` (270) + 9 = 279. It errs unflattering, which is the safe
direction.

## Commands

```
npm run test:freshness    21   the card tint
npm run test:exclusion    17   the ingest exclusion
npm run test:handlers     59   webhook handlers
npm run test:recompute    26   the cron and the instant path
npm run test:parity      157   across seven panels
                        ----
                         280

npm run rebuild:ci             one panel, ~2 min, instead of a 592s build
cd worker && npx wrangler deploy
npx wrangler tail
```

Every suite builds its own SQLite replica from `schema.sql` + `seed.sql` and
skips politely when those are absent, which they are in CI.

Deploys must run from a machine logged in to Cloudflare.

## Parked, deliberately

**Traffic.** `npm run ingest:traffic` runs by hand and nothing renders it. The
store holds 2026-08-13 → 08-28; GitHub's window is 14 days, so **Aug 29 becomes
unrecoverable around Sept 12** if it is not run before then. The one dataset
here that cannot be backfilled. Loading it into D1 is the fix.

**The org-wide `meanRunMinutes` divides by `sampledRuns` while each repo's own
mean divides by `timedRuns`.** With roughly a seventh of runs now untimed, that
biases the org figure downwards — the opposite direction from the bug the
ceiling fixed, and much smaller. Left alone because it is existing behaviour and
changing it would move a number for an unrelated reason.

**The ingest exclusion.** `NH_INGEST_EXCLUDE` is applied in code and covered by
`npm run test:exclusion`, but CI has no repo secret, so a CI build still
republishes the excluded repo. Settle it when the repo moves into the org.

**The Leaderboard sorts by all-time under a subtitle claiming the selected
period.** Predates all of this. One line either way; which line is a product
question.

---

## Open the next conversation with

> Read `handoff.md` and `going-live-status.md`. Run the block at the top — the
> `ciHealth` port is committed and none of it is applied or deployed. Then
> reconcile the live panel against `data/dashboard.json` on the five checks that
> file lists, not on a row count, before adding `ciHealth` to `LIVE_PANELS`.
> After that, port `issues`, which already has its parity test written.
