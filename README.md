# NH-Dashboard

A dashboard for monitoring the [GTNewHorizons](https://github.com/GTNewHorizons) GitHub organization.

Zero dependencies — Node 20.6+ and its built-in `fetch`. There is no install step.

## Viewing it

**Hosted (no setup):** the scheduled build deploys to GitHub Pages, so the
dashboard is just a URL — nothing to install or run. Data refreshes every 30
minutes. This is the way to read it from any machine.

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

### Scheduled builds and Pages

`.github/workflows/build.yml` runs every 30 minutes: it builds the data,
commits `data/`, and deploys `web/` + `data/` to GitHub Pages.

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

The raw store lives in `.cache/ingest/` and is gitignored. Only the aggregate
lands in `data/`.

## Layout

```
src/config.js        tracked labels, thresholds, org — tune here first
src/github/client.js API client: auth, pagination, rate limits, caching
src/panels/          one module per panel
src/build.js         runs all panels → data/dashboard.json
src/serve.js         local static server
web/index.html       frontend (single file, no build step)
data/                generated output — committed on purpose
```

`data/` is committed deliberately. Once a cron runs the build on a schedule,
the git history of that file becomes a free time-series of point-in-time values
that can't be reconstructed from the API later (star counts, CI pass rates,
team membership). Most historical metrics *are* reconstructible from
`created_at`/`merged_at` timestamps and don't need this.

## Tuning

Everything worth adjusting lives in `src/config.js`:

- `TRACKED_LABELS` — which labels get a tab
- `RELEASE_COMMIT_THRESHOLD` — raise it if repos that auto-release on merge are noisy
- `STALE_REPO_CUTOFF_DAYS` — skips dormant repos in org-wide sweeps; the main cost lever
- `CACHE_TTL_MINUTES` — local API response cache

Pass `--no-cache` (or `npm run build:fresh`) to bypass the cache.

## Moving into the org

The GitHub API layer is isolated in `src/github/client.js` and reads its token
from `src/config.js`. To cover private repos, swap in a token with full `repo`
scope — no panel code changes. Note that GitHub Pages access control is
Enterprise Cloud only, so if this ends up serving private-repo data it needs
somewhere other than Pages to live.

## Not built yet

- **Contributor activity** (PRs authored and reviews approved, over 1/3/6/12 months
  and all-time). Needs a local ingestion pipeline rather than live queries —
  review data is nested under each PR, so answering it live would mean walking
  every PR in the org on every page load.
- Scheduled builds via GitHub Actions.
