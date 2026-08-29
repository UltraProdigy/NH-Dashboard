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

**Phase D steps 1–6 — schema, seed, skeleton, handlers.** All proven locally.
`npm run test:handlers` is 31 assertions; `npm run webhook:test` exercises the
signature path including rejection.

---

## Where the plan is now wrong

**The seed does not need two days or Workers Paid.** The ~150k estimate assumed
labels, assignees and review requests became link tables. As JSON columns —
which is how they already exist in the store — the load is:

| Table | Rows |
|---|---|
| `pull_requests` | 29,029 |
| `reviews` | 41,141 |
| `issues` | 26,478 |
| `traffic_daily` | 4,731 |
| `ingest_state` | 341 |
| **total** | **101,726** |

Splitting traffic to a second day puts the first pass at **96,995**, under the
100,000/day ceiling. `--only=prs,issues,state` then `--only=traffic`.

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

## Not in the plan, and blocking

**There is no display filter for private repos.** Nothing leaks today because no
panel reads traffic and the private backfill has not run. But Phase E puts
private PRs and issues into a `dashboard.json` served from public Pages. Per the
plan's own reasoning this wants to be opt-in — panels ask for restricted repos
rather than remembering to exclude them, so a new panel fails closed.

**This is the real blocker on Phase E**, and it is not a numbered step anywhere.

---

## Decisions taken today

**`Dupes-Exploits-GTNH` is excluded at ingest**, via `NH_INGEST_EXCLUDE` in
`.env` and never in committed source. Revisit once the Worker plus access
control exists — at that point it is a one-line change, and GitHub retains PR and
issue history so only that repo's traffic is lost.

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

1. `npx wrangler d1 create nh-dashboard`, paste the id into `worker/wrangler.toml`
2. Regenerate `worker/seed.sql` — the store advanced to 29,091 PRs
3. Seed remote once: `--only=prs,issues,state`
4. `npx wrangler deploy`
5. Webhook URL and secret into the App settings; subscribe `pull_request`,
   `pull_request_review`, `issues`, `issue_comment`, `push`, `workflow_run`,
   `release`, `repository`; confirm the ping
6. Watch a real event land in D1

Then the bulk of Phase D: port panels to D1 queries, debounced recompute,
`/api/version`, frontend polling, deploy automation.

**First CI run of the new workflow needs checking** — confirm the post-job cache
save appears. Until it does, `git rm -r --cached data/` should wait.
