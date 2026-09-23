# Calculations

How every figure on the dashboard is measured. Search for the label you see on
screen (the **On screen** lines) or the payload field name.

Each entry names its source file. Entries use this shape where it applies:

| Field | Meaning |
|---|---|
| **Shows** | What the number claims to be |
| **Numerator** | What is counted, and which timestamp dates it |
| **Denominator** | What it is divided by; "none" means it is a count |
| **Excluded** | Left out of both halves |
| **Empty case** | What renders on an empty sample |

**Contents** — [Global conventions](#global-conventions) ·
[Shared primitives](#shared-primitives) ·
[What the stores contain](#what-the-stores-contain) ·
[Pull request metrics](#pull-request-metrics) ·
[Contributor metrics](#contributor-metrics) ·
[Issue metrics](#issue-metrics) ·
[Repo activity metrics](#repo-activity-metrics) ·
[Drilldown metrics](#drilldown-metrics) ·
[CI health metrics](#ci-health-metrics) ·
[Repository state panels](#repository-state-panels) ·
[Browser-side calculations](#browser-side-calculations) ·
[Org Search](#org-search) ·
[Known biases and blind spots](#known-biases-and-blind-spots) ·
[Change log](#change-log)

---

## Global conventions

These hold everywhere unless an entry says otherwise.

### Bots

`BOT_PATTERN` in `src/shared/contributor-rules.js` (re-exported from
`src/config.js`): a login is a bot if it ends in `[bot]`, starts with
`dependabot`, `github-actions`, `renovate`, `codecov`, `mergify` or `stale`, or
is null/empty (deleted accounts). `isBotSql` is the SQL twin, generated from
the same prefix list; the analytics parity test runs both over every login in
the seed.

| Bots excluded from | Bots included in |
|---|---|
| Every author, reviewer, reporter, responder, closer, fixer and assignee count | Raw PR and issue totals |
| Distinct-people sets (active authors, reporters, reviewers) | Merge and close timings |
| First review timestamp (a bot comment is not a review) | Comment and reaction counts (GitHub totals) |
| First response timestamp (a bot reply is not an answer) | Repo activity `opened` and concentration |
| PR-creation heatmap | Org Search |
| Dep updates' last direct commit (`DEP_UPDATE_IGNORE_BOTS`, on) | |

"How many PRs were opened" counts bots; "how many people opened PRs" does not.

### Time windows

`WINDOWS` in `src/panels/contributors.js`, imported by every panel.

| id | Label | Days |
|---|---|---|
| `all` | All time | — |
| `m1` | 1 month | 30 |
| `m3` | 3 months | 90 |
| `m6` | 6 months | 180 |
| `y1` | 1 year | 365 |
| `y2` | 2 years | 730 |
| `y5` | 5 years | 1825 |

```
window    = [now − days × 86,400,000, ∞)        all time = (−∞, ∞)
```

Month = 30 days, year = 365, so "3 months" is 90 days, not a calendar quarter.
Only monthly *buckets* use calendar months.

### Every event is dated by its own timestamp

The most important rule here. An event lands in the window containing the time
*it* happened, not when its parent was created.

| Event | Dated by |
|---|---|
| PR opened | `createdAt` |
| PR merged | `mergedAt` |
| PR closed unmerged | `closedAt`, falling back to `updatedAt` where not backfilled (drilldown uses `updatedAt` only — see Repo activity) |
| Issue opened | `createdAt` |
| Issue closed | `closedAt` |
| First response | `firstResponseAt` |
| Approval | reviewer's `submittedAt` |

So clearing a five-year-old backlog shows entirely in this period's `closed` and
not at all in its `opened`.

### Previous-period deltas

Each fixed window also accumulates the equal-length period before it,
`[now − 2×days, now − days)`; "vs. previous" compares against that. All time has
no previous period, so its deltas are absent, not zero. `periodsFor()` in
`src/panels/issueMetrics.js`, inline in `src/panels/analytics.js`.

### Null versus zero

- **0** — looked, and the answer is none
- **null**, rendered `—` — nothing to compute from: an empty sample or a field
  not yet backfilled

Medians, percentiles and shares are null on an empty sample. `medianPRLines` is
null (not 0) when no PR in the window has diff data.

### Rounding

Applied at the end of a calculation, never partway.

- `round1` — 1 dp; hours and minutes
- `round3` — 3 dp; shares (rendered as whole percentages)
- Org-wide CI projections — whole numbers

### Timezone

UTC throughout: GitHub's ISO-8601 UTC timestamps, day keys are their first ten
characters, and the browser renders in UTC. No local timezone is consulted.

---

## Shared primitives

### Percentile — nearest rank, no interpolation

`src/shared/analytics-rules.js`; used by `analytics`, `issueMetrics`,
`drilldown` and the Worker.

```
pct(sorted, p):
  if empty -> null
  i = min(floor(p/100 × n), n − 1)
  return sorted[i]
```

Input sorted ascending. `p = 50` is the median, `p = 90` is p90. On an even
sample the median is the **upper** middle value, not the mean of the two.

**SQL.** `pctRankSql` ranks with `ROW_NUMBER() OVER (ORDER BY value)` against
`COUNT(*) OVER ()` and takes the row with

```
rank = 1 + min(n − 1, CAST(n × p/100 AS INTEGER))
```

`CAST` truncates, which equals `floor` for non-negative values, and the fraction
is the same double JS computes, so the two agree exactly.

**Several overlapping periods at once** (the thirteen Analytics slices): build
the set once, keep a running count per period, and take the first row where it
reaches the rank:

```
k_i          = SUM(row in period i) OVER (ORDER BY value ROWS UNBOUNDED PRECEDING)
percentile_i = MIN(value) WHERE k_i = rank_i          # period i non-empty
```

The frame must be `ROWS`: the default `RANGE` lumps tied values together, so the
count jumps past a rank inside a tie and nothing matches.

### Median

```
median(values) = round1(pct(sort_ascending(values), 50))
```

The mean is never used for PR size, merge time, response time or close time;
one regenerated file drags a mean past every real value. The only deliberate
mean is `meanRunMinutes` (CI).

### Week key

Monday-start ISO week, matching GitHub. `src/shared/analytics-rules.js`.

```
t        = date at UTC midnight
dow      = (UTC weekday of t + 6) mod 7        # Monday = 0
t        = t + (3 − dow) days                  # that week's Thursday
firstThu = 4 January of t's year
week     = 1 + round((t − firstThu) / 7 days)
key      = "<year of t>-W<week, 2 digits>"
```

The Thursday shift fixes weeks straddling New Year. Keys sort chronologically.
`weekKeySql` spells out the same steps with `date()`/`julianday()`;
`strftime('%Y-%W')` is **not** equivalent (counts from the first Sunday and
disagrees at about every other year boundary). The parity test checks every day
2005–2035.

### Month and day keys

```
monthKey = "<UTC year>-<UTC month, 2 digits>"
dayKey   = first 10 chars of the ISO string       # "2026-08-24"
```

Both sort chronologically. Monthly buckets are the one place calendar months
are used.

### Duration in hours

```
hours(from, to) = (epoch_seconds(to) − epoch_seconds(from)) / 3600
```

Whole seconds, not `julianday` differences, whose float error can reorder
near-equal rows and so move a percentile. GitHub timestamps are whole seconds
(asserted by the parity test), so this is exact.

### Timestamp vs. period boundary (SQL)

Stored timestamps are fixed-width `YYYY-MM-DDTHH:MM:SSZ`, so a window test is a
string comparison against a bound ceiled to the second:

```
isoBound(ms) = ISO of ceil(ms / 1000) s
t×1000 ≥ bound  ⟺  t ≥ ceil(bound/1000)
t×1000 < bound  ⟺  t < ceil(bound/1000)
```

Both hold whether or not the bound is on a whole second, so one value serves
both ends. Without the ceiling the boundary second compares backwards (`Z` sorts
after `.`). Parity tests assert the equivalence at ±1 ms and that no compared
column has a fraction or varies in width.

Not `CAST(strftime('%s', col) AS INTEGER)`: correct, but 43 ms per query vs 7 ms.
If `strftime` is ever used for comparison the `CAST` is mandatory — SQLite sorts
all TEXT above all numbers, so an uncast comparison is constant (always true or
always false) and looks like a working query.

### Age and staleness

```
ageDays   = floor((now − createdAt) / 86,400,000)
staleDays = floor((now − updatedAt) / 86,400,000)     # null without updatedAt
```

`now` is the build start, not the reader's clock.

### Backlog age buckets

`src/shared/analytics-rules.js`, re-exported from `src/panels/analytics.js`,
shared by every panel that buckets by age so org totals equal the sum of repos.

| Bucket | Days |
|---|---|
| `< 1 week` | < 7 |
| `1–4 weeks` | 7–29 |
| `1–3 months` | 30–89 |
| `3–12 months` | 90–364 |
| `> 1 year` | ≥ 365 |

First bucket whose `max` the value is strictly below; overflow goes to the last.
Also used for staleness (days since update) on cards that offer both.

### Top-N lists (people and repos)

`topRepos`, `topAuthors`, `topReviewers` (Analytics), the six `top*` lists per
Issue window, the by-contributor table, and every "top N by count" list.

```
sort by count desc, then key (login or repo) asc; take first n
```

The key tiebreak makes the order deterministic and reproducible in SQL; without
it ties come out in store order. It matters: in the 1-month by-contributor
window 256 people tie at involvement 1 for 74 slots (the tiebreak changed 53 of
200 rows there, 79 across all windows), and on the Issue lists 8 of 42 lists
changed, 6 in membership. Strings compare with `<`, not `localeCompare`, so
locale cannot change the result.

### Top-N lists of issues

`oldest`, `quietest`, `ignored` (triage snapshot) and `mostDiscussed`.

```
sort by metric desc, then repo asc, then number asc; take first n
```

`(repo, number)` is the primary key, so the order is total. It bites here
because the first three rank on whole days (e.g. nine open issues share the
boundary age of `oldest` for six slots), and 723 issue pairs share
`(comments, number)`. Per-repo issue rows: `open` desc, `total` desc, repo name
(seven repo pairs tie on both counts).

### First of two same-second events

Used by `newReporters` and `newContributors` to decide "first ever".

```
earliest createdAt, then smallest "repo#number" as a string
```

A **string** comparison (`t#9` > `t#10`), deliberately; GitHub stamps to the
second and some authors filed two items in one second, which once made
first-time reporters exceed reporters. The parity test constructs a digit-count
case since none exists in the store.

---

## What the stores contain

Decided at ingest and only counted later.

### Traffic views and clones

`src/ingest/traffic.js`. `GET /repos/{repo}/traffic/views` and `/clones` (each
returns the full retained window). One row per `repo + UTC date` with `views`,
`viewUniques`, `clones`, `cloneUniques`.

- **Keyed, not appended** — a later reading of a day replaces the earlier one,
  so overlapping runs are idempotent.
- **Today is discarded** — partial. Only closed days are stored.
- **Yesterday may be low** — GitHub lags hours; the next run overwrites it.
- **No traffic, no row** — absent = zero, so rows < repos × days.
- **Uniques do not sum** — daily uniques summed over a week is an upper bound on
  reach. Only `views` and `clones` add across days.
- **Clones are not people** — CI can produce huge clones against few uniques;
  `cloneUniques` is the useful signal.
- **Excluded repos** (`NH_INGEST_EXCLUDE`) are never requested, so their traffic
  can never be backfilled.

### First response on an issue

`src/ingest/issues.js` (GraphQL) and `src/ingest/issuesBulk.js` (REST bulk).

```
firstResponseAt, firstResponder = first comment (creation order) whose author is
                                  not null, not the issue author, not a bot
```

- GraphQL reads `COMMENT_SAMPLE = 10` comments. No qualifying reply in those and
  more than 10 comments → `responseUnknown: true`, a third state dropped from
  **both** sides of every answered/unanswered figure.
- REST bulk streams every comment, so it never sets `responseUnknown`; it keeps
  up to `CANDIDATES = 3` early commenters and filters the reporter at merge.
- Response medians cover issues with a known response only; never-answered
  issues go to `neverAnswered`.

### Who closed an issue

`closure()` in `src/ingest/issues.js`; read by `closerOf`/`fixerOf`/`closingPR`
in `src/panels/issueMetrics.js`. Both are counted, separately:

- **`closedBy`, the closer** — actor on the last `CLOSED_EVENT` (`last: 1`, so
  only the close that stuck).
- **`closedVia`, the fixer** — author of the closing PR, if the event names one.

`closerKnown` is `true` from GraphQL and `false` from REST bulk (REST only
returns `closed_by` per issue). Any closed record without `closerKnown === true`
counts as `unknownCloser`, which every close-count card shows alongside.

### Close reason

GitHub's `stateReason`. `UNRESOLVED = {NOT_PLANNED, DUPLICATE}`; everything
else, including null, is completed. Null is also counted as `unknownReason`
(currently never fires; GitHub backfilled `COMPLETED`). New reasons GitHub adds
will count as completed until the set is updated.

### Approvals

One per reviewer per PR, dated by that reviewer's **earliest** approval.
Exception: the contributor drilldown's review queue uses each reviewer's
**latest** verdict (current state of the review).

- `reviews(first: 50)` per PR; more sets `reviewsTruncated`, counted by the
  contributors panel and warned at build. Approvals on those PRs are floors.
- Reviews by deleted accounts (null author) count toward no one and are
  excluded from totals (2 approvals, 31 reviews today).

### Labels

GraphQL issue walk: `LABEL_SAMPLE = 15` per issue, sets `labelsTruncated` if
more. REST bulk: all labels. PRs: `labels(first: 10)`.

### Reactions

PR reactions are ingested; issue reactions are not (GitHub's abuse limit refused
the query on the largest tracker). So PR 👍/👎 lists exist, and issue engagement
is comment count only.

### Search API cap

`searchIssues()` in `src/github/client.js` stops at 1,000 results (GitHub's
limit) and warns at build. Past that, counts are floors.

---

## Pull request metrics

`src/panels/analytics.js`, over the PR store.

### Totals (all time)

| Figure | Rule |
|---|---|
| `prs` | Records with `createdAt` |
| `merged` | `mergedAt` set |
| `open` | no `mergedAt`, `state = OPEN` |
| `closed` | the rest |
| `approvals` | Σ over PRs of distinct non-bot approvers |
| `contributors` | distinct non-bot authors |
| `repos` | distinct repos with ≥ 1 PR |
| `firstPR` | earliest first-PR timestamp across authors |

`merged + open + closed = prs` by construction.

### Time to merge

On screen: *Median time to merge*, *Median to merge*, *To merge (median)*,
*To merge (p90)*, *p90 to merge*

```
mergeHours       = (mergedAt − createdAt) / 3,600,000     # merged PRs
medianMergeHours = pct(mergeHours, 50)
p90MergeHours    = pct(mergeHours, 90)
```

Dated by `mergedAt`. Bots included. Null when empty; `mergeN` is the sample
size.

> **Tiles and charts disagree by design.** The window figure dates each sample by
> `mergedAt` ("PRs merged this period took N hours"). The time series puts the
> same sample in the bucket containing `createdAt` ("PRs opened this week took N
> hours"). A chart point and a tile differing is almost always this.

### Time to first review

On screen: *Median first review*, *To first review (median)*

```
firstReviewAt   = earliest submittedAt of a review by neither a bot nor the PR author
firstReviewHours = (firstReviewAt − createdAt) / 3,600,000
```

Any verdict counts. Null when empty; `reviewN` is the sample size. **Dated by
`createdAt`**, the one deliberate exception to the event-timestamp rule: it is a
property of the PR's opening.

### Merge rate

On screen: *Merge rate*, *Merged share*

```
mergeRate = merged / (merged + closed)          # null if both 0
```

Denominator is PRs that reached an outcome in the period, each dated by its own
event. Still-open PRs are in neither half.

### Approved share and unapproved merges

On screen: *Approved before merge*, *Merged with an approval*, *Merged without
approval*, *Merged unapproved*

```
approvedShare    = mergedWithApproval / merged   # null if merged = 0
unapprovedMerges = merged − mergedWithApproval
```

`mergedWithApproval` = merged PRs with ≥ 1 non-bot approval **at any time**,
including after the merge (rare). Dated by `mergedAt`.

### Review concentration

On screen: *Top-5 reviewer share* (tinted red above 60%, amber above 40%)

```
reviewConcentration = Σ approvals of top 5 reviewers / Σ approvals of all reviewers
```

Bots excluded. Null when nobody approved. Ties at fifth place follow the Top-N
tiebreak.

### PR size

On screen: *Median PR size*, *Lines added*, *Lines removed*, *Lines changed*

```
lines(pr)     = additions + deletions
medianPRLines = pct(lines, 50)
p90PRLines    = pct(lines, 90)
linesChanged  = Σ additions + Σ deletions
```

PRs without numeric `additions` (ingested before diff fields) are **skipped**,
not zero; `sizedPRs` is the sample size. Diff size and commits are dated by
`createdAt`, so lines per PR divides two figures over the same PRs.
`changedFiles` is carried only as a sanity check, not aggregated.

### Changes-requested share

On screen: *Needed changes first*

```
changesRequestedShare = mergedAfterChanges / merged    # null if merged = 0
```

`mergedAfterChanges` = merged PRs with ≥ 1 non-bot `CHANGES_REQUESTED` review at
any time, dated by `mergedAt`. Same denominator as `approvedShare` so they read
together. GitHub forbids self changes-requested, so no self-exclusion is needed.
Whether a PR was sent back, not how often (94% never are).

### Time to abandon

On screen: *Median to abandon*

```
abandonHours       = closedAt − createdAt     # state CLOSED, no mergedAt
medianAbandonHours = pct(abandonHours, 50)
```

Dated by `closedAt`. Only records carrying `closedAt` count, so an
un-backfilled store gives null; `abandonedWithTime` is the sample size. Counts
(`closed`, closed side of the volume series) fall back to `updatedAt`; this
median does not, since `updatedAt` overstates by any post-close comments.

### PR size buckets

On screen: *PR size* card

```
XS < 10 · S 10–49 · M 50–249 · L 250–999 · XL 1000+     (lines)

per bucket:  prs, merged, mergeRate = merged / prs
             medianMergeH, p90MergeH over merged PRs only
```

All PRs with diff data go in the counts; only merged ones in the percentiles,
so `mergeRate` can fall while medians stay flat. No diff data → skipped. Empty
bucket → null medians. All time, not windowed. Buckets not means (mean ≈ 990
lines vs median 26; largest PR 1.9M lines).

### Active authors, reviewers, repos, new contributors

On screen: *Active authors*, *Active reviewers*, *Reviewers active*,
*First-time contributors*, *First-time authors*, *First-time*

| Figure | Rule |
|---|---|
| `activeAuthors` | distinct non-bot logins that opened a PR in the period |
| `activeReviewers` | distinct non-bot logins that gave a first approval in the period |
| `activeRepos` | distinct repos with a PR opened in the period |
| `newContributors` | PRs opened in the period that were the author's first ever |

First ever: per non-bot author, earliest `createdAt`, ties by `repo#number`
string (see *First of two same-second events*).

### Open backlog

On screen: *Open backlog*, *Open PRs*

Over PRs with `state = OPEN` and no `mergedAt`; not windowed.

| Figure | Rule |
|---|---|
| `total` | open PRs |
| `unreviewed` | no `firstReviewAt` |
| `buckets` | by `ageDays`, shared buckets |
| `oldest` | 25 highest `ageDays` |

Whole-day ages tie often: SQL breaks ties by `createdAt`, then `repo#number`;
Node leaves store order. The parity test compares ages, not identities.

### Time series buckets

On screen: *PR volume*, *Review latency*, *Contributor growth*

Day, week and month granularity, same fields. Each PR contributes to two
buckets:

1. Bucket of `createdAt`: `opened`, author into the author set, `newAuthors` if
   first ever, and its merge and first-review hours into the samples.
2. Bucket of its end (`mergedAt`, or close time if unmerged): `merged` or
   `closed`.

So `merged` is not a subset of `opened` within a bucket.

| Field | Rule |
|---|---|
| `opened`, `merged`, `closed` | as above |
| `authors` | distinct non-bot authors |
| `newAuthors` | first-ever PRs opened |
| `mergeMedianH`, `mergeP90H` | percentiles of the bucket's merge hours |
| `reviewMedianH` | median of its first-review hours |
| `mergeN`, `reviewN` | sample sizes |
| `t` | earliest timestamp in the bucket, for sorting |

Daily buckets go back `DAY_SERIES_DAYS = 730` only (all time would be ~4,300
buckets); `series.dayFrom` carries the
limit and the frontend states it.

### Activity heatmap

On screen: *When PRs open*

```
heat[weekday][hour] = PRs created     weekday = (UTC weekday + 6) mod 7  (Mon = 0)
shade = count / max(cells)            # in the browser
```

Bots excluded; last 365 days only; ignores the window control.

### Most grossing

On screen: *Most grossing*

`src/panels/grossing.js`. Three all-time lists: most commented, most 👍, most 👎.

```
keep entries with field > 0; sort by field desc, then PR number desc; take n
```

n = 5 on a repo drilldown, 10 on the org card (a top 5 across ~1,400 repos is
mostly one repo). Never windowed (a windowed
version would be ~9 MB and mostly empty). Zero-count entries are dropped, not
padded.

---

## Contributor metrics

`src/panels/contributors.js`; active days in `src/panels/activeDays.js`.

### Per-window counts

| Field | Counted when | Dated by |
|---|---|---|
| `prs` | they opened a PR | `createdAt` |
| `merged` | a PR of theirs merged | `mergedAt` |
| `approvals` | they approved a PR | their earliest approval |

An event is added to every window with `days == null or ageDays ≤ days`, where
`ageDays = (now − t) / 86,400,000`. This is `≤`, while analytics uses `≥ from`:
the boundary differs by one tick between the panels.

`firstSeen`/`lastSeen` (On screen: *First PR*, *Last active*) = min/max over PRs,
merges and approvals, **not** issues. A drilldown's `first`/`last` (*Active
since*) include issues, so they can differ for a triager.

### Leaderboard ordering

On screen: *Leaderboard*

```
rank by all.prs + all.approvals desc
show if all.prs + all.approvals ≥ CONTRIBUTOR_MIN_ACTIVITY   # default 0
```

An unweighted sum of acts. Further filtering is a browser slider.

### Active days

On screen: the active-days share on Leaderboard and drilldown

A UTC calendar day on which the person did at least one of: opened a PR,
submitted a review (any verdict), filed an issue, was first responder on an
issue, closed an issue, or authored the PR that closed an issue. Their own PR
being merged by someone else does **not** count. Days are deduplicated.

```
fixed window:  days  = active days ≥ today − N
               denom = N
all time:      days  = all active days
               denom = (today − first active day) + 1
activeShare = days / denom                  # ≤ 100% by construction
```

The period always runs to **today**, never to the last active day, so time
away counts against the share (dividing by `last − first` gave a one-afternoon
contributor 100%). The denominator ships in the payload: `activeSpan` on a
drilldown record, `activeDenom` on a leaderboard row, read by `activeShare()` in
`web/js/format.js`.

### Gone quiet

On screen: *Gone quiet*

`web/js/modules/people.js`: `all.prs + all.approvals ≥ 20` and
`now − lastSeen > 180 days`. Both hardcoded.

### New faces

On screen: *New faces*

Contributors whose `firstSeen` falls in the card's own period, which is
separate from the page's.

---

## Issue metrics

Definitions live once in `src/panels/issueMetrics.js`, shared by the org panel,
the repo drilldown and the person drilldown.

### Tracker rollup (org or repo)

| Metric | On screen | Formula |
|---|---|---|
| `opened` | Opened, Issues filed | issues created in the period |
| `closed` | Closed, Issues closed | issues closed in the period (`closedAt`) |
| `completed` | Closed as completed | closed, `stateReason ∉ {NOT_PLANNED, DUPLICATE}` (null counts) |
| `notPlanned` | Closed as not planned | `stateReason = NOT_PLANNED` |
| `duplicate` | Closed as duplicate | `stateReason = DUPLICATE` |
| `unresolved` | Closed unresolved | `notPlanned + duplicate` |
| `net` | Net, Net backlog, Backlog moved | `opened − closed`; positive = backlog grew |
| `completedShare` | Completed share, Resolved share, Resolved rather than declined | `completed / closed`; null if `closed = 0` |
| `medianCloseHours` | Median time to close, To close (median), Median close | `pct(closeHours, 50)`, `closeHours = (closedAt − createdAt) / 3.6e6` |
| `p90CloseHours` | To close (p90) | `pct(closeHours, 90)` |
| `medianFirstResponseHours` | Median first response, To first response (median) | `pct(responseHours, 50)`, `responseHours = (firstResponseAt − createdAt) / 3.6e6` |
| `p90FirstResponseHours` | | `pct(responseHours, 90)` |
| `labeledShare` | Labeled on arrival | `labeled / opened`, over issues opened in the period |
| `unlabeled` | Unlabeled | `opened − labeled` |
| `answeredShare` | Answered share, Answered at all | `answered / (answered + unanswered)` |
| `neverAnswered` | Never answered | `unanswered` |
| `reporters` | Reporters, Distinct reporters | distinct non-bot authors of issues opened |
| `newReporters` | First-time reporters | issues opened that were the author's first ever |
| `responders` | People answering | distinct non-bot first responders |
| `responses` | First replies | first replies given |
| `closers` | People closing, Closers | distinct people who pressed close |
| `closedByPR` | Closed by a PR, Closes from a PR | closes done by a PR |
| `closedByHand` | Closed by hand | closes with a known actor and no PR |
| `unknownCloser` | Closer not recorded | closes the store cannot attribute |
| `assignees` | People assigned | distinct non-bot assignees on issues opened |
| `comments` | Comments | Σ comments on issues opened |
| `closedN`, `respondedN` | | sample sizes behind the medians |

`answeredShare` excludes `responseUnknown` records from both halves, so
`answered + unanswered` can be less than `opened`.

`closedByPR + closedByHand + unknownCloser = closed` by construction.

### Person rollup

Filing, answering, closing and fixing are kept separate.

| Metric | On screen | Formula |
|---|---|---|
| `filed` | Filed, Issues filed | issues they opened |
| `filedOpen` / `filedClosed` | Open filed | of those, open / closed |
| `filedCompleted` / `filedUnresolved` | | of the closed, by close reason |
| `acceptedShare` | Accepted, Accepted share | `filedCompleted / filedClosed` — a property of the reports, not the person |
| `filedLabeledShare` | | `filedLabeled / filed` |
| `filedAnswered` / `filedUnanswered` | | their reports that got a reply / never did |
| `answeredShare` | Their reports answered | `filedAnswered / (filedAnswered + filedUnanswered)` |
| `commentsReceived` | Comments received | Σ comments on issues they filed |
| `medianWaitHours`, `p90WaitHours` | Median wait for a reply, They waited | percentiles of how long **their** reports waited for a reply |
| `responses` | First replies given | first replies they gave on others' issues, dated by the reply |
| `medianResponseLagHours`, `p90ResponseLagHours` | Median reply lag, They answered in | issue age when they replied |
| `closed` | Closed by them | closes where they pressed the button (`closedAt`) |
| `closedCompleted` / `closedUnresolved` | | of those, by reason |
| `closedOwn` | | …of their own issues (not triage) |
| `closedForOthers` | …for others | `closed − closedOwn` |
| `closedByTheirPR` | Closed by their PR | they pressed close **and** their PR was the closer |
| `closedByHand` | | they pressed close, no PR |
| `medianCloseLagHours`, `p90CloseLagHours` | Median age at close | issue age when they closed it |
| `fixed` | | closed by a PR they authored, whoever pressed close |
| `assigned` / `assignedOpen` | Assigned, Assigned to them, Assigned, open | issues assigned to them / still open |
| `triage` | Triage acts | `responses + (closed − closedOwn)` |
| `involvement` | | `filed + responses + closed + fixed` |
| `repos` | Repos touched | distinct repos they touched an issue in |
| `filedRepos` | | distinct repos they filed in |
| `helped` | People helped | distinct other reporters they answered or closed for |

`triage` and `involvement` are unweighted sums of acts, for ranking.

One person can hold several roles on one issue (reporter and closer is common)
and is credited in each. The `_iclosed` log emits **one row per close**, noting
whether they pressed close, wrote the PR, or both.

Assignment has no date of its own, so it is dated by the issue's `createdAt`.

### Label groups

Labels follow `Prefix: Value`, split by `^([A-Za-z0-9][A-Za-z0-9 ]*):\s*(.+)$`;
non-matching labels go to `Other` with the full name.

Groups sort by `GROUP_ORDER = [Status, Bug, Type, Platform, Mod, Other]`, then
unlisted groups alphabetically, then open desc, then total desc. Label stats are
keyed by **repo and name**, never name alone, since each tracker has its own
taxonomy.

### Label table ordering

On screen: *Label mix* (Issues)

Per repo: group rank, group name, `open` desc, `total` desc, label name. The
name tiebreak decides 86 of 314 rows (tied on open and total within their
group). All comparisons use `<`, not `localeCompare`.

### Triage snapshot

On screen: *Triage state*, *Needs attention*, *Oldest open*, *Quietest*,
*Quiet for 3 months or more*

Not windowed; over all open issues.

| Figure | Rule |
|---|---|
| `open` | open issues |
| `unlabeled` | open, no labels |
| `unanswered` | open and `isUnanswered`: no `firstResponseAt` and not `responseUnknown` |
| `unassigned` | open, no assignees |
| `stale` | open, `staleDays ≥ ISSUE_STALE_DAYS` (90) |
| `ageBuckets` / `staleBuckets` | open by `ageDays` / `staleDays` |
| `oldest` | 40 highest `ageDays` |
| `quietest` | 40 highest `staleDays` |
| `ignored` | unanswered open, 40 highest `ageDays` |

Ties on `(repo, number)`. 90 days rather than 30 because a quiet month on this
modpack usually means waiting on a release.

### Per-repo issue stats

On screen: *Where the issues are*

| Figure | Rule |
|---|---|
| `total`, `open`, `closed` | all time |
| `unanswered`, `unlabeled`, `unassigned`, `stale` | **open issues only** |
| `closedByPR` | all-time closes by a PR |
| `prShare` | `round3(closedByPR / closed)`; null if `closed = 0` |
| `reporters`, `closers` | distinct non-bot logins, all time |
| `medianCloseHours`, `medianFirstResponseHours` | over the repo's full history |
| `last` | max `updatedAt` |

### Issue time series buckets

On screen: *Issue volume*, *Response and resolution*

Same granularities and 730-day daily limit as PRs. `opened` goes to the
`createdAt` bucket, `closed` to the `closedAt` bucket.

| Field | Rule |
|---|---|
| `opened`, `closed` | as above |
| `unresolved` | closes in the bucket with reason NOT_PLANNED or DUPLICATE |
| `net` | `opened − closed`; the only chart figure that can go negative |
| `reporters` | distinct non-bot authors of issues opened |
| `newReporters` | first-ever issues opened |
| `closeMedianH`, `closeP90H` | close-hour percentiles |
| `responseMedianH` | median first-response hours |
| `closeN`, `responseN` | sample sizes |

Latency samples go in the `createdAt` bucket, with the same tile-vs-chart caveat
as PRs.

### Most discussed

On screen: *Most discussed*

25 issues with the most comments, all time; zero-comment issues excluded; ties
by `(repo, number)`. Comments are the only issue engagement signal (see
Reactions).

### Per-label monthly series

Only for `ISSUE_LABEL_REPO` (the modpack), labels with `total ≥ SERIES_MIN` (20),
over the last `SERIES_MONTHS` (60) months:

```
cutoff = YYYY-MM of (now − 60 × 30.4 days)
cell   = [opened, closed]   # by month opened / month closed; empty months absent
```

Other repos' label counts are still available behind the picker.

### By-contributor table

On screen: *By contributor*, *Who files, answers and closes*

`PEOPLE_CAP = 200` rows per window, ranked by `involvement` desc, then login.
~6,400 participants total; at the cap the card says `top 200 of N`. Everyone
keeps a full drilldown.

---

## Repo activity metrics

`src/panels/repos.js`; one row per repo. Its per-window `opened`, `merged`,
`closed`, `mergeRate`, `approvals`, `people`, `reviewers` and
`medianMergeHours` use the analytics arithmetic, and agree with it exactly on
opened, merged, closed, approvals and the open PR total.

### Last activity and lifecycle

On screen: *Last activity*, *Lifecycle*, *Rung*

```
last     = max(PR createdAt, mergedAt, closedAt, issue createdAt, closedAt)
idleDays = floor((now − last) / 1 day)
```

A count of days; no denominator. `updatedAt` is excluded (a comment on an old PR
is not work on the repo); including it would shift the split from
124/74/64/37 to 133/70/60/36. No activity at all → `silent` (both
implementations, via the SQL LEFT JOIN null).

| Rung | Idle days | Repos |
|---|---|---|
| Active | < 30 | 124 |
| Slowing | 30–89 | 74 |
| Dormant | 90–364 | 64 |
| Silent | ≥ 365 | 37 |

Rungs reuse the `m1`/`m3`/`y1` spans.

### Closed PRs are dated by `closedAt` here

Falls back to `updatedAt` only where unbackfilled, matching analytics.
**`src/shared/drilldown-fold.js` still uses `updatedAt` alone**, so a repo's row
here and its drilldown can disagree on `closed`. Known divergence; the
drilldown should follow.

### Stale open PRs

On screen: *Stale PRs*, *Older than 6mo*, *Stale backlog*

```
staleOpenPRs = open PRs with now − createdAt ≥ 180 days
```

Count per repo, summable org-wide (66 across 35 repos today). Drafts count.

### Activity concentration

On screen: *Pulse* (Repo Activity)

```
activity      = opened + issuesOpened                         # per repo, per window
concentration = Σ activity of top 5 repos / Σ activity of all repos
```

Bots included. Null when the window has no activity. Top 5 to match *Review
concentration*. 59.9% over 3 months.

### Distinct people per repo

On screen: *Authors*, *Reviewers*

`people` = PR authors excluding bots; `reviewers` = approvers excluding bots but
**including** self-approval — the same rules as `drilldown-fold.js`. Since
`opened` counts bots and `people` does not, a Dependabot-heavy repo shows high
`opened` against low `people`.

---

## Drilldown metrics

`src/panels/drilldown.js`; one record per contributor and per repo. The PR
window summary uses the analytics arithmetic, so repos roll up into the org.

### `people` and `reviewers` depend on the subject

| Field | On a repo | On a contributor |
|---|---|---|
| `people` | distinct non-bot PR authors (*Contributors*) | distinct repos they opened PRs in (*Repos touched*) |
| `reviewers` | distinct approvers | distinct PR authors they approved for |

### Empty windows

A window with `opened = merged = closed = approvals = 0` is omitted from the
payload; the frontend fills in a blank. Issue side: empty means `involvement`
and `assigned` are 0 (person) or `opened`, `closed`, `responses` are 0 (repo).
An absent window means nothing happened, never missing data.

### Slim records

Full record if `substantial()`: ≥ 1 PR opened, or ≥ 1 all-time approval, or an
open PR, or ≥ 1 first response, or ≥ 1 issue closed, or ≥ 1 issue fixed, or
ever assigned, or **≥ 3 issues filed**, or anything currently in their review
queue or assignment log.

Otherwise slim: name, dates, active days and filed-issue log; no monthly
series, ranked-repo maps or partner lists. Slim people still count in every
aggregate and still get a page.

### Search index ranking

```
contributor = totalPRs + all-time approvals + (filed + responses + closed + fixed)
repo        = totalPRs + total issues filed
```

Issue involvement is included so triagers without PRs are not buried.

### Monthly series

PR series are **padded**: every month from the subject's first bucket to now,
quiet months `null` (→ zeroes). Issue series are **sparse** (only non-empty
months; the frontend fills gaps). `SERIES_MONTHS = 240` is a ceiling.

### Partner lists

On screen: *They approve*, *Approves their PRs*, *They help*, *Helped by*

All time only.

- `reviewsFor` — PR authors this person approved, excluding self and bot PRs
- `reviewedBy` — the mirror
- `helped` — reporters they answered, closed for or fixed for, excluding their
  own and bot-filed issues
- `helpedBy` — the mirror

### Backlogs

On screen: *Backlog*

Null when nothing is open. Beyond the org backlog fields:

| Field | Rule |
|---|---|
| `drafts` | open PRs with `draft === true` |
| `draftsKnown` | true only if every open PR has a non-null draft flag |

`draftsKnown` separates "no drafts" from "not yet ingested". The oldest-first
list is emitted in full so the Backlog filter searches everything.

### Field coverage

`prFieldCoverage` counts PR records carrying later-added fields, each over the
population where it is meaningful, only when that population is non-empty:

| Field | Counted over |
|---|---|
| `reviewRequests` | open PRs (GitHub deletes requests once the review lands) |
| `assignees` | all PRs |
| `labels` | all PRs |

`closerCoverage` = `{closed, unknown}` over the issue store.

**Live (D1) index:** `closerCoverage` and `issueData` match the build exactly
(`closer_known <> 1` over closed issues; `{closed: 23675, unknown: 0}`).
`prFieldCoverage` cannot. The Node store distinguishes `undefined` (never
asked) from `[]` on the three arrays; D1 declares the three arrays `NOT NULL DEFAULT '[]'`
and the handler writes them from every payload, so it reports `labels` and
`assignees` as `total` and `reviewRequests` as `openPRs`. Consequence: a row
written without labels reads as "no labels", not "never asked". Fixing it needs
a per-field `known` flag like `closer_known`/`response_unknown`; not done since
every payload carries these fields.

---

## CI health metrics

`src/panels/ciHealth.js` (API) and `worker/src/panels/ci-health.js` (D1), both
using the rules in `src/shared/ci-rules.js`.

**Sample:** the last `CI_RUN_SAMPLE = 20` **completed** runs per repo on the
**default branch**. That leaves out PR-triggered runs (the majority), so every
figure is a floor. The `branch=<default>` filter is what excludes them;
`exclude_pull_requests` does not (it only empties each run's `pull_requests`
array — identical 89,979-run sets on GT5-Unofficial either way, including all
57 `pull_request` runs). With the branch filter the sample is `push` and
`workflow_run` events only, and the SQL port filters on branch alone. Runs
triggered by other workflows *are* included (42 of 100 on GT5-Unofficial).

### Pass rate

On screen: *Pass rate*

```
decisive = conclusion ∈ {success, failure, timed_out, startup_failure}
passRate = success / decisive             # null if decisive = 0
failures = decisive − success
```

`cancelled`, `skipped`, `action_required` are in neither half (they reflect
people, not code). Null, not 0, when nothing was decisive.

### Run duration

On screen: *Median run*

```
duration = (updated_at − (run_started_at ?? created_at)) / 60,000   min
keep if finite, ≥ 0 and ≤ CI_MAX_RUN_MINUTES (360)
medianMinutes = s[floor(n/2)]         # upper middle, same as pct(·,50)
totalMinutes  = Σ kept durations;  timedRuns = count kept
```

**Why the ceiling.** Runs have no end timestamp: `/actions/runs` returns
`run_started_at` and `updated_at`, and only `/actions/runs/{id}/timing` has a
real duration, at one request per run. `updated_at` is last-touched
and GitHub bumps it long after (log expiry, artifact cleanup, re-runs). Three
EnderStorage runs of ~5 min read as ~580,000 min each, 99.99% of that repo's
time, inflating org `sampledMinutes` to 22.6M and `hoursPerMonth` to ~33,654.
360 is GitHub's per-job limit and sits in an empty band: across 201 sampled
runs the longest believable was 44.5 min and the shortest unbelievable exactly
1,440 (GitHub's 24-hour queued-job kill).

**Discarded, not clamped.** Dropped runs stay in `runs` and leave `timedRuns`.
Org-wide: 53 of 3,156 runs (1.7%) across 29 of 252 repos, holding 99.95% of the
old minutes; no repo loses all its durations.

**Wall-clock, not billable minutes.** Billing is per job (a matrix of 8 bills
~8×; macOS 10×, Windows 2×). The real figure costs one request per run,
~4,000 per build.

### Sample span

```
sampleSpanDays = (newest run start − oldest run start) / 86,400,000
```

Null with fewer than two runs or a non-positive span. Twenty runs can span two
days or two years; the span is what turns the sample into a rate.

### Org-wide projection

On screen: *Runs per month*, *Est. runs/month*, *Est. minutes/month*,
*Wall-clock hours per month*, *Average run*, *Actions load*

Per repo, skipping repos without `sampleSpanDays` or `timedRuns`:

```
perDay      = runs / sampleSpanDays
meanMinutes = totalMinutes / timedRuns          # deliberate mean: projecting a total

runsPerMonth    = round(Σ perDay × 30)
minutesPerMonth = round(Σ perDay × 30 × meanMinutes)
hoursPerMonth   = round1(minutesPerMonth / 60)
projectedFrom   = repos that contributed

sampledRuns    = Σ runs
sampledMinutes = Σ totalMinutes
meanRunMinutes = sampledMinutes / sampledRuns   # null if 0
passRate       = Σ success / Σ decisive
```

Month = 30 days. Not a bill, a total, or a job count (the endpoint returns runs,
not jobs).

`meanRunMinutes` divides by `sampledRuns`, not `timedRuns`, so discarded runs
bias the org mean **down** relative to per-repo means. Left as is to avoid
moving a number for an unrelated reason.

The "where the time goes" table in `web/js/modules/analytics.js` recomputes
`perDay` and `meanMinutes` itself; if it disagrees with the tiles, one copy has
drifted.

### The D1 version

Reads the `workflow_runs` table. Selection in SQL, arithmetic from `shared/ci-rules.js`, `summarizeOrg` reused
directly. Three things the SQL must reproduce explicitly:

```
median position   rank floor(n/2) + 1 over timed runs only   # discarded ≠ 0 minutes
sample span       null on one run                            # MAX − MIN = 0 would divide
sample cap        ORDER BY run_started_at DESC, run_id DESC  # same-second starts
```

Durations use `strftime` (arithmetic, which a string compare cannot do), with
the mandatory `CAST` to INTEGER. `worker/test/ci-health.parity.test.js` runs
both implementations over the same fixture — the only parity test comparing two
readings of one input rather than of one store.

---

## Repository state panels

Both have a SQL twin in `worker/src/panels/releases.js`. Shared rules are in
`src/shared/commit-rules.js` (paired with its SQL twin, as `issue-rules.js` is); `worker/test/releases.parity.test.js` checks
agreement. Where the SQL differs, it is because a webhook carries less than
GraphQL.

### Needs a release

On screen: *Needs a release*, *Last release*, *Released*

`src/panels/needsRelease.js`. Filters in order, cheapest first:

1. **Sweep** — non-archived repos by `pushedAt` desc, stopping at the first
   pushed more than `STALE_REPO_CUTOFF_DAYS` (365) ago.
2. **Candidate** — has a non-draft release (prereleases count) whose tag SHA ≠
   default-branch HEAD.
3. **Commit count** — REST `compare` tag…HEAD gives `ahead_by`; drop if
   `< RELEASE_COMMIT_THRESHOLD` (1).
4. **PR test** — keep only if ≥ 1 commit in the range has a PR (direct pushes
   like buildscript bumps don't need a release).

```
daysSinceRelease = floor((now − release.publishedAt) / 86,400,000)
sort: commitsAhead desc
```

If `compare` fails (force-push, deleted tag), the repo stays with
`commitsAhead: null` and skips step 4. `RELEASE_EXCLUDED_REPOS` (globs, `!`
re-includes, later wins, case-insensitive) is applied before `compare`.

**SQL step 2:** a `release` webhook has no tag SHA (only `tag_name` and
`target_commitish`, usually a branch name), so D1 asks instead

```
∃ commit on the default branch with committed_at > latest_release.published_at
```

Same meaning, and more robust to a moved tag. `commitsAhead = COUNT(*)` of those
rows, so the `compare` failure case cannot happen. Non-draft =
`draft = 0 AND published_at IS NOT NULL`; prereleases count. Step 4 loses
accuracy — see *Pull-request association*.

### Dep updates

On screen: *Time since last update*

`src/panels/depUpdates.js`. **A proxy, and the card says so.**

Measures: the newest default-branch commit with **no PR** and (with
`DEP_UPDATE_IGNORE_BOTS`) a non-bot author. Claims: time since dependencies were
touched. It holds because nearly everything here arrives by PR and direct
commits are usually maintainer dependency bumps; a direct typo fix makes a repo
read fresher. GitHub cannot cheaply say what a commit changed.

```
daysSinceDirect = floor((now − commit.committedDate) / 86,400,000)
```

The walk stops at `DEP_UPDATE_LOOKBACK_DAYS` (365) or `DEP_UPDATE_MAX_PAGES`
(10 × 100 commits). If nothing is found, `approx: true` with a floor:

- reached the lookback horizon (`exhausted`) → 365 (shown "≥ 1 yr")
- ran out of pages first → age of the oldest commit seen

Sort: `daysSinceDirect` desc, exact before approximate, then repo name.

**SQL floor** = `min(365, age of the oldest stored commit for that repo)`: D1
only knows how far its own capture goes, so it under-claims instead of asserting
a horizon it never reached.

### Pull-request association

Both panels ask whether a commit came through a PR (`needsRelease` wants ≥ 1
that did; `depUpdates` the newest that did not).

| Source | Method | Exact? |
|---|---|---|
| GraphQL (build, backfill) | `associatedPullRequests.totalCount` | yes |
| `push` webhook | not available in the payload | — |
| D1 read | `commits.sha = pull_requests.merge_commit_sha` | mostly |

So `commits.via_pr` is nullable: 0/1 = resolved by the build, NULL = written by
a delivery, read through the join. The join is exact for squash and merge
commits but misses **rebase merges** (new SHAs). The error is one-directional:
`depUpdates` can read a repo as fresher (never staler); `needsRelease` can add a
repo wrongly, never drop one. The next backfill overwrites `via_pr` with
GitHub's answer.

### Timestamp normalisation

D1 stores Z-normalised whole seconds and compares as strings. Push payloads carry
the committer's offset (`2026-08-30T12:34:56+02:00`), which sorts below `Z` and would break
`MAX(committed_at)`; `utcSeconds` in `src/shared/commit-rules.js` normalises on
the way in (asserted by handler and parity tests).

### Search-backed PR panels

On screen: *Approved, not merged*, *Changes requested*, *By label*

`src/panels/pullRequests.js`. The query is the definition:

| Panel | Query |
|---|---|
| Approved, not merged | `org:X is:pr is:open review:approved -is:draft` |
| Changes requested | `org:X is:pr is:open review:changes_requested -is:draft` |
| By label | `org:X is:pr is:open label:"L"` per managed label |

`review:` reflects **current** review state, so the first two are mutually
exclusive by GitHub's definition. `is:open` implies unmerged. Labels come from
`Label-Sync-GTNH` each build, capped at `MAX_TRACKED_LABELS` (40), one search
each.

---

## Browser-side calculations

Derived in the browser, so these can drift from the payload.

### Which drilldown payload a card shows

`web/js/drilldown-data.js`. Cached per subject at `state.subjects[kind][id]` as
`{ s, labelNames, version, from }`:

```
subject()       → cached payload, any version
subjectStale()  → version != null && version != state.version
drillOnBuild()  → from == "build", or the index came from the file
```

- A stale payload still renders (up to ~10 min old, which the `cron` ring
  indicates); `subjectStale` only triggers a refetch.
- The version is the Worker's `x-version` header, so the cache expires with the
  Worker's row.
- A payload from the build file records the page's current version, so a
  version bump prompts a refetch; bumps are at most every 10 minutes, so no loop.

### Label names on a drilldown row

`labelText(l, names)` in `web/js/drilldown-data.js`. Rows hold indexes into
the **subject's own** `labelNames`:

```
names = subjects[kind][id].labelNames  ??  drill.labelNames  ??  []
```

The build file is one snapshot with one global table; a cached payload is not,
because the recompute renumbers the global table. A wrong table gives a
plausible wrong name; a missing one gives `""`, which `labelsOf` filters out,
so the label filter silently matches nothing.

### Delta arrows

`delta()` in `web/js/data.js`.

```
ordinary: diff = (current − previous) / previous
share:    diff = current − previous                 # percentage points (pp: true)
flat (•) if |diff| < 0.02 (ordinary) or < 0.005 (share)
```

Colour follows the metric's `invert` flag (latency and unapproved merges: down
is good). Fallback when either side is null or `previous = 0` on an ordinary
metric.

### Series slicing

```
seriesSlice: last ceil(windowDays / bucketDays) buckets
sliceMonths: last max(1, ceil(windowDays / 30.4)) buckets
```

Counts buckets from the end rather than comparing dates, so a gap in the series
shifts what the slice covers. 1-month window on monthly buckets = one bar.

### Chart scaling

- `niceMax(v)` — axis max rounded up to 1, 2, 2.5, 5 or 10 × 10ⁿ
- Bar width = `value / max(values)`
- Bar row `share` = `round(value / Σ rendered values × 100)` — over rendered rows
  only, so a truncated list's shares don't reflect the full population
- Heatmap shade = `round(cell / max(cells) × 100)`
- Head-to-head bars = `value / rows[0].value`

### Combining label rows across repos

`labelRows()` in `web/js/data.js`, Label mix with several repos selected:
`open`, `closed`, `total`, `unanswered` are summed and `repos` counts trackers
using the label; medians become null and the columns are hidden. One repo
selected shows its own medians.

### Head-to-head leaders

On screen: *Head to head*

`leaders()` in `web/js/modules/versus.js` returns a **set** of column indexes, so
ties highlight all. No leader when the row has `dir: null`, fewer than two
non-null values, or everyone is zero. Null never leads.

### Windowing drilldown logs

Filed/closed issue logs and the resolved-PR list are filtered by
`at ≥ now − windowDays × 86,400,000`: open PRs and issues by open date
(`ageDays ≤ windowDays`), resolved PRs by end date, closed issues by close date.

### Latency chart sample floor

*Review latency* drops buckets with `mergeN ≤ 3`; the hint under the chart says
so.

### Volume KPIs

On screen: *Opened in range*, *Merged in range*, *…% of opened*, *Peak*
(PR volume); *Opened in range*, *Closed in range* (Issue volume)

Over the visible (sliced) buckets, not the window rollup:

```
Opened in range = Σ opened
Merged in range = Σ merged                 # PRs
% of opened     = Σ merged / Σ opened      # PRs
Peak <gran>     = max opened, and its bucket
Closed in range = Σ closed                 # issues; subtitle Σ unresolved
```

Merged can exceed opened (and the share can pass 100%) because they are dated by
different events.

### Triage concentration

On screen: *Done by the top five*, *Triage acts*, *People involved* (By
contributor card, Issues)

`web/js/modules/issues.js`, over the rows of the by-contributor table for the
window:

```
Triage acts          = Σ triage                         # subtitle: Σ closed closes
Done by the top five = Σ triage of top 5 rows by triage / Σ triage   # null if 0
People involved      = row count (capped at PEOPLE_CAP)
```

Tinted red above 80%. Rows are capped at 200, so both sums cover the top 200 by
involvement only.

---

## Org Search

On screen: *Org Search*

`/api/search` returns records, not figures.

### Matching

```
title match:  instr(lower(title), lower(query)) > 0     # lowered in JS
number:       query ~ /^#?\d+$/ → match on number only (4821 = #4821)
```

Substring, anywhere, ASCII case-insensitive. `instr` rather than `LIKE`, so `%`
and `_` are literal and case folding matches a card's `applyFilter`. A number
lookup uses the `(repo, number)` key and can return several rows (numbers are
per repo).

Not searched: bodies, comments, review text, commit messages, branch names (not
stored). Excluded repos are filtered by `scopedDb`.

Empty form → the 50 most recently updated records. A query with no match → empty
table with a note that only titles are searched.

### Order

| Sort | Expression |
|---|---|
| Recently updated (default) | `updated_at DESC, repo, number` |
| Newest | `created_at DESC, repo, number` |
| Oldest | `created_at ASC, repo, number` |
| Most discussed | `comments DESC, repo, number` |

Always total (723 pairs share `(comments, number)`), so repeated searches under a
`LIMIT` return the same rows. `(repo, number)` is unique across issues and PRs
together, since GitHub numbers both from one sequence per repo.

### Page

50 rows; the query fetches 51 and the extra row means "there is more". No total
count. Sorting a results column reorders those 50 rows only.

### States

| Filter | Matches |
|---|---|
| open | `state = 'OPEN'` |
| closed | `state = 'CLOSED'` — **not** "not open", so merged PRs are excluded |
| merged | `state = 'MERGED'`; for issues the predicate is `1 = 0` |

### Bots

Included; the one place bots are not excluded from anything.

---

## Known biases and blind spots

**Toward flattery**

- New `stateReason` values count as completed until `UNRESOLVED` is updated
- `approvedShare` counts approvals given after the merge
- Dep updates treats a direct non-dependency commit as a dependency update
- D1 `via_pr` misses rebase merges, making Dep updates read fresher

**Toward pessimism**

- CI excludes PR-triggered runs — a floor
- `reviewsTruncated` PRs undercount approvals
- Search panels cap at 1,000
- Unattributable closes go to `unknownCloser`, so `closedByHand` reads low on a
  half-backfilled store
- `meanRunMinutes` divides by `sampledRuns`, biasing the org mean down

**Easy to misread**

- `merged` is not a subset of `opened` in a bucket or window
- A series bucket's `mergeMedianH` is dated by open date, the tile's
  `medianMergeHours` by merge date
- `net` is the only chart figure that can go negative
- `people`/`reviewers` mean different things on a repo vs a contributor
- Medians are nearest-rank: upper middle on an even sample
- All-time percentiles move slowly and hide recent regressions
- Leaderboard `firstSeen`/`lastSeen` are PR-only; drilldown `first`/`last`
  include issues
- Repo activity and the repo drilldown date closed PRs differently

**Sampling limits**

| Limit | Value | Past it |
|---|---|---|
| `COMMENT_SAMPLE` | 10 | issue records `responseUnknown` |
| `LABEL_SAMPLE` | 15 | `labelsTruncated` set |
| `reviews(first:)` | 50 | approvals undercount, flagged |
| `CI_RUN_SAMPLE` | 20 | same math, safe to raise |
| Search cap | 1,000 | counts become floors, warned |
| `MAX_TRACKED_LABELS` | 40 | no By label card past the 40th |
| `PEOPLE_CAP` | 200 | top-200 table, says so |
| `ISSUE_TOP_N` | 200 | drilldown ranked lists truncate |
| `DAY_SERIES_DAYS` | 730 | daily charts stop, say so |

---

## Change log

Add an entry when a definition changes, not when data moves. Newest first.

| Date | Metric | Change |
|---|---|---|
| 2026-09-09 | Repo activity panel | New panel, no existing figure moves. Lifecycle rungs at 30/90/365 days idle; stale open PR at 180 days; concentration over the top 5 repos. Closed PRs dated by `closedAt` here while the drilldown still uses `updatedAt` — a known divergence. See **Repo activity metrics**. |
| 2026-09-08 | Label chip colours | Chips take their colour from `repo_labels`, keyed on `(repo, name)` because one name is coloured differently in different repos; the managed `labels` set is the fallback and an unknown name stays uncoloured. No figure moves. |
| 2026-09-08 | Org Search empty form | An empty form returns the fifty most recently updated records rather than no rows. See **Org Search**. |
| 2026-09-08 | Search matching and order | New endpoint, no existing figure moves. Titles matched by `instr` on a lowered string rather than `LIKE`; order is total on `(repo, number)`; `closed` excludes merged. See **Org Search**. |
| 2026-09-03 | `prFieldCoverage` | The live index reports complete coverage, because D1 declares the three array columns `NOT NULL DEFAULT '[]'` and cannot represent the unasked state. No number moves; the "never asked" hint can no longer fire on the live panel. See **Field coverage**. |
| 2026-09-03 | Drilldown label names | Resolved against the subject's own `labelNames` rather than one global table, because cached payloads outlive recomputes that renumber it. See **Label names on a drilldown row**. |
| — | *(initial)* | Document created. |
