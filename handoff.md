# Handoff — going live

Paste the opening line at the bottom into a fresh conversation. This file is the
map; `going-live-status.md` is the territory and wins where they disagree. Both
are temporary and get deleted when the migration lands.

Written 2026-08-30.

---

## Do this first — nothing from the last session is deployed

The Worker still runs code from before any of it. Verified: `x-refresh` comes
back `null` and `/api/panel/approvedUnmerged` returns 404. The *code* is on
`origin/main`, because `wrangler deploy` has nothing to do with git.

```
cd worker && npx wrangler deploy
curl -X POST "https://nh-dashboard.gtnh.workers.dev/api/recompute?force=1"
git push          # two commits: the freshness tint, which is frontend-only
```

The forced recompute matters — the two new panels have never been built, so
they 404 until something builds them, and the instant path only fires on a new
delivery.

`git push` is separate and equally necessary: `LIVE_PANELS` and the tint live in
`web/js/`, and those only reach the site through a CI run. Deploying the Worker
without pushing means the page never asks for the new panels; pushing without
deploying means it asks and gets a 404. Order does not matter, both are needed.

**Until the Worker ships, every live card shows red.** That is the indicator
working: they are in `LIVE_PANELS`, they 404, and red means "should be live and
is not". They turn green and blue on deploy.

## What "live" means here

Four panels are served from D1, in two tiers, and the tier is a real property of
the pipeline rather than a label:

| Panel | Tier | Latency |
|---|---|---|
| `approvedUnmerged` | instant | seconds — rebuilt on the webhook delivery |
| `changesRequested` | instant | seconds — same |
| `contributors` | cron | ≤10 min |
| `analytics` | cron | ≤10 min |

The instant path runs inside `ctx.waitUntil` after the 200 has gone back to
GitHub, so it cannot delay or fail a delivery — which matters more than the
freshness, because a webhook that keeps failing gets disabled and does it
silently. Only `pull_request` and `pull_request_review` trigger it.

The split is drawn by measurement, not category: ~68ms and ~55ms for the two
instant panels against ~2.6s for `analytics` alone. If a panel gets cheap
enough, move it into `INSTANT` in `worker/src/recompute.js` — the card retints
itself, because the tier reaches the frontend as an `x-refresh` header rather
than a second list.

Everything else still comes from the daily build. The page loads
`data/dashboard.json` first and the Worker's copies overlay it, so a Worker
outage costs freshness and nothing else.

## The card tint

Every card carries its state on its border. `web/js/data.js` → `freshness()`.

- **green** — instant
- **blue** — cron
- **amber** — from the static build, by design
- **red** — should have been live, the API did not answer

Amber and red are the same stale data and opposite meanings, which is the whole
point: half this dashboard is legitimately amber, so an outage sharing that
colour would be invisible.

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

**The webhook pipeline works.** D1 held 29,101 PRs against a seed of 29,091,
plus 11 new reviews and 4 new issues — writes land in seconds.

**`/api/health` can serve a cached response.** It reported the bare seed counts
once and sent a whole investigation down a blind alley. Fetch it with
`cache: "no-store"` before concluding anything from it.

## Next: three of five Dream Panel cards

| Card | State |
|---|---|
| Approved, not merged | ported, needs the deploy above |
| Changes requested | ported, needs the deploy above |
| Needs a release | needs `push` + `release` payloads |
| Time since last update | needs `push` payloads |
| By label | needs a label table |

**The events are already arriving and being thrown away.** `onRepoTouch` in
`worker/src/handlers.js` handles `push`, `workflow_run` and `release` by
upserting the repo row and discarding the payload. Capturing them is a table and
a handler each, not new plumbing:

- `push` carries commits and whether each arrived via a pull request — that is
  `depUpdates` ("last direct commit") and half of `needsRelease`
- `release` carries the tag — the other half of `needsRelease`
- `workflow_run` carries run conclusions — that is `ciHealth`, which was also
  written off as impossible

`byLabel` needs the managed label list from Label-Sync-GTNH, which a Worker
cannot fetch. A `label_colors`-style table populated by the daily build fixes
both that and the one cosmetic regression from the port: D1 stores label *names*
only, so live chips render uncoloured. `authorAvatar` was dropped outright —
nothing in `web/` reads it.

**Do not repeat the mistake that made this a five-card job instead of a
two-card one.** The previous handoff said four panels "each need a live GitHub
call, so D1 cannot answer for them", and that was carried forward twice without
checking. Two of them needed no new data at all — they only *asked* GitHub,
because a single search query was convenient for a panel that ran at build time.
Check what a panel needs, not what it does.

## Then: the remaining Node panels

`issues`, `issueMetrics`, `activeDays`, `drilldown`. Groundwork for `issues` is
already done and committed:

- `src/shared/issue-rules.js` — every rule with its SQL twin, because JavaScript
  reads a nested `closedVia` and D1 reads four flattened columns
- `worker/test/issues.parity.test.js` — 8 assertions, passing, comparing per
  issue rather than per total. The panel comparison skips until the panel exists
- The core needs **no JSON support**: `unlabelled`/`unassigned` are the only
  questions asked of those columns and every empty value is exactly `[]`. Only
  the label breakdown needs `json_each`, which is untested on D1

`drilldown` is 23 MB and cannot use `panel_cache` — a D1 row caps at 2 MB. It
gets `drilldown_contributors` and `drilldown_repos`, already in the schema.

## Things that will bite again

**`strftime` parses a date per row per call.** The single largest cost in
`analytics` — 43ms a query against 7ms for the equivalent string comparison.
Timestamps here are fixed-width whole seconds, so lexical order is chronological
order; compare strings and ceil the bound with `isoBound`.

**If you do use `strftime('%s')`, cast it.** It returns TEXT, and SQLite orders
every TEXT value above every number, so an uncast comparison is not
approximately right, it is *constant*. Every windowed count came back as the
whole table or as zero and no query looked wrong.

**±Infinity cannot cross the D1 wire.** Parameters serialise as JSON and
`Infinity` becomes `null`. Periods bind finite ISO sentinels.

**A window frame defaults to RANGE, and RANGE cannot count.** The percentiles
rank with `ROWS UNBOUNDED PRECEDING`; drop it and rows tied on a value share one
running total, so the count jumps past a rank and the lookup returns NULL — a
median that is occasionally just absent.

**A local SQLite replica proves logic, not dialect.** A six-arm `UNION` passed
every local test and failed on the first real recompute. A multi-row `VALUES` is
a compound SELECT too, which is why periods are columns rather than a joined
table.

**But it does predict cost: D1 runs about 2.2× the local replica.** Measured
twice. Profile locally and multiply rather than spending a deploy per
hypothesis — two confident theories about `analytics` were wrong, and the one
that was measured first was worth 40%.

**Write the parity test before the port.** It caught a hardcoded `truncated: 0`,
the TEXT comparison above, and a `closerUnknown` rule that the real store cannot
exercise at all. Two implementations of the same numbers drift invisibly.

**Do not name a CTE after a real table.** `worker/src/scope.js` rewrites
`FROM issues` and friends into a filtered subquery; a CTE with one of those
names would be rewritten too.

## Commands

```
npm run test:freshness    # 14, the card tint
npm run test:exclusion    # 17, the ingest exclusion
npm run test:handlers     # 31, webhook handlers
npm run test:recompute    # 26, the cron and the instant path
npm run test:parity       # 60 across four panels

cd worker && npx wrangler deploy
npx wrangler tail
curl -X POST "https://nh-dashboard.gtnh.workers.dev/api/recompute?force=1"
node worker/seed.js --out worker/seed.sql     # regenerate from the local store
```

Every suite builds its own SQLite replica from `schema.sql` + `seed.sql` and
skips politely when those are absent, which they are in CI.

Deploys must run from a machine logged in to Cloudflare.

## Parked, deliberately

**The ingest exclusion.** `NH_INGEST_EXCLUDE` is applied in code and covered by
`npm run test:exclusion`, but CI has no repo secret, so a CI build still
republishes the excluded repo. The decision was to settle it when the repo moves
into the org. Detail in `going-live-status.md`.

**Traffic.** `npm run ingest:traffic` runs by hand and nothing renders it. The
window is 14 days, so unrun for two weeks the data is gone permanently — it is
the one thing here that cannot be backfilled. Loading it into D1 is the fix.

**The Leaderboard sorts by all-time under a subtitle claiming the selected
period.** Predates all of this. One line either way; which line is a product
question.

**`git rm -r --cached data/`.** `data/` is tracked and committed.

---

## Open the next conversation with

> Read `handoff.md` and `going-live-status.md`. Deploy the worker and push
> first — nothing from the last session is live. Then capture the `push`,
> `release` and `workflow_run` payloads the webhook already receives and
> discards, so Needs-a-release and Time-since-last-update can come off the daily
> build. Parity test first.
