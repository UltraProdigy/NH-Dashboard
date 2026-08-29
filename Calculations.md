# Calculations

Every statistical figure the dashboard renders, and exactly how it was arrived
at. If a number on a page looks wrong, this is where you check whether the
definition is wrong before you go reading the code.

Formulas are written in words and variables rather than against real data. The
point is not to reproduce a figure by hand — it is to be able to say "that
number counts X against a denominator of Y, and my objection is with Y" without
opening a single `.js` file.

Each entry names the file it lives in, so the code is one search away if the
description isn't enough.

**Contents**

- [How to read an entry](#how-to-read-an-entry)
- [Global conventions](#global-conventions) — the rules every number obeys
- [Shared primitives](#shared-primitives) — percentile, median, rounding, buckets
- [What the stores contain](#what-the-stores-contain) — derivations made at ingest
- [Pull request metrics](#pull-request-metrics)
- [Contributor metrics](#contributor-metrics)
- [Issue metrics](#issue-metrics)
- [Drilldown metrics](#drilldown-metrics)
- [CI health metrics](#ci-health-metrics)
- [Repository state panels](#repository-state-panels)
- [Browser-side calculations](#browser-side-calculations)
- [Known biases and blind spots](#known-biases-and-blind-spots)
- [Change log](#change-log)

---

## How to read an entry

Each metric gets the same five things, in the same order:

| Field | Meaning |
|---|---|
| **Shows** | What the number claims to be |
| **Numerator** | What is counted, and what act dates it |
| **Denominator** | What it is divided by, if anything |
| **Excluded** | What is deliberately left out of both halves |
| **Empty case** | What renders when the sample is empty, and why |

Where a metric has no denominator it is a count, and the Denominator row says
so. That distinction matters more than it looks: most disagreements about a
dashboard number turn out to be disagreements about a denominator nobody stated.

---

## Global conventions

These hold everywhere unless an entry says otherwise.

### Bots are excluded from people-shaped numbers

A login is a bot if it matches `BOT_PATTERN` in `src/config.js`: a trailing
`[bot]`, or a name starting `dependabot`, `github-actions`, `renovate`,
`codecov`, `mergify`, or `stale`. A null or empty login also counts as a bot,
which is how deleted accounts are handled.

Bot exclusion applies to:

- every author, reviewer, reporter, responder, closer, fixer and assignee count
- distinct-people sets (active authors, reporters, reviewers)
- the "first review" timestamp — a bot commenting is not a review
- the "first response" timestamp — a bot replying is not an answer
- the PR-creation heatmap
- the "last direct commit" probe in Dep updates, when
  `DEP_UPDATE_IGNORE_BOTS` is on (it is)

Bot exclusion does **not** apply to:

- raw PR and issue totals — a bot's PR is still a PR that was opened
- merge and close timings — a bot's PR still took the time it took
- comment counts and reaction counts, which are totals from GitHub

This asymmetry is deliberate. "How many PRs were opened" and "how many people
opened PRs" are different questions and only the second one should ignore
machines.

### Time windows

Defined once, in `WINDOWS` in `src/panels/contributors.js`, and every panel
imports that list:

| id | Label | Days |
|---|---|---|
| `all` | All time | *(none)* |
| `m1` | 1 month | 30 |
| `m3` | 3 months | 90 |
| `m6` | 6 months | 180 |
| `y1` | 1 year | 365 |
| `y2` | 2 years | 730 |
| `y5` | 5 years | 1825 |

A fixed window is the half-open interval `[now − days × 86,400,000, ∞)`.
All-time is `(−∞, ∞)`.

Months are approximated as 30 days and years as 365 — "3 months" is exactly 90
days, not a calendar quarter. Nothing in the dashboard uses calendar month
boundaries for windowing; monthly *buckets* are a separate thing and do use
calendar months.

### Every event is counted against its own timestamp

This is the single most important rule in the file. An event lands in a window
if *the date the event happened* falls inside it — not the date its parent
object was created.

- A PR **opened** counts against the window containing `createdAt`
- A PR **merged** counts against the window containing `mergedAt`
- A PR **closed unmerged** counts against the window containing `updatedAt`
  (GitHub gives no separate close timestamp on the PR record)
- An issue **opened** counts against `createdAt`
- An issue **closed** counts against `closedAt`
- A **first response** counts against `firstResponseAt`
- An **approval** counts against the reviewer's `submittedAt`

The consequence readers most often trip on: clearing a five-year-old backlog
shows up entirely in the current period's `closed`, and not at all in its
`opened`. That is intended. The alternative — dating a close by the issue's open
date — makes a month of hard triage look like nothing happened.

### Previous-period deltas

Every fixed window gets a second accumulator covering the equal-length period
immediately before it: `[now − 2×days, now − days)`. That is what "vs. previous"
compares against. A 3-month view compares against the 3 months before it, never
against last month.

All-time has no previous period and its deltas are absent, not zero.

Built in `periodsFor()` in `src/panels/issueMetrics.js` and inline in
`src/panels/analytics.js`.

### Null versus zero

The codebase distinguishes these everywhere and so should you when reading a
page:

- **0** means "we looked, and the answer is none"
- **null** (rendered as an em dash `—`) means "there is nothing to compute
  from", which is either an empty sample or a field the ingest has not
  backfilled yet

Specifically: medians, percentiles and shares are null on an empty sample.
`medianPRLines` is null rather than 0 when no PR in the window carries diff data
— otherwise a half-backfilled store renders as "nobody wrote any code this
quarter".

### Rounding

- `round1` — one decimal place, used for hour counts and minute counts
- `round3` — three decimal places, used for shares, because they render as whole
  percentages and full float precision was megabytes of payload noise
- Org-wide CI projections round to whole numbers, because the precision implied
  by "4,138.7 runs a month" is not there

Rounding happens at the end of a calculation, never partway through.

### Timezone

Everything is UTC. Timestamps come from GitHub as ISO-8601 UTC strings, day keys
are the first ten characters of those strings, and the browser renders dates in
UTC too. Nothing in the pipeline consults a local timezone, deliberately —
rendering in local time would slide half the org's dates a day either way
depending on who was looking.

---

## Shared primitives

### Percentile — nearest-rank, no interpolation

Defined identically in `src/panels/analytics.js`, `src/panels/issueMetrics.js`
and `src/panels/drilldown.js`.

```
pct(sorted, p):
  if sorted is empty        -> null
  index = floor((p / 100) × length(sorted))
  index = min(index, length(sorted) − 1)
  return sorted[index]
```

Notes that matter when a median looks off by one element:

- The array must be sorted ascending first. Every call site sorts in place
  before calling.
- There is no interpolation between neighbours. On an even-sized sample the
  "median" is the upper of the two middle values, not their mean.
- `p = 50` gives the median, `p = 90` gives p90.

This is a deliberate simplification. On samples of the size this dashboard
works with the difference from a properly interpolated percentile is smaller
than the noise in the underlying data.

### Median

```
median(values) = round1(pct(sort_ascending(values), 50))
```

The **mean is never used** for PR size, merge time, response time or close time.
On this org one regenerated language file drags a mean past every real number in
the list. Where a mean does appear it is labelled as one — see
`meanRunMinutes` under CI health.

### Week key

ISO-ish week, Monday-start, matching GitHub's own charts. Defined in
`src/panels/analytics.js` and `src/panels/issueMetrics.js`.

```
weekKey(date):
  t = date at UTC midnight
  dow = (UTC day of week of t + 6) mod 7          # Monday = 0
  shift t by (−dow + 3) days                       # the week's Thursday
  firstThu = 4 January of t's (possibly shifted) year
  week = 1 + round((t − firstThu) / 7 days)
  return "<year of t>-W<week, zero-padded to 2>"
```

The Thursday shift is what makes the year correct for weeks straddling New
Year. The key sorts lexically, which for this format is chronological.

### Month and day keys

```
monthKey(date) = "<UTC year>-<UTC month + 1, zero-padded>"
dayKey(date)   = first 10 characters of the ISO string   ->  "2026-08-24"
```

Both sort lexically as chronological, same as the week key. Monthly buckets use
real calendar months; this is the one place calendar boundaries are used.

### Backlog age buckets

One list, in `src/panels/analytics.js`, imported by every panel that buckets by
age so the org total always equals the sum of the repos:

| Bucket | Condition |
|---|---|
| `< 1 week` | age < 7 days |
| `1–4 weeks` | 7 ≤ age < 30 |
| `1–3 months` | 30 ≤ age < 90 |
| `3–12 months` | 90 ≤ age < 365 |
| `> 1 year` | age ≥ 365 |

Bucketing takes the **first** bucket whose `max` the value is strictly less
than; anything past the last bucket falls into it. Ages are whole days,
`floor((now − timestamp) / 86,400,000)`.

The same list buckets by *staleness* (days since last update) as well as by age,
on the cards that offer both.

### Age and staleness

```
ageDays(x)   = floor((now − x.createdAt) / 86,400,000)
staleDays(x) = floor((now − x.updatedAt) / 86,400,000)   # null if no updatedAt
```

`now` is the build's start time, not the reader's clock — every age on a page is
as of the last build.

---

## What the stores contain

Several numbers are decided at ingest time and merely counted later. If one of
these derivations is wrong, no amount of reading the panel code will show it.

### Traffic views and clones

`src/ingest/traffic.js`.

**Shows** — how many times a repo was viewed and cloned, per day.

**Rule** — `GET /repos/{repo}/traffic/views` and `/traffic/clones`, both of which
return the whole retained window on every call. Each datapoint's `timestamp` is
truncated to its `YYYY-MM-DD` UTC date and stored as one row per repo per day,
carrying `views`, `viewUniques`, `clones`, and `cloneUniques`.

**The store is keyed, not appended.** Every row is identified by `repo + date`,
and a later reading of a day replaces the earlier one rather than adding to it.
This is what makes the job safely re-runnable: successive runs overlap by
thirteen days and collapse to nothing.

**The current day is discarded.** GitHub counts today as it goes, so capturing
it would store a partial number that only gets corrected if another run happens
before midnight UTC. Rows only exist for days that have closed.

**Yesterday can still arrive late.** GitHub's aggregation lags by some hours, so
the most recent closed day is sometimes missing or zero at capture time. The
next run overwrites it with the settled figure, so this self-heals — but a row
read within a day of capture may be low.

**A day with no traffic has no row.** GitHub omits datapoints for days a repo saw
nothing, so absent and zero mean the same thing and neither is stored as a gap.
Consequently the row count is well below `repos × days`.

**Uniques do not sum.** `viewUniques` counts distinct visitors within one day.
Adding a week of daily uniques counts a returning visitor once per day they
appeared, so the result is an upper bound on weekly reach, not a headcount. Only
`views` and `clones` are safely additive across days.

**Clones are not people.** A single CI job cloning in a loop can put six figures
of clones against a few dozen uniques. Where the two diverge sharply the traffic
is automated, and the useful signal is `cloneUniques`.

**Excluded repos are absent entirely**, per `NH_INGEST_EXCLUDE` — they are never
requested, so their traffic is not merely hidden but never collected, and cannot
be backfilled later.

### First response on an issue

`src/ingest/issues.js` (GraphQL path) and `src/ingest/issuesBulk.js` (REST bulk
path).

**Shows** — when a human other than the reporter first said something.

**Rule** — walk the issue's comments in creation order and take the first whose
author is not null, not the issue's author, and not a bot. Record its timestamp
as `firstResponseAt` and its author as `firstResponder`.

**The sample limit** — the GraphQL walk fetches `COMMENT_SAMPLE = 10` comments
per issue. If those ten contain no qualifying reply *and the issue has more than
ten comments*, the record is stamped `responseUnknown: true`. That is a third
state, and it is neither "answered" nor "unanswered" — such issues are dropped
from **both** sides of every answered/unanswered figure rather than counted as
silence.

The REST bulk path streams every comment in the repo, so it always knows the
true first reply and never sets `responseUnknown`. It keeps up to three distinct
early commenters per issue (`CANDIDATES = 3`) because the reporter replying to
themselves twice before anyone else speaks is common; the reporter is filtered
out at merge time.

**Consequence** — median first-response times are computed over issues that have
a known response only. An issue nobody ever answered contributes to
`neverAnswered`, not to the median.

### Who closed an issue, and what closed it

`closure()` in `src/ingest/issues.js`, read through `closerOf` / `fixerOf` /
`closingPR` in `src/panels/issueMetrics.js`.

Two people can reasonably be said to have closed an issue and the dashboard
counts both, separately:

- **`closedBy` / "the closer"** — the actor on the last `CLOSED_EVENT` in the
  issue's timeline. Whoever pressed the button.
- **`closedVia` / "the fixer"** — if the close event names a closing pull
  request, that PR's author. Whoever wrote the fix.

`last: 1` on the timeline query means an issue closed and reopened several times
yields only the close that stuck.

**`closerKnown`** is the honesty flag. The GraphQL walk always asks, so it writes
`true`. The REST bulk path *cannot* ask — REST returns `closed_by` only when
fetching one issue at a time — so it writes `false`. Any closed record without
`closerKnown === true` is counted as `unknownCloser`, never as "closed by
nobody". Every card showing a close count also shows this figure so a
half-backfilled store reads as incomplete rather than as a team that does no
triage.

### Close reason

GitHub's `stateReason`, passed through. `UNRESOLVED = {NOT_PLANNED, DUPLICATE}`;
everything else — including `null` — counts as completed.

The null branch is counted separately as `unknownReason` so the assumption is
visible if it ever fires. GitHub appears to have backfilled `COMPLETED` onto
issues closed before the field existed, so it currently never does.

New close reasons GitHub adds later will fall into "completed" until this set is
updated. That fails towards the flattering answer, which is worth knowing.

### Approvals

One approval per reviewer per PR, dated to that reviewer's **earliest**
approval. Re-approving after a round of requested changes is one act of review,
not two.

The exception is the review queue on a contributor drilldown, which takes each
reviewer's **latest** verdict instead — it is answering "where does this review
stand", and there only the newest verdict is still true.

`reviews(first: 50)` caps how many reviews are fetched per PR. Anything beyond
that sets `reviewsTruncated`, the contributors panel counts how many records
carry it, and the build prints a warning. Approval counts on those PRs are
slightly under.

### Labels

The GraphQL issue walk fetches `LABEL_SAMPLE = 15` labels per issue and sets
`labelsTruncated` if there were more. The REST bulk path returns all of them and
never truncates. PR labels are `labels(first: 10)`.

### Reactions

Issue reactions are **not** ingested at all. Three aggregate counts per issue is
150 aggregations on a 50-issue page, and GitHub's abuse limit refused that query
on the org's largest tracker on every attempt. Consequently:

- PR 👍/👎 lists exist (PR reactions *are* ingested)
- Issue 👍/👎 lists do not exist; issue engagement is comment count only

### Search-backed panels are capped at 1,000

`searchIssues()` in `src/github/client.js` pages the Search API to a hard ceiling
of 1,000 results — GitHub's limit, not ours. A query matching more prints a
warning at build time. No current panel comes close, but if one ever does, its
counts are a floor.

---

## Pull request metrics

All from `src/panels/analytics.js`, over the ingested PR store.

### Totals (all time, not windowed)

| Figure | Rule |
|---|---|
| `prs` | Every PR record with a `createdAt` |
| `merged` | `mergedAt` is set |
| `open` | No `mergedAt` and `state == OPEN` |
| `closed` | Everything else — no `mergedAt`, not open |
| `approvals` | Sum over PRs of the count of distinct non-bot approvers |
| `contributors` | Distinct non-bot PR authors, all time |
| `repos` | Distinct repos with at least one PR |
| `firstPR` | Earliest first-PR timestamp across all authors |

`merged + open + closed = prs` holds by construction: the three branches are
exclusive and exhaustive.

### Time to merge

**Shows** — hours from a PR being opened to being merged.

**Numerator** — `(mergedAt − createdAt) / 3,600,000`, collected for every merged
PR in the period.

**Denominator** — none; this is a distribution. `medianMergeHours` is `pct(·,50)`
of it and `p90MergeHours` is `pct(·,90)`.

**Excluded** — PRs never merged contribute nothing. Bots are *not* excluded; a
bot's PR still took the time it took.

**Empty case** — null, with `mergeN` reporting the sample size beside it.

**Which window** — the sample is attributed to the window containing `mergedAt`.

> **Watch this one.** The *window rollup* dates a merge-time sample by
> `mergedAt`, but the *time series* buckets pushes the same sample into the
> bucket containing `createdAt` — see [Time series
> buckets](#time-series-buckets). So a bucket's `mergeMedianH` answers "PRs
> opened this week took N hours to merge" while the KPI tile's
> `medianMergeHours` answers "PRs merged this period took N hours". Those are
> different questions and they will not agree. If a chart point and a tile
> disagree, this is almost always why.

### Time to first review

**Shows** — hours a PR author waited for anyone to look at their diff.

**Numerator** — `(firstReviewAt − createdAt) / 3,600,000`.

`firstReviewAt` is the earliest `submittedAt` among reviews whose author is not
a bot and **not the PR's own author**. Verdict is irrelevant — a review
requesting changes is still a review. Self-reviews do not count.

**Empty case** — null; `reviewN` reports the sample size.

**Which window** — attributed to the window containing `createdAt`, not the
review date. This is the one deliberate exception to "count against your own
timestamp": the metric is a property of the PR's opening, and the analytics
series buckets it with `opened`.

### Merge rate

```
mergeRate = merged / (merged + closed)          # null when both are 0
```

**Denominator is PRs that reached a terminal state in the period.** Still-open
PRs have no outcome yet and are excluded from both halves — they are not counted
as failures.

`merged` and `closed` here are the per-period counts, each dated by its own
event, so a PR opened last year and merged this month contributes to this
month's numerator.

### Approved share, and unapproved merges

```
approvedShare    = mergedWithApproval / merged   # null when merged = 0
unapprovedMerges = merged − mergedWithApproval
```

`mergedWithApproval` counts merged PRs that had **at least one** non-bot
approval at any point, not necessarily before the merge. A PR approved after
merging still counts. That is a known looseness; in practice it is rare enough
not to move the number.

Both are dated by `mergedAt`.

### Review concentration

```
reviewConcentration = (sum of the top 5 reviewers' approval counts)
                    / (sum of all reviewers' approval counts)
```

**Shows** — how much of the reviewing is done by how few people. A high number
means the org has a bus problem regardless of how healthy the medians look.

**Excluded** — bots. **Empty case** — null when nobody approved anything.

Ties at the fifth position are broken arbitrarily by sort order; with five slots
out of a reviewer pool this size that has no visible effect.

### PR size

```
lines(pr)     = pr.additions + pr.deletions
medianPRLines = pct(sorted lines, 50)
p90PRLines    = pct(sorted lines, 90)
linesChanged  = sum of additions + sum of deletions
```

**Critically**: a PR whose `additions` is not a number — a record ingested
before diff fields were queried — is **skipped entirely**, not added as zero.
`sizedPRs` reports how many PRs actually contributed. A half-backfilled store
therefore reports a smaller *sample*, not a smaller codebase.

Diff size and commit counts are attributed to the window containing
`createdAt`, so "lines per PR" divides two numbers describing the same set of
PRs.

`changedFiles` is carried but not aggregated into any headline figure; it exists
so an implausible line count can be checked against a file count.

### Active authors, reviewers, repos, new contributors

| Figure | Rule |
|---|---|
| `activeAuthors` | Distinct non-bot logins that opened a PR in the period |
| `activeReviewers` | Distinct non-bot logins that gave a first approval in the period |
| `activeRepos` | Distinct repos with a PR opened in the period |
| `newContributors` | PRs opened in the period that were that author's first ever |

"First ever" is decided in a pass before bucketing: for each non-bot author,
find the PR with the earliest `createdAt`, breaking ties on `repo#number`
lexically. A PR is somebody's first if it *is* that PR.

The tie-break on the identifier rather than on the timestamp is load-bearing.
GitHub stamps to the second, so two PRs opened in the same second would both
match a timestamp comparison and both count as somebody's first — which is how
the issue side once reported more first-time reporters than reporters.

### Open backlog

Built from PRs where `state == OPEN` and `mergedAt` is unset.

| Figure | Rule |
|---|---|
| `total` | Count of open PRs |
| `unreviewed` | Open PRs with no `firstReviewAt` — nobody but the author has spoken |
| `buckets` | Open PRs bucketed by `ageDays` against the shared bucket list |
| `oldest` | The 25 highest `ageDays`, descending |

Not windowed. "Open right now" is a statement about now.

### Time series buckets

Emitted at three granularities — `day`, `week`, `month` — with the same fields.
Each PR contributes to **two** buckets:

1. The bucket containing `createdAt` gets `opened`, the author added to the
   distinct-author set, `newAuthors` if it was their first, and the PR's merge
   and review latencies pushed onto that bucket's samples.
2. The bucket containing the PR's *end* — `mergedAt`, or `updatedAt` if closed
   unmerged — gets `merged` or `closed`.

So within a single bucket, `merged` is **not** a subset of `opened`. A bucket
can show 10 opened and 14 merged.

Per-bucket outputs:

| Field | Rule |
|---|---|
| `opened`, `merged`, `closed` | Counts as above |
| `authors` | Size of the distinct non-bot author set |
| `newAuthors` | First-ever PRs opened in the bucket |
| `mergeMedianH`, `mergeP90H` | Percentiles over that bucket's merge-hour sample |
| `reviewMedianH` | Median over that bucket's first-review-hour sample |
| `mergeN`, `reviewN` | Sample sizes, so a wild median can be spotted as a small one |
| `t` | Earliest timestamp seen in the bucket, for sorting |

**Daily buckets only reach back `DAY_SERIES_DAYS = 730` days.** An all-time
daily series would be ~4,300 buckets in a file committed on every build. The
payload carries `series.dayFrom` and the frontend says so rather than quietly
plotting a shorter span than the control promised.

### Activity heatmap

A 7 × 24 grid of PR-creation counts: `heat[weekday][hour]`, where weekday is
`(UTC day of week + 6) mod 7` so Monday is row 0, and hour is the UTC hour.

**Excluded** — bots, and anything older than 365 days. Not affected by the
window control.

Cell shading is `count / max(all cells)`, computed in the browser.

### Most grossing

`src/panels/grossing.js`. Three all-time ranked lists — most commented, most 👍,
most 👎.

```
topGrossing(entries, field, n):
  keep entries where entries[field] > 0
  sort descending by field, ties broken by descending PR number
  take first n
```

**All-time, never windowed.** A window-keyed top 5 across three kinds and seven
windows is roughly 9 MB across the org's repos, to slice a list whose whole
appeal is that it is the hall of fame — and it would leave the 1-month view as
three empty boxes on most repos, since the median PR draws no reaction at all.

Zero-count entries are dropped rather than padding the list to `n`. A list
padded to five with 0-comment PRs claims a ranking that isn't there.

`n` is 5 on a repo drilldown and 10 on the org-wide Analytics card, because a top
5 across 1,400 repos is almost entirely one repo's greatest hits.

Ties break on PR number so the output is identical across builds rather than
reordering with whatever the store happened to yield first.

---

## Contributor metrics

`src/panels/contributors.js`, plus `src/panels/activeDays.js` for the active-day
half.

### Per-window counts

For each person and each window:

| Field | Counted when | Dated by |
|---|---|---|
| `prs` | They opened a PR | `createdAt` |
| `merged` | A PR of theirs was merged | `mergedAt` |
| `approvals` | They approved a PR | their earliest approval's `submittedAt` |

The bump rule is `ageDays = (now − timestamp) / 86,400,000`, and the event is
added to every window where `days == null or ageDays ≤ days`. Note this is `≤`,
where the analytics panel's period test is `≥ from` — the boundary differs by
one clock tick between the two panels, which is immaterial at day granularity
but is the kind of thing worth knowing before chasing an off-by-one.

`firstSeen` and `lastSeen` are the min and max of every timestamp that ever
bumped that person, so they cover PRs, merges and approvals but **not** issue
activity. The drilldown's `first`/`last` do include issues; those two dates can
legitimately differ for a triager.

### Leaderboard ordering

Rows sort descending by `all.prs + all.approvals`. This is a sum of acts, not a
score — filing a PR and approving one are both work, and weighting them against
each other would invent a judgement the data cannot support.

Rows are filtered by `all.prs + all.approvals ≥ CONTRIBUTOR_MIN_ACTIVITY`, which
is 0 by default. The useful filtering happens in the browser as a slider.

### Active days

`src/panels/activeDays.js`. Shared by the Leaderboard column and the contributor
drilldown tile so the two pages cannot disagree about the same person.

**A day worked** is a calendar day (UTC, `YYYY-MM-DD`) on which the person did
at least one of:

- opened a pull request
- submitted a review of **any** verdict, not just an approval
- filed an issue
- was the first responder on an issue
- closed an issue (pressed the button)
- authored the pull request that closed an issue

**Not a day worked**: their own PR being merged by somebody else. That is a day
*they* had, not a day they worked, and counting it would credit people for other
people's Tuesdays.

The day set is deduplicated, so five PRs in one afternoon is one day.

**The denominator is the load-bearing part:**

```
fixed window:  days  = count of active days ≥ (today − N)
               denom = N

all time:      days  = count of all active days
               denom = (today − their first active day) in days, + 1
```

**Every period runs to today, never to the person's last active day.** The first
version divided by `last − first`, which freezes the clock the day somebody
stops, so leaving is invisible to the arithmetic: somebody who opened four PRs
in one afternoon of 2023 and never came back had a one-day span, scored 100%,
and outranked a decade of work. Over half the people in the store are that
contributor. Running the denominator to today puts the gap since their last
commit *in* the denominator, where it grows every day they stay away.

The denominator ships with the count rather than being recomputed in the
browser, precisely so a second implementation cannot drift. `days ≤ denom` holds
by construction, so the share cannot exceed 100%.

Rendered as `activeShare = activeDays / denom` — see `activeShare()` in
`web/js/format.js`, which reads `activeSpan` on a drilldown record and
`activeDenom` on a leaderboard row. Two field names, one meaning.

### Gone quiet

Browser-side, in `web/js/modules/people.js`. Contributors where
`all.prs + all.approvals ≥ 20` **and** days since `lastSeen` > 180. Both
thresholds are hardcoded in that module, not configurable.

### New faces

Contributors whose `firstSeen` is within the card's own window. This card keeps
a period separate from the page's, because "who's new" and "who's busiest" want
different spans by nature.

---

## Issue metrics

Definitions live once in `src/panels/issueMetrics.js` because three places
aggregate the issue store — the org panel, the repo drilldown and the person
drilldown — and they have to agree.

### Tracker-shaped rollup

The shape used when the subject is a thing issues happen *to* (the org, or one
repo).

| Metric | Formula | Notes |
|---|---|---|
| `opened` | Count of issues created in the period | |
| `closed` | Count of issues closed in the period | Dated by `closedAt` |
| `completed` | Closed with `stateReason` not in {NOT_PLANNED, DUPLICATE} | Includes null reason |
| `notPlanned` | Closed with `stateReason == NOT_PLANNED` | |
| `duplicate` | Closed with `stateReason == DUPLICATE` | |
| `unresolved` | `notPlanned + duplicate` | The closes that resolved nothing |
| `net` | `opened − closed` | Positive means the backlog grew |
| `completedShare` | `completed / closed` | Null when `closed == 0` |
| `medianCloseHours` | `pct(closeHours, 50)` | `closeHours = (closedAt − createdAt) / 3.6e6` |
| `p90CloseHours` | `pct(closeHours, 90)` | |
| `medianFirstResponseHours` | `pct(responseHours, 50)` | `responseHours = (firstResponseAt − createdAt) / 3.6e6` |
| `p90FirstResponseHours` | `pct(responseHours, 90)` | |
| `labeledShare` | `labeled / opened` | Over issues **opened** in the period |
| `unlabeled` | `opened − labeled` | |
| `answeredShare` | `answered / (answered + unanswered)` | See below |
| `neverAnswered` | `unanswered` | |
| `reporters` | Distinct non-bot authors of issues opened in the period | |
| `newReporters` | Issues opened that were that author's first ever | Same tie-break rule as PRs |
| `responders` | Distinct non-bot first responders in the period | |
| `responses` | Total first replies given in the period | |
| `closers` | Distinct people who pressed close in the period | |
| `closedByPR` | Closes where a pull request did the closing | |
| `closedByHand` | Closes with a known actor and no closing PR | |
| `unknownCloser` | Closes the store cannot attribute | The honest denominator for the two above |
| `assignees` | Distinct non-bot assignees on issues opened in the period | |
| `comments` | Sum of comment counts on issues opened in the period | |
| `closedN`, `respondedN` | Sample sizes behind the medians | |

**`net` is deliberately a difference, not a ratio.** "12 more than we closed" is
a number you can act on; "1.04" is not.

**`answeredShare`'s denominator is not `opened`.** It is `answered + unanswered`,
which excludes `responseUnknown` records — issues whose comment sample was
exhausted without finding a human reply. Those are genuinely undecided and are
dropped from both halves rather than counted as silence. So on a store with many
such records, `answered + unanswered < opened`.

`closedByPR + closedByHand + unknownCloser = closed` holds by construction.

### Person-shaped rollup

The shape used when the subject is somebody doing things *to* issues. Four
distinct jobs, kept apart: filing, answering, closing, and fixing with a PR.
Someone who only triages and someone who only writes fixes both look busy on
this org, and a single "issues" number would describe neither.

| Metric | Formula |
|---|---|
| `filed` | Issues they opened in the period |
| `filedOpen` / `filedClosed` | Of those, still open / closed |
| `filedCompleted` / `filedUnresolved` | Of the closed ones, by close reason |
| `acceptedShare` | `filedCompleted / filedClosed` |
| `filedLabeledShare` | `filedLabeled / filed` |
| `filedAnswered` / `filedUnanswered` | Their reports that got a reply / never did |
| `answeredShare` | `filedAnswered / (filedAnswered + filedUnanswered)` |
| `commentsReceived` | Sum of comments on issues they filed |
| `medianWaitHours`, `p90WaitHours` | Percentiles of how long **their own** reports waited for a reply |
| `responses` | First replies they gave to somebody else, dated by the reply |
| `medianResponseLagHours`, `p90ResponseLagHours` | How old the issue was when they replied |
| `closed` | Closes where they pressed the button, dated by `closedAt` |
| `closedCompleted` / `closedUnresolved` | Of those, by close reason |
| `closedOwn` | …of their own issues, which is not triage |
| `closedForOthers` | `closed − closedOwn` |
| `closedByTheirPR` | Closes where they pressed the button *and* their PR did the fixing |
| `closedByHand` | Closes they pressed where no PR was the closer |
| `medianCloseLagHours`, `p90CloseLagHours` | How old the issues were when they closed them |
| `fixed` | Issues closed by a PR they authored, whoever pressed the button |
| `assigned` / `assignedOpen` | Issues they were assigned, and how many are still open |
| `triage` | `responses + (closed − closedOwn)` |
| `involvement` | `filed + responses + closed + fixed` |
| `repos` | Distinct repos they touched an issue in, any way |
| `filedRepos` | Distinct repos they filed in |
| `helped` | Distinct other reporters they answered or closed for |

**`acceptedShare` is a property of the reports, not the person.** A good bug
report about a mod nobody maintains still ends up not-planned.

**`triage` and `involvement` are sums of acts, not scores.** No weighting is
applied between filing, answering and closing, because weighting them would
invent a judgement the data cannot support. They exist to rank a leaderboard by,
and a leaderboard ranked by a sum of acts is honest about what it is.

**A person can be several things at once on one issue** — reporter and closer is
common — and every branch is independent, so they are credited in each. The
`_iclosed` log emits **one row** per close whether they pressed the button,
wrote the PR, or both; the row says which. Two rows for one close would
double-count the log against the counts beside it.

**Assignment carries no date of its own**, so it is dated by the issue's
`createdAt`. An assignment made today on a five-year-old issue lands in the
five-year-old window.

### Label groups

Label names on the modpack follow `Prefix: Value`. Splitting is by the regex
`^([A-Za-z0-9][A-Za-z0-9 ]*):\s*(.+)$` — anything not matching is grouped as
`Other` with the whole name as its short form.

Groups sort by `GROUP_ORDER = [Status, Bug, Type, Platform, Mod, Other]`, then
alphabetically for anything unlisted, then by descending open count, then by
descending total.

Label stats are keyed by **repo and name**, never name alone. Labels are a
per-tracker taxonomy; an org-wide sum of "Bug: Minor" across trackers that mean
different things by it means nothing. See the browser-side note on combining
them.

### Issue triage snapshot

Not windowed — a statement about right now. Over all open issues:

| Figure | Rule |
|---|---|
| `open` | Count of open issues |
| `unlabeled` | Open with no labels |
| `unanswered` | Open where `isUnanswered` — no `firstResponseAt` **and** not `responseUnknown` |
| `unassigned` | Open with no assignees |
| `stale` | Open where `staleDays ≥ ISSUE_STALE_DAYS` (90) |
| `ageBuckets` | Open bucketed by `ageDays` |
| `staleBuckets` | Open bucketed by `staleDays` |
| `oldest` | 40 highest `ageDays` |
| `quietest` | 40 highest `staleDays` |
| `ignored` | Unanswered open issues, 40 highest `ageDays` |

`ISSUE_STALE_DAYS` is 90 rather than 30: on a modpack this size a bug report
going quiet for a month usually means it is queued behind a release, not that it
was dropped.

### Per-repo issue stats

| Figure | Rule |
|---|---|
| `total`, `open`, `closed` | All-time counts for that repo |
| `unanswered`, `unlabeled`, `unassigned`, `stale` | Counted over **open** issues only |
| `closedByPR` | All-time closes with a closing PR |
| `prShare` | `round3(closedByPR / closed)`, null when `closed == 0` |
| `reporters`, `closers` | Distinct non-bot logins, all time |
| `medianCloseHours`, `medianFirstResponseHours` | Medians over the repo's full history |
| `last` | Max `updatedAt` across its issues |

Note the asymmetry: the counts on the left are all-time, the four in the middle
are open-only. That is intentional — "how many unanswered issues are in this
repo" is only a useful question about live ones.

### Issue time series buckets

Same three granularities as the PR series, same `dayFrom` limit of 730 days,
and the same two-bucket rule: an issue contributes `opened` to the bucket
containing `createdAt`, and `closed` to the bucket containing `closedAt`.

| Field | Rule |
|---|---|
| `opened`, `closed` | As above |
| `unresolved` | Closes in this bucket whose reason is NOT_PLANNED or DUPLICATE |
| `net` | `opened − closed`. The only figure on the chart that can go negative, and the one that answers "are we keeping up" |
| `reporters` | Distinct non-bot authors of issues opened in the bucket |
| `newReporters` | First-ever issues opened in the bucket |
| `closeMedianH`, `closeP90H` | Percentiles over close-hour samples |
| `responseMedianH` | Median first-response hours |
| `closeN`, `responseN` | Sample sizes |

The latency samples are pushed into the bucket containing `createdAt`, matching
the PR series and carrying the same caveat: bucket medians are dated by open
date while window medians are dated by the event.

### Most discussed

The 25 issues with the highest comment count, all time, ties broken on
descending issue number so the list is stable across builds. Issues with zero
comments are excluded.

Comment count is the only engagement signal available on the issue side —
reactions were dropped from the ingest query when GitHub's abuse limit refused
them on the org's largest tracker.

### Per-label monthly series

Only for `ISSUE_LABEL_REPO` (the modpack), only for labels with
`total ≥ SERIES_MIN` (20), only for the last `SERIES_MONTHS` (60) months.
Cutoff is computed as `now − 60 × 30.4 days`, truncated to a `YYYY-MM` key.

Each cell is `[opened, closed]` for that label in that month, keyed by the
month the issue was opened and the month it was closed respectively. Months with
nothing in them are absent, not zero.

Labels are a per-tracker taxonomy and the modpack is the only tracker with
enough volume for a trend to mean anything; the other repos' label *counts* are
still there behind the picker.

### By-contributor table cap

`PEOPLE_CAP = 200` rows per window, ranked by `involvement` descending. The
store holds roughly 6,400 distinct issue participants, nearly all of them
someone who filed one bug years ago. Anyone who falls off the table still has a
complete record on their own drilldown.

If the table is at its cap, the card says `top 200 of N` rather than implying it
is the whole population.

---

## Drilldown metrics

`src/panels/drilldown.js`. One record per contributor, one per repo. The PR-side
window summary is the same shape and same arithmetic as the analytics panel's —
`mergeRate`, `approvedShare`, `medianMergeHours`, `medianPRLines` and the rest
are computed identically, so a repo's numbers roll up into the org's.

Differences worth stating:

### `people` means different things by subject type

The `people` field on a window is a distinct-set size, and which set depends on
the subject:

- On a **repo**: distinct non-bot authors who opened a PR here in the window
- On a **contributor**: distinct repos they opened a PR in

Same field name, two questions. The frontend labels them differently
("Contributors" versus "Repos touched") but the payload does not.

Likewise `reviewers`:

- On a **repo**: distinct logins who approved a PR here
- On a **contributor**: distinct PR *authors* they approved for

### Empty windows are omitted

A window with `opened == merged == closed == approvals == 0` is left out of the
payload entirely rather than emitted as zeroes. The frontend substitutes a blank
window, which is what a zeroed record would have said. Same rule on the issue
side, where the emptiness test is `involvement` and `assigned` for a person, and
`opened`, `closed` and `responses` for a repo.

So an absent window means "nothing happened", never "data missing".

### Slim records

A contributor gets a full record if any of these hold — `substantial()`:

- they have opened at least one PR, **or**
- given at least one all-time approval, **or**
- have an open PR, **or**
- given at least one first response, **or**
- closed at least one issue, **or**
- fixed at least one issue with a PR, **or**
- been assigned an issue, **or**
- filed **three or more** issues, **or**
- have anything in their review queue or assignment log right now

Everyone else gets a slim record: name, dates, active-day figures and their
filed-issue log, with no monthly series, ranked-repo maps or partner lists. They
are still counted in every aggregate — repo reporter lists, org tables — and
still get a page. A ranked list linking to a page that does not exist is worse
than either option.

The threshold of three filed issues is the only arbitrary number here; it is
where "filed enough to have a pattern" was drawn.

### Search index ranking

The combobox list is ranked by:

- **Contributors**: `totalPRs + all-time approvals + issue involvement`, where
  issue involvement is `filed + responses + closed + fixed`
- **Repos**: `totalPRs + total issues filed`

Issue involvement is *in* the contributor ranking rather than beside it because
a full-time triager has no PRs and no approvals, and ranking on those two buried
the people doing the most visible work in the org below everyone who ever opened
a one-line fix.

### Monthly series

PR series are **padded**: every calendar month from the subject's first bucket
to now gets an entry, with quiet months as `null` (which rehydrates to zeroes).
Months before the subject existed are not invented — a repo created last March
does not show a year of flat zeroes leading up to it.

Issue series are **sparse**: only months with something in them appear. Issue
subjects are dominated by "one bug report, once", for which padding costs ten
times what the data does. The frontend fills the gaps when it draws.

`SERIES_MONTHS = 240` is a ceiling, not a floor.

### Partner lists

`reviewedBy`, `reviewsFor`, `helped`, `helpedBy` are **all-time only**, never
windowed. They describe a relationship, and slicing a relationship by window
mostly produces noise.

- `reviewsFor` — counts of PR authors whose PRs this person approved, excluding
  self-approvals and bot-authored PRs
- `reviewedBy` — the mirror
- `helped` — reporters this person answered, closed for, or fixed for, excluding
  their own issues and bot-filed ones
- `helpedBy` — the mirror

### Backlogs

A subject's PR backlog is null rather than an object of zeroes when nothing is
open. Additional fields beyond the org backlog:

| Field | Rule |
|---|---|
| `drafts` | Open PRs where `draft === true` |
| `draftsKnown` | True only if **every** open PR has a non-null draft flag |

`draftsKnown` distinguishes "no drafts" from "the ingest has not been asked
about draft status yet". Records ingested before `isDraft` was queried carry
null, and null must not render as false.

The oldest-first list is emitted **in full**, not truncated. Truncating it made
the Backlog tab's own filter lie about what it had searched.

### Field coverage

`prFieldCoverage` counts, over the whole PR store, how many records carry fields
the ingest added later:

| Field | Counted over |
|---|---|
| `reviewRequests` | Open PRs only — requests are deleted by GitHub when the review lands |
| `assignees` | All PRs — assignment survives the close |
| `labels` | All PRs |

Each is checked against the population it is meaningful over, and only when that
population is non-empty. An org with no open PRs would otherwise be told forever
that its review-request backfill had not run.

`closerCoverage` does the same job for issues: `{closed, unknown}` over the whole
store.

---

## CI health metrics

`src/panels/ciHealth.js`. The one panel that asks the API rather than reading a
store.

**The sample** is the most recent `CI_RUN_SAMPLE = 20` **completed** workflow
runs on each repo's **default branch**, with `exclude_pull_requests=true`.

That sampling frame is the biggest caveat on this whole section: PR-triggered
runs are excluded outright, and on most repos those are the majority of all CI
activity. Every number below is a floor.

### Pass rate

```
decisive = runs whose conclusion is in {success, failure, timed_out, startup_failure}
passes   = decisive runs whose conclusion is "success"
passRate = passes / decisive                  # null when decisive == 0
failures = decisive − passes
```

`cancelled`, `skipped` and `action_required` are excluded from **both** halves.
They say something about the humans, not the code — counting them as failures
would make every repo where somebody cancels a slow run look broken.

Null rather than 0 when nothing was decisive: "no verdict" and "all red" are
very different and must not render the same.

### Run duration

```
duration(run) = (updated_at − (run_started_at or created_at)) / 60,000   minutes
```

Kept only if finite and non-negative. `medianMinutes` is the middle element of
the sorted list — note this uses `s[floor(length/2)]`, a plain midpoint, not the
shared `pct()` helper. On an even-sized sample it takes the upper middle, same
as `pct` would.

`totalMinutes` is the sum over the sampled runs; `timedRuns` is how many
contributed. A run missing a usable timestamp contributes nothing and is not
counted in the denominator.

**This is wall-clock time, not GitHub's billable minutes.** Billing is per job: a
matrix of eight jobs in parallel bills roughly eight times what the run took on
the clock, macOS bills 10×, Windows 2×. The only endpoint giving the real figure
is one request per run — roughly 4,000 per build — for a number nobody is going
to reconcile against an invoice.

### Sample span

```
sampleSpanDays = (newest run start − oldest run start) / 86,400,000
```

Null when there are fewer than two runs, or when the span is not positive. A
single timestamp has no width, and dividing by zero days would report an
infinite rate for the least active repos in the org.

The sample is "the last 20 completed runs", so the span it covers is **not** a
fixed period. A busy repo's 20 runs might be two days and a quiet one's might be
two years. Recording the span is what lets a sample become a rate.

### Org-wide projection

Per repo, skipping any repo with no `sampleSpanDays` or no `timedRuns`:

```
perDay      = runs / sampleSpanDays
meanMinutes = totalMinutes / timedRuns
```

Summed across repos:

```
runsPerMonth    = round( Σ perDay × 30 )
minutesPerMonth = round( Σ perDay × 30 × meanMinutes )
hoursPerMonth   = round1( minutesPerMonth / 60 )
projectedFrom   = how many repos had enough sample width to contribute
```

A "month" is exactly 30 days.

Note `meanMinutes` is a **mean**, the one place a mean is used deliberately —
projecting a total needs an average, and a median times a count is not a total.

Also reported, so the card can show its work:

```
sampledRuns    = Σ runs across all repos
sampledMinutes = Σ totalMinutes
meanRunMinutes = sampledMinutes / sampledRuns       # null when sampledRuns == 0
passRate       = Σ passes / Σ decisive
```

Note that `meanRunMinutes` divides by `sampledRuns` while each repo's own mean
divides by `timedRuns`. Runs missing timestamps therefore drag the org-wide mean
slightly down relative to the per-repo ones.

The frontend recomputes the per-repo projection independently in
`web/js/modules/analytics.js` for its "where the time goes" table, using the same
two lines. If that table ever disagrees with the tiles above it, one of the two
copies has drifted.

**What this figure is not:** a bill, a total, or a job count. The runs endpoint
returns runs, not jobs.

---

## Repository state panels

### Needs a release

`src/panels/needsRelease.js`. Four filters, applied in order — cheap ones first,
so an excluded or up-to-date repo never costs a request.

1. **Sweep** — every non-archived repo in the org, ordered by `pushedAt`
   descending, stopping at the first repo pushed longer ago than
   `STALE_REPO_CUTOFF_DAYS` (365). Since the order is descending, the first
   stale repo means every repo after it is stale too.
2. **Candidate test** — a repo is a candidate if it has a non-draft release
   (prereleases count — a repo that just cut an rc is not "needing a release")
   whose tag commit SHA differs from the default branch's HEAD SHA.
3. **Commit count** — a REST `compare` between tag and HEAD gives `ahead_by`.
   Repos with `ahead_by < RELEASE_COMMIT_THRESHOLD` (1) drop out.
4. **PR test** — a candidate survives only if **at least one commit in the
   range has a pull request attached**. Buildscript bumps and workflow edits go
   straight to the default branch and nobody is waiting on a release for those;
   anything that does want one arrives as a PR.

```
daysSinceRelease = floor((now − release.publishedAt) / 86,400,000)
```

Results sort by `commitsAhead` descending.

**Failure handling**: if the `compare` call fails — a force-push or deleted tag
can orphan the base commit — the repo stays in the list with `commitsAhead:
null` and skips the PR test, rather than being dropped on a guess.

Repos matching `RELEASE_EXCLUDED_REPOS` (glob patterns, `!` re-includes, later
rules win, case-insensitive) are filtered before the compare call, so an
excluded repo costs nothing.

### Dep updates

`src/panels/depUpdates.js`. **This panel is an explicit proxy and the card says
so.**

**What it actually measures**: the newest commit on the default branch that has
**no pull request attached** and (with `DEP_UPDATE_IGNORE_BOTS` on) was not
authored by a bot.

**What it claims to measure**: how long since dependencies were touched.

The proxy holds because in this org practically everything arrives as a pull
request, and the things that do not are almost always a maintainer bumping a
dependency straight on the default branch. A repo where somebody pushed a typo
fix directly will read younger than it is.

There is no cheap way to ask GitHub what a commit changed — GraphQL gives a
changed-file *count* and no names, so a real answer costs one REST call per
commit.

```
daysSinceDirect = floor((now − commit.committedDate) / 86,400,000)
```

**Floors**: history is only walked back `DEP_UPDATE_LOOKBACK_DAYS` (365) and at
most `DEP_UPDATE_MAX_PAGES` (10) pages of 100 commits per repo. A repo where the
walk ran out reports `approx: true` and a floor value:

- If the walk reached the lookback horizon (`exhausted`), the floor is 365 —
  every such repo reads the same "≥ 1 yr" rather than a per-repo floor that
  means something different each time
- Otherwise the floor is the age of the oldest commit actually seen

Sort is `daysSinceDirect` descending, then exact answers before approximate
ones, then repo name — among things that cannot be dated exactly, the quietest
is the better guess at worst.

### Search-backed PR panels

`src/panels/pullRequests.js`. No arithmetic beyond age, but the *query* is the
definition:

| Panel | Query |
|---|---|
| Approved, not merged | `org:X is:pr is:open review:approved -is:draft` |
| Changes requested | `org:X is:pr is:open review:changes_requested -is:draft` |
| PRs by label | `org:X is:pr is:open label:"L"` for each managed label |

`review:approved` and `review:changes_requested` reflect the PR's **current**
review state, so "approved and later got changes requested" appears in the
second list and not the first. The two lists are mutually exclusive by GitHub's
definition, not by ours.

`is:open` already implies unmerged: merging closes the PR.

Label list comes from `Label-Sync-GTNH` on every build — adding a label there
makes it appear here on the next run with no code change — capped at
`MAX_TRACKED_LABELS` (40) since each label costs one search request.

---

## Browser-side calculations

Most numbers arrive precomputed. These are the ones the browser derives itself,
and therefore the ones that can disagree with the payload if a bug creeps in.

### Delta arrows

`delta()` in `web/js/data.js`.

```
ordinary metric:  diff = (current − previous) / previous
share metric:     diff = current − previous            # reported in points
```

Rendered flat (`•`) when `|diff| < 0.02` for an ordinary metric or `< 0.005` for
a share. Direction is coloured good/bad by the metric's `invert` flag — for
latency and unapproved merges, down is good.

Returns the fallback when either side is null, or when `previous == 0` on an
ordinary metric (division by zero).

**Note the asymmetry**: a share's delta is a difference in percentage *points*,
not a percentage change of a percentage. `pp: true` at the call site is what
selects that.

### Series slicing

```
seriesSlice:  keep the last  ceil(windowDays / bucketDays)  buckets
sliceMonths:  keep the last  max(1, ceil(windowDays / 30.4))  buckets
```

`bucketDays` comes from the granularity list; monthly slicing uses 30.4 days per
month. A 1-month window over monthly buckets is therefore a single bar —
honest, if sparse.

Slicing is by **bucket count from the end**, not by comparing bucket dates
against a cutoff. A gap in the series shifts what a slice covers.

### Chart scaling

- `niceMax(v)` rounds an axis maximum up to 1, 2, 2.5, 5 or 10 times a power of
  ten, so grid lines land on readable numbers
- Bar widths in horizontal bar lists are `value / max(all values) × 100%`
- The `share` percentage on a bar row is `round(value / sum(all values) × 100)`
  — note this is the sum over the *rendered* rows, so a truncated list's shares
  do not sum to 100% of the underlying population
- Heatmap cell shading is `round(cell / max(all cells) × 100)` as a colour mix
- Head-to-head bars scale against the leading row, `value / rows[0].value × 100%`

### Combining label rows across repos

`labelRows()` in `web/js/data.js`. When more than one repo is selected in the
Label mix card:

- **Counts add.** `open`, `closed`, `total` and `unanswered` are summed across
  repos, and `repos` counts how many trackers use that label.
- **Medians do not, and are set to null.** A median of medians is not a median
  of anything. The table drops those two columns entirely when more than one
  repo is in view rather than printing a plausible fiction.

With exactly one repo selected, the medians are the repo's own and are shown.

### Head-to-head leaders

`leaders()` in `web/js/modules/versus.js`. Returns a **set** of column indexes,
so a tie highlights every tied cell rather than silently picking whoever was
added first.

- Rows with `dir: null` have no leader — nobody is winning at having been here
  since 2015
- Null values never lead; a subject with no data has not won
- Fewer than two real values means no leader is marked
- A row where everybody scores zero has no leader, only a shared blank

### Windowing the drilldown logs

The filed and closed issue logs, and the resolved-PR list, are filtered
client-side by `at >= now − windowDays × 86,400,000`. Each half is windowed by
the only date it has:

- **Open** PRs and issues by their **open** date (via `ageDays ≤ windowDays`)
- **Resolved** PRs by the date they ended, **closed** issues by their close date

That is what the separate Backlog and Closed cards each did, so no row changes
which window it lands in when they are read together.

### Latency chart sample floor

The Review latency chart drops any bucket with `mergeN ≤ 3`. Small samples swing
a median wildly, which is why a daily view of that chart is mostly gaps. The
hint under the chart says so.

### Analytics volume KPIs

Computed over the *sliced* series, not from the window rollup:

```
"Opened in range"  = Σ opened over visible buckets
"Merged in range"  = Σ merged over visible buckets
"…% of opened"     = Σ merged / Σ opened
"Peak <gran>"      = max opened across visible buckets, and which bucket
```

Because merges and opens are bucketed by different dates, "merged in range" can
exceed "opened in range" and the share can exceed 100%. That is not a bug; it
means the period closed out more than it took in.

---

## Known biases and blind spots

Collected in one place so an auditor does not have to reconstruct them.

**Toward flattery**

- New `stateReason` values GitHub adds will count as "completed" until the
  `UNRESOLVED` set is updated
- `approvedShare` counts an approval given *after* the merge as an approval
  before it
- Dep updates reads a direct typo-fix commit as a dependency update, making a
  repo look fresher than it is

**Toward pessimism**

- CI figures exclude PR-triggered runs entirely — a floor, not a total
- `reviewsTruncated` PRs undercount approvals
- Search-backed panels cap at 1,000 results
- Any close the store cannot attribute lands in `unknownCloser`, so
  `closedByHand` reads low on a half-backfilled store

**Neither, but easy to misread**

- Within any one bucket or window, `merged` is not a subset of `opened` — the
  two are dated by different events
- A series bucket's `mergeMedianH` is dated by open date, while the KPI tile's
  `medianMergeHours` is dated by merge date; the two will not agree and neither
  is wrong
- `net` on a monthly bucket is the only chart figure that can go negative
- `people` and `reviewers` on a drilldown window mean different things on a repo
  than on a contributor
- Medians are nearest-rank, so on an even sample they are the upper middle value
  rather than a mean of two
- All-time percentile figures are over the whole store, so they move very
  slowly and a recent regression is invisible in them
- `firstSeen`/`lastSeen` on the Leaderboard cover PR activity only;
  `first`/`last` on a drilldown include issue activity

**Sampling limits that become wrong answers at scale**

| Limit | Value | What breaks past it |
|---|---|---|
| `COMMENT_SAMPLE` | 10 | Issues open with 10+ bot/self comments record `responseUnknown` |
| `LABEL_SAMPLE` | 15 | An issue with more labels sets `labelsTruncated` |
| `reviews(first:)` | 50 | Approval counts undercount, flagged per record |
| `CI_RUN_SAMPLE` | 20 | Wider sample, same math — safe to raise |
| Search cap | 1,000 | Panel counts become floors, warned at build |
| `MAX_TRACKED_LABELS` | 40 | Labels past the 40th get no PR-by-label card |
| `PEOPLE_CAP` | 200 | Table is a top-200, and says so |
| `ISSUE_TOP_N` | 200 | Drilldown ranked lists truncate at 200 |
| `DAY_SERIES_DAYS` | 730 | Daily charts cannot reach further back, and say so |

---

## Change log

Append an entry whenever a definition changes — not when a number moves because
the data moved. Newest first.

The point of this section is that a figure changing shape between two builds
should be explainable from this file alone.

| Date | Metric | Change |
|---|---|---|
| — | *(initial)* | Document created; describes the pipeline as it stands. |
