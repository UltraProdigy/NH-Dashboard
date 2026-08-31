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
| `issues` | cron | ≤10 min |
| `drilldown` | cron | **index ported and reconciled; payloads still to do** |

`issues` is live. Its gate earned its keep: reconciling against production found
the `state_reason` casing bug below, which no parity test here could have seen,
and migration 004 has repaired it — production reads `unknownReason: 0` and
`notPlanned` back at the build's 5,105, with `completed` down the one issue that
had been flattered.

**`drilldown` is the whole of what remains** — 22 of the 53 cards, both drilldown
pages. Its index is ported and live on the cron; the per-subject payloads are
not, and the panel must stay out of `LIVE_PANELS` until they are.

## Do these in order

1. **Load traffic.** The last thing on the list that is nobody else's copy.
   `traffic_daily` still reads 0 in D1 and the store on one laptop is all there
   is. Re-run the ingest first so the store carries yesterday, then regenerate
   and apply:

```
npm run ingest:traffic
node worker/seed.js --only=traffic --out worker/traffic.sql
cd worker
npx wrangler d1 execute nh-dashboard --remote --file traffic.sql
```

   Then confirm `/api/health` shows `traffic_daily` above zero. That reading 0
   is how you know this has not run.

2. **Add `NH_INGEST_EXCLUDE` as a repo secret**, under Settings → Secrets and
   variables → Actions, value as in `.env`. A push does not run the `data` job
   — it is skipped by design — but **the 05:00 cron does**, and a `data` run
   without the secret re-walks the excluded repo and republishes its issue
   titles to a public page. This is the one item here with a clock on it.

3. **Republish `data/*.json`** with `gh workflow run build.yml`. The drilldown
   tiebreaks are in the pushed source but `data/` is gitignored, so the file on
   Pages still carries the untied orderings until a `data` run rebuilds it.
   15–90 minutes.

4. **Then `drilldown`.** See below.

## Next: `drilldown`, and it is not shaped like the others

Every panel so far was "compute a blob, cache it, overlay it". This one cannot
be, and it is the only remaining piece of the migration.

`data/drilldown.json` is 23 MB, against a **2 MB D1 row cap**, so `panel_cache`
is out. The shape is what makes it tractable:

| Part | Size | Notes |
|---|---|---|
| `contributors` | 18.3 MB | 6,749 entries keyed by login, mean 2.8 KB |
| `repos` | 3.2 MB | 298 entries keyed by repo, mean 11.1 KB |
| `index` | 0.46 MB | what the pickers need up front |
| 18 schema keys | 8.3 KB | field-name lists, windows, buckets |

So it is not a blob that resists a Worker, it is 6,749 rows waiting for
`WHERE login = ?`. `drilldown_contributors` and `drilldown_repos` are **already
in `schema.sql`** for exactly this, and they are a read-through cache rather
than something the recompute fills — see the section below, which measures why
filling them in one pass cannot work. The `index` and the schema keys together
are 470 KB and *are* an ordinary cached blob, on the cron like every other
panel.

**No single payload comes near the row cap, but watch the top of the list.**
Largest contributor is Dream-Master at 759 KB and largest repo is
GT-New-Horizons-Modpack at 523 KB, against 2 MB. Nothing else is above 362 KB.
Dream-Master is already 37% of the cap and grows with the org, so it is the row
that decides whether this design lasts — worth a test asserting it rather than
finding out from a failed recompute.

## The recompute cannot materialise every subject at all

Measured before the port rather than after, and the answer is stronger than the
write-cost note below it: a full materialisation is not expensive, it is
**impossible**, and it fails on three limits independently. Any one of them
would settle it.

| | Full pass | One subject on demand |
|---|---|---|
| rows touched | 96,491 | 14,088 worst case (Dream-Master) |
| JSON before a single accumulator | **35.3 MB** | 5.9 MB |
| local time | 236 ms | 44 ms → ~97 ms projected on D1 |
| D1 queries | ~35,000 | **5** |
| rows written | 7,047 | 1, and only when someone looks |

1. **Memory.** 35.3 MB of raw rows is only the input. Bucketing them needs an
   accumulator per subject per window, and 6,749 × 7 was already measured at
   34.2 MB *for the issue side alone* — the version this file rejected. With the
   PR side on top it is past the isolate's 128 MB ceiling before the payloads
   are serialised.
2. **Queries.** D1 allows **1,000 per Worker invocation** on Paid. Five queries
   per subject across 7,047 subjects is ~35,000, so the per-subject shape cannot
   be looped inside one recompute either. Neither shape fits.
3. **Writes**, which is the section below, and the least of the three.

**So the drilldown is computed per subject, on the request, and cached.**
`/api/contributor/{login}` reads `drilldown_contributors`, serves the payload if
its `version` matches the current one, and otherwise computes that one subject
from five indexed queries and writes the row back. `version` is already a column
on both tables; nothing needs a migration.

The worst subject in the org costs ~97 ms projected, and the median is nearer
10 ms. A cache that lives one cron tick means repeat views inside ten minutes
are a single indexed read.

**And it is the argument for reusing the Node panel rather than translating it.**
"Rebuild the store in the isolate and call the proven function" was rejected at
96 MB for pull requests — a finding about *the whole store*. One subject is
5.9 MB. So the same trade the issue panel made for `people` applies here and
more strongly: extract a per-subject entry point from `src/panels/drilldown.js`,
hand it one subject's rows, and the agreement with the build is structural
rather than tested. That is the difference between porting 1,500 lines and
calling them.

## Do not put `drilldown` in `LIVE_PANELS` yet

Registering the index on the cron created a trap that did not exist before.
`PAGE_PANEL` in `web/js/data.js` maps both drilldown pages to the `drilldown`
panel, so listing that name would tint **all 22 drilldown cards blue** — while
every per-subject payload behind them still comes from the 23 MB build file.
One entry, twenty-two confidently wrong blues, which is the largest instance of
the failure the tint exists to prevent that this project has been one line away
from.

It goes in `LIVE_PANELS` when the payloads are served, not when the index is.

## The card tint had the same bug, in a smaller way

Found by reading rather than by looking, and worth recording because looking
would not have found it. Two cards on the Analytics page read a panel that is
not their page's: Label mix reads `byLabel`, Actions load reads `ciHealth`. Both
took their tint from `analytics`.

**It is right today, and right by coincidence.** All three panels are live on
the cron, so all three cards are blue and the blue is true. The failure is
latent: if `ciHealth` stops answering while `analytics` keeps answering, the
card holds a confident blue where it owes a red — an outage painting only part
of a page is precisely the case the four-colour scheme was built for. Promoting
either panel to `instant` would go equally unnoticed.

Cards now declare `reads`, which says where the data comes from and claims
nothing else. That is deliberately *not* `panelId`, which additionally means
"this card's rows are that panel's array" and drives the tab badge in
`render.js` — borrowing it for the tint would have given two cards a row count
they do not have.

The freshness suite now walks all 53 cards and fails any whose render names a
panel it is not tinted by, rather than testing the handful someone thought to
name. The old assertion here was not merely loose — "eleven of eleven cards on
one tier" asserted the wrong behaviour and passed, which is what kept this
invisible.

## The index is ported, and it reconciles exactly

`worker/src/panels/drilldown.js`, registered on the cron. **16 queries, 156ms
local, ~344ms projected on D1, 475 KB cached** — a quarter of the row cap and
about a tenth of what `issues` costs. Both indexes agree with the build on
membership, on every field, and in order.

This is the only part of the panel rebuilt in SQL; the per-subject payloads
reuse the Node functions. The risk it carries is not arithmetic — every number
is a COUNT or a MAX — it is **which subjects exist at all**, and a
reimplementation can agree on all six numbers while quietly shipping a picker
that is missing people.

**A contributor exists** if `person(login)` was ever called for it, and there
are six call sites, not the four a first reading suggests:

1. non-bot author of a pull request
2. an *approver* of any pull request
3. a review requestee, **only on an open unmerged one**
4. a current reviewer, same restriction, and this one excludes self-review
5. an assignee — pull requests in any state, and issues
6. anyone involved in an issue: author, first responder, closer, fixer, assignee

Three of those contribute no number at all and exist only to put a row in the
list. There are **exactly three such people**, and two are Copilot accounts
`BOT_PATTERN` does not match — which is worth knowing on its own, and is a tail
worth reproducing rather than rounding off, since dropping either source fails
the parity test by name.

`activeDayIndex` deliberately does **not** create subjects — the comment there
is explicit that routing active days through `person()` would promote several
thousand people whose whole trace is one drive-by review into full subjects.
That is a trap worth not re-springing.

| Field | Contributor | Repo |
|---|---|---|
| `n` | PRs authored, bots excluded | PRs in the repo, bots included |
| `a` | all-time approvals given | — |
| `open` | — | PRs open and unmerged |
| `i` | `filed + responses + closed + fixed` | issues filed |
| `iOpen` | — | open issues |
| `last` | see below | MAX of PR `created_at`, issue `created_at`, issue `closed_at` |

**`last` for a contributor is a MAX over four things and not one more**, from the
five `touch()` calls that reach a person:

- `created_at` of PRs they authored
- `submitted_at` of their approvals — and it is the *approval* date, not any
  review date. A COMMENTED review does not move it
- `created_at` of issues they filed
- `first_response_at` where they are the first responder
- `closed_at` where they closed **or** fixed

**Two rules that differ from their neighbours and will be read past.**
`approversOf` excludes bots but **not self-approvals**, while `firstReviewAt`
and `latestReviewsOf` exclude both. So `a` counts a self-approval and the review
latency does not. And an approval is one per reviewer per PR dated to their
*earliest*, because re-approving after a round of changes is one act — the
partner lists next to it use the same pair but skip self.

Then `substantial()` decides full record against slim, which is a separate
question from existence and does not touch the index.

## The write cost, which the design above retires

Kept because the arithmetic is worth having if anyone reaches for a full pass.

`drilldown_contributors` and `drilldown_repos` are 7,047 rows between them, each
with a TEXT primary key, so a full pass is **7,047 rows plus 7,047 index entries
— about 14,100 billed writes.** Cloudflare bills an index entry as its own
written row; that is the same arithmetic that made the seed cost 441,640 rather
than 97,000.

At the current `*/10 * * * *` cron that is 144 passes a day:

| | |
|---|---|
| per pass | ~14,100 writes |
| per day | ~2.03 million |
| per month | **~61.7 million** |
| Workers Paid includes | 50 million / month, then $1.00 per million |

So a full rewrite every tick spends the entire monthly write allowance, and then
some, re-storing bytes that did not change. Every other panel avoids this by
being one `panel_cache` blob — the write cost scales with the panel count, not
with the data. This is the one panel where it scales with the data, which is
exactly what the pattern note in `going-live-status.md` warned about.

On-demand computation reduces this to one row written per subject actually
viewed, which is a few hundred a day at most and needs no hash column and no
migration. The `hash`-and-diff scheme that was going to be needed for a full
pass is not, because there is no full pass.

**This is the first one that needs a frontend change.** Every other panel was one
entry in `LIVE_PANELS`. The drilldown pages load one 23 MB file today and would
have to fetch a row on demand instead. Budget for that rather than discovering it.

Two things already known about the content: `src/panels/drilldown.js` computes
`people` differently by subject type, and the resolved-PR rows are positional
arrays like the issue panel's people rows — `resolvedFields` and friends are the
column orders, and they still want moving into `drilldown-rules.js` beside the
comparators before a second implementation packs them.

## The orderings are done, and they were the biggest instance yet

The recurring bug — a list sorted on its metric alone, ties left in store
order — was in **every ordered list this panel produces.** Measured on the file
as it shipped, before anything was changed:

| Where | Ties |
|---|---|
| `index.contributors` | **6,538 of 6,748 adjacent pairs** — 97% of the picker |
| `index.repos` | 187 of 297 |
| ranked lists | 95,671 ties across 13,490 lists; 10,659 contain one |
| backlog `oldest` | 1,490 ties on `ageDays`, which is a whole number of days |
| resolved PR rows | 9,664 of 25,719 tie on the timestamp |

Fixing them moved **67,811 positions across 5,474 lists**, and 1,207 of those
were *membership* changes — a tie at a capped list's cut line meant an entry was
in or out by nothing at all. Every one of those would have shown up as a parity
failure during the port with no bug behind it, because store order is not
something SQL reproduces.

The comparators live in `src/shared/drilldown-rules.js` as comparator/SQL pairs,
the same arrangement `issue-rules.js` uses. `byRecord` is deliberately `(repo,
number)` compared as parts and **not** the `"repo#number"` string the frontend
renders — switching it to the string form fails the test in 91 real lists, so
the digit-count trap the issue panel documents is live in this data too.

`npm run test:parity:drilldown` is the test, written before the port and broken
ten ways to check it bites. It has one named survivor: swapping two field names
that neither the sort nor the arity touches passes, because that half of the
file checks one implementation's shape rather than two implementations' values.
Closing it is the panel comparison's job, which is why that half decodes rows by
field name on both sides rather than by position.

`npm run rebuild:drilldown` is the oracle. It pins `now` to `dashboard.json`'s
`generatedAt` for the same reason `rebuild:issues` does — half this file is ages
and staleness measured from an instant, so rebuilding at wall clock puts a panel
counting from today next to one counting from the build.

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
npm run test:freshness    24   the card tint
npm run test:exclusion    17   the ingest exclusion
npm run test:handlers     60   webhook handlers
npm run test:recompute    26   the cron and the instant path
npm run test:parity      215   across nine panels, plus the drilldown orderings
                        ----
                         342

npm run rebuild:ci             one panel, ~2.5 min
npm run rebuild:issues         one panel, <1s, no token
npm run rebuild:drilldown      the whole file, ~3s, no token
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

> Read `handoff.md` and `going-live-status.md`. Two things are waiting on a
> machine logged in to Cloudflare: load `worker/traffic.sql` into D1, and apply
> `worker/migrations/004-normalise-state-reason.sql` then deploy, which is what
> unblocks adding `"issues"` to `LIVE_PANELS` — the reconciliation against
> production is done and found one defect, the webhook storing REST's lowercase
> `not_planned` against the seed's `NOT_PLANNED`. Then the `drilldown`, which is
> all that remains. Its orderings and column orders are already in
> `src/shared/drilldown-rules.js` and `npm run test:parity:drilldown` guards
> them; what is left is the panel itself. Do not try to materialise every
> subject in the recompute — that is measured as impossible on three separate
> limits and the file says so. It is a read-through cache: one subject computed
> on the request from five indexed queries, reusing the Node panel's own
> functions rather than translating them, since one subject is 5.9 MB against
> the 96 MB that made reuse impossible for the whole store. The index is the
> only part that has to be rebuilt in SQL, and its exact definitions are written
> down. Write the panel comparison half of the parity test before trusting any
> of it.
