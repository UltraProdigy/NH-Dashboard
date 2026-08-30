/**
 * Webhook event handlers.
 *
 * Every handler is an upsert. A PR that is opened, reviewed, updated and merged
 * is four deliveries landing on one row, and the reconcile sweep writing that
 * same row afterwards has to be a no-op rather than a duplicate.
 *
 * The rule that matters most here: **a handler only writes the columns its
 * payload actually knows about.** Several fields exist only via reconciliation —
 * reactions have no webhook event at all, `closedVia` comes from the timeline
 * API, `first_response_at` is derived by walking comments. An upsert that set
 * every column would blank those on the next delivery, and the damage would be
 * invisible until someone noticed a panel quietly emptying out.
 *
 * So each ON CONFLICT clause lists its columns explicitly. Nothing is written
 * with SELECT *, and nothing is written by spreading an object.
 */

import { commitAuthor, headline, utcSeconds } from "../../src/shared/commit-rules.js";

/** The store uses OPEN / MERGED / CLOSED; payloads say open / closed + merged. */
function prState(pr) {
  if (pr.merged || pr.merged_at) return "MERGED";
  return (pr.state ?? "open").toUpperCase();
}

function names(list) {
  return JSON.stringify((list ?? []).map((x) => x?.name ?? x?.login ?? x).filter(Boolean));
}

function login(user) {
  return user?.login ?? null;
}

/**
 * A repository timestamp, whichever of the two forms GitHub sent.
 *
 * `repository.pushed_at` arrives as an ISO string on most events and as a Unix
 * **epoch integer** on `push`. Written straight into a TEXT column the integer
 * becomes `'1756568400'`, and every comparison in this store is a string
 * comparison — `'1'` sorts below `'2'`, so an epoch value lands beneath every
 * ISO date there has ever been.
 *
 * The damage that does is invisible and backwards: `pushed_at >= <a year ago>`
 * becomes false, so the repo is read as *dormant* and drops out of both release
 * panels. The repos affected are exactly the ones being pushed to — the most
 * active in the org — and they disappear one webhook after they were correct.
 *
 * Seconds and milliseconds are told apart by magnitude rather than by trusting
 * either payload shape: anything below ~Sep 2001 read as milliseconds is
 * epoch-seconds. Same reasoning as `utcSeconds` — a timestamp that does not
 * compare correctly is worse than one that is missing, because it is wrong
 * quietly.
 */
const repoTime = (value) => {
  if (typeof value !== "number") return utcSeconds(value);
  return utcSeconds(value < 1e11 ? value * 1000 : value);
};

async function upsertRepo(db, repo) {
  if (!repo?.name) return;
  await db
    .prepare(
      `INSERT INTO repos (name, full_name, private, archived, default_branch, pushed_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (name) DO UPDATE SET
         full_name = excluded.full_name,
         private = excluded.private,
         archived = excluded.archived,
         default_branch = excluded.default_branch,
         pushed_at = excluded.pushed_at,
         updated_at = excluded.updated_at`,
    )
    .bind(
      repo.name,
      repo.full_name ?? repo.name,
      repo.private ? 1 : 0,
      repo.archived ? 1 : 0,
      repo.default_branch ?? null,
      repoTime(repo.pushed_at),
      repoTime(repo.updated_at),
    )
    .run();
}

/**
 * pull_request — opened, closed, reopened, edited, synchronize, labeled, ...
 *
 * review_count and the thumbs fields are deliberately absent from the update
 * list: the payload carries neither, and the sweep owns them.
 */
async function onPullRequest(db, payload) {
  const pr = payload.pull_request;
  const repo = payload.repository?.name;
  if (!pr || !repo) return { skipped: "no pr or repo" };

  await db
    .prepare(
      `INSERT INTO pull_requests (
         repo, number, title, author, created_at, updated_at, merged_at,
         closed_at, state, is_draft, additions, deletions, changed_files,
         commits, comments, labels, assignees, review_requests, merge_commit_sha
       ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)
       ON CONFLICT (repo, number) DO UPDATE SET
         title = excluded.title,
         updated_at = excluded.updated_at,
         merged_at = excluded.merged_at,
         closed_at = excluded.closed_at,
         state = excluded.state,
         is_draft = excluded.is_draft,
         additions = excluded.additions,
         deletions = excluded.deletions,
         changed_files = excluded.changed_files,
         commits = excluded.commits,
         comments = excluded.comments,
         labels = excluded.labels,
         assignees = excluded.assignees,
         review_requests = excluded.review_requests,
         -- COALESCE, not excluded: GitHub sets merge_commit_sha on merge and
         -- may send null on a later edit. Overwriting would erase the only
         -- link between a stored commit and the PR that produced it, and the
         -- commits it orphans would silently start reading as direct pushes.
         merge_commit_sha = COALESCE(excluded.merge_commit_sha, pull_requests.merge_commit_sha)`,
    )
    .bind(
      repo,
      pr.number,
      pr.title ?? null,
      login(pr.user),
      pr.created_at,
      pr.updated_at ?? pr.created_at,
      pr.merged_at ?? null,
      pr.closed_at ?? null,
      prState(pr),
      pr.draft ? 1 : 0,
      pr.additions ?? null,
      pr.deletions ?? null,
      pr.changed_files ?? null,
      pr.commits ?? null,
      pr.comments ?? null,
      names(pr.labels),
      names(pr.assignees),
      names(pr.requested_reviewers),
      pr.merge_commit_sha ?? null,
    )
    .run();

  return { table: "pull_requests", repo, number: pr.number, state: prState(pr) };
}

/**
 * pull_request_review — submitted, edited, dismissed.
 *
 * INSERT OR REPLACE rather than ON CONFLICT: the unique index is over coalesced
 * expressions, which ON CONFLICT cannot name without repeating them exactly.
 */
async function onPullRequestReview(db, payload) {
  const review = payload.review;
  const repo = payload.repository?.name;
  const number = payload.pull_request?.number;
  if (!review || !repo || number == null) return { skipped: "no review" };

  const state =
    payload.action === "dismissed"
      ? "DISMISSED"
      : (review.state ?? "commented").toUpperCase();

  await db
    .prepare(
      `INSERT OR REPLACE INTO reviews (repo, pr_number, author, state, submitted_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
    .bind(repo, number, login(review.user), state, review.submitted_at ?? null)
    .run();

  return { table: "reviews", repo, number, state };
}

/**
 * issues — opened, closed, reopened, edited, labeled, assigned, ...
 *
 * closed_by comes from `sender` on a close, per the plan: the payload has no
 * closer field, but the person whose action closed it is the sender. closerKnown
 * marks that as a webhook-derived guess rather than a timeline-confirmed fact,
 * and closed_via stays untouched — only reconciliation can fill it.
 */
async function onIssues(db, payload) {
  const issue = payload.issue;
  const repo = payload.repository?.name;
  if (!issue || !repo) return { skipped: "no issue" };

  const closing = payload.action === "closed";

  await db
    .prepare(
      `INSERT INTO issues (
         repo, number, title, author, created_at, updated_at, closed_at, state,
         state_reason, labels, assignees, comments, closed_by, closer_known
       ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
       ON CONFLICT (repo, number) DO UPDATE SET
         title = excluded.title,
         updated_at = excluded.updated_at,
         closed_at = excluded.closed_at,
         state = excluded.state,
         state_reason = excluded.state_reason,
         labels = excluded.labels,
         assignees = excluded.assignees,
         comments = excluded.comments,
         closed_by = COALESCE(excluded.closed_by, issues.closed_by),
         closer_known = MAX(excluded.closer_known, issues.closer_known)`,
    )
    .bind(
      repo,
      issue.number,
      issue.title ?? null,
      login(issue.user),
      issue.created_at,
      issue.updated_at ?? issue.created_at,
      issue.closed_at ?? null,
      (issue.state ?? "open").toUpperCase(),
      issue.state_reason ?? null,
      names(issue.labels),
      names(issue.assignees),
      issue.comments ?? null,
      closing ? login(payload.sender) : null,
      closing && login(payload.sender) ? 1 : 0,
    )
    .run();

  return { table: "issues", repo, number: issue.number, action: payload.action };
}

/**
 * issue_comment — fires for comments on issues *and* pull requests, which the
 * payload distinguishes only by the presence of issue.pull_request.
 *
 * Only the count is touched. first_response_at is derived by walking comments
 * in order and is reconciliation's job; guessing it from a single delivery would
 * be wrong for any comment that isn't the first.
 */
async function onIssueComment(db, payload) {
  const issue = payload.issue;
  const repo = payload.repository?.name;
  if (!issue || !repo) return { skipped: "no issue" };

  const table = issue.pull_request ? "pull_requests" : "issues";
  await db
    .prepare(`UPDATE ${table} SET comments = ?1, updated_at = ?2 WHERE repo = ?3 AND number = ?4`)
    .bind(issue.comments ?? null, issue.updated_at ?? new Date().toISOString(), repo, issue.number)
    .run();

  return { table, repo, number: issue.number, comments: issue.comments };
}

async function onRepository(db, payload) {
  await upsertRepo(db, payload.repository);
  return { table: "repos", repo: payload.repository?.name, action: payload.action };
}

/**
 * An event whose payload carries nothing this store keeps. Nothing subscribes
 * to one today; kept because the next event added will want it before its
 * table exists, and a repo row is always worth the upsert.
 */
async function onRepoTouch(db, payload) {
  await upsertRepo(db, payload.repository);
  return { touched: payload.repository?.name ?? null };
}

/**
 * workflow_run — requested, in_progress, completed.
 *
 * Two filters, and both discard far more than they keep.
 *
 *   **Only `completed`.** This event fires three times per run and is the
 *   noisiest subscription here by a wide margin. The other two actions carry no
 *   conclusion and no end timestamp, so there is nothing in them the panel
 *   reads — writing them would triple the write rate to store rows that are
 *   immediately overwritten.
 *
 *   **Only the default branch**, which is what the card means by CI health: a
 *   topic branch's runs answer a question about work in progress rather than
 *   about whether the branch releases are cut from is green. `default_branch`
 *   comes from the payload rather than being assumed — this org runs both
 *   `master` and `main`.
 *
 * There is deliberately **no filter on `event`**, and that is a correction
 * rather than an omission. The Node panel passes `exclude_pull_requests=true`
 * and its comment says that drops PR-triggered runs; measured against the API,
 * that parameter returns a byte-identical set of runs and only empties the
 * `pull_requests` array on each one. What excludes PR runs is the branch
 * filter, here and there — a pull request's `head_branch` is its source branch,
 * so it does not match. Adding an event filter would make this stricter than
 * the panel it reproduces, on a case measured at 0 of 100 runs.
 *
 * `run_started_at` is absent on old runs, where `created_at` is the only start
 * that exists. Resolved here rather than at read time so the column holds one
 * kind of value and the index over it means one thing.
 *
 * ON CONFLICT DO UPDATE rather than DO NOTHING: a re-run of a failed job
 * delivers the same `run_id` again with a new conclusion, and the newer verdict
 * is the one the badge should show.
 */
async function onWorkflowRun(db, payload) {
  await upsertRepo(db, payload.repository);

  const run = payload.workflow_run;
  const repo = payload.repository?.name;
  if (!run?.id || !repo) return { skipped: "no run or repo" };

  if (payload.action !== "completed") {
    return { skipped: "not completed", action: payload.action };
  }

  const branch = payload.repository?.default_branch;
  if (!branch || run.head_branch !== branch) {
    return { skipped: "not the default branch", branch: run.head_branch };
  }

  await db
    .prepare(
      `INSERT INTO workflow_runs (
         repo, run_id, name, head_branch, event, conclusion,
         run_started_at, updated_at, html_url
       ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
       ON CONFLICT (repo, run_id) DO UPDATE SET
         conclusion = excluded.conclusion,
         updated_at = excluded.updated_at,
         name = excluded.name,
         html_url = excluded.html_url`,
    )
    .bind(
      repo,
      run.id,
      run.name ?? null,
      run.head_branch ?? null,
      run.event ?? null,
      run.conclusion ?? null,
      utcSeconds(run.run_started_at ?? run.created_at),
      utcSeconds(run.updated_at),
      run.html_url ?? null,
    )
    .run();

  return {
    table: "workflow_runs",
    repo,
    run: run.id,
    conclusion: run.conclusion ?? null,
  };
}

/**
 * push — default-branch commits.
 *
 * Three filters before anything is written, in the order that discards fastest:
 *
 *   A deleted ref carries no commits and means the opposite of a push.
 *
 *   Branches other than the default are skipped, because that is what the two
 *   panels mean. A topic branch's commits would inflate "commits ahead" with
 *   work that gets squashed into one commit on merge, and would date a
 *   dependency bump to the branch it was written on rather than the day it
 *   landed. `default_branch` is read from the payload rather than assumed —
 *   this org runs both `master` and `main`.
 *
 *   Tag pushes land on `refs/tags/…` and fail the same test, which is what we
 *   want: a tag is the release event's business.
 *
 * `via_pr` is written NULL, not 0. The payload has no pull-request field on a
 * commit — the full list is `id, tree_id, distinct, message, timestamp, url,
 * author, committer, added, removed, modified` — so 0 would be an assertion
 * this handler is in no position to make, and one the read path could not tell
 * from a real answer. NULL means "ask the join", and the daily build later
 * overwrites it with GitHub's own.
 *
 * ON CONFLICT DO NOTHING because a SHA is immutable and a force-push replaying
 * history re-delivers commits already stored. The one thing that must not be
 * clobbered is a `via_pr` the build has since resolved.
 */
async function onPush(db, payload) {
  await upsertRepo(db, payload.repository);

  const repo = payload.repository?.name;
  const branch = payload.repository?.default_branch;
  if (!repo || payload.deleted) return { skipped: "deleted or no repo" };
  if (!branch || payload.ref !== `refs/heads/${branch}`) {
    return { skipped: "not the default branch", ref: payload.ref };
  }

  const commits = payload.commits ?? [];
  if (!commits.length) return { table: "commits", repo, written: 0 };

  const statement = db.prepare(
    `INSERT INTO commits (repo, sha, committed_at, author, message, via_pr)
     VALUES (?1, ?2, ?3, ?4, ?5, NULL)
     ON CONFLICT (repo, sha) DO NOTHING`,
  );

  // One batch rather than a loop of awaits: a push of a few hundred commits is
  // ordinary here, and the delivery has ten seconds before GitHub calls it
  // failed. Commits without a parseable timestamp are dropped rather than
  // stored unsorted — `committed_at` is the column both panels order by.
  const rows = [];
  for (const commit of commits) {
    const at = utcSeconds(commit.timestamp);
    if (!commit.id || !at) continue;
    rows.push(
      statement.bind(
        repo,
        commit.id,
        at,
        commitAuthor(commit),
        headline(commit.message),
      ),
    );
  }

  if (rows.length) await db.batch(rows);

  return {
    table: "commits",
    repo,
    written: rows.length,
    // The payload caps at 2048 commits and says so only by being short. A push
    // that hits the cap has history this store will never see, and the count
    // is the only way anyone would notice.
    truncated: commits.length >= 2048,
  };
}

/**
 * release — published, edited, deleted, prereleased, released.
 *
 * `published_at` is null on a draft, and the panel orders by it, so a draft
 * sorts as having no date rather than as the newest release. `created_at` is
 * kept alongside because it is the only date a draft has.
 *
 * A deleted release is removed rather than flagged: "the latest release" is a
 * question about what exists now, and a tombstone row would have to be
 * excluded by every query that asks.
 */
async function onRelease(db, payload) {
  await upsertRepo(db, payload.repository);

  const release = payload.release;
  const repo = payload.repository?.name;
  if (!release?.tag_name || !repo) return { skipped: "no release or repo" };

  if (payload.action === "deleted") {
    await db
      .prepare("DELETE FROM releases WHERE repo = ?1 AND tag_name = ?2")
      .bind(repo, release.tag_name)
      .run();
    return { table: "releases", repo, tag: release.tag_name, action: "deleted" };
  }

  await db
    .prepare(
      `INSERT INTO releases (repo, tag_name, published_at, created_at, draft, prerelease)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (repo, tag_name) DO UPDATE SET
         published_at = excluded.published_at,
         created_at = excluded.created_at,
         draft = excluded.draft,
         prerelease = excluded.prerelease`,
    )
    .bind(
      repo,
      release.tag_name,
      utcSeconds(release.published_at),
      utcSeconds(release.created_at),
      release.draft ? 1 : 0,
      release.prerelease ? 1 : 0,
    )
    .run();

  return { table: "releases", repo, tag: release.tag_name, action: payload.action };
}

const HANDLERS = {
  pull_request: onPullRequest,
  pull_request_review: onPullRequestReview,
  issues: onIssues,
  issue_comment: onIssueComment,
  repository: onRepository,
  push: onPush,
  workflow_run: onWorkflowRun,
  release: onRelease,
};

export async function handleEvent(db, event, payload) {
  const handler = HANDLERS[event];
  if (!handler) return { ignored: event };
  return handler(db, payload);
}

export const HANDLED_EVENTS = Object.keys(HANDLERS);
