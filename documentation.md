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
| Issue analytics | 0 (reads local store) | Triage state, volume, labels, and who files, answers and closes — aggregated from ingested issue data, see below |
| CI health | ~30 GraphQL + 1 REST per active repo | Recent completed runs on each repo's default branch — the only panel that reaches past PR data |
| Actions load | 0 (reuses CI health's sample) | Org-wide runs and wall-clock minutes per month, projected |

## Dream Panel

Four cards, ordered by how close each one is to "somebody press the button":
Approved-not-merged, Needs a release, Changes requested, By label.

### Exclusions

Each card carries its own filters, as buttons in its own header:

| Card | Buttons |
| --- | --- |
| Approved, not merged | Repos, Labels |
| By label | Repos, Labels |
| Needs a release | Repos |
| Changes requested | Repos |

Each opens a searchable checklist of things to hide **from that card only**.
Needs a release is repo-level data with no labels on it, and Changes requested
is a list you want to read whole — the only thing worth hiding there is a repo
that isn't yours.

**Per card rather than per page.** The four cards ask different questions, and
the same repo can be noise in one and the point of another: nobody here cuts
DreamAssemblerXXL's releases, but a PR sitting approved in it still wants
looking at. One shared list forced those two answers to be the same. It also put
the buttons on the page toolbar, above a grid of four cards — which is where a
control that changes the whole page belongs, and reads that way whether it is
one or not.

Within a card the filter still applies to the rows themselves rather than to the
By-label selection: a PR carrying an excluded label disappears from
Approved-not-merged whichever label it was found under. Tab counts follow the
exclusions, because a badge that disagrees with the list under it is worse than
no badge.

Defaults live in `DREAM_EXCL_DEFAULT` in `state.js`, one entry per card, and are
applied to any card with nothing saved. Choices are written to `localStorage`
under `nh:dreamExcl:v2` the moment a box is ticked — the same handful shouldn't
have to be dismissed every morning. A card with an empty *saved* list keeps it:
unticking everything is a decision, and only a card that has never been touched
falls back to its defaults. The key is versioned because the saved shape changed
from one list per page to one per card, and a half-read old value would have
silently applied the old page-wide list to one card and nothing to the rest.

Repo names arrive in two spellings — the search-backed panels carry
`GTNewHorizons/Angelica`, the release sweep carries a bare `Angelica` — so
everything is compared bare.

#### What a list offers

Two groups: **On this card**, then **Elsewhere in the org** (every repo the CI
sweep walked, every label the page has seen plus the tracked ones). The second
group is what makes the filter usable before the fact — several of the repos
worth hiding from Approved have no PR open in them today, and a list that only
offers what's currently on screen can't be told about them until the morning
they turn up.

They're checkbox lists rather than native `<select multiple>` boxes. The native
control is a fixed-height scrolling box that can't show which of eighty repos
are ticked without scrolling, and ctrl-clicking to deselect one entry is a
well-known way to lose the other nine.

**Anything currently hidden is pinned to the top**, above both group dividers,
and stays there while you search — with 250 repos in the list, "what am I hiding
right now" is the first question it has to answer, and it shouldn't require
scrolling an alphabetical list to audit. The full name is on each row's `title`,
since the visible one ellipsises. **Clear** is scoped to the button you opened,
so clearing Approved's repos can't silently un-hide its labels or touch the card
next to it.

#### The popup is drawn outside the card

One popup exists at a time, rendered into `#popLayer` at the end of `<body>` and
positioned by script against the button that opened it. It can't live inside the
card header where its button is: a card is `overflow: hidden` so its table can
have rounded corners, and it's a `container-type: inline-size` query container so
its KPI strips size against the card rather than the viewport. Between them, a
popup drawn in the header is clipped at the header's bottom edge *and* positioned
against the card, and no rule inside the card can undo either.

It's repositioned on scroll and resize rather than closed, because scrolling the
list scrolls the page underneath it once the list hits its end.

#### The option row

Absolutely positioned checkbox, ordinary block for the name. Flex and grid have
both been tried here and both failed the same way — the box ended up adrift in
the middle of the row with the name crushed against the right edge, because each
has free space to hand out and each managed to hand it to the wrong place. This
construction has no free space to distribute, so there is nothing left to
distribute wrongly.

### The label picker

It lives in the **By label** card's header, in the slot where every other card
puts its caption. It's the only thing that says what the rows underneath are.

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

## Issue analytics

The same trade the contributor panels make, applied to issues: walk them once,
store them, and every question about history becomes free.

```bash
npm run ingest                    # both stores
npm run ingest -- --only=issues   # just this one
npm run ingest -- --bulk=NAME     # first-load one big tracker over REST
```

The issue store lives in `data/ingest/issues.ndjson` with its own watermark
file, `issues-state.json`. It's separate from the PR store on purpose — the two
have independent watermarks, so a run that dies halfway through issues doesn't
cost the PR pass its progress, and a checkout can legitimately have one and not
the other. The build treats the issue panel as optional for that reason: no
issue store means the Issue Analytics page says so and every other page carries
on.

Only repos with the issue tab switched on are walked. Most of the org's repos
have it off, and asking them costs a request each.

One difference from the PR ingest worth knowing about: there's no "nothing
pushed since we last looked" shortcut. Issue activity doesn't imply a commit —
somebody can comment on or close an issue in a repo that hasn't been touched in
years — so every issue-enabled repo costs at least one request per run. The
watermark keeps it to exactly one.

### What each record carries

| Field | Feeds |
|---|---|
| `title` | every ranked list on the page |
| `state`, `closedAt`, `stateReason` | volume, time to close, completed vs. not planned |
| `labels[]` | Label mix, unlabeled counts |
| `assignees[]` | unassigned count |
| `comments` | Most commented, engagement totals |
| `reactions`, `thumbsUp`, `thumbsDown` | Most 👍 / Most 👎 |
| `firstResponseAt`, `firstResponder` | first-response latency, "never answered", who answers |
| `closedBy`, `closedVia`, `closerKnown` | who closes, closed-by-hand vs. closed-by-a-PR, every triage metric |

First response is derived at ingest time rather than stored raw. The question
is "when did somebody other than the reporter first say anything", and keeping
ten comment nodes per issue to recompute that later would roughly double the
store for nothing. Ten comments are fetched per issue; when all ten are the
reporter or bots and more exist, the record sets `responseUnknown` instead of
claiming silence, and those issues are dropped from both sides of the response
stats rather than counted as unanswered.

### Two orderings, and why

A first walk and a refresh want opposite things from the same query.

The refresh wants newest-updated first, so it can stop at the first issue it
has already seen — that is what makes a daily run cost one request per repo.
But ordering by update time reads a secondary index and seeks further into it
on every page, so cost grows with depth. That is invisible on a few hundred
issues and fatal on tens of thousands.

So a repo with no watermark is walked oldest-created first instead. A first
walk takes everything anyway, so it has nothing to stop early at, and creation
order runs with the grain of the rows rather than against an index. It is also
the safer order to paginate: issues opened mid-walk are appended past the end
instead of shifting the window under the cursor.

The switch is automatic — `seenThrough` is only set once a repo finishes, so a
resumed first walk keeps the ordering that produced its cursor.

### Bulk loading a large tracker

Even oldest-first, GraphQL could not fill the modpack from empty. 22,000
issues asked for 50 at a time, each page carrying labels, assignees and
comments, is refused by GitHub's abuse limit — not the hourly quota, a
*secondary* limit about pace and cost, which returns a flat 60-second penalty
however small the request that tripped it.

`--bulk` fills one repo over REST instead, and `src/ingest/issuesBulk.js`
explains why that works where GraphQL doesn't. Briefly: 100 items a page
instead of 50, `since` walking forward through an index rather than paging into
an offset, and list endpoints cheap enough not to look like scraping.

It runs two passes. The first streams every comment in the repo in creation
order to learn who replied first on each issue; the second streams the issues
and writes complete records. Both checkpoint — the comment map lives in a
sidecar beside the store until the load finishes, then is deleted.

First response comes out *better* than the GraphQL path's. That one samples ten
comments per issue and sets `responseUnknown` when that isn't enough; this sees
every comment in the repo, so `responseUnknown` is never set. It keeps the
first three distinct commenters per issue and credits the first who isn't the
reporter, so somebody replying to their own bug report twice before anyone else
speaks is not recorded as the response.

Records are written in exactly the shape the GraphQL walk produces — the panel
cannot tell which path wrote one. Afterwards the repo has a watermark and every
future run uses the normal incremental path at one request.

`--bulk` refuses to run on a repo that already has a watermark, so it cannot be
fired by accident later.

### Progress survives interruption

Both the GraphQL walk and the bulk loader checkpoint per *page*, not per repo.
The distinction matters at this scale: an earlier version accumulated a repo in
memory and wrote on completion, so twenty-five minutes of fetching the modpack
evaporated when the connection gave out on the last page, and every retry
started from the top. A page is the unit of work you can afford to lose.

### Adding a field later

The PR store grew a bespoke backfill pass per field added. The issue store
carries a version number on every record instead: bump `REC_VERSION` in
`src/ingest/issues.js` when the query changes, and the next run re-walks every
repo holding a record below it. Same properties as the PR backfills — it's
self-limiting once the store is current, and resumable, because records
rewritten before an interruption are already excluded from the next run's set.

**But a bump is the expensive option, and it is often the wrong one.** The
re-walk uses the full query, which is the shape GitHub's abuse limit refuses on
the modpack — the closer field learned this the hard way, and `patchClosers` is
what replaced it. When a new field can be fetched *on its own*, fetch it on its
own: a query of just that field, a hundred a page, merged onto the record already
on disk, with a cursor saved per page. Reserve the bump for changes that really
do need every field re-read, and reserve `--bulk` for filling a tracker from
nothing.

`--limit=N` bounds both passes as well as the main walk now, so a cautious first
run is actually cautious.

### Caveats worth knowing

**Close reasons are a moving target.** GitHub has grown the list over time —
`DUPLICATE` arrived well after `NOT_PLANNED` — and the panel treats both as
unresolved, with everything else counting as completed. That means a reason
added in future fails towards the flattering side, so `UNRESOLVED` in
`src/panels/issues.js` is worth re-checking against live data now and then.
Issues closed before GitHub recorded a reason at all appear to have been
backfilled to `COMPLETED`; the null branch stays anyway, and `unknownReason` in
the totals reports how many landed there so the assumption stays visible if it
ever starts firing.

**Reactions aren't collected.** Three aggregate counts per issue is 150
aggregations on a 50-issue page, and that was the part GitHub's abuse limit
kept refusing on the modpack. They fed the 👍/👎 lists and nothing else, so
Most Discussed ranks on comment count instead — a plain field on the issue that
costs nothing. Reinstating them means a `REC_VERSION` bump and a re-walk.

**Closing credit is a floor until the store is re-walked.** The next section says
why, and what to run.

### Who closed it

The store used to know *when* an issue closed and not by whose hand, which left
the org's actual triage work invisible: the people whose job is to sort, answer
and close tickets appeared in no number on the dashboard, while anybody who
opened a one-line PR appeared in several.

The ingest now asks for the last `CLOSED_EVENT` on each issue and keeps two
things from it:

- **`closedBy`** — who pressed the button.
- **`closedVia`** — what closed it: a pull request (with its number, repo and
  author), a commit, or nothing at all, which means somebody closed it by hand.

That is one timeline node per issue, about 2% on top of a page already carrying
fifteen labels and ten comments per issue — nothing like the reaction aggregates
that had to be abandoned. `last: 1` because an issue can be closed and reopened
several times and only the close that stuck describes the record's state.

Both are credited separately everywhere they appear, because on this org they are
usually two different people doing two different jobs:

- **Closed** — they pressed the button. Split further into their own issues and
  other people's, and into closed-by-hand versus closed-by-a-PR.
- **Closed by their PR** — the pull request that closed the issue was theirs,
  whoever pressed the button.
- **Triage acts** — first replies plus closes of somebody else's issue. The one
  number for "how much triage is this person doing". Deliberately a sum of acts
  rather than a weighted score: weighting answering against closing would be
  inventing a judgement the data can't support.

The same close can therefore be counted for two people in two different columns.
That's the honest reading, and every card that shows both says so.

Existing records don't have any of this, and getting it to them is where the
first attempt went wrong. It rode `REC_VERSION`, which orders a full re-walk —
and a full re-walk uses the *heavy* query, fifty issues a page carrying fifteen
labels, ten comments and five assignees each. That is the exact shape GitHub's
abuse limit refuses on the modpack, the reason `--bulk` exists in the first
place. It cleared all 86 repos in a request each and then sat in a 60-second
penalty every few requests, forever.

So the closer gets a pass of its own instead: `patchClosers` asks only for the
number and the one timeline node, and merges it onto the record already on disk
rather than rebuilding it, so nothing else is re-fetched to obtain one field. Open
issues are stamped locally, for free — the answer is known without asking.

The first version of that pass took a hundred a page with `states: [CLOSED]`,
reasoning that a fifth of the nodes at half the requests must be cheaper. It was
refused anyway. **Filtering a connection is not free**: the server still walks the
rows and discards, so a filtered page is *more* work than an unfiltered one of the
same size, not less. It now mirrors the shape that demonstrably works — unfiltered,
fifty a page, creation order — carrying one timeline node instead of thirty
assorted others. Matching a proven shape beats reasoning about which shape ought
to be cheaper.

It walks **newest-first**, the one deliberate difference from the first walk. The
backfill it replaces went oldest-first and died partway, so on the repos it touched
the oldest issues are the patched ones and the newest are the gaps: coming down
from the top reaches them immediately and stops when the set is empty. That is 149
pages for the modpack instead of 366. Both directions read the creation index
rather than a secondary one, which is the part that matters for cost.

It is resumable on two axes. The set it works on is "closed records that don't
know their closer", so anything already patched is excluded next time, *and* the
page cursor is saved per page, so an interruption costs one page rather than a
repo. That second part is what the version-driven backfill could never do — it
had no way to record where in a repo it had got to, so a refused request three
hundred pages into the modpack threw away all three hundred.

Measured against the real store with a stubbed API: 219 pages, every record
attributed, nothing else in any record altered.

### When the token is in cooldown

A secondary limit that keeps firing whatever the spacing is isn't a pace problem,
and no amount of politeness inside one process fixes it. Both patch passes carry a
breaker: three consecutive failures and the pass stops, says that this is a
cooldown rather than a pace, and points at running the same command later.

It counts two shapes of failure, because the first version only counted one. A
throttled page the client retried into success shows up as a bump in its
rate-limit counter; a page still throttled after all five attempts arrives as a
thrown 403. Counting only the first meant a cooled-off token failed quietly for
five minutes a repo, thirty-six times over. A first repo that fails before a
single record has come back stops the pass immediately — five attempts a repo at a
minute each means confirming the obvious costs ten minutes.

The important half of that fix is one line in `backfillStale`: a record whose only
gap is the closer belongs to the patch pass, so the version-driven walk skips it.
Without it, the breaker stopped the light pass and the heavy query then attacked
the very same records — the pattern that caused the cooldown in the first place.

Until that pass has run, closes read as unattributed rather than as zero.
`closerKnown` is a per-record tri-state, the panels count what they can't
attribute, and every affected card says how many closes it couldn't see and what
to run. A record only counts as attributed if it says out loud that it asked — a
bulk load over REST cannot ask, so it writes `closerKnown: false` rather than
staying silent and being mistaken for "closed by nobody".

The version-driven backfill is still there for fields that genuinely need every
other field re-read, and it got safer on the way past: it appends per page and
tracks which issue numbers are still stale, instead of accumulating a whole repo
in memory and writing on completion.

### By contributor

The issues page has a **By contributor** tab: one row per person, every column
sortable, covering all four things somebody can do to an issue — file it, answer
it, close it, or fix it with a pull request. It carries the medians too, so
"answers quickly" and "answers a lot" are separable.

Two things on that card are worth reading before quoting it:

- **Median reply lag is measured from when the issue was filed**, not from when
  the person picked it up. Somebody who works through old threads looks slow. It
  describes the queue as much as the person.
- **Concentration**: the KPI row reports what share of all triage acts the top
  five people account for. That's the number an admin acts on — if five people
  are doing four fifths of it, the queue has a bus problem no median will show.

The table is capped at the 200 busiest people per window and packed positionally
against `personFields`. The store holds 6,400 distinct issue participants, nearly
all of them somebody who filed one bug in 2019; a full per-window table of those
would be most of a megabyte in the file every page loads. Anyone who falls off
the cap still has a complete record on their own drilldown, which is where you go
when you want one person rather than a ranking.

### Labels are a per-repo taxonomy

The modpack names labels `Prefix: Value` — `Mod: GT`, `Status: Stale`,
`Type: Recipe` — across 233 of them, and the prefixes are different questions
rather than one long list:

| Group | Labels | Answers |
|---|---|---|
| `Status:` | 9 | where an issue is stuck |
| `Bug:` | 3 | how bad it is |
| `Type:` | 30 | what kind of thing it is |
| `Platform:` | 3 | which OS |
| `Mod:` | 174 | which component |
| no prefix | 14 | Suggestion, Crash, and friends |

Flattened into one ranked chart, the nine `Status:` labels that describe where
work is stuck disappear under a hundred that describe what it is about. So the
card groups by prefix, and the overview shows `Status:` alone — the triage
pipeline is the part you act on. A repo with no `Status:` labels falls back to
its busiest and says so.

Label stats are per repo for the same reason: the org-wide sum of a taxonomy
one tracker invented means nothing. The picker reaches every repo with labels;
`ISSUE_LABEL_REPO` in `src/config.js` sets which one it opens on.

Monthly trends are kept for that focus repo only, and only for labels with 20+
issues. That bound is deliberate — series size scales with labels times months,
and a trend line for a label carrying four issues is two dots and a gap.

### Triage

Three counts drive the page, and they mean different things:

- **Unlabeled** — nobody has classified it.
- **Unassigned** — nobody owns it.
- **Unanswered** — nobody except the reporter has said a word. A label or an
  assignment doesn't count here, because neither is visible to the person
  waiting for a reply.

Needs attention ranks the open issues three ways — oldest, longest untouched,
never answered — because an issue can be bad news in any one of them
independently. The ones sitting in all three are the ones worth opening first.

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

The data lives in its own `data/drilldown.json` (~19 MB, 3.4 MB gzipped) rather
than in `dashboard.json`. The frontend fetches it the first time you open a
drilldown page and keeps it for the session, so the other four pages don't pay
for data they never use.

Both stores feed it. Pull requests answer "what did they build"; issues answer
"what did they sort out", and those are frequently different people. A subject can
exist because of issue activity alone — a reporter or a triager with no PRs — or
because of PRs alone, on a repo with the issue tab switched off. Every card
tolerates the other half being absent and says which case it's in rather than
rendering a grid of noughts.

#### What it costs, and where that went

Folding in the issue store took the file from 6.3 MB to 19 MB, and the subject
count from 1,200 to 6,700. Four things bounded that, and they're worth knowing
because they're the shapes the frontend has to unpack:

- **Issue window records are packed positionally** against
  `issueWindowFields.contributors` / `.repos` — 12.9 MB down to 2.0 MB. Named
  objects meant writing `medianResponseLagHours` twenty-one thousand times.
- **Issue series are sparse month maps**, not padded arrays, and an empty series
  is `null` rather than 240 nulls in a row. PR series still pad: their subjects
  are people who open pull requests in consecutive months, and issue subjects are
  dominated by "one bug report, once".
- **Backlogs are `null` when empty** and carry bucket counts without their
  labels, which the payload states once at the top as `backlogBuckets`. Both the
  PR and issue backlogs work this way now, so both are read through the
  `backlogOf` / `issueBacklogOf` accessors rather than reached into directly.
- **Slim records.** The 3,900 people whose entire footprint is one or two bug
  reports get name, dates, packed windows and their filed rows — no ranked maps,
  no partner lists, no series. They still get a page, because a ranked list that
  links to a page that doesn't exist is worse than either; they just don't get
  eight ranked maps describing a single event. `substantial()` in
  `src/panels/drilldown.js` is the bar: any PR, any approval, any reply, any
  close, any assignment, or three issues filed.

Issue-side ranked lists are capped at 200 (`ISSUE_TOP_N`), unlike the PR ones.
The distributions aren't comparable: the median repo has ten distinct PR authors,
and the modpack has 5,086 distinct issue reporters.

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

The third option is `controlsHtml()`, which puts a control in the card's own
header instead of the toolbar — where the Dream Panel's filters live. Use it
when the control belongs to one card on both the overview and its tab, and
`tabControls` when it only makes sense with the card expanded.

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

### Issue cards on the drilldowns

The contributor page carries three, after the PR ones rather than interleaved
with them — they answer a different question about the same person, and reading
them as a block is how anyone uses them:

- **Issues** — the profile tiles' counterpart. Filed, accepted share, how long
  their own reports waited, first replies given, how fast they answer, closes
  split by whose issue it was and by hand versus by a PR, and what's assigned to
  them. Expanded, the same thirty metrics across all seven windows.
- **Triage** — where they answer and where they close, as two ranked repo lists,
  plus who they help and who helps them, plus the full log of everything they
  closed with a column saying whether their own pull request did it.
- **Filed issues** — every issue they reported with its outcome, how long it
  waited for a reply, and its comment count. Expanded, a monthly chart of all four
  activities at once.

The repo page carries four:

- **Issues** — opened, closed, backlog movement, both latencies, answered and
  resolved shares, reporters, responders, closers, and the by-hand/by-PR split.
  Expanded, the all-window table and monthly volume and people charts.
- **Issue backlog** — open right now, with unanswered, unlabeled and unassigned
  counts, age and last-activity profiles, and the full open list.
- **Issue people** — most filed, first to reply, closed the most, whose PRs closed
  them, and who's assigned.
- **Labels** — that repo's label mix, grouped by prefix, read straight out of
  `dashboard.json`. The issues panel already carries every label of every repo
  with its counts and medians, so the drilldown duplicates none of it; the
  consequence is that this card needs the issues panel to have built, and says so
  when it hasn't.

### Head to head

Both drilldowns have a **Head to head** tab. It pins the page's own subject as the
first column, takes up to four more from its own search box, and lays every
metric out side by side on whichever period the toolbar is set to.

Five columns is the limit on purpose: a table of ten is not a comparison, it's a
leaderboard, and the People and Repos pages already are one.

Every metric it shows is one that already exists on the page it's part of. A
lineup that computed its own numbers would eventually disagree with the profile
of the same person, and then one of them would be wrong.

The highlighted cell is the one **leading** that row, and on the volume rows that
is all it means — whoever opened more pull requests is not thereby better at
anything. Latency rows highlight the lowest, share rows the highest, and rows
where leading is meaningless (first seen, median PR size, open counts) highlight
nothing at all. A tie highlights both cells rather than silently picking whoever
was added first, and a row where everybody scored zero has no leader.

Below the table, each headline metric gets a ranked bar block, and two overlaid
monthly line charts show PR and issue volume per subject. Each subject keeps one
colour across the chips, the table headers, the bars and both charts.

The lineup is held per mode (`state.vs.contributor` / `.repo`), so flipping from a
contributor to a repo doesn't drag four logins along, and coming back finds the
lineup you left. It isn't in the hash: a five-subject comparison is a thing you
assemble, not a thing you link to, and encoding four names in a URL would double
its length for a case nobody shares.

The picker is a second combobox rather than the toolbar's. The toolbar's changes
which subject the page is *about*; this one adds a column to one card. Sharing the
widget would have meant one input with two meanings depending on where the caret
happened to be.

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
web/index.html       page markup — no logic, no styles
web/styles/          one stylesheet per region of the page
web/js/              frontend (native ES modules, no build step)
data/                generated output — committed on purpose
```

The frontend is plain ES modules loaded by the browser. There is no bundler and
no build step: `web/index.html` links the stylesheets and loads `js/main.js`,
and the browser resolves the rest. Both the local server and the Pages deploy
copy `web/` verbatim, so what you edit is what runs.

```
js/state.js            the single mutable state object, plus its constants
js/format.js           escaping, numbers, durations, dates, entity links
js/charts.js           hand-rolled SVG chart primitives
js/table.js            column definitions, sorting, filtering, table markup
js/data.js             reads dashboard.json: panels, windows, deltas
js/drilldown-data.js   reads drilldown.json: one subject's pull requests
js/issue-data.js       reads drilldown.json: one subject's issues, unpacked
js/versus-data.js      the head-to-head lineup and its metric catalogue
js/contributor-data.js the contributor rows shared by the people modules
js/module-helpers.js   fragments several modules render the same way
js/dream.js            Dream Panel exclusions and the label picker
js/pages.js            the six pages and the modules each one shows
js/modules/            one file per page's modules; index.js composes them
js/render.js           sidebar, tabs, toolbar, cards; and the drilldown fetch
js/router.js           hash routing
js/events.js           every delegated listener
js/theme.js            dark/light toggle
js/main.js             entry point: boot, load dashboard.json, first render
```

Dependencies run one way, roughly top to bottom in that list — `state` and
`format` know about nothing, `main` knows about everything. A module that
renders a card only ever imports helpers, never the renderer that calls it, so
there are no import cycles.

`data/` is committed deliberately. Once a cron runs the build on a schedule,
the git history of that file becomes a free time-series of point-in-time values
that can't be reconstructed from the API later (star counts, CI pass rates,
team membership). Most historical metrics *are* reconstructible from
`created_at`/`merged_at` timestamps and don't need this.

`data/drilldown.json` is the exception, and is **gitignored**. Every byte of it
comes from `prs.ndjson` and `issues.ndjson`, both of which are already committed,
so its history would record nothing you couldn't regenerate exactly — it'd be
19 MB of repo growth per build in exchange for nothing. The build writes it on every run and the Pages deploy
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
- `ISSUE_STALE_DAYS` — how long an open issue sits untouched before Triage state calls it stale
- `ISSUE_LABEL_REPO` — which tracker the Label mix card opens on, and the only one with per-label trends
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

## Rate limits

GitHub enforces two unrelated limits and they need opposite responses.

The **primary quota** is a budget — 5,000 points an hour. Spend it as fast as
you like and wait for the reset. Nothing in this project comes close.

The **secondary limits** are about pace: concurrent requests, points per
minute, server CPU per minute. Hitting one costs a flat 60-second penalty
regardless of how small the request that tripped it was, and against a limit
like that going flat out is strictly worse than going steadily — a walk that
trips a penalty every fifth request averages twelve seconds a request, where
the same walk spaced a second apart may never trip one.

So `src/github/client.js` starts at zero spacing and widens it by 250 ms every
time a secondary limit is hit, up to three seconds, settling wherever the API
is willing to be talked to. `NH_REQUEST_SPACING_MS` sets a floor for a run that
already knows it will be throttled.

It also prints which limit was hit and GitHub's own message. That matters more
than it sounds: before it did, every throttle looked identical from outside,
and the only way to tell an exhausted quota from a pace limit was to guess.

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
- **Cross-referenced PRs that didn't close anything.** `closedVia` catches the
  pull request that actually closed an issue, which covers "whose fix landed".
  It doesn't catch a PR that mentions an issue without closing it, or the several
  PRs that touched one before the last did. That needs
  `closedByPullRequestsReferences` or the full timeline, and it's a much larger
  query than one node per issue.
- **Who applied which label, and when.** Labelling is most of what triage
  actually is, and the store can only see the labels an issue ended up with — not
  who put them there or how long it took. Both live in the timeline as
  `LABELED_EVENT`, which is unbounded per issue rather than one node.
- **Comment counts per person.** The store knows who replied *first*, which is
  the number that matters for latency, but not who wrote the other four hundred
  comments on a long thread. That's a paginated connection per issue.
