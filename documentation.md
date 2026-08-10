# NH-Dashboard

A dashboard for monitoring the [GTNewHorizons](https://github.com/GTNewHorizons) GitHub organization.

Zero dependencies — Node 20.6+ and its built-in `fetch`. There is no install step.

## Viewing it

**Hosted (no setup):** the build workflow deploys to
[GitHub Pages](https://ultraprodigy.github.io/NH-Dashboard/), so the dashboard
is just a URL — nothing to install or run. Data refreshes when the
[build workflow](https://github.com/UltraProdigy/NH-Dashboard/actions/workflows/build.yml)
runs: on every push to `main`, or on demand via **Run workflow**. This is the
way to read it from any machine.

**Locally (fresh data on demand):** double-click `Dashboard.command` in Finder.
It builds, starts the server, and opens your browser. Closing the Terminal
window stops it.

Or from a shell:

```bash
gh auth login     # once — no token stored on disk
npm start         # build + serve
```

Without a token you get 60 requests/hour instead of 5,000, which isn't enough
for the release sweep.

### Token resolution

Tried in order:

1. `GITHUB_TOKEN` env var — how CI supplies it, and fine for one-offs:
   `GITHUB_TOKEN=$(gh auth token) npm run build`
2. The `gh` CLI's stored credential — nothing on disk, nothing to rotate
3. `.env` (gitignored) — see `.env.example`

### Builds and Pages

`.github/workflows/build.yml` runs on push to `main` and on manual dispatch: it
builds the data, commits `data/`, and deploys `web/` + `data/` to GitHub Pages.
A 30-minute `schedule:` trigger is parked (commented out) in the workflow —
uncomment to bring it back. Cost isn't the concern; every run commits `data/`,
so 48 runs a day grow the repo whether or not anyone is reading the dashboard.

One-time setup: Settings → Pages → Source → **GitHub Actions**.

It needs a repo secret named **`GH_DASHBOARD_TOKEN`** (Settings → Secrets and
variables → Actions), holding a PAT with `public_repo` scope. Actions' built-in
`secrets.GITHUB_TOKEN` will *not* work — it's scoped to this repo alone and
can't read the GTNewHorizons org.

GitHub Secrets are only readable from inside a workflow run, which is why local
development needs one of the three options above rather than reusing the secret.

## Panels

| Panel | Cost | How it works |
|---|---|---|
| Approved, not merged | 1 search | `review:approved` is *current* state, so anything since un-approved drops out automatically |
| Changes requested | 1 search | Same — already excludes anything since approved |
| PRs by label | 1 search per label | Label list is read from Label-Sync-GTNH on every build, so it tracks the org's managed set automatically |
| Needs release | ~30 GraphQL + 1 REST per candidate | Sweeps every repo's HEAD vs its last release tag; only compares where they differ |
| Contributors | 0 (reads local store) | Aggregated from ingested PR/review data — see below |
| Drilldowns | 0 (reads local store) | Same data pivoted onto one contributor or one repo — see below |

## Contributor activity

Review approvals are nested under each PR, so there's no query that answers
"how many reviews has X approved". The only way is to walk every PR in the org.
That's too slow to do live, so it's a separate ingestion step:

```bash
npm run ingest      # first run walks all-time history; Ctrl-C is safe, it resumes
npm run build       # aggregates the store into the dashboard
```

The ingest is resumable (state saved per repo) and incremental after the first
pass — later runs only fetch PRs updated since the last run, and skip repos with
no pushes since. Records are append-only and keyed `repo#number`, so a late
review on an old PR correctly supersedes the earlier record.

The store lives in `data/ingest/prs.ndjson` and **is committed** — that's what
lets the hosted Pages build show contributor stats, and it doubles as a raw
dataset you can query directly.

Writes during a run are append-only so an interrupted run can't corrupt the
file. At the end of each run the store is compacted: deduplicated (newest
record per `repo#number` wins) and sorted by repo then PR number. That keeps it
from growing without bound as PRs get updated, and makes the output
deterministic so git diffs show only genuinely changed lines instead of a
reshuffled 9 MB file.

CI runs the ingest too, so the hosted dashboard stays current without you
running anything locally.

Set `NH_STORE_DIR` to point the store somewhere else — tests use this so they
can't clobber real data.

## Drilldowns

Two pages answer "how is *this* one doing" rather than "how is the org doing":
**Contributor Drilldown** and **Repo Drilldown**. Pick a subject with the search
box; the toggle beside it switches between the two, landing on the equivalent
tab where there is one.

Both are pure local computation over the same ingest store, so a subject costs
nothing to add and every time window is equally cheap. No extra API calls.

Deep links carry the subject, so they're shareable:

```
#contributor/Dream-Master          overview
#contributor/Dream-Master/cActivity  a specific tab
#repo/GT5-Unofficial/rBacklog
```

The data lives in its own `data/drilldown.json` (~2.5 MB) rather than in
`dashboard.json`. The frontend fetches it the first time you open a drilldown
page and keeps it for the session, so the other three pages don't pay for data
they never use.

Size drove two visible choices:

- **Contributor repo breakdowns** are stored for 1-year and all-time only.
  1,189 contributors x 5 windows x 10 repos was most of a megabyte for a list
  nobody reads at that granularity. The page uses the closer of the two and
  says which one it's showing. Repos, at 295 subjects, get all five windows.
- **Review relationships** ("who approves their PRs") are all-time. A review
  relationship accumulates slowly, and windowing it mostly produces noise.

New Faces on the Contributor Activity page has a jump button beside each name
that opens that person's drilldown. The name itself still links to GitHub —
the drilldown is the follow-up question, not a replacement for the profile.

## Layout

```
src/config.js        tracked labels, thresholds, org — tune here first
src/github/client.js API client: auth, pagination, rate limits, caching
src/panels/          one module per panel
src/build.js         runs all panels → data/dashboard.json + data/drilldown.json
src/serve.js         local static server
web/index.html       frontend (single file, no build step)
data/                generated output — committed on purpose
```

`data/` is committed deliberately. Once a cron runs the build on a schedule,
the git history of that file becomes a free time-series of point-in-time values
that can't be reconstructed from the API later (star counts, CI pass rates,
team membership). Most historical metrics *are* reconstructible from
`created_at`/`merged_at` timestamps and don't need this.

`data/drilldown.json` is the exception, and is **gitignored**. Every byte of it
comes from `prs.ndjson`, which is already committed, so its history would
record nothing you couldn't regenerate exactly — it'd be repo growth in
exchange for nothing. The build writes it on every run and the Pages deploy
copies it off disk, so the hosted site is unaffected.

The practical consequence: a fresh clone has no drilldown data until someone
runs `npm run build`. `Dashboard.command` does that before serving, and the
frontend shows a "run the build" message rather than breaking if the file is
absent, so this only ever surfaces if you open `web/index.html` directly.

## Tuning

Everything worth adjusting lives in `src/config.js`:

- `TRACKED_LABELS` — which labels get a tab
- `RELEASE_COMMIT_THRESHOLD` — raise it if repos that auto-release on merge are noisy
- `RELEASE_EXCLUDED_REPOS` — repos that never want a release, hidden from that panel
- `STALE_REPO_CUTOFF_DAYS` — skips dormant repos in org-wide sweeps; the main cost lever
- `CACHE_TTL_MINUTES` — local API response cache

`RELEASE_EXCLUDED_REPOS` takes repo names without the org prefix, matched
case-insensitively. `*` and `?` wildcards work, and a leading `!` re-includes
something an earlier pattern caught:

```js
export const RELEASE_EXCLUDED_REPOS = [
  "GT-New-Horizons-Modpack",  // released out of band
  "Horizon-*",                // all the tooling repos…
  "!Horizon-QA",              // …except this one
];
```

`NH_RELEASE_EXCLUDE=a,b` in the environment adds to that list instead of
replacing it, so CI can suppress a repo without a commit.

Pass `--no-cache` (or `npm run build:fresh`) to bypass the cache.

## Moving into the org

The GitHub API layer is isolated in `src/github/client.js` and reads its token
from `src/config.js`. To cover private repos, swap in a token with full `repo`
scope — no panel code changes. Note that GitHub Pages access control is
Enterprise Cloud only, so if this ends up serving private-repo data it needs
somewhere other than Pages to live.

## Not built yet

- **Per-repo detail beyond pull requests** — stars, watchers, open issues, CI
  status, topics. None of it is in the ingest store, so the Repo Drilldown
  covers PR and review activity only. Adding it means a per-repo API sweep on
  every build (~295 extra GraphQL requests), which is affordable against the
  5,000/hr budget but slows the build and adds a failure mode.
- **Issue data.** The ingest walks pull requests only, so nothing anywhere
  reflects issue volume or triage latency.
