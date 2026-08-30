# Handoff — going live

Paste the opening line at the bottom into a fresh conversation. This file is the
map; `going-live-status.md` is the territory and wins where they disagree. Both
are temporary and get deleted when the migration lands.

Rewritten 2026-08-30, after `ciHealth` went live.

---

## The one deadline in this project

**Traffic. Aug 29 becomes unrecoverable around Sept 12.**

`npm run ingest:traffic` runs by hand, the store holds 2026-08-13 → 08-28, and
GitHub's traffic window is 14 days with no backfill. It is the only dataset here
where delay costs something permanent — PRs, issues, commits and runs can all be
re-walked whenever. `traffic_daily` is in the schema and holds **0 rows**; it was
the deferred half of the original seed split and has been parked ever since.

Nothing else in this file is urgent. This is.

## Where the port stands

Eight panels served from D1, and every event the App subscribes to is now
captured — `workflow_run` was the last one being received and discarded.

| Panel | Tier | Latency |
|---|---|---|
| `approvedUnmerged` | instant | seconds — rebuilt on the webhook delivery |
| `changesRequested` | instant | seconds — same |
| `contributors` | cron | ≤10 min |
| `analytics` | cron | ≤10 min |
| `needsRelease` | cron | ≤10 min |
| `depUpdates` | cron | ≤10 min |
| `byLabel` | cron | ≤10 min |
| `ciHealth` | cron | ≤10 min |

**The panel count flatters it.** Two panels still come from the daily build and
they are **32 of the 53 cards**, so most of this page is still static:

| Panel | Cards | Blocked on |
|---|---|---|
| `drilldown` | 22 — both drilldown pages | No `worker/src/panels/drilldown.js`. `drilldown_contributors` and `drilldown_repos` are already in `schema.sql` |
| `issues` | 10 — Issue Analytics | No `worker/src/panels/issues.js`. The `issues` table is in the schema and `worker/test/issues.parity.test.js` is written and skipping politely until the panel exists |

Neither is blocked on data. Both are blocked on someone writing the panel.

## Next: the `issues` port

The groundwork is committed and it is the same shape the other eight went in.

`src/shared/issue-rules.js` pairs every rule with its SQL twin, and
`worker/test/issues.parity.test.js` already passes 8 assertions comparing per
issue rather than per total. The core needs **no JSON support** —
`unlabelled`/`unassigned` are the only questions asked of those columns and every
empty value is exactly `[]`. Only the label breakdown needs `json_each`, which is
still untested on D1.

After that: `issueMetrics`, `activeDays`, `drilldown`. `drilldown` is 23 MB and
cannot use `panel_cache` — a D1 row caps at 2 MB — which is why it gets its own
materialised tables, already in the schema.

## Then, and these are decisions rather than work

- **Step 10 of Phase D: deploying the Worker from Actions.** Not done. The daily
  workflow has no Cloudflare secret at all and adding one is a call nobody has
  made. Every deploy today is manual, from a machine logged in to Cloudflare.
- **Phase E — App auth and the private backfill.** Unblocked since the decision
  that private repo data ships publicly. `getToken()` swaps to the App flow,
  then the ingest walks the 12 private repos for the first time.
- **Phase F — cleanup.** Retire `GH_DASHBOARD_TOKEN`, move the repo into the
  org, and decide what to do about 96 MB of git history. The org move is the
  event that forces the `NH_INGEST_EXCLUDE` question below.

## Live infrastructure

| Thing | Value |
|---|---|
| Worker | `https://nh-dashboard.gtnh.workers.dev` |
| D1 database | `nh-dashboard`, id `ed20adc3-f434-4f0a-8832-80862af30201` |
| GitHub App | `NH-Dashbot`, App ID `4745300` |
| Plan | Workers Paid |
| Cron | `*/10 * * * *` (recompute), plus a daily `0 5 * * *` build |
| Pages | `https://ultraprodigy.github.io/NH-Dashboard/` |

Endpoints: `/webhook`, `/api/health`, `/api/version`, `/api/panel/:name`,
`POST /api/recompute?force=1`.

## Four things ship independently and none implies another

This has cost time in three different directions now, so it is a table.

| Action | Changes |
|---|---|
| `git push` | the repo, and Pages via the workflow |
| `wrangler deploy` | the Worker's code, nothing else |
| `wrangler d1 execute` | D1's contents |
| a `data` workflow run | the published `data/*.json` |

`origin/main` being current says nothing about what the Worker is running.
Deploying the Worker without pushing means the page never asks for a new panel.
And **a local `npm run build` or `npm run rebuild:ci` never reaches Pages** — the
workflow restores `data/*.json` from its own Actions cache, so a clean file on
your disk proves nothing about the deployed one. Only a `data` run (the 05:00
cron, or `gh workflow run build.yml`) republishes numbers.

## Read production through /api/health, and bust the cache

**`/api/health` will serve you a stale cached response.** One session opened by
reading it, got a shape from months earlier, and concluded the Worker was far
behind. A cache-busting query string or `cache: "no-store"` gives the real
answer. That is twice it has sent an investigation down a blind alley.

`wrangler` cannot substitute: **`--command` is refused by this account** (code
7403 on `/query`) and **`--file` goes through the import endpoint, which executes
statements and discards result rows.** There is no wrangler path to a SELECT
result against production. `--file` still applies migrations fine.

What the endpoint reports, and why it is a funnel rather than row counts — every
bug this port produced was invisible in a count and obvious in the funnel:

```
counts: repos, pull_requests, reviews, issues, commits, releases,
        workflow_runs, traffic_daily
scope:  live, withHorizon, droppedAsDormant, withCommits,
        withCommitsInWindow, commitsAwaitingPrAnswer, reposWithEpochPushedAt,
        reposWithRuns, reposWithRunsOnDefault
```

`reposWithRuns` against `reposWithRunsOnDefault` is the newest pair and catches
the CI panel's quietest failure: a repo that renames `master` to `main` keeps
every run row it had and shows nothing, because runs are stored with the branch
they ran on and the panel matches the *current* default branch.

## The card tint

Every card carries its state on its border. `web/js/data.js` → `freshness()`.

- **green** — instant
- **blue** — cron
- **amber** — from the static build, by design
- **red** — should have been live, the API did not answer

Amber and red are the same stale data with opposite meanings, so an outage must
not share a colour with the legitimately-static half of the page. Blue is the
dangerous one: it asserts *this is current*, so a wrong blue is worse than the
amber it replaces. That is the entire reason each panel was held out of
`LIVE_PANELS` until it reconciled against the build rather than merely returning
rows. The tier travels as an `x-refresh` header the Worker sets, never a second
list in the frontend.

## Filling the store

Four writers, on four different clocks. Each emits SQL; apply with
`wrangler d1 execute nh-dashboard --remote --file`, run from `worker/`.

```
npm run backfill:commits -- --out worker/backfill.sql   # history; slow, ~15k rows
npm run backfill:runs    -- --out worker/runs.sql       # ~260 requests, one per repo
npm run backfill:labels  -- --out worker/labels.sql     # 20 rows; when labels change
node worker/seed.js --out worker/seed.sql               # from the local ingest store
```

None needs Cloudflare credentials to *generate*, which is why CI can never run
them. All are upserts on natural keys, so a partial file applied now and a full
one later converge.

`backfill-runs.js` writes `repos` rows but deliberately **not `commits_since`**:
that column is the release panels' record of how far back *their* sweep walked,
and this sweep walks no commits. Writing NULL over it would shallow the
`depUpdates` floors — a bug that card already had once, arriving from a script
with nothing to do with it.

## The bug this port keeps producing

Every defect found while going live made the org look **healthier** than it was,
until the last one, which pointed the other way.

- `commitsAhead` counted the sweep window, not commits — 20 where the truth was
  106, on the repos furthest behind
- `depUpdates` floors read 102 days where the truth was 365
- Seven private repos were withheld from a page that publishes them
- A stale-repo cutoff dropped 25 repos with commits from last week
- Six repos with no commits at all vanished entirely
- **`ciHealth` durations read ~580,000 minutes where the truth was five**, which
  made the org look busier and more expensive rather than healthier
- **A green workflow run deployed nothing at all**, and said success

The direction varies; the cause does not. None was visible from the thing's own
output. **Keep the Node panels after porting; do not delete them.** They are the
only oracle this project has.

## Things that will bite again

**Check what a payload or a parameter actually carries.** Three times: the push
payload's non-existent PR field, the release payload's non-existent tag SHA, and
`exclude_pull_requests`, which returns a byte-identical set of runs and only
empties each one's `pull_requests` array — the branch filter is the whole of the
exclusion. Each was documented confidently before being checked.

**Do not extrapolate a rate from a sample chosen for its outliers.** The discard
rate went into three files as "about one in seven", from fourteen repos picked
as the worst offenders. Measured org-wide it is 1.7% — 53 of 3,156 runs.

**A skip propagates down the whole job graph, not one edge.** `data` is skipped
on a push; `site` survives on its own `always()`; `deploy` inherited the skip
*through* `site` and was itself skipped while the run reported success. Both
`site` and `deploy` now carry `if: always() && needs.<dep>.result == 'success'`.
The result check is not decoration — `always()` alone would deploy over a failed
`site`.

**`updated_at` on a workflow run is not an end time.** GitHub bumps it on log
expiry and job re-runs, months later. Durations over `CI_MAX_RUN_MINUTES` are
discarded, so `timedRuns < runs` on a minority of repos is normal.

**`strftime` parses a date per row per call** — 43ms against 7ms for the
equivalent string comparison. Timestamps are fixed-width whole seconds, so
lexical order is chronological order. Compare strings, ceil the bound with
`isoBound`, normalise anything from a payload with `utcSeconds`. The one
legitimate use is a *duration*, which arithmetic requires; even there the `CAST`
is mandatory, because `strftime` returns TEXT and SQLite orders every TEXT value
above every number.

**±Infinity cannot cross the D1 wire.** Parameters serialise as JSON and
`Infinity` becomes `null`. Bind finite sentinels.

**A window frame defaults to RANGE, and RANGE cannot count.** Percentiles rank
with `ROWS UNBOUNDED PRECEDING`; without it, rows tied on a value share one
running total and the lookup returns NULL.

**D1 rejects a compound SELECT with more than a few arms.** A six-arm `UNION`
passed every local test and failed on the first real recompute. A local replica
proves logic, never dialect — **but it does predict cost: D1 runs about 2.2× the
local replica.** Profile locally and multiply rather than spending a deploy per
hypothesis.

**Write the parity test before the port, then try to break it.** The `ciHealth`
one was green on its first run, which meant nothing until eight deliberate
mutations of the panel were each confirmed to fail it.

**Do not name a CTE after a real table.** `worker/src/scope.js` rewrites
`FROM commits`, `FROM workflow_runs` and friends into filtered subqueries. For
the same reason a **write** must use the raw handle: `DELETE FROM (SELECT …)` is
not a statement, which is why `pruneWorkflowRuns` takes `env.DB`.

**`CREATE TABLE IF NOT EXISTS` will not add a column.** New columns need a file
in `worker/migrations/`, applied before `schema.sql`. New *tables* need nothing.

**A theory that fits the symptom is not evidence.** Twenty-four repos vanished
and the cause looked certain — an epoch `pushed_at` sorting below every ISO date.
Every detail fit. The counter added to prove it came back 0.

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

**`depUpdates` reconciles at 279**, not the 276 an earlier handoff predicted.
244 exact rows + 35 floors, and `withCommitsInWindow` (270) + 9 repos with no
commits = 279. Live is a strict superset of the build; the three extra —
`Mobile-Issues-Tracker`, `ao-issue-tracker`, `nac-issue-tracker` — are issue-only
repos holding no code, exactly the noise `releases.js` predicted the `LEFT JOIN`
would add. It errs unflattering, which is the safe direction.

**`ciHealth` reconciles exactly** on 252 repos, 3,156 sampled runs, 3,029
decisive, 185 failures, and a pass rate matching to sixteen decimal places. The
only difference is 10.4 minutes of sampled time out of 11,569, traced to six
repos at the 20-run cap whose sample slid in the fifteen minutes between the
build and the backfill.

## Commands

```
npm run test:freshness    21   the card tint
npm run test:exclusion    17   the ingest exclusion
npm run test:handlers     59   webhook handlers
npm run test:recompute    26   the cron and the instant path
npm run test:parity      157   across seven panels
                        ----
                         280

npm run rebuild:ci             one panel, ~2.5 min, instead of a 592s build
cd worker && npx wrangler deploy
npx wrangler tail
curl -X POST "https://nh-dashboard.gtnh.workers.dev/api/recompute?force=1"
gh workflow run build.yml      republish data/*.json to Pages
```

Every suite builds its own SQLite replica from `schema.sql` + `seed.sql` and
skips politely when those are absent, which they are in CI.

**Run wrangler from `worker/`.** Chaining `cd worker &&` onto the first line of a
block means pasting it while already there silently skips that step, which has
now cost three rounds across two sessions.

## Parked, deliberately

**The ingest exclusion, and the org move is the same event.** `NH_INGEST_EXCLUDE`
keeps `Dupes-Exploits-GTNH` out of the published artefact, and with the display
filter dropped it is the *only* thing doing so. It is applied in code and covered
by `npm run test:exclusion`, but **CI has no repo secret**, so a CI build still
republishes the repo. Add it under Settings → Secrets and variables → Actions
*before* the next `data` run.

That becomes urgent at the org move rather than before it: moving in means the
repo goes public, `data/` is in the git *history*, and that history includes
`dashboard.json` versions carrying the excluded repo's issue titles. Untracking
`data/` going forward did not remove what is already there.

**The org-wide `meanRunMinutes` divides by `sampledRuns` while each repo's own
mean divides by `timedRuns`.** With 1.7% of runs untimed that bias is real but
roughly a thousandth of the bug the ceiling fixed. Existing behaviour; changing
it would move a number for an unrelated reason.

**The Leaderboard sorts by all-time under a subtitle claiming the selected
period.** Predates all of this. One line either way; which line is a product
question.

---

## Open the next conversation with

> Read `handoff.md` and `going-live-status.md`. Load `traffic_daily` into D1 —
> the store holds through Aug 28, GitHub's window is 14 days, and it is the only
> dataset here that cannot be backfilled. Then port `issues` off the daily
> build, which already has its parity test written against
> `src/shared/issue-rules.js`. Parity test first, and try to break it before
> trusting it; reconcile against `data/dashboard.json` before adding anything to
> `LIVE_PANELS`. Every defect this port has produced was invisible in the
> panel's own output and needed a second implementation to disagree with.
