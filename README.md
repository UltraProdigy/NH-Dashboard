# NH-Dashboard

A dashboard for monitoring the [GTNewHorizons](https://github.com/GTNewHorizons) GitHub organization.

Zero dependencies — Node 20.6+ and its built-in `fetch`. There is no install step.

## Setup

```bash
gh auth login     # recommended — no token stored on disk
npm run build     # fetch data → data/dashboard.json
npm run serve     # http://localhost:4000
```

Without a token you get 60 requests/hour instead of 5,000, which isn't enough
for the release sweep.

### Token resolution

Tried in order:

1. `GITHUB_TOKEN` env var — how CI supplies it, and fine for one-offs:
   `GITHUB_TOKEN=$(gh auth token) npm run build`
2. The `gh` CLI's stored credential — nothing on disk, nothing to rotate
3. `.env` (gitignored) — see `.env.example`

### Scheduled builds

`.github/workflows/build.yml` runs every 30 minutes and commits `data/`.

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
| PRs by label | 1 search per label | Labels are per-repo, so we track a curated list rather than enumerating 1400 repos' worth |
| Needs release | ~30 GraphQL + 1 REST per candidate | Sweeps every repo's HEAD vs its last release tag; only compares where they differ |

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
