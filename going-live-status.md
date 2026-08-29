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

**The schedule stays off, for a new reason.** Committing `data/` was what made a
cron expensive, and that is fixed. What keeps it parked now is minutes: the repo
is private, so Actions bills against 2,000/month rather than the unlimited public
pool, and a build costs 15–90 minutes because the ingest walks all-time history.
Half-hourly is roughly ten times the budget. Moving the repo into the org, or
webhooks making this job reconcile-only, each fix it.

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
exclusion is now the *only* thing keeping that repo out of a public artefact, so
it is load-bearing rather than provisional. GitHub retains PR and issue history
either way, so only that repo's traffic is lost while it stays excluded.

**Labels and assignees stay JSON, not link tables.** Reversible in-database with
no API calls if a panel ever needs to filter by label at scale.

**Handlers write only the columns their payload carries.** Reactions have no
webhook event, `closedVia` comes from the timeline API, `first_response_at` is
derived by walking comments. A full-row upsert would blank these and nothing
would look wrong until a panel emptied out. The tests assert this specifically.

**A failing handler still answers 200.** GitHub disables a webhook that keeps
failing, and that failure is silent, so a handler bug must not cost the
subscription when the sweep will correct it anyway.

**Don't buy Workers Paid yet.** Nothing on the current path needs it. The moment
that changes is the private backfill, which will certainly exceed 100,000 writes.

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

Then the bulk of Phase D: port panels to D1 queries, debounced recompute,
`/api/version`, frontend polling, deploy automation. Also still outstanding:
loading `traffic_daily`, which was the deferred half of the seed split.

Phase E is unblocked — see the private-repo decision above.

**First CI run of the new workflow needs checking** — confirm the post-job cache
save appears. Until it does, `git rm -r --cached data/` should wait.
