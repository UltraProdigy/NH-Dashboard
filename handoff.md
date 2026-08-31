# Handoff — going live

Paste the opening line at the bottom into a fresh conversation. This file is the
map; `going-live-status.md` is the territory and wins where they disagree. Both
are temporary and get deleted when the migration lands.

Rewritten 2026-08-30, after the `issues` port. Updated 2026-08-31, after
reconciling it against production.

---

## Nothing here is on a deadline any more

Traffic was the one clock-bound thing and it has been caught up. The store holds
**Aug 13–29 dense, 5,405 rows**; the one-row hole on Aug 28 is filled and Aug 29
is captured. Aug 30 is deliberately absent — the ingest discards the current day
because GitHub counts it as it goes.

What is left is not a deadline but it is still the only copy: **`traffic_daily`
holds 0 rows in D1**, and the store on one laptop is all there is. The SQL is
generated and gitignored:

```
cd worker
npx wrangler d1 execute nh-dashboard --remote --file traffic.sql
```

Re-run `npm run ingest:traffic` first if more than a few days have passed —
it is safely re-runnable and overlapping runs replace rather than duplicate.

## Where the port stands

**Nine of the ten panels can now be served from D1.** `issues` was the last
substantial one and it is done: fifteen keys, six identical to the build byte
for byte and the rest differing only by a day and a half of freshness.

| Panel | Tier | Note |
|---|---|---|
| `approvedUnmerged` | instant | rebuilt on the webhook delivery |
| `changesRequested` | instant | same |
| `contributors` | cron | ≤10 min |
| `analytics` | cron | ≤10 min |
| `needsRelease` | cron | ≤10 min |
| `depUpdates` | cron | ≤10 min |
| `byLabel` | cron | ≤10 min |
| `ciHealth` | cron | ≤10 min |
| `issues` | cron | **deployed and reconciled; blocked on migration 004** |
| `drilldown` | — | the last one still from the build |

`issues` has now been reconciled against production as well as the seed, and the
gate earned its keep: it found the `state_reason` casing bug below, which no
parity test here could have seen. It goes live once migration 004 has repaired
the nine rows that bug already wrote.

**After `issues` goes live, `drilldown` is the whole of what remains** — 22 of the
53 cards, both drilldown pages.

## Do these in order

1. **Push.** The junk files are gone and the Worker carrying `issues` is already
   deployed; what is unpushed is the `state_reason` fix below.
2. **Load traffic**, as above.
3. **Repair `state_reason`, then promote `issues`.** The reconciliation is done
   — see `going-live-status.md` — and it found one defect: the webhook handler
   was storing the payload's lowercase `not_planned` where the seed holds
   `NOT_PLANNED`, so nine closed issues were being read as completed. Fixed in
   `handlers.js`; the rows already in D1 need the migration.

```
cd worker
npx wrangler d1 execute nh-dashboard --remote --file migrations/004-normalise-state-reason.sql
npx wrangler deploy
curl -X POST "https://nh-dashboard.gtnh.workers.dev/api/recompute?force=1"
```

   Then check `/api/panel/issues` reads `unknownReason: 0` and `notPlanned:
   5105` again, add `"issues"` to `LIVE_PANELS`, and push.

4. **Then `drilldown`.** See below.

## Next: `drilldown`, and it is not shaped like the others

Every panel so far was "compute a blob, cache it, overlay it". This one cannot
be, and it is the only remaining piece of the migration.

`data/drilldown.json` is 23 MB, against a **2 MB D1 row cap**, so `panel_cache`
is out. The shape is what makes it tractable:

| Part | Size | Notes |
|---|---|---|
| `contributors` | 18.4 MB | 6,749 entries keyed by login |
| `repos` | 3.2 MB | 298 entries keyed by repo |
| `index` | 0.5 MB | what the pickers need up front |
| 17 schema keys | tiny | field-name lists, windows, buckets |

So it is not a blob that resists a Worker, it is 6,749 rows waiting for
`WHERE login = ?`. `drilldown_contributors` and `drilldown_repos` are **already
in `schema.sql`** for exactly this; the recompute materialises them and
`/api/contributor/{login}` serves one. The `index` and the schema keys are small
enough to be an ordinary cached blob.

**This is the first one that needs a frontend change.** Every other panel was one
entry in `LIVE_PANELS`. The drilldown pages load one 23 MB file today and would
have to fetch a row on demand instead. Budget for that rather than discovering it.

Two things already known about the content: `src/panels/drilldown.js` computes
`people` differently by subject type, and the resolved-PR rows are positional
arrays like the issue panel's people rows — `resolvedFields` and friends are the
column orders, and they belong in a shared module before a second implementation
packs them.

## Then, and these are decisions rather than work

- **Step 10 of Phase D: deploying the Worker from Actions.** Not done. The daily
  workflow has no Cloudflare secret and adding one is a call nobody has made.
  Every deploy today is manual, from a machine logged in to Cloudflare.
- **Phase E — App auth and the private backfill.** Unblocked since the decision
  that private repo data ships publicly. `getToken()` swaps to the App flow, then
  the ingest walks the 12 private repos for the first time.
- **Phase F — cleanup.** Retire `GH_DASHBOARD_TOKEN`, move the repo into the org,
  decide what to do about 96 MB of git history. The org move is the event that
  forces the `NH_INGEST_EXCLUDE` question below.

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
And **a local `npm run build` or `npm run rebuild:*` never reaches Pages** — the
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

`traffic_daily` reading 0 is how you will know the load above has not run.

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
node worker/seed.js --only=traffic --out worker/traffic.sql
```

None needs Cloudflare credentials to *generate*, which is why CI can never run
them. All are upserts on natural keys, so a partial file applied now and a full
one later converge. `seed.js` resolves store paths against the repo, so it works
from any directory — it used to find nothing when run from `worker/` and write a
valid empty file.

`backfill-runs.js` writes `repos` rows but deliberately **not `commits_since`**:
that column is the release panels' record of how far back *their* sweep walked,
and this sweep walks no commits. Writing NULL over it would shallow the
`depUpdates` floors.

## The bug this port keeps producing

Two families now, and the second one turned out to be much the larger.

**Every defect made the org look healthier than it was** — until `ciHealth`,
which pointed the other way. `commitsAhead` counted the sweep window rather than
commits, 20 against a true 106. `depUpdates` floors read 102 days where the truth
was 365. Seven private repos were withheld from a page that publishes them. A
stale-repo cutoff dropped 25 repos with commits from last week. Six repos with no
commits vanished entirely. `ciHealth` durations read ~580,000 minutes where the
truth was five. A green workflow run deployed nothing at all, and said success.

**And a list sorted on a metric alone leaves its ties in store order.** This one
turned up in *seven* places and was never once cosmetic, because store order is
not something SQL can reproduce — the two implementations disagree by
construction, on the rows nobody looks at closely:

| Where | What it was deciding |
|---|---|
| `people` (by-contributor) | 256 people level on involvement 1 in `m1`, 74 fit. **79 rows replaced** |
| window top-N lists | 8 of 42 changed, **6 changed membership** |
| label tables | 86 of 314 rows level on group, open and total |
| `oldest`/`quietest`/`ignored` | 9 open issues share the boundary age, 6 fit |
| `mostDiscussed` | tiebroke on `number`, unique per repo and not across them |
| per-repo issue rows | 7 repo pairs tie on both counts |
| leaderboard, `topRepos`/`topAuthors`/`topReviewers` | fixed earlier, same cause |

The orderings now live in `src/shared/issue-rules.js` as comparator/SQL pairs.
**If you add a list, give it a total order in the shared file**, and note that
`firstIssueOrderSql` is deliberately *not* `(repo, number)` — it mirrors a
JavaScript compare of `"repo#number"` strings, and the two disagree whenever two
numbers in one repo differ in digit count.

The direction varies; the cause does not. **None was visible from the thing's own
output. Keep the Node panels after porting; do not delete them.** They are the
only oracle this project has.

## Things that will bite again

**A `CASE WHEN` whose condition is NULL falls through to `ELSE`.**
`closedByHand` read 21,495 against a true 19,011 because
`NOT (closed_at >= ? AND closed_at < ?)` is NULL for an open issue, so all 2,484
of them landed in `ELSE 1`. The all-time version of the same count was right the
whole time because it leads with `closed_at IS NULL THEN 0`. Lead with the NULL
arm.

**A column left out of a projection is a rule quietly changed.** `people` read
`filedUnanswered` one high because `response_unknown` was missing from the
SELECT, so `isUnanswered` saw `undefined` and reclassified every issue whose
comment sample merely ran out. Nothing errored.

**A parity test cannot see the webhook write path.** Every suite here compares
two readings of one seed, and the seed comes from the GraphQL walk. The handler
writes REST's spelling — `not_planned` against the seed's `NOT_PLANNED` — and no
parity test can reach it. Reconciling against production is the only check that
reads what the handler actually wrote, and it is what caught this.

**Do not write a test's expectation out of its input.** `check("state_reason
written", …, "completed")` fed a payload in and asserted the payload came back.
It passed for three weeks over a column the panel could not read. Assert the
rule the store exists to answer, not the value you just bound.

**Rebuild the oracle before believing a parity failure.** When a rule changes,
the shipped `dashboard.json` is a stale baseline and the test reports a fix as a
regression. That has cost two investigations now. `npm run rebuild:issues`
patches one panel in under a second and needs no token — and it pins `now` to the
file's own `generatedAt`, because a panel counting from today inside a file whose
others count from the build differs everywhere for no reason.

**Check what a payload or a parameter actually carries.** Three times: the push
payload's non-existent PR field, the release payload's non-existent tag SHA, and
`exclude_pull_requests`, which returns a byte-identical set of runs and only
empties each one's `pull_requests` array.

**Do not extrapolate a rate from a sample chosen for its outliers.** The discard
rate went into three files as "about one in seven", from fourteen repos picked as
the worst offenders. Measured org-wide it is 1.7%.

**A skip propagates down the whole job graph, not one edge.** Both `site` and
`deploy` carry `if: always() && needs.<dep>.result == 'success'`. The result
check is not decoration — `always()` alone would deploy over a failed `site`.

**`updated_at` on a workflow run is not an end time.** GitHub bumps it on log
expiry and job re-runs, months later.

**`strftime` parses a date per row per call** — 43ms against 7ms for the
equivalent string comparison. Timestamps are fixed-width whole seconds, so
lexical order is chronological order. Compare strings, ceil the bound with
`isoBound`, normalise anything from a payload with `utcSeconds`.

**±Infinity cannot cross the D1 wire.** Parameters serialise as JSON and
`Infinity` becomes `null`. Bind finite sentinels — `NEVER`/`FOREVER` in
`worker/src/periods.js`.

**A window frame defaults to RANGE, and RANGE cannot count.** Percentiles rank
with `ROWS UNBOUNDED PRECEDING`.

**D1 rejects a compound SELECT with more than a few arms.** A six-arm `UNION`
passed every local test and failed on the first real recompute. A local replica
proves logic, never dialect — **but it does predict cost: D1 runs about 2.2× the
local replica.** The widest query in production is 39 columns; nothing has tested
further, so do not assume a 150-column one works.

**Write the parity test before the port, then try to break it.** Green on the
first run means nothing. The `issues` port ran 32 deliberate mutations across
four slices; four found real gaps in the *test*, including one where deleting a
rule from `fixerSql` passed everything because the store happens never to
exercise it. Where a survivor is a branch no row takes, it is named where it sits
and given a synthetic row.

**A tiebreak that is missing is invisible from the output.** Deleting the repo
name from the `repos` sort changed nothing, because SQLite happened to group in
name order. The parity test now re-sorts a *shuffled* copy, which only passes if
the comparator alone decides the order.

**Do not name a CTE after a real table.** `worker/src/scope.js` rewrites
`FROM issues` and friends into filtered subqueries. For the same reason a
**write** must use the raw handle.

**`CREATE TABLE IF NOT EXISTS` will not add a column.** New columns need a file
in `worker/migrations/`, applied before `schema.sql`. New *tables* need nothing.

**A theory that fits the symptom is not evidence.** Twenty-four repos vanished
and the cause looked certain. The counter added to prove it came back 0.

## Two rules that were re-measured rather than inherited

Both were right when written and wrong to apply here, and the difference was a
measurement each.

**"Aggregate in SQL, never in the isolate"** exists because rebuilding the store
in a Worker cost 96 MB against a 128 MB ceiling — a finding about *pull
requests*. Issues are smaller: the whole store is 32 MB. So `people` feeds the
Node panel's own `foldPerson` accumulators rather than reimplementing 32 fields
per person per window in SQL, and the agreement is structural instead of tested.
It is scoped to the 553 people who can make a cut, because accumulators for all
6,450 are 45,150 objects and 66.5 MB.

**`json_each` was never needed.** It gated five keys and could not be probed
through wrangler. Measured against expanding the JSON columns in the isolate:
9.3ms versus ~56ms locally, on 0.76 MB. The isolate route needs nothing D1 has
never been asked to do, so the untested feature never had to be tested. The
drilldown port should reach for the same trick before assuming it needs SQL.

## Known divergences from the build

**`needsRelease`** — three repos, one cause: a release webhook carries no tag SHA,
so the panel compares commit *dates* against `published_at` where the Node
version compares *ancestry*.

| Repo | Build | Live |
|---|---|---|
| BugTorch | 79 ahead | 35 |
| TinkersGregworks | 50 ahead | absent |
| Variable-Horizons | 2 ahead | absent |

Two fail by dropping a repo silently. The fix is to have the daily build resolve
each tag to its commit and store it; deliberately not done at three repos.

**`depUpdates` reconciles at 279**, not 276. Live is a strict superset of the
build; the three extra are issue-only repos holding no code. It errs unflattering.

**`ciHealth` reconciles exactly** on 252 repos and 3,156 sampled runs, with a
pass rate matching to sixteen decimal places.

**`issues` reconciles exactly against the seed** on all fifteen keys. It has not
yet been compared against production.

## Commands

```
npm run test:freshness    21   the card tint
npm run test:exclusion    17   the ingest exclusion
npm run test:handlers     60   webhook handlers
npm run test:recompute    26   the cron and the instant path
npm run test:parity      190   across eight panels
                        ----
                         314

npm run rebuild:ci             one panel, ~2.5 min
npm run rebuild:issues         one panel, <1s, no token
cd worker && npx wrangler deploy
npx wrangler tail
curl -X POST "https://nh-dashboard.gtnh.workers.dev/api/recompute?force=1"
gh workflow run build.yml      republish data/*.json to Pages
```

Every suite builds its own SQLite replica from `schema.sql` + `seed.sql` and
skips politely when those are absent, which they are in CI.

**Run wrangler from `worker/`.** Chaining `cd worker &&` onto the first line of a
block means pasting it while already there silently skips that step.

## Parked, deliberately

**The ingest exclusion, and the org move is the same event.** `NH_INGEST_EXCLUDE`
keeps `Dupes-Exploits-GTNH` out of the published artefact, and with the display
filter dropped it is the *only* thing doing so. It is applied in code and covered
by `npm run test:exclusion`, but **CI has no repo secret**, so a CI build still
republishes the repo. Add it under Settings → Secrets and variables → Actions
*before* the next `data` run.

That becomes urgent at the org move: moving in means the repo goes public,
`data/` is in the git *history*, and that history includes `dashboard.json`
versions carrying the excluded repo's issue titles.

**`src/panels/issues.js` commits as a binary diff.** It carries a NUL as the
label key separator, so git will not diff it. A `.gitattributes` line fixes it.
The NUL is belt-and-braces either way — GitHub repo names cannot contain spaces,
so a plain separator could not collide.

**`worker/runs.sql` is tracked and its four siblings are not.** Same kind of
generated file. Looks like an oversight rather than a decision.

**The org-wide `meanRunMinutes` divides by `sampledRuns` while each repo's own
mean divides by `timedRuns`.** Existing behaviour; changing it would move a
number for an unrelated reason.

**The Leaderboard sorts by all-time under a subtitle claiming the selected
period.** Predates all of this. One line either way; which line is a product
question.

**The `firsts` CTE is rebuilt four times in the issue panel** — once per series
grain and once for `byWindow`, ~220ms local and ~490ms on D1. The largest single
piece of waste there, left alone because `analytics` spent three deploys on
theories about its own hot spots and was wrong twice. The numbers are in the
panel header so the trade can be made on evidence.

---

## Open the next conversation with

> Read `handoff.md` and `going-live-status.md`. `issues` is ported and
> registered in `recompute.js` but not in `LIVE_PANELS` — deploy, force a
> recompute, and diff `/api/panel/issues` against `data/dashboard.json` before
> adding it, expecting live to run slightly ahead on day counts. Load
> `worker/traffic.sql` into D1 while you are there; `traffic_daily` still holds
> zero rows. Then port `drilldown`, which is the last panel from the build and
> the only one that cannot be a cached blob: 23 MB against a 2 MB row cap, so it
> uses the `drilldown_contributors` and `drilldown_repos` tables already in
> `schema.sql` plus a per-row endpoint, and it is the first port that needs a
> frontend change. Write the parity test first and try to break it — every
> defect this port has produced was invisible in the panel's own output, and the
> most common one by far is a list sorted on a metric with no tiebreak.
