# Handoff — going live

Paste the opening line at the bottom into a fresh conversation. This file is the
map; `going-live-status.md` is the territory and wins where they disagree. Both
are temporary and get deleted when the migration lands.

Rewritten 2026-09-03, after the frontend landed. **The port is code-complete.**
Nothing is left to build; what is left is one push, one verification pass
against production, and two phases that are decisions rather than work.

Earlier rewrites: 2026-08-30 after the `issues` port, 2026-08-31 after
reconciling against production and porting the drilldown index, and earlier the
same day as this one, when the frontend was still the only thing outstanding.

---

## Where the port stands

**All ten panels are served from D1 and all ten are consumed by the page.**
Nothing on the dashboard is build-only any more, and `amber` — "static by
design" — now has no occupants. It is kept in the tint table on purpose: it is
the statement a newly-added panel has to be able to make before it reconciles.

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
| `drilldown` | cron | index on the cron, one subject per request |

Suites: **443**, up from 359. The new ones are 72 in
`test/drilldown-live.test.js` and 6 apiece in the drilldown parity suite and the
freshness suite.

## What landed, in three commits

**`/api/panel/drilldown` now carries the coverage counts.** The frontend reads
four head keys the index did not have. `closerCoverage` and `issueData`
reconcile against the build exactly — `{closed: 23675, unknown: 0}` — and
`prFieldCoverage` cannot, because the distinction it reports does not exist in
D1: the three array columns are `NOT NULL DEFAULT '[]'` and the handler writes
each of them from every payload, so every row has been asked by construction.
It reports complete coverage, which is true of that store. `Calculations.md`
records what that costs — a row the handler somehow wrote without labels reads
as a PR with none rather than as one nobody has walked, and no count can tell.

`labelNames` is the fourth and stays off the index deliberately. It travels on
each subject payload.

**The page fetches an index plus one subject per navigation.**
`ensureDrilldown()` is two fetches on two clocks. The index goes through a new
`lazyPanel` path in `live.js` — registered rather than listed in `LIVE_PANELS`,
so nothing fetches it until a drilldown is opened and the poll refreshes it
afterwards like any other panel. A subject is fetched as you navigate and cached
against the Worker's own `x-version`, so the browser's copy expires exactly when
the server's row does. A stale copy keeps rendering while its replacement is on
the way.

**The fallback is lazy, and reads red.** `data/drilldown.json` is still the
floor but is fetched only once the API has failed — eagerly fetching 23 MB to
have a fallback ready would have kept the entire cost the change removes. A
drilldown running on it reads red rather than amber, because the panel is live
now and build-old data there is a fault rather than a design.
`drillOnBuild()` in `data.js` reads both halves, so the case where the index
answers and the subject behind it falls through — 22 cards blue over the build
file — reads correctly too.

## Three things this session found that the previous handoff did not have

**Head to head was reading four *other* subjects out of the whole file.**
`versus-data.js` indexed `state.drill[bucket][id]` for up to four opponents,
which was free when all 7,047 subjects were in hand and is a fetch each now. It
asks for them like any other subject. Nothing in the previous handoff mentioned
this file, and it would have failed as an empty lineup with no error.

**The picker's "nothing named that" was a statement about a fetch that had not
happened.** `state.subject && !subject()` was exactly right when there was
nothing between asking and having. It now also matches a subject in flight, so
the page briefly told you your colleague did not exist. Gated on an explicit
`missing` state, which is a 404 and nothing else.

**A version bump has to invalidate the browser's copy too.** The Worker caches a
subject against the version it was folded at; the page holds the same number and
compares. Missing that, a drilldown left open would have shown one version's
numbers indefinitely while every other card moved around it.

## What is left, and none of it is code

**1. Push.** `worker.yml` deploys the Worker on any push touching `worker/**` or
`src/shared/**`; `build.yml` deploys the page. Both fire from the one push.

**2. Force a recompute, immediately after.** This is the only ordering trap
left. The index is a `panel_cache` blob rebuilt on the cron, so deploying the
Worker does not refresh it — for up to ten minutes the new frontend reads an old
index with no coverage counts in it. Nothing breaks; the review-queue hints
report a backfill that has run and the closer counts read zero. One call closes
the window:

```
curl -X POST "https://nh-dashboard.gtnh.workers.dev/api/recompute?force=1"
```

**3. Verify against production, and check these four things specifically.**
Everything below reconciled against the seed and the replica; none of it has
been read from the deployed Worker, because `wrangler` cannot answer a SELECT
against production and the browser is where the frontend half actually runs.

- **Open a drilldown and watch the network panel.** Two requests:
  `/api/panel/drilldown` and one `/api/contributor/…`. **No `drilldown.json`.**
  That absence is the whole change; everything else is detail.
- **Check a subject's label chips have names on them.** Blank chips are the
  per-subject label table resolved against the wrong one, and it raises nothing
  — `labelsOf` filters blanks, so the label filter simply matches nothing.
- **Check the cards are blue, not red.** Red on a drilldown means a subject came
  out of the build file, which after a successful deploy means the subject route
  is failing where the index route is not.
- **Load Analytics and confirm nothing drilldown-shaped is fetched.** The index
  is 470 KB and four of the six pages must not pay for it. This is the one
  property that passes every other assertion in the new suite when broken, which
  is how the suite came to have a check for it.

**4. Then `gh workflow run build.yml`.** Still outstanding from before, still no
code: republishes `data/*.json` so the drilldown tiebreaks reach Pages. It
matters less than it did — the file is the fallback now rather than the normal
path — but the fallback should not be the one carrying the old orderings. 15–90
minutes.

## Then, and these are decisions rather than work

- **Phase E — App auth and the private backfill.** `getToken()` swaps to the App
  flow, then the ingest walks the 12 private repos for the first time.
- **Phase F — cleanup.** Retire `GH_DASHBOARD_TOKEN`, move the repo into the org,
  decide what to do about 96 MB of git history.

Once Phase F is done, this file and `going-live-status.md` get deleted and
whatever survives moves into `documentation.md`.

---

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

**Amber now has no occupants, and is kept anyway.** All ten panels are live, so
nothing is static by design. The colour stays because that sentence is one a
panel added later has to be able to say before it reconciles, and deleting it
would leave only red — which would make "not ported yet" and "the API is down"
the same statement again.

**The drilldown is the one panel whose tint is not decided by the panel alone.**
It arrives as an index plus one payload per subject, and either half can fall
through to the build file on its own — so `p.down` being clear does not mean the
numbers came from the Worker. `drillOnBuild()` reads `state.drillSource` for the
index and `from` on the subject's cache entry, and either one on the file makes
the card red. Without that, an index answering over a fallen-through subject
would put a confident blue on 22 of the 53 cards.

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
npm run test:freshness         30   the card tint
npm run test:drilldown-live    72   the two clocks, the lazy fallback, the
                                    per-subject label tables, head to head
npm run test:exclusion         17   the ingest exclusion
npm run test:handlers          60   webhook handlers
npm run test:recompute         26   the cron and the instant path
npm run test:parity           238   across nine panels, the drilldown
                                    orderings, the per-subject payloads,
                                    the coverage counts and the worker route
                             ----
                              443

npm run rebuild:ci             one panel, ~2.5 min
npm run rebuild:issues         one panel, <1s, no token
npm run rebuild:drilldown      the whole file, ~3s, no token
cd worker && npx wrangler deploy   # rarely needed: worker.yml deploys on push
npx wrangler tail
curl -X POST "https://nh-dashboard.gtnh.workers.dev/api/recompute?force=1"
gh workflow run build.yml      republish data/*.json to Pages
```

Every suite builds its own SQLite replica from `schema.sql` + `seed.sql` and
skips politely when those are absent, which they are in CI.
`test:freshness` and `test:drilldown-live` are the two that need neither — they
run the frontend modules under Node against a stubbed DOM and a stubbed `fetch`,
so they are the only suites that always run in CI.

**Run wrangler from `worker/`.** Chaining `cd worker &&` onto the first line of a
block means pasting it while already there silently skips that step.

## Parked, deliberately

**The git history, and the org move is the same event.** `NH_INGEST_EXCLUDE` is
a repo secret now and CI applies it, so the *forward* path is closed:
`Dupes-Exploits-GTNH` stays out of the published artefact, in code, in CI, and
under `npm run test:exclusion`. With the display filter dropped it remains the
only thing doing so, so treat it as load-bearing rather than provisional.

What is still open is behind it. Moving into the org means making the repo
public, `data/` is in the git *history*, and that history includes
`dashboard.json` versions carrying the excluded repo's issue titles. Untracking
`data/` going forward does not remove what is already there. Settle it *before*
the move completes.

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

> Read `handoff.md` and `going-live-status.md`. **The port is code-complete.**
> All ten panels are served from D1 and all ten are consumed by the page, so
> nothing on the dashboard is build-only and `amber` has no occupants left.
> Suites 443.
>
> The drilldown was the last one and it landed in three commits: the coverage
> counts added to `/api/panel/drilldown`, the frontend split into an index
> fetch plus one subject per navigation, and the docs. Nothing is committed
> that has not reconciled — `closerCoverage` matches the build exactly, the
> per-subject payloads agree leaf for leaf both from the store and out of D1,
> and the new `test/drilldown-live.test.js` runs the frontend modules under
> Node against a stubbed DOM.
>
> **Nothing is pushed.** What is left is not code:
>
> 1. Push. `worker.yml` and `build.yml` both fire from it.
> 2. `curl -X POST ".../api/recompute?force=1"` straight after — the index is a
>    `panel_cache` blob on the cron, so for up to ten minutes the new frontend
>    would read an old index with no coverage counts in it. Nothing breaks; the
>    review-queue hints and closer counts just read wrong.
> 3. Verify in a browser, and four things specifically: opening a drilldown
>    makes two requests and **no `drilldown.json`**; label chips have names on
>    them; the cards are blue rather than red; and loading Analytics fetches
>    nothing drilldown-shaped, because the index is 470 KB and four of the six
>    pages must not pay for it.
> 4. `gh workflow run build.yml`, still outstanding from before, so the
>    fallback file is not the one carrying the old tiebreaks. 15–90 minutes.
>
> **One divergence is worth knowing before you trust a hint.**
> `prFieldCoverage` reports complete coverage from the live index, because D1
> declares `labels`, `assignees` and `review_requests` as
> `NOT NULL DEFAULT '[]'` and the handler writes all three from every payload —
> so the "we have never asked what this PR's labels are" state is not
> representable there at all. True of that store, and the cost is written down
> in `Calculations.md`: a row written without labels reads as a PR with none
> rather than as one nobody has walked.
>
> Then Phase E (App auth and the private backfill) and Phase F (retire
> `GH_DASHBOARD_TOKEN`, move into the org, decide about 96 MB of git history),
> and both are decisions rather than work. After F this file gets deleted and
> whatever survives moves into `documentation.md`.
