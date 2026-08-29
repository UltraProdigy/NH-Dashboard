# Handoff — resuming the panel port

Paste the opening line at the bottom into a fresh conversation. This file is the
map; `going-live-status.md` is the territory and wins where they disagree. Both
are temporary and get deleted when the migration lands.

Written 2026-08-29, end of the session that took the Worker live.

---

## The one-paragraph version

The ingest pipeline is live and unattended. GitHub events reach a Cloudflare
Worker, land in D1, and a cron rebuilds cached panels every ten minutes. One
panel — `contributors` — is ported to SQL, proven identical to the old
JavaScript, and rendering live in the browser. Five panels remain. The next one,
`analytics`, is the hardest in the set and was deliberately not started at the
tail of a long session.

## Live infrastructure

| Thing | Value |
|---|---|
| Worker | `https://nh-dashboard.gtnh.workers.dev` |
| D1 database | `nh-dashboard`, id `ed20adc3-f434-4f0a-8832-80862af30201` |
| GitHub App | `NH-Dashbot`, App ID `4745300` |
| Plan | **Workers Paid**, active |
| Cron | `*/10 * * * *` |

Endpoints: `/webhook`, `/api/health`, `/api/version`, `/api/panel/:name`,
`POST /api/recompute?force=1`. All read routes send permissive CORS, which the
dashboard needs because Pages and workers.dev are different origins.

Seeded and verified in production: 29,091 pull requests, 41,239 reviews, 26,513
issues. `traffic_daily` is still 0 — the deferred half of the seed split.

## What was built this session

- The Worker deployed, webhook configured, eight events subscribed, deliveries
  confirmed writing to D1 (`meta.dirty` flipped to 1)
- `src/shared/contributor-rules.js` — `WINDOWS`, `BOT_PATTERN`, `isBot`, and the
  leaderboard comparator, dependency-free so Node and the Worker share one copy
- `worker/src/panels/contributors.js` — the panel as three D1 queries
- `worker/src/recompute.js` + `panel_cache` — panels cached as one JSON blob
  each, rebuilt on a debounced cron
- `web/js/live.js` — the frontend overlays live panels over the built file and
  polls `/api/version`

Twelve commits, all local and unpushed. Nothing has been pushed at any point.

## Next task: port `analytics`

`src/panels/analytics.js`, 484 lines, 281 KB of output. Follow the pattern in
`worker/src/panels/contributors.js` and write the parity test first.

What makes it the hard one:

- **Percentiles per time bucket.** `mergeMedianH`, `mergeP90H`,
  `reviewMedianH`. SQLite has no percentile function. The route is
  `ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY hours)` against
  `COUNT(*) OVER (PARTITION BY bucket)`, picking the row matching the existing
  `pct()` — index `floor(p/100 * len)`, zero-based, so `rn = index + 1`
- **Week keys.** `weekKey()` is ISO-week arithmetic via the nearest Thursday.
  `strftime('%Y-%W')` is *not* the same thing and will disagree at year
  boundaries
- **First PR ever.** Ties on `createdAt` break on `repo#number`, deliberately —
  GitHub stamps to the second and the issue side once reported more first-time
  reporters than reporters
- **`firstReviewAt`** excludes bots *and* the PR's own author
- **The heatmap** is weekday × hour, UTC, over the last year
- **Previous-period accumulators** — every dated window has an equal-length
  period before it for the deltas. All-time has none

`grossingLists` and `hasEngagement` come from `src/panels/grossing.js`, which
reads no store and may port straight across.

After `analytics`: `issues`, `issueMetrics`, `activeDays`, then `drilldown`.
`drilldown` is 23 MB and cannot use `panel_cache` — a D1 row caps at 2 MB. It
gets `drilldown_contributors` and `drilldown_repos`, which already exist in the
schema for exactly this reason.

Staying in the Node build permanently: `ciHealth`, `depUpdates`, `needsRelease`,
`pullRequests`. Each needs a live GitHub call, so D1 cannot answer for them.
That split is the end state, not a migration half-done.

## Four things that will bite again

**A local SQLite replica proves logic, not dialect.** `node:sqlite` and D1 are
different builds. A six-arm `UNION` passed every local test and failed on the
first real recompute — D1 caps compound SELECT terms far below SQLite's default
of 500. The parity test now counts UNION arms, but the general lesson stands:
the first real recompute is part of the test, not a formality after it.

**Write the parity test before trusting the port.** It is the whole reason the
`contributors` port is believable. It caught a hardcoded `truncated: 0` that
would have silently switched off the frontend's "approval counts are a floor"
warning. Two implementations of the same numbers drift invisibly — a wrong
leaderboard looks exactly like a right one.

**Reusing the Node panels in the Worker does not fit.** Measured: 96 MB of heap
to rebuild the PR store, against a 128 MB ceiling, before any accumulator and
before issues. Paid lifted CPU, not memory.

**Cache panels as blobs, not rows.** Materialising 1,214 contributor rows per
recompute would make write cost scale with the data rather than the panel count.
One blob is one write. The 2 MB row cap is the ceiling to watch.

## Commands

```
npm run test:handlers     # 31 assertions, webhook handlers
npm run test:parity       # SQL vs JS, needs worker/seed.sql + data/dashboard.json
node --experimental-sqlite worker/test/recompute.test.js

cd worker && npx wrangler deploy
npx wrangler tail                                    # live delivery log
curl -X POST "https://nh-dashboard.gtnh.workers.dev/api/recompute?force=1"
npx wrangler d1 execute nh-dashboard --remote --command "SELECT key, value FROM meta"
```

Both test suites build their own SQLite replica from `schema.sql` + `seed.sql`
and skip politely when those are absent, which they are in CI. Neither is
committed.

Deploys must run from a machine logged in to Cloudflare — the credentials are
local to the operator and `node_modules` holds platform-specific `workerd`
binaries.

## Two loose ends

**`data/dashboard.json` has six empty panels** — approvedUnmerged,
changesRequested, byLabel, needsRelease, depUpdates, ciHealth. A build ran
without a token. `npm run build` with one restores them. Nothing is lost, and
the file was deliberately kept out of every commit.

**`git rm -r --cached data/` still waits** on someone confirming the new
workflow's post-job cache save actually appears.

## Parked for QA, not forgotten

The Leaderboard orders by all-time activity under a subtitle claiming the
selected period. Predates the port; breaking ties by login made it visible.
Detailed in `going-live-status.md`.

---

## Open the next conversation with

> Read `handoff.md` and `going-live-status.md` in the repo, then port the
> `analytics` panel to D1 following the pattern in
> `worker/src/panels/contributors.js`. Write the parity test first.
