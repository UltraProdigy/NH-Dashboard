# Going live — status

Companion to the going-live plan. The plan is intent; this is what is actually
true, and where the two disagree, this file wins.

Temporary, like the plan. Both get deleted when the migration lands and whatever
survives moves into `documentation.md`.

Last updated 2026-08-29.

---

## Done

**Phase A — the App is verified.** `NH-Dashbot`, App ID `4745300`, installed on
GTNewHorizons with `repository_selection: all`. Re-check any time with
`npm run verify:app`, which prints no secrets.

- Repo **Administration: Read** granted, so traffic works — confirmed against a
  live probe, not just a permission listing
- `discussions` and `repository_projects` were requested but **not granted**, and
  nothing in `src/` or `web/` reads either. Drop them from the request. This
  answers open question 4 in the plan
- `deployments: read` was granted and is unused
- **Private backlog: 12 repos** of 339 visible

**Phase B — traffic is capturing.** `npm run ingest:traffic`, 4,731 rows over
Aug 14–27, 338 repos in scope.

**Phase C — the repo is safe for private data, code-wise.** Keys ignored, `data/`
ignored, commit step gone, `contents: read`, rolling Actions cache, deploy
narrowed to `data/*.json`.

**Phase D steps 1–6 — schema, seed, skeleton, handlers.**

- `npm run test:handlers` is 31 assertions; `npm run webhook:test` exercises the
  signature path including rejection
- D1 database `nh-dashboard`, id `ed20adc3-f434-4f0a-8832-80862af30201`
- **Schema and seed are loaded remotely and verified**: 29,091 pull requests,
  41,239 reviews, 26,513 issues. Traffic is not loaded — it was the deferred
  half of the split, and see the write ceiling note below

**The Worker is deployed and the webhook is configured.**

- `https://nh-dashboard.gtnh.workers.dev`, on the account's `gtnh.workers.dev`
  subdomain. The subdomain is account-wide, not per-Worker, and renaming it
  would break every URL under it including the webhook
- `/api/health` answers from production with the seed counts, which is the
  D1 binding proving itself rather than just the deploy succeeding
- `GITHUB_WEBHOOK_SECRET` is set as a production secret, matching
  `worker/.dev.vars`
- The App subscribes the eight events and the ping is green

**Workers publishing is gated on a verified account email; D1 is not.** The seed
loaded happily hours before the first deploy failed with code 10034. Worth
knowing because the error arrives after a successful bundle upload and reads
like a code fault.

---

## Where the plan is now wrong

**D1 bills index writes, and that changes the seed maths entirely.**

The plan estimated ~150k records against a 100,000/day ceiling. Keeping labels
and assignees as JSON columns rather than link tables does cut the *logical*
rows to ~97,000 — but D1's billing metric is **rows written**, which counts every
secondary index entry as well as the row itself. The actual seed cost was
**441,640 writes**, about 4.5×:

| Table | Logical rows | Billed (approx.) |
|---|---|---|
| `pull_requests` | 29,091 | ~143,000 |
| `reviews` | 41,245 | ~165,000 |
| `issues` | 26,513 | ~111,000 |
| `ingest_state` | 341 | ~700 |

So the plan's instinct was right and the "it fits free" revision was wrong. The
seed blew roughly 4.4× through a day's free allowance.

**This is a one-time cost, not an ongoing one.** Steady state is a webhook
delivery writing one row plus its indexes — five or six billed writes — and a
busy day across the org is a few hundred deliveries. Ongoing operation sits
comfortably inside the free tier.

Two consequences worth carrying forward: any *reseed* costs the same 440k again,
and dropping an index is now a write-cost decision as well as a read-speed one.

**`drilldown.json` is not the hardest part of the port.** 18.5 MB of its 22 MB is
one map keyed by login — 6,818 contributors averaging 2.7 KB. That is not a blob
that resists a Worker, it is 6,818 rows waiting for `WHERE login = ?`. The
recompute materialises them into `drilldown_contributors`; `/api/contributor/
{login}` serves one. Same for `drilldown_repos` at 3.3 MB.

**The schedule can go back on — the reason it was parked was wrong.** Two
successive reasons were recorded here: first that committing `data/` made a cron
expensive, which was fixed; then that minutes were the constraint, "because the
repo is private, so Actions bills against 2,000/month".

**The repo is not private and never was billed.** It is public, so the minutes
come from the unlimited public pool and a 15–90 minute build costs nothing. The
constraint was imaginary, and it is what has kept the dashboard on manual builds.

Nothing now blocks a schedule. Webhooks already make this job reconciliation
rather than the freshness mechanism for the ported panels, so the sensible
cadence is daily rather than 48 times a day — the cron exists for the four
panels D1 can never answer, not for the ones it can.

Note `cancel-in-progress: false`, below: that was set for exactly this, and has
to stay false whatever cadence is chosen.

**`cancel-in-progress` was a latent deadlock.** With builds sometimes exceeding
an hour, a 30-minute cron would kill each run before its cache save and the
replacement would redo the same work forever. Now `false`.

**Traffic must not live in the Actions cache.** Losing a cache entry costs the
ingest nothing — watermarks reset and the next run re-walks from the API. It
costs traffic everything older than the current 14-day window, which is the loss
the job exists to prevent. It runs locally until D1 holds it.

---

## Decisions taken today

**Private repo data ships publicly. There will be no display filter.** The
earlier position was that Phase E needed an opt-in filter before private PRs and
issues could reach a `dashboard.json` served from public Pages. That is
withdrawn: the content across the 12 private repos is judged unharmful, and the
one repo that was not — `Dupes-Exploits-GTNH` — is already excluded at ingest.
Phase E is therefore unblocked and has no outstanding prerequisite.

What this commits to, so it is not rediscovered later: private PR and issue
titles, bodies, authors and timings become public and indexable the first time a
`dashboard.json` built from D1 is deployed. Un-publishing removes the file, not
the copies. If a private repo is ever added that does not meet the same bar, the
lever is `NH_INGEST_EXCLUDE`, and it has to be pulled *before* the build that
would carry it.

**`Dupes-Exploits-GTNH` is excluded at ingest**, via `NH_INGEST_EXCLUDE` in
`.env` and never in committed source. With the display filter dropped, this
exclusion is the *only* thing keeping that repo out of a public artefact, so it
is load-bearing rather than provisional. GitHub retains PR and issue history
either way, so only that repo's traffic is lost while it stays excluded.

**It was not actually applied, and the repo reached the public site.** Found
while mapping the `issues` port. `isIngestExcluded` was called from the traffic
ingest and from nowhere else, so 352 issues were walked, stored, seeded into
production D1, and published in `data/dashboard.json` — including exploit titles
in the three triage lists. The paragraph above asserted the protection, and
`config.js` asserted it in more detail, for as long as it did not exist.

Nothing failed, because a filter that is never called cannot fail. The only
symptom was data quietly present, in a file nobody re-reads.

Fixed in both ingests, at both the repo list and `readStore` — the second so an
already-polluted store goes clean on the next build rather than after an hour of
re-walking. `npm run test:exclusion` asserts the wiring *and* the behaviour, and
fails on both counts if either regresses.

**The data stays in D1, deliberately.** The decision taken was that the concern
is the repo appearing in the published dashboard, not the rows existing in a
database only the operator can query. So there is no D1 purge. What changed
instead:

- `readStore` filters, so the Node build never sees it and `dashboard.json`
  comes out clean
- the Worker is handed a **scoped database handle** that rewrites
  `FROM issues` into `FROM (SELECT * FROM issues WHERE not excluded)` before
  preparing anything. `/api/panel/:name` is public with permissive CORS, and a
  SQL panel reads D1 directly, so `readStore` protects nothing there

The wrapper rather than a predicate per query is the whole point: there are
thirty-odd queries across two panels with four more to come, and forgetting one
produces a repo on a public page rather than an error. There is no unscoped
handle for a panel to reach for.

Note for whoever adds a panel: **do not name a CTE after a real table.** The
rewrite fires on `FROM`/`JOIN` followed by `pull_requests`, `reviews`, `issues`
or `traffic_daily`, and a CTE with one of those names would be rewritten too.

Cleanup done: the issue store is 26,513 → 26,161, `state.json`,
`issues-state.json`, `issue-labels.json` and the miniflare replica are purged,
and `worker/seed.sql` was regenerated from the filtered store. **`dashboard.json`
and `drilldown.json` have been rebuilt and contain zero references to the repo.**
All four suites are green: 100 assertions.

The rebuild took 592s and 409 API requests, which is the cost of a clean
artefact and worth knowing before anyone treats a rebuild as free.

**The Worker secret is set and deployed.** `NH_INGEST_EXCLUDE` is a Worker
secret; the scoped handle is live.

**The local rebuild does not reach Pages, and that was nearly the whole fix
undone.** The workflow restores the ingest cache, runs its *own*
`src/ingest.js` and `src/build.js`, and publishes *that* to Pages — a clean
`dashboard.json` on the operator's disk proves nothing about the deployed one.
Neither step was passed `NH_INGEST_EXCLUDE`, so the next push would have
re-walked the excluded repo and republished it, and everything local would have
kept looking correct.

**Deliberately parked** — the decision is to deal with this when the repo moves
into the org, not before. Nothing below is urgent on its own; the state is the
one that has held for months.

**But it becomes urgent at the org move, and that is the same event.** Moving in
means making the repo public, which is the point of the move — Actions minutes.
`data/` is tracked, so the git *history* goes public too, including the
`dashboard.json` versions carrying the excluded repo's issue titles and now the
ndjson as well. So this has to be settled *before* the move completes, and it is
the same job as the `git rm -r --cached data/` already on the loose-ends list:
untracking `data/` going forward does not remove what is already in history.

Both CI steps now pass the variable, and the test asserts they do. What remains:

- **Add `NH_INGEST_EXCLUDE` as a repo secret** — Settings → Secrets and
  variables → Actions. Value is the same as in `.env`. **Do this before
  pushing**, because the workflow triggers on push to `main` and a run without
  the secret republishes the repo.
- **Then push, and let the workflow rebuild Pages.** That is the step that
  finally replaces the public copy.
- Optionally clear the `ingest-` Actions cache. Not required — `readStore`
  filters on the way out, so a cache written before the exclusion existed still
  produces a clean build — but it is the tidier end state.

For the record, the contributors parity test failed in between, and the failure
was the stale baseline rather than a regression: every difference was
`activeDays` or `activeDenom`, always lower in SQL, because the seed had lost
352 issues the old `dashboard.json` still counted. It went green on the rebuild,
which is the diagnosis confirming itself.

Worth carrying: a control whose failure mode is silence needs a test, not care.
This one had a comment instead.

**Labels and assignees stay JSON, not link tables.** Reversible in-database with
no API calls if a panel ever needs to filter by label at scale.

**Handlers write only the columns their payload carries.** Reactions have no
webhook event, `closedVia` comes from the timeline API, `first_response_at` is
derived by walking comments. A full-row upsert would blank these and nothing
would look wrong until a panel emptied out. The tests assert this specifically.

**A failing handler still answers 200.** GitHub disables a webhook that keeps
failing, and that failure is silent, so a handler bug must not cost the
subscription when the sweep will correct it anyway.

**Workers Paid is now active**, taken earlier than planned and for a different
reason than expected. The recompute measured 8.8ms warm and 12.6ms cold against
the free plan's 10ms CPU ceiling, with five panels still to port — and a cron
firing every ten minutes is cold nearly every time. The alternative was
rebuilding one panel per tick to keep each invocation small, which works but
buys staleness and bookkeeping to dodge a $5 problem.

What it lifts, beyond the CPU: D1 queries per invocation 50 → 1000, database
size 500 MB → 10 GB, and a write allowance that makes both the seed and the
private backfill unremarkable. The write ceiling section below is now history
rather than a live constraint.

Going back to free would mean the per-tick round-robin, and re-checking the
payload sizes — worth revisiting once the panel port settles and the real
numbers are known.

---

## Findings worth keeping

**Approvals exclude deleted accounts.** Reproducing the analytics total in SQL
only matched once reviews with a null author were dropped rather than grouped.
Two approvals and 31 reviews are in that state. Now documented in
`Calculations.md`.

**Six duplicate reviews exist in the store** — identical author, PR and
timestamp. They collapse on insert. Also: SQLite permits NULL in a rowid table's
primary key, so the obvious composite key would have let the 31 null-author and
3 pending reviews duplicate silently on every re-sync. Hence the unique index
over coalesced expressions.

**Something cloned the modpack 255,000 times over Aug 20–23** — 92,715 on Aug 22
alone from 51 unique cloners, about one clone every 47 seconds per machine.
Views stayed flat, so it was automated, not attention. It ramped Aug 17–19 and
stopped dead Aug 24. `GT5-Unofficial` and `NewHorizonsCoreMod` show the same
shape. This was five days from ageing out of the retention window unseen.

---

## Next

**The pipe is proven end to end.** `meta.dirty` reads `1` against the remote
database. It ships as `0` in the schema, only `markDirty` sets it, and that runs
only after a handler completes — so a real delivery was received, verified,
written, and committed. Nothing clears it yet because the recompute does not
exist.

**The write ceiling never bit, and the estimate should not have been treated as
a block.** The 441,640 figure is an estimate of *billed* writes, which is a
billing quantity, not an observed refusal. Writes kept working the same day.
Anything of this shape wants a probe before it becomes a reason to stop: a green
ping is not that probe, because the ping handler returns before touching D1.
`meta.dirty` is, and reads are free.

Useful checks, both cheap:

    npx wrangler d1 execute nh-dashboard --remote --command "SELECT key, value FROM meta"
    npx wrangler tail          # from worker/, one JSON line per delivery

Deploy must be run from a machine logged in to Cloudflare. The credentials are
local to the operator, and `node_modules` holds platform-specific `workerd`
binaries, so it does not run from an arbitrary environment.

**The panel port has started, and the pattern is set.** `contributors` is done:
the aggregation runs as three D1 queries, the Worker only stitches the results,
and `npm run test:parity` diffs the output field by field against the
`dashboard.json` the Node panel produced from the same seed. 1,214 contributors,
every count matching in all seven windows.

**`analytics` is done too, and it was the hard one.** 484 lines of accumulators
became 43 queries: 25 parity assertions pass against the seed, and the cached
blob is 281 KB. The four things that took the time are worth carrying:

- **`strftime` returns TEXT, and SQLite orders TEXT above every number.** An
  uncast `strftime('%s', col) >= ?` is not imprecise, it is *constant* — `>=` a
  bound always true, `<` always false. Every windowed count came back as either
  the whole table or zero, and every query looked correct. `epochSql` casts;
  nothing else may compare a timestamp to a bound.
- **±Infinity cannot cross the D1 wire.** Parameters are serialised as JSON and
  `Infinity` becomes `null`, which would turn every comparison NULL. All-time
  binds a finite sentinel instead.
- **The bot rule now exists in two languages.** SQLite has no regex, so
  `BOT_PATTERN` and `isBotSql` are both generated from one list of prefixes and
  the parity test runs both over all 6,525 logins in the seed.
- **ISO weeks are not `strftime('%Y-%W')`.** The parity test runs `weekKey`
  against its SQL twin on every day from 2005 to 2035 rather than sampling,
  because the only days they could differ on are the thirty year boundaries.

The panel is registered in `recompute.js` and in `LIVE_PANELS`, so the frontend
should read "2 panels live" once a recompute has run.

**The first production recompute took 6,306ms**, against 400ms for
`contributors` — 2.4× the local replica rather than better than it. Version 15,
nothing failed, 287,157 bytes cached.

That was the per-period percentile queries: each rebuilt its value set, and for
first-review hours that set is a join and a grouping over 41,000 reviews, done
thirteen times. The fix builds each set once and ranks within each period using
a running `SUM(…) OVER (ORDER BY value ROWS UNBOUNDED PRECEDING)` — thirteen
counters in one pass, with the percentile picked where a counter first reaches
the rank. Thirteen queries became three, and the panel went from 43 queries to
33. The local replica moved 2.6s → 2.4s, which says almost nothing: locally the
cold seed paging in is most of the wall time, and the repeated work this removed
is what D1 was actually charging for. **The number that matters is the next
production recompute.**

`ROWS UNBOUNDED PRECEDING` is load-bearing there and is not the default frame.
RANGE lumps in every row tied on the value, so a group of equal values jumps the
running count past a rank sitting inside it and the lookup silently returns
NULL. The parity test caught nothing here because it passed first time — which
is the argument for having written it before the port rather than after.

**That fix bought 19%, and the theory behind it was wrong.** 6,306ms → 5,102ms.
A second theory — that D1 charges per query and the panel's `Promise.all` was
not overlapping round trips — was measured with a temporary `/api/probe` and is
also wrong:

| 33 queries | sequential | `Promise.all` | `batch()` |
|---|---|---|---|
| `SELECT 1` | 291ms | 73ms | 26ms |
| `COUNT(*)` over `pull_requests` | 320ms | 84ms | 30ms |

A round trip is ~9ms, `Promise.all` does overlap them, and all 33 cost about
73ms together. A full-table `COUNT(*)` costs 1ms more than `SELECT 1`. So
neither round trips nor scanning was the expense, and `batch()` would have won
back about 50ms — the probe is deleted, and it was worth its one deploy for
ruling that out before another rewrite.

**It was `strftime`, which parses a date string per row per call.** Measured
locally over the 29,091 rows:

| | |
|---|---|
| `COUNT(*)` baseline | 0.0ms |
| 13 window comparisons via `strftime('%s')` | 43.0ms |
| the same 13 as plain ISO string compares | 7.2ms |
| week-key grouping | 37.4ms |
| week-key with the Thursday computed once | 33.6ms |
| day grouping via `substr` | 4.0ms |

Every stored timestamp is a fixed-width `YYYY-MM-DDTHH:MM:SSZ`, so lexical order
*is* chronological order and a window can be a string comparison — given the
bound is ceiled to a whole second, which both ends of the window do identically.
`isoBound` carries the equivalence and the parity test asserts it at the
boundary second and a millisecond either side, because comparing against a raw
millisecond bound gets that one second backwards: `Z` sorts after `.`.

**Local rebuild 2,451ms → 1,314ms; production 5,102ms → 3,080ms.** Half of the
original 6,306ms, and the panel is done being optimised — what is left is real
work rather than waste.

**D1 runs this workload at about 2.2× the local replica.** Two measurements:
2,451 → 5,102 and 1,314 → 3,080. That ratio is the most reusable thing to come
out of the exercise, because it means the four remaining panels can be tuned
against `node:sqlite` and multiplied, rather than spending a deploy per
hypothesis the way this one did. It also settles the older worry in the other
direction: a local replica cannot prove *dialect*, but it turns out to predict
*cost* well enough to work from.

Headroom that was deliberately left, in order of size, if a future panel makes
the recompute too slow as a whole: the week-key expression (37ms a query
locally, in six queries), the `approver` CTE built twice, and `periodScalars`'
seven scans of 29,000 rows, which could be one query of 91 columns if D1's
column limit allows it — untested, and the compound-SELECT lesson says do not
assume.

**Top-N lists now break ties on the key.** `topRepos`, `topAuthors` and
`topReviewers` sorted on count alone, so tied entries came out in store order
and reshuffled between builds — the same latent bug the Leaderboard had. Once a
panel exists in two languages that stops being cosmetic: store order is not
something SQL can reproduce, so the two would have disagreed by construction.
Both sides now sort by count then key. Rebuilding the Node panel against the
same store differs from the shipped `dashboard.json` in exactly two leaves, one
tied pair swapping places, which is the whole of the behaviour change.

**D1 rejects a compound SELECT with more than a few arms.** A six-arm `UNION`
building the active-day set failed on the first real recompute with "too many
terms in compound SELECT", having passed every local test — `node:sqlite`
compiles with SQLite's own default of 500 and accepts what D1 will not. A local
replica proves logic, never dialect. The parity test now counts UNION arms in
the panel sources so the next one fails cheaply.

The workaround costs real CPU. Deduplicating the day set moved from SQLite into
JavaScript, taking the panel from ~9ms to ~50ms — nothing against Paid's 30
seconds, but it means this panel could no longer fit the free plan even split
one-per-tick. Downgrading would mean materialising the day set into a table
rather than rebuilding it each run.

The pattern each remaining panel follows:

1. Aggregate in SQL, not in the isolate. Query time is I/O and free; a loop over
   96,000 rows is not
2. Cache the result as one JSON blob in `panel_cache`. Materialising rows per
   recompute is what makes write cost scale with the data instead of the panel
   count — `drilldown` is the exception, at 23 MB it needs its own tables
3. Write the parity test *before* trusting the port. Two implementations of the
   same numbers drift silently, and a wrong leaderboard looks exactly like a
   right one

**Reusing the Node panels inside the Worker was measured and rejected.** The
tempting shortcut — rebuild the store from D1, call the existing, proven panel
function — costs 96 MB of heap against a Worker's 128 MB ceiling, for pull
requests alone, before the panel allocates an accumulator and before the
drilldown adds 26,513 issues. Paid lifts CPU, not memory. So the panels are
reimplemented in SQL rather than moved, and the parity test is what makes that
survivable.

**That "staying in the Node build permanently" list was wrong, and it was wrong
twice.** It read `ciHealth`, `depUpdates`, `needsRelease`, `pullRequests` —
"each needs a live GitHub call, so no amount of D1 helps. That split is the end
state." It was written once, then repeated into the handoff, then repeated again
in conversation, without anyone checking it.

Two of those panels needed no new data whatsoever. `approvedUnmerged` and
`changesRequested` — which is what `pullRequests` means on the Dream Panel —
*ask* GitHub via one search query, because that was convenient for a panel
running at build time. Every fact is in `pull_requests` and `reviews`. Both are
now ported.

The other three are not blocked either, only unfed. `ciHealth`, `depUpdates` and
`needsRelease` need workflow runs, commits and release tags, and the webhook
already subscribes `workflow_run`, `push` and `release` — `onRepoTouch` receives
all three, upserts the repo row, and throws the payload away. That is a gap in
what is stored, not in what can be known.

The lesson worth keeping: **check what a panel needs, not what it does.** A
panel that calls an API is not thereby a panel that requires one.

Still to port: `issues`, `issueMetrics`, `activeDays`, `drilldown`, plus the
three above once their events are captured. Genuinely outside D1's reach:
nothing yet identified.

## Reproducing GitHub's review state

`approvedUnmerged` and `changesRequested` are not approval counts.
`review:approved` is *current state* — a pull request approved and then sent
back for changes is not in that list — so the port had to reproduce GitHub's own
resolution: each reviewer's **latest** verdict, then aggregate.

- approved: someone's latest is APPROVED and nobody's latest is CHANGES_REQUESTED
- changes: anybody's latest is CHANGES_REQUESTED
- COMMENTED is not a verdict and never decides
- DISMISSED is a verdict withdrawn: it ranks as latest, then counts as neither

No tiebreak on the ordering, and that is a guarantee rather than an oversight —
`idx_reviews_key` is unique over `(repo, pr_number, author, submitted_at)`, so
one reviewer cannot hold two verdicts in a second. The test asserts the schema
forbids it, because the panel rests on that.

Against the search API on the same seed: 10 to 9 and 31 to 33. Every shared row
identified the same pull request, and every difference traced to the store
lagging GitHub rather than to the logic — the incremental ingest keys on
`updated_at`, which a review does not always move. Webhooks close that gap, so
**the live answer is fresher than the search it replaces.**

Two cosmetic regressions, both known: `authorAvatar` is dropped (nothing in
`web/` reads it), and label chips render uncoloured, because D1 stores label
names only and the colour lives in Label-Sync-GTNH. A label table fixes the
second and unblocks `byLabel`.

## Two rebuild tiers, and cards that say which

The ten-minute cron is a debounce whose justification is `analytics` at ~2.6s on
D1. That reasoning got applied to every panel, which was wrong: the two review
cards measure ~68ms and ~55ms, against the ten seconds GitHub allows a delivery.

They now rebuild on the delivery itself, through `ctx.waitUntil` so the work
happens after the 200 has gone back — it cannot delay a delivery or fail one,
which matters more than freshness because a failing webhook gets disabled
silently. Only `pull_request` and `pull_request_review` trigger it;
`workflow_run` fires constantly and moves neither card. `dirty` is left set, so
the cron still owes the expensive panels their rebuild.

Every card now carries its state on its border: green for instant, blue for
cron, amber for the static build, **red for a panel that should have been live
and whose API did not answer**. Amber and red are the same stale data and
opposite meanings — half this dashboard is legitimately amber, so an outage
sharing that colour would be invisible.

The tier travels as an `x-refresh` header the Worker sets, not a list in the
frontend. A second copy of the instant/cron split would be wrong the first time
a panel moved between them, and wrong in the direction that lies to the reader.

**The frontend reads live panels already.** `web/js/live.js` loads
`data/dashboard.json` as before, then overlays the ported panels from the Worker
and re-overlays when `/api/version` moves.

**Nothing from the 2026-08-30 session is deployed.** Verified against the live
Worker: `x-refresh` returns null and `/api/panel/approvedUnmerged` 404s. The
code is on `origin/main` — `wrangler deploy` is not git, and was never run.

The static file stays the floor rather than being replaced, and that is the
design, not a stepping stone. A Worker that is down, blocked or slow costs
freshness only — the page still renders from data at worst as old as the last
build. Fetching panels from the API alone would have made an API outage a blank
dashboard. Polling pauses on a hidden tab and every fetch has a timeout.

Adding a panel to the live set is one entry in `LIVE_PANELS`.

Then: deploy automation, and loading `traffic_daily`, which was the deferred
half of the seed split.

**Ties in the leaderboard are now broken by login.** 497 of 1,214 people share a
score of 1, and their order was previously whatever the store yielded, so the
bottom two-thirds reshuffled on every build for no reason.

Phase E is unblocked — see the private-repo decision above.

---

## Found, parked for QA

Deliberately not fixed yet. Shipping first, then a QA pass.

**The Leaderboard orders by the wrong period.** The card reads "by activity,
last 6 months" and every column is windowed, but the rows arrive in all-time
order and `contributorRows()` filters without re-sorting — `sortRows` only bites
once the tab is expanded and a column is clicked. So Dream-Master, with 20 PRs
in six months, outranks UltraProdigy's 374 on a card claiming to rank six
months. True of every window except All.

Predates the port. Breaking ties by login made it *stable*, which is how it
became visible. Either sort by the selected window, or change the subtitle to
say the ranking is all-time — the first is one line, the second is honest about
the current behaviour, and which is right is a product question.

**Six panels in `data/dashboard.json` are empty** — approvedUnmerged,
changesRequested, byLabel, needsRelease, depUpdates, ciHealth. A build was run
without a token. `npm run build` with one restores them; nothing is lost.

**First CI run of the new workflow needs checking** — confirm the post-job cache
save appears. Until it does, `git rm -r --cached data/` should wait.
