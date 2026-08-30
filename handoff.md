# Handoff — going live

Paste the opening line at the bottom into a fresh conversation. This file is the
map; `going-live-status.md` is the territory and wins where they disagree. Both
are temporary and get deleted when the migration lands.

Rewritten 2026-08-30, after the five Dream Panel cards went live.

---

## Do this first — one Worker change is committed but not deployed

```
cd worker && npx wrangler deploy
curl -X POST "https://nh-dashboard.gtnh.workers.dev/api/recompute?force=1"
git push          # handoff.md only, no deploy implication
```

`depUpdates` currently returns **270**; it should return **276**. The difference
is six repos with no commits at all, which used to vanish and now get a
365-day floor — the last commit to `worker/src/panels/releases.js` changed
`JOIN seen` to `LEFT JOIN`, and that commit landed after the most recent deploy.

This is the failure mode worth internalising, because it has now happened in
both directions in one session: **`wrangler deploy` and `git push` are
independent, and neither implies the other.** Deploying without pushing means
the page never asks for the new panels; pushing without deploying means it asks
and gets a stale answer. `origin/main` being current says nothing about what the
Worker is running.

Confirm afterwards:

```
curl -s "https://nh-dashboard.gtnh.workers.dev/api/health" | jq .scope
```

`reposWithEpochPushedAt` should be 0, and `withCommitsInWindow` (270) plus the
six floor rows should equal `/api/panel/depUpdates`' length (276). On the page,
the three new cards should tint **blue**, not amber and not red.

Note the failure mode this replaced: deploying the Worker without pushing means
the page never asks for the new panels, and pushing without deploying means it
asks and gets a 404. Both are needed, and neither implies the other —
`wrangler deploy` has nothing to do with git.

## What is live

Seven panels are served from D1. Five are the whole Dream Panel.

| Panel | Tier | Latency |
|---|---|---|
| `approvedUnmerged` | instant | seconds — rebuilt on the webhook delivery |
| `changesRequested` | instant | seconds — same |
| `contributors` | cron | ≤10 min |
| `analytics` | cron | ≤10 min |
| `needsRelease` | cron | ≤10 min |
| `depUpdates` | cron | ≤10 min |
| `byLabel` | cron | ≤10 min |

Only **`ciHealth`** still comes from the daily build.

The instant path runs inside `ctx.waitUntil` after the 200 has gone back to
GitHub, so it cannot delay or fail a delivery — which matters more than the
freshness, because a webhook that keeps failing gets disabled silently. Only
`pull_request` and `pull_request_review` trigger it.

`needsRelease` and `depUpdates` measure 15ms and 44ms on D1, well inside the
instant budget. They are on the cron anyway: promoting them means firing the
instant path on `push`, which arrives far more often than `pull_request`, for
cards nobody reads to the minute. The numbers are the argument if that ever
changes; the tier reaches the frontend as an `x-refresh` header, so a card
retints itself when it moves.

## The card tint

Every card carries its state on its border. `web/js/data.js` → `freshness()`.

- **green** — instant
- **blue** — cron
- **amber** — from the static build, by design
- **red** — should have been live, the API did not answer

Amber and red are the same stale data and opposite meanings. Blue is the
dangerous one: it asserts *this is current*, so a wrong blue is worse than the
amber it replaced. That is the whole reason each card was held back until it
reconciled against the build rather than merely returning rows.

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

## Read production through /api/health, not wrangler

**`wrangler --command` is refused by this account** — code 7403 on the `/query`
endpoint — and **`--file` goes through the import endpoint, which executes
statements and throws away result rows.** A five-statement diagnostic reported
"30,563 rows read" and printed nothing. There is currently no wrangler path to a
SELECT result against production. `--file` still applies migrations fine.

So `/api/health` carries the diagnostics, and it reports the *funnel* rather
than just row counts, because every bug this port produced was invisible in a
count and obvious in the funnel:

```
counts: repos, pull_requests, reviews, issues, commits, releases, traffic_daily
scope:  live, withHorizon, droppedAsDormant, withCommits,
        withCommitsInWindow, commitsAwaitingPrAnswer, reposWithEpochPushedAt
```

`withCommitsInWindow` should equal `depUpdates`' row count. When it did not, the
rows were present and a predicate was eating them — a different investigation
from a store that never loaded, and not distinguishable any other way.

**Fetch it `no-store`.** It can serve a cached response and has sent one
investigation down a blind alley already.

## Filling the store

Three writers, on three different clocks.

```
npm run backfill:commits -- --out worker/backfill.sql   # history; slow, ~15k rows
npm run backfill:labels  -- --out worker/labels.sql     # 20 rows; when labels change
node worker/seed.js --out worker/seed.sql               # from the local ingest store
```

Each emits SQL; apply with `wrangler d1 execute nh-dashboard --remote --file`.
None needs Cloudflare credentials to *generate*, which is why CI can never run
them — the daily workflow has no Cloudflare secret at all, and adding one is a
decision nobody has made.

`backfill-commits.js` sweeps in three passes: releases and repo rows at 50 a
page, commit history at 10, then a deeper walk for the few repos whose last
release predates the lookback. Combining the first two into one query returned
502 forever — a GraphQL 502 is a server-side timeout, so retries cannot help.
It writes what it has on `SIGINT`, marked `-- PARTIAL`, and every write is an
upsert on a natural key, so partial and full runs converge.

## Next: ciHealth, the last discarded event

`workflow_run` is still on `onRepoTouch` — received, repo row upserted, payload
thrown away. It is the last of the three events that were being discarded;
`push` and `release` are now captured.

`src/panels/ciHealth.js` is the target. What makes it tractable:

- **`summarizeRuns(runs)` is already exported and pure.** It takes an array of
  run objects and returns the panel's per-repo shape. That is the SQL twin
  boundary, already drawn — write the parity test against it first.
- The Node version asks for `CI_RUN_SAMPLE` (20) most recent **completed** runs
  per repo, on the **default branch**, with `exclude_pull_requests=true`.
- A `workflow_run` payload carries everything that needs: `conclusion`,
  `run_started_at`, `updated_at`, `html_url`, `name`, `head_branch`, `event`.
  The three filters above become a WHERE clause.
- Output is `{ repos: {...}, org: {...} }` — nested deliberately, so a repo
  named `org` cannot shadow the roll-up.

A `workflow_runs` table wants `(repo, run_id)` as its key, a `head_branch`, and
enough of a bound that it does not grow without limit — the panel only ever
reads the newest 20 per repo, so anything older can be pruned.

**`workflow_run` fires constantly.** It is the one event volume matters for.
Do not put it on the instant path, and check what a busy day costs in D1 writes
before deciding how much history to keep.

A backfill is needed too, for the same reason as commits: the webhook only
captures forward, and 20 runs × ~250 active repos is one REST call each.

## Then: the remaining Node panels

`issues`, `issueMetrics`, `activeDays`, `drilldown`.

`issues` has its groundwork committed already: `src/shared/issue-rules.js` pairs
every rule with its SQL twin, and `worker/test/issues.parity.test.js` passes 8
assertions comparing per issue rather than per total. The core needs **no JSON
support** — `unlabelled`/`unassigned` are the only questions asked of those
columns and every empty value is exactly `[]`. Only the label breakdown needs
`json_each`, which is still untested on D1.

`drilldown` is 23 MB and cannot use `panel_cache` — a D1 row caps at 2 MB. It
gets `drilldown_contributors` and `drilldown_repos`, already in the schema.

## The bug this port keeps producing

Every defect found while going live made the org look **healthier** than it was.

- `commitsAhead` counted the sweep window, not commits — 20 where the truth was
  106, on the repos furthest behind
- `depUpdates` floors read 102 days where the truth was 365, because the horizon
  came from the oldest stored row rather than from how far the sweep looked
- Seven private repos were withheld from a page that publishes them
- A stale-repo cutoff dropped 25 repos that had commits from last week
- Six repos with no commits at all vanished entirely — the strongest form of the
  thing the card looks for, answered by omission

None was visible from the panel's own output. Every one needed a second
implementation to disagree with. **Keep the Node panels after porting; do not
delete them.** They are the only oracle this project has.

## Things that will bite again

**`strftime` parses a date per row per call** — 43ms against 7ms for the
equivalent string comparison. Timestamps are fixed-width whole seconds, so
lexical order is chronological order. Compare strings, ceil the bound with
`isoBound`, and normalise anything arriving from a payload with `utcSeconds` —
a push commit's timestamp carries the committer's offset, and `+02:00` sorts
below `Z`.

**If you do use `strftime('%s')`, cast it.** It returns TEXT, and SQLite orders
every TEXT value above every number, so an uncast comparison is *constant*.

**±Infinity cannot cross the D1 wire.** Parameters serialise as JSON and
`Infinity` becomes `null`. Bind finite sentinels.

**A window frame defaults to RANGE, and RANGE cannot count.** Percentiles rank
with `ROWS UNBOUNDED PRECEDING`; without it, rows tied on a value share one
running total and the lookup returns NULL.

**A local SQLite replica proves logic, not dialect.** A six-arm `UNION` passed
every local test and failed on the first real recompute. **But it does predict
cost: D1 runs about 2.2× the local replica.** Profile locally and multiply
rather than spending a deploy per hypothesis.

**Write the parity test before the port.** It has caught a hardcoded
`truncated: 0`, the TEXT comparison above, a `closerUnknown` rule the real store
cannot exercise, and a shim whose `bind()` mutated shared state — that last one
let 31 assertions pass while silently breaking the one caller that batches.

**Do not name a CTE after a real table.** `worker/src/scope.js` rewrites
`FROM commits`, `FROM repos` and friends into filtered subqueries; a CTE with
one of those names would be rewritten too.

**`CREATE TABLE IF NOT EXISTS` will not add a column.** New columns on existing
tables need a file in `worker/migrations/`, applied before `schema.sql`. New
*tables* need nothing — `schema.sql` is idempotent.

**A theory that fits the symptom is not evidence.** Twenty-four repos vanished
and the cause looked certain: `repository.pushed_at` is an epoch integer on
`push` events, which would sort below every ISO date. Every detail fit. It was
wrong — the counter added to prove it came back 0. Check before writing it down
as fact, which is the same lesson the previous handoff's push-payload claim
taught from the other direction.

## Known divergences from the build

Live and the build disagree on three repos, all in `needsRelease`, all from one
cause: **a release webhook carries no tag SHA**, so the panel compares commit
*dates* against `published_at` where the Node version compares *ancestry*
(`tagSha...headSha`). They agree until a tag is cut from an older commit.

| Repo | Build | Live |
|---|---|---|
| BugTorch | 79 ahead | 35 |
| TinkersGregworks | 50 ahead | absent |
| Variable-Horizons | 2 ahead | absent |

Two fail by dropping a repo silently. The fix is to have the daily build resolve
each tag to its commit and store it; deliberately not done at three repos.
Worth re-checking whether it is still three.

`depUpdates` reconciles exactly at 276 — 270 repos with commits inside the
window, plus the 6 with none, which report a 365-day floor. If it reads 270, the
deploy at the top of this file has not been run.

## Commands

```
npm run test:freshness    # 14, the card tint
npm run test:exclusion    # 17, the ingest exclusion
npm run test:handlers     # 51, webhook handlers
npm run test:recompute    # 26, the cron and the instant path
npm run test:parity       # 118 across six panels

cd worker && npx wrangler deploy
npx wrangler tail
curl -X POST "https://nh-dashboard.gtnh.workers.dev/api/recompute?force=1"
```

Every suite builds its own SQLite replica from `schema.sql` + `seed.sql` and
skips politely when those are absent, which they are in CI.

Deploys must run from a machine logged in to Cloudflare. **Run wrangler commands
from `worker/`** — chaining `cd worker &&` onto the first line of a block means
pasting it while already there silently skips that step, which has now cost two
rounds.

## Parked, deliberately

**Traffic.** `npm run ingest:traffic` runs by hand and nothing renders it. The
store holds 2026-08-13 → 08-28; GitHub's window is 14 days, so **Aug 29 becomes
unrecoverable around Sept 12** if it is not run before then. It is the one
dataset here that cannot be backfilled. Loading it into D1 is the fix.

**The ingest exclusion.** `NH_INGEST_EXCLUDE` is applied in code and covered by
`npm run test:exclusion`, but CI has no repo secret, so a CI build still
republishes the excluded repo. Settle it when the repo moves into the org.

**The Leaderboard sorts by all-time under a subtitle claiming the selected
period.** Predates all of this. One line either way; which line is a product
question.

**`git rm -r --cached data/`.** `data/` is tracked and committed.

---

## Open the next conversation with

> Read `handoff.md` and `going-live-status.md`. Capture `workflow_run`, the last
> event the webhook receives and discards, and port `ciHealth` off the daily
> build. Parity test first, against
> `summarizeRuns`. Reconcile the result against `data/dashboard.json` before
> adding it to `LIVE_PANELS` — every defect this port has produced made the org
> look healthier than it was, and none was visible without a second
> implementation to disagree with.
