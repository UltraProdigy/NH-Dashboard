# Handoff — resuming the panel port

Paste the opening line at the bottom into a fresh conversation. This file is the
map; `going-live-status.md` is the territory and wins where they disagree. Both
are temporary and get deleted when the migration lands.

Written 2026-08-29, end of the session that ported `analytics`.

---

## The one-paragraph version

The ingest pipeline is live and unattended. GitHub events reach a Cloudflare
Worker, land in D1, and a cron rebuilds cached panels every ten minutes. Two
panels — `contributors` and `analytics` — are ported to SQL, proven identical to
the JavaScript, and registered in `LIVE_PANELS`. `analytics` was the hard one:
it deployed at 6.3 seconds and came down to 3.1 over two rounds. Everything
committed is deployed and nothing is outstanding. Four panels remain, and the
next, `issues`, is ordinary work by comparison.

## State of play

Everything committed is deployed. Version 19, both panels built, nothing failed.

| Panel | Cached | Rebuild |
|---|---|---|
| `contributors` | 737 KB | 437ms |
| `analytics` | 287 KB | 3,080ms |

`analytics` started at 6,306ms and came down in two rounds. It is done being
optimised — what is left is real work, not waste.

The one thing worth carrying forward: **D1 runs this workload at about 2.2× the
local `node:sqlite` replica** — measured twice, 2,451 → 5,102 and 1,314 → 3,080.
So the remaining panels can be tuned locally and multiplied, instead of spending
a deploy per hypothesis, which is what the first two rounds here cost.

Not yet confirmed in a browser: the header should read "2 panels live".

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

- `src/shared/analytics-rules.js` — the percentile, the week/month/day keys, the
  backlog buckets and the top-N comparator, each with its SQL twin generated
  from the same constants. Dependency-free so Node and the Worker share one copy
- `isBotSql` in `src/shared/contributor-rules.js`, generated from the same
  prefix list as `BOT_PATTERN`, because SQLite has no regex
- `worker/src/panels/analytics.js` — the panel as 33 D1 queries
- `worker/test/analytics.parity.test.js` — 26 assertions, all passing
- Top-N ties now break on the key, in both implementations
- `analytics` registered in `recompute.js` and `LIVE_PANELS`

Nineteen commits this session, none pushed. Nothing has been pushed at any point.

## Next task: port `issues`

`src/panels/issues.js`. Follow the pattern in `worker/src/panels/analytics.js`
and write the parity test first — `analytics.parity.test.js` is the closer model
of the two, since it deals with buckets and windows rather than one flat table.

After `issues`: `issueMetrics`, `activeDays`, then `drilldown`. `drilldown` is
23 MB and cannot use `panel_cache` — a D1 row caps at 2 MB. It gets
`drilldown_contributors` and `drilldown_repos`, which already exist in the schema
for exactly this reason.

Staying in the Node build permanently: `ciHealth`, `depUpdates`, `needsRelease`,
`pullRequests`. Each needs a live GitHub call, so D1 cannot answer for them.
That split is the end state, not a migration half-done.

## Seven things that will bite again

**`strftime` parses a date string, per row, per call.** It is the single
largest cost in this panel — 43ms a query against 7ms for the equivalent string
comparison, over 29,000 rows. Timestamps here are fixed-width and whole-second,
so lexical order is chronological order; compare the strings and ceil the bound
with `isoBound`. Reach for a date function only where the calendar is genuinely
needed, as the weekday and the ISO week are.

**And if you do reach for `strftime('%s')`, cast it.** It returns TEXT, and
SQLite orders every TEXT value above every number, so an uncast comparison is
not approximately right, it is constant — `>=` a bound always true, `<` always
false. Every windowed count in the first run of `analytics` came back as the
whole table or as zero, and not one query looked wrong.

**Measure before rewriting, and measure the thing itself.** Two confident
theories about this panel's 6.3 seconds — the repeated first-review grouping,
then per-query round-trip cost — were wrong, and each cost a rewrite and a
deploy. A temporary `/api/probe` settled the second in one deploy: round trips
are ~9ms, `Promise.all` does overlap them, and 33 of them cost 73ms together.
The third theory was measured locally first and was worth 40%.

The local replica predicts D1 at ~2.2×, so there is no excuse for guessing:
profile against `node:sqlite`, and only deploy once the local number has moved.

**±Infinity cannot cross the D1 wire.** Parameters serialise as JSON and
`Infinity` becomes `null`, which makes every comparison NULL. All-time binds a
finite sentinel.

**A local SQLite replica proves logic, not dialect.** `node:sqlite` and D1 are
different builds. A six-arm `UNION` passed every local test and failed on the
first real recompute — D1 caps compound SELECT terms far below SQLite's default
of 500, and a multi-row `VALUES` is a compound SELECT too, which is why the
thirteen periods are columns and parameters rather than a joined period table.
The parity test counts UNION arms; the general lesson stands.

**Write the parity test before trusting the port.** It is the whole reason both
ports are believable. On `contributors` it caught a hardcoded `truncated: 0`; on
`analytics` it caught the TEXT comparison above, which four other kinds of
checking had not. Two implementations of the same numbers drift invisibly — a
median merge time of 3.5 hours and one of 4.1 look equally like a working
dashboard.

**Reusing the Node panels in the Worker does not fit.** Measured: 96 MB of heap
to rebuild the PR store, against a 128 MB ceiling, before any accumulator and
before issues. Paid lifted CPU, not memory.

**A window frame defaults to RANGE, and RANGE cannot count.** The percentiles
rank with `SUM(…) OVER (ORDER BY v ROWS UNBOUNDED PRECEDING)`; drop the explicit
frame and every row tied on `v` shares one running total, so the count jumps
past any rank inside a tied group and the lookup returns NULL rather than a
number. It would show up as a median that is occasionally absent, on a panel
where a missing median renders the same as one that has not been computed yet.

## Commands

```
npm run test:handlers     # 31 assertions, webhook handlers
npm run test:recompute    # 17 assertions, the cron's contract
npm run test:parity       # both panels, SQL vs JS
npm run test:parity:analytics

cd worker && npx wrangler deploy
npx wrangler tail                                    # live delivery log
curl -X POST "https://nh-dashboard.gtnh.workers.dev/api/recompute?force=1"
npx wrangler d1 execute nh-dashboard --remote --command "SELECT key, value FROM meta"
```

Every suite builds its own SQLite replica from `schema.sql` + `seed.sql` and
skips politely when those are absent, which they are in CI. Neither is
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
> `issues` panel to D1, following the pattern in
> `worker/src/panels/analytics.js`. Write the parity test first.
