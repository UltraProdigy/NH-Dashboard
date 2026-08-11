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
| Most grossing | 0 (reads local store) | Most commented / 👍 / 👎 PRs, per repo and org-wide |
| CI health | ~30 GraphQL + 1 REST per active repo | Recent completed runs on each repo's default branch — the only panel that reaches past PR data |
| Actions load | 0 (reuses CI health's sample) | Org-wide runs and wall-clock minutes per month, projected |

## Dream Panel

Four cards, ordered by how close each one is to "somebody press the button":
Approved-not-merged, Needs a release, Changes requested, By label.

### Exclusions

Two buttons on the toolbar — **Repos** and **Labels** — each opening a
searchable checklist that hides its entries from **every** card on the page.
They default to the **⚠️ AUTHOR MERGE ONLY** label and the **Angelica** repo,
and the choice is remembered in `localStorage`; the same handful shouldn't have
to be dismissed every morning.

The page's whole job is a short list of things somebody should act on. A label
that means "this is not yours to merge" is noise on it permanently, not just on
its own tab, so the filter applies to the rows themselves rather than to the
By-label selection: a PR carrying an excluded label disappears from
Approved-not-merged too. Tab counts follow the exclusions, because a badge that
disagrees with the list under it is worse than no badge.

Repo names arrive in two spellings — the search-backed panels carry
`GTNewHorizons/Angelica`, the release sweep carries a bare `Angelica` — so
everything is compared bare.

They're checkbox lists rather than native `<select multiple>` boxes. The native
control is a fixed-height scrolling box that can't show which of eighty repos
are ticked without scrolling, and ctrl-clicking to deselect one entry is a
well-known way to lose the other nine.

**Anything currently hidden is pinned to the top of its list**, above an
"Everything else" divider, and stays there while you search — with nineteen
labels and eighty repos, "what am I hiding right now" is the first question the
list has to answer, and it shouldn't require scrolling an alphabetical list to
audit. The full name is on each row's `title`, since the visible one ellipsises.

#### Why two buttons rather than one popup

This started as a single **Exclusions ▾** button opening a two-column popup,
and every problem it had came from that one decision:

- The row layout had to work at half the popup's width, which is what kept
  putting the checkboxes somewhere other than where they belonged.
- The search inputs needed a `.excl-pop`-qualified rule to win a specificity
  fight with the global `input[type="search"]` 260px floor — right for the
  toolbar, twice too wide for half a popup.
- The toolbar showed one count, which was the sum of two unrelated numbers. Six
  hidden things told you nothing about whether any of them were repos.

Hiding a repo and hiding a label are unrelated decisions and there's no reason
to make them at the same moment. One list per popup costs one more slot on a
toolbar that has room, and all three problems stop existing rather than being
worked around. Opening one closes the other; **Clear** is scoped to the group
you're looking at, so clearing repo exclusions can't silently un-hide every
label as well.

Rows are a flex line with an explicitly non-shrinking checkbox (`flex: none`)
rather than a grid with a fixed first track. The two look equivalent, but a
fixed grid track only has to be handed one contradictory width — from a browser's
own form defaults, a zoom level, a stylesheet that arrives later — to put the
box somewhere unintended. `flex: none` can't be talked out of its size.

### The label picker

It lives in the **By label** card's header, in the slot where every other card
puts its caption, rather than in the page toolbar. That card is the only thing
on the page it changes, and a control sitting above a grid of four cards reads
as a page-wide filter — which the exclusions now genuinely are.

Excluded labels drop out of the picker, and the selection falls back to the
first visible one rather than showing an empty table for a label that's been
hidden.

## One period control per page

Every page carries exactly one time control, in the same shape: a segmented
**All / 1m / 3m / 6m / 1y / 2y / 5y**. It scopes the KPI tiles and the charts
together.

The org pages used to carry two — a `window` dropdown driving the aggregates
and a separate `range` picker driving the chart x-axis — sitting side by side
on one toolbar, answering subtly different questions about the same page. A
3-month window next to a 1-year range is not a state anyone chose on purpose.
They're now one control, and the charts read the window like everything else.

Analytics and Contributor Activity default to **6 months**; the drilldowns keep
their own setting and still default to all time. Looking at the org you want
the recent picture, looking at one subject you want their whole history first
and then to narrow. The two settings are independent, so moving between them
doesn't reset either.

Six rather than three because three is short enough that a quiet fortnight
moves every number on the page, and on an org this size the question being
asked is nearly always "what does the last half-year look like".

**New Faces is the exception**, and keeps a period of its own defaulting to
3 months. "Who's new" and "who's busiest" want different spans by nature — six
months of first-timers is a long list of people who stopped being new some time
ago. The alternative, rewriting the page's period whenever you open that tab,
changes what Leaderboard was showing behind your back.

The cost is that its card on the overview grid doesn't answer to the toolbar
control above it, so its caption names the period it's actually on rather than
leaving you to assume it matches its neighbours. `OWN_WINDOW` in the frontend
is the whole mechanism: a module id mapped to the slot of `state` its period
lives in, which `windowKey()` consults before falling back to the page's.

Granularity is a separate control, because it isn't a time range — it's what
one bar *means*. It's labelled **x-axis** for exactly that reason, and offers
**by day / by week / by month**.

Both controls carry their label — **period** and **x-axis**. "3m" and "by
month" are both short strings of time sitting next to each other, and which one
is the range and which one is the bucket size isn't guessable from the buttons
alone.

Daily buckets only reach back `DAY_SERIES_DAYS` (two years). The org's history
starts in 2014, so an all-time daily series would be ~4,300 buckets — about
800 KB in a file that's committed on every build, drawn as a chart nobody can
read at that width. Two years is 731 buckets and 139 KB. When the selected
period reaches further back than the daily data goes, the chart says so rather
than quietly plotting a shorter span than the control promised.

Review latency at daily granularity is mostly gaps by design: a point only
appears once a bucket has more than three merges, and most days don't.

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

### What each record carries

Beyond the identity and timing fields, every PR record holds:

| Field | Feeds |
|---|---|
| `title` | Most grossing, Biggest PRs, Closed PRs |
| `additions`, `deletions`, `changedFiles` | lines-changed metrics everywhere, Biggest PRs |
| `commits` | commit counts per repo and per contributor |
| `comments` | Most commented, engagement totals |
| `reactions`, `thumbsUp`, `thumbsDown` | Most 👍 / Most 👎 |
| `reviewCount`, `reviews[]` | approvals, review latency, Collaboration |
| `isDraft` | Open PRs / Backlog state column |

All of them are scalars or `totalCount`-only connections on the PR itself, so
they cost nothing against the GraphQL node budget — 50 PRs × 50 reviews is
still 2,500 nodes a page. The expensive part was never the fields; it was the
one-time re-walk to populate the records that predate them.

Titles are clipped to 160 characters on the way in. They're the single largest
field in the store, a ranked-list row ellipsises long before that, and only a
handful of PR titles are really a paragraph.

### Backfilling a newly-added field

The incremental walk is watermark-driven, so adding a field to the GraphQL
query only populates it for PRs that happen to change afterwards. Everything
already in the store keeps its old shape indefinitely.

`backfillField` closes that gap. It takes a predicate for "records that still
need this" and a query to re-walk the repos holding them with, and runs after
the main pass so anything that pass already refreshed is skipped. Two are wired
up in `BACKFILLS`:

| Pass | Predicate | Query | Cost |
|---|---|---|---|
| Draft status | open records missing `isDraft` | `OPEN_PRS` | ~118 requests |
| Diff size, comments, reactions, titles | any record missing `additions` | `PRS` | ~570 requests, once |

The second one *is* a full re-walk — every record in the store predates those
fields, so "the repos holding a record that needs it" is every repo. There's no
cheaper option: diff size is meaningful on merged PRs, so it can't be scoped to
open ones the way draft status could. It's paid once, and 570 requests against
a 5,000/hour budget is an inconvenience rather than a problem.

Every pass is **self-limiting** — once the field is populated it costs one local
store read and zero requests — so both can stay in place permanently. They're
also **naturally resumable**: records written before an interruption already
carry the field, so the next run picks up at the repos that didn't get there.
Appends happen per repo rather than batched at the end for exactly that reason.

Until the second pass has run, everything derived from diff size reports
honestly rather than guessing. Windows carry `sizedPRs` — how many PRs in that
window actually had diff data — and the tiles say "no diff data yet" and point
at `npm run ingest` rather than rendering a confident `0`. PRs missing the data
are dropped from Biggest PRs entirely instead of being ranked at zero, which on
an un-backfilled store would be a list ordered by nothing.

Draft state is the same deal: the drilldowns show `unknown` rather than
guessing, because rendering "ready" for a PR we've never asked about would be a
quiet lie.

## CI health

The one panel that can't come from the ingest store. Workflow runs aren't
attached to pull requests in any way the ingest walks, so "is this repo's CI
green, and how flaky is it" has to be asked directly.

Two stages, same shape as Needs release: a GraphQL sweep for names and default
branches that stops at `STALE_REPO_CUTOFF_DAYS`, then one REST call per
surviving repo for its most recent completed runs on that branch. Repos with no
workflows return an empty list and drop out for free.

Cancelled, skipped and `action_required` runs are excluded from the pass rate —
they describe the humans, not the code, and counting them as failures makes
every repo where someone cancels a slow run look broken. A repo whose only runs
were cancelled reports no verdict rather than 0%.

The panel is optional in the build: reading Actions runs needs a token scope
the other panels don't, so a token that works everywhere else can still fail
here without turning the build red or blocking the Pages deploy.

`CI_RUN_SAMPLE` in `src/config.js` sets how many recent runs are sampled. It's
one request per repo regardless, so raising it is free until 100, where the API
starts paginating.

### Actions minutes

The Health tab reports **Actions time**: the summed wall-clock duration of the
runs already sampled, with the run count beside it. It costs nothing — the
durations were being computed for the median anyway.

It is deliberately **not** GitHub's billable minutes, and the panel says so.
Billing is per *job*: a run with eight matrix jobs in parallel bills roughly
eight times what it took on the clock, and macOS bills 10x, Windows 2x. A
duration can't know any of that.

The real figure comes from `/actions/runs/{id}/timing`, which is one request
per run — ~20 per active repo, or roughly 4,000 per build on top of what this
panel already costs. That would dominate the rate-limit budget for a number
nobody is going to reconcile against an invoice. Summed over a known run count,
wall-clock still answers the question being asked: which repos are the
expensive ones.

The org's actual billed total is one request to
`/orgs/{org}/settings/billing/actions`, but it needs `admin:org` and has no
per-repo breakdown, so it would be an Analytics tile rather than anything the
repo drilldown could use. Not built.

### Actions load, org-wide

General Analytics carries an **Actions load** card projecting the same sampled
runs onto the whole org: runs per month, wall-clock hours per month, average
run duration, and the aggregate pass rate. It costs **zero extra requests** —
every number comes from samples the CI health sweep already fetched.

The projection is per repo and then summed. Each repo's sample covers a span
(`sampleSpanDays`, the gap between its oldest and newest sampled run), which
turns "20 runs" into a rate; that rate times 30 days is its contribution. A
repo with fewer than two runs has no span to divide by and is skipped rather
than reported as infinite — `projectedFrom` on the card says how many of the
repos actually contributed.

The card states its limits rather than burying them, because the numbers are
large and large numbers get quoted:

- **It's an estimate from a recent sample.** A repo that hammered CI last week
  and has been quiet since projects a month that won't happen.
- **It's a floor, not a total.** Only completed default-branch runs are
  sampled, and `exclude_pull_requests=true` drops PR-triggered runs outright.
  On most repos those are the majority of all CI activity.
- **Minutes are wall-clock**, with the same matrix-and-macOS caveat as above.
- **There are no job counts.** `/actions/runs` returns runs, not jobs. A job
  breakdown needs one more request per run — roughly 1,500 a build — which
  would cost more than every other panel combined. The card says so instead of
  quietly reporting runs under a heading that says jobs.

The expanded tab adds a sortable per-repo table — estimated minutes and runs
per month, median run, pass rate — which is the form that answers "which repos
are the expensive ones".

The panel's payload is `{ repos, org }` rather than the flat repo map it used
to be. A flat map left nowhere to put an org-wide roll-up that a repo couldn't
accidentally shadow; an org containing a repo named `org` would have overwritten
it. The frontend reads `p.data.repos ?? p.data`, so a stale `dashboard.json`
still renders while a rebuild is pending.

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

The data lives in its own `data/drilldown.json` (~9 MB once the size and title
fields are populated, roughly 1.5 MB gzipped) rather than in `dashboard.json`. The frontend fetches it the first time you open
a drilldown page and keeps it for the session, so the other three pages don't
pay for data they never use.

### One time control

The drilldowns have exactly one: a segmented **All / 1m / 3m / 6m / 1y / 2y /
5y**, defaulting to all time. It scopes the numbers and the charts together.
Every other page now works the same way — see "One period control per page"
above; the drilldowns just got there first.

Each drilldown module declares which controls it actually uses, so Collaboration
(all-time by nature) and Open PRs show no time control at all rather than one
that does nothing when you touch it.

The setting is per-page: changing it here doesn't touch Analytics or
Contributor Activity, which keep their own. Looking at one subject you
generally want their whole history first and then narrow; looking at the org
you want the recent picture.

### The profile tiles

The first tile is **PRs opened** for the period, with **PRs closed** for the
same period underneath — closed meaning everything that reached a terminal
state, merged or dropped. It used to read "N all time", which put a windowed
number directly above a lifetime one. Two numbers on the same clock compare;
two on different clocks just sit there.

Because the charts follow the window, the series has to reach back far enough
to answer "5 years" and "all time" — so `SERIES_MONTHS` is a ceiling of 240
rather than a flat 24, and each subject is trimmed to its own first month. A
1-month window plots a single bar, which is sparse but honest.

The window list is read from whichever file the page is backed by.
`dashboard.json` and `drilldown.json` are built separately and can disagree
about which windows exist — after a change like adding 2y and 5y, one is
rebuilt before the other — so a drilldown reads its own list rather than
borrowing the analytics one and hiding options its data actually has.

Both profiles also carry **lines changed** and **commits** for the period, with
the median PR size beside them. Added and removed are shown separately rather
than as a net figure — a refactor that moves 4,000 lines nets to zero, which is
the least informative thing that could be said about it — and the median sits
next to the sum because the sum is dominated by whichever PR regenerated a lang
file. The all-window table breaks out added, removed, median and p90 PR size,
commits, files touched and comments.

These come from PR diffs, not from the commit graph, so they miss anything
pushed straight to a branch without a PR. `/repos/{org}/{repo}/stats/contributors`
would cover that — one REST request per repo for true all-time commits and line
counts per contributor — but it's computed asynchronously (a `202` on the first
call, needing retry logic) and caps at each repo's top 100 contributors. Not
built; the PR-derived numbers came free with data the ingest was already
fetching.

Ranked lists — top repos, top authors, review partners — are **uncapped**. That
was measured rather than assumed: capping at 10 produced 2.54 MB, at 100 it was
3.11 MB, and uncapped 3.18 MB. The distributions are steep (the median repo has
10 distinct authors, p90 has 45), so the cap was only ever truncating the
handful of subjects where the long tail is the interesting part. Long lists
scroll inside their box rather than stretching the page.

### Numbered rows and shares

Every `hbars` list ranks by exactly one metric, so each row carries its
position. Rank is information in a single-metric list, and "who is seventh"
shouldn't need counting down from the top with a finger. The numbers are right
aligned and tabular so 9 and 10 line up on their last digit rather than the
list developing a kink at every power of ten.

The contributor's **Repos** card and the repo's **People** card also show each
row's **share of the list total** beside the count. Those breakdowns are
exhaustive — every PR someone opened lands in exactly one repo — so the list
total is the subject's total, and the percentage is meaningful rather than a
share of some truncated top-N. It changes what the number means: "48 PRs in
GT5-Unofficial" is a different fact at 12% of someone's output than at 80%, and
on the repo side one person at 70% is a bus factor where three at 25% each
isn't. The bar alone can't say this — it compares each row against the biggest
one, not against the whole.

Review relationships ("who approves their PRs") are counted over all time. A
review relationship accumulates slowly, and windowing it mostly produces noise.

### Authored vs. reviewed, by repo

The contributor's **Repos** card carries two ranked lists — PRs opened per repo
and PRs reviewed per repo — both following the period control. Authoring and
reviewing are different jobs that land in different places: plenty of people
open PRs against one mod and review across a dozen, and one list only ever told
half that story. It's the mirror of the repo drilldown's **People** card, which
splits the same pair by person instead of by repo.

Stacked on the overview, side by side in the expanded tab. The overview slot is
four columns wide and two ranked lists beside each other there ellipsis the
repo names down to nothing.

Inside a paired box the label/bar split is inverted from the wide cards: the
name takes whatever's left and the track is capped at a third, rather than the
name being capped at 34%. In a half-width box that cap ellipsised repo names
after about twelve characters while the bar sat in acres of empty panel — and
in these lists the name is the thing you're reading, with the bar only there
for a sense of scale.

The reviewed list is built the same way as the authored one, from the same
`_counts` map — the key just carries a `reviewed` segment instead of `opened`.
It sums exactly to that window's approval count, which is the cheap check that
the two haven't drifted. It costs about 0.6 MB on `drilldown.json`, which is
gitignored and regenerated on every build.

Activity charts label **every** month, upright, with the month stacked over its
year on two lines — at 24 buckets a single line of "Aug '26" doesn't fit the
slot, and rotating it makes the axis hard to read.

Those labels are HTML beneath the plot rather than SVG `<text>`, because the
charts use `preserveAspectRatio="none"` — anything drawn inside gets squashed
horizontally as the card narrows, which is survivable for six labels and
unreadable for twenty-four. The org-wide charts on Analytics still thin theirs;
at weekly granularity over two years there are 104 buckets and nothing fits.

On the overview grid, list cards (Repos, Collaboration, People) grow to the
height of their row instead of stopping at a fixed height and leaving a strip
of empty panel below. In the expanded tab view they take their own max-height
instead — the card stands alone there, so an uncapped list would just make the
page metres long.

### Closed PRs

The contributor drilldown carries every PR of theirs that reached a terminal
state — merged or closed unmerged — newest first, with a toggle for All /
Merged / Closed. It respects the time control like everything else, so all-time
by default. Full width on the overview, since a half-width table of four
columns looked stranded.

The toggle only appears on the tab, not on the overview: the overview gathers
every module's controls into one toolbar, and a three-way filter for one card
down the page is clutter up there. That's what a module's `tabControls` are, as
against `controls`.

There are 25,660 of these org-wide, and the obvious
`{repo, number, at, merged}` shape cost ~1.9 MB in repeated key names and
repeated repo strings — more than every other contributor field combined. They
ship packed instead: positional rows, with the repo replaced by an index into a
short per-contributor list, since people work in a handful of repos even when
they have hundreds of PRs. The frontend expands them on first use like the
series, destructuring positionally against `RESOLVED_FIELDS`:

```
[repo, number, at, merged, additions, deletions, commits, comments, title]
```

Timestamps are stored as plain dates. The list sorts by recency and renders
"3 days ago"; the time of day was 25,660 records' worth of bytes nobody reads.

Diff size, commits and comments ride along on these rows rather than living in
a separate "biggest PRs" list. A precomputed top-15 per contributor would have
been barely smaller — 17,835 rows against 25,660 — and could only ever answer
one question. Carrying the numbers here means Biggest PRs, the Closed PRs table
and the merged/dropped toggle all read the same array, and every one of them
follows the period control for free.

Rows written before those columns existed are four long, so the tail
destructures to `undefined` and is normalised to `null` — "we haven't asked" and
"this PR changed nothing" have to render differently.

### Biggest PRs

The contributor page ranks their PRs by lines changed, with commits, comments
and outcome beside them. "Biggest" has four plausible meanings, so all four
columns are sortable in the expanded tab and diff size only leads because it's
the one that most often matches what somebody means by "their big PR".

Open PRs are included alongside resolved ones. A 6,000-line PR that has been
sitting open for a year is exactly what this card should surface, and excluding
it for not having landed would be perverse. Resolved PRs are windowed by when
they ended and open ones by when they were opened — the only dates each half
has, and the same ones Closed PRs and Open PRs already window by, so the three
cards agree about what "last 6 months" contains.

It reads `resolvedAll()` rather than `resolvedRows()`, deliberately: the latter
also applies the Closed PRs tab's merged/dropped toggle, which isn't shown on
this card. Reusing it would let a setting made two tabs ago quietly halve the
list.

### Most grossing

Three ranked lists — most commented, most 👍, most 👎 — on every repo
drilldown, and an org-wide version on General Analytics. They answer a different
question from everything else here: not how much work happened, but what the
org actually argued about, liked, or hated.

**All-time, in both places**, and the caption says so rather than displaying a
period control that would do nothing. A window-keyed top 5 across three kinds
and seven windows is 105 rows per repo — with titles attached that's roughly
9 MB across 1,400 repos, to slice a list whose whole appeal is that it's the
hall of fame. Windowing would also leave the 1-month view as three empty boxes
on most repos, since the median PR draws no reaction at all.

The org board shows ten rows where a repo shows five: a top 5 across 1,400
repos is almost entirely one repo's greatest hits, which is the opposite of
what an org-wide board is for.

Lists are truncated at whatever actually scored, never padded — a repo where
nothing was ever discussed shows an empty box and says so, rather than claiming
a ranking among PRs with zero comments. Ties break on PR number so the output
is deterministic across builds instead of reshuffling with whatever the store
happened to yield first.

Rows are rendered without bars. These counts span three orders of magnitude — a
400-comment thread next to a 6-comment one — and a proportional track renders
four invisible slivers under one full-width one, which tells you less than the
numbers already did.

The ranking lives in `src/panels/grossing.js` rather than in either panel.
Both own half of it otherwise, and having `analytics.js` import it from
`drilldown.js` would make a needless import cycle out of forty lines of sorting.

### "+ N more" counts what was truncated

`renderTable` derives its "+ N more — open the tab for the full list" line from
the array it was handed, and says nothing when nothing was cut.

It used to take a separate `total` and subtract the rows shown from it. Callers
passed the pre-filter count, so searching an already-complete list produced
"+ 312 more — open the tab for the full list" underneath every matching row:
the list *was* complete, the search had simply removed 312 rows on purpose. A
count of hidden rows has to come from the same array the rows came from, or it
ends up answering a different question than the one the sentence asks.

### Getting there

**Every contributor name in the dashboard links to their drilldown**, not to
github.com — leaderboards, New Faces, Gone quiet, top authors and reviewers,
the repo People lists, all of it. The drilldown answers more of what you were
asking when you clicked a name here, and it carries a "View on GitHub" button
of its own, so the profile is one more click rather than gone.

The one exception is that button itself, on the drilldown header.

They're real anchors to `#contributor/<login>`, so middle-click and
open-in-new-tab behave normally. Plain clicks are intercepted only so they
route through `go()` and clear the sort and filter, which a bare hash change
wouldn't.

**Repo names work the same way**, linking to `#repo/<name>` — the Busiest repos
list, the repo columns on every PR table, the contributor's Repos card, all of
it. Same trade, same reasoning: the drilldown answers more of what you were
asking when you clicked a repo name here, and it carries its own "View on
GitHub" button.

The one exception is **Needs a release** on the Dream Panel. That card exists to
send you somewhere to press a button, and the button is on github.com — routing
it through a drilldown would add a step to the one place on the dashboard whose
entire purpose is not having steps. Which is why `COLUMNS.release` keeps its
direct links while `COLUMNS.pr` doesn't.

Everything is compared bare before linking, since the search-backed panels carry
`GTNewHorizons/Angelica` and the drilldown is keyed on `Angelica` — the same
`bareRepo` the exclusion filter uses.

### Remembering where you were

Each page remembers its last tab, and the drilldowns also remember their last
subject, so moving between pages resumes rather than resetting. The mode toggle
does the same: flipping to Repo puts you back on the repo you were looking at,
falling back to the equivalent tab only if you've never been there.

This is in-memory for the session. The hash stays the source of truth, so a
reload or a shared link lands exactly where the URL says — the memory only
fills in what a navigation didn't specify.

## Layout

```
src/config.js        tracked labels, thresholds, org — tune here first
src/github/client.js API client: auth, pagination, rate limits, caching
src/panels/          one module per panel
src/panels/grossing.js  shared by analytics and drilldown, owned by neither
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

- **Per-repo detail beyond PRs and CI** — stars, watchers, open issues, topics.
  None of it is in the ingest store. CI health opened the door to per-repo API
  enrichment, so adding these is now a matter of extending that sweep rather
  than building a new one.
- **Per-workflow CI breakdown.** The Health tab aggregates all default-branch
  runs together, so it tells you a repo is flaky but not which job is at fault.
  That needs an extra request per repo to list workflows.
- **Job-level Actions data.** Jobs per run, per-job duration and per-job
  pass/fail all need `/actions/runs/{id}/jobs` — one request per run, roughly
  1,500 a build even capped at five runs per repo. Actions load reports runs
  instead and says plainly that it can't report jobs.
- **Real billed Actions minutes.** One request to
  `/orgs/{org}/settings/billing/actions`, but it needs `admin:org` and returns
  no per-repo breakdown. It would be worth adding as a single calibration tile
  next to the projection if the estimate ever needs defending.
- **True commit and line counts.** Everything on the dashboard is derived from
  PR diffs, so commits pushed straight to a branch are invisible.
  `/repos/{org}/{repo}/stats/contributors` would cover them at one request per
  repo, at the cost of `202`-and-retry handling and a top-100-contributors cap.
- **Issue data.** The ingest walks pull requests only, so nothing anywhere
  reflects issue volume or triage latency.
