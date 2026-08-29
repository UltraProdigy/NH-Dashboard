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
      repo.pushed_at ?? null,
      repo.updated_at ?? null,
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
         commits, comments, labels, assignees, review_requests
       ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)
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
         review_requests = excluded.review_requests`,
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
 * push, workflow_run, release — these feed panels that are still computed from
 * the live API, so there is nothing to write yet. They still mark the aggregates
 * dirty, because "a release happened" changes what the needs-release panel says
 * even though no row moved.
 */
async function onRepoTouch(db, payload) {
  await upsertRepo(db, payload.repository);
  return { touched: payload.repository?.name ?? null };
}

const HANDLERS = {
  pull_request: onPullRequest,
  pull_request_review: onPullRequestReview,
  issues: onIssues,
  issue_comment: onIssueComment,
  repository: onRepository,
  push: onRepoTouch,
  workflow_run: onRepoTouch,
  release: onRepoTouch,
};

export async function handleEvent(db, event, payload) {
  const handler = HANDLERS[event];
  if (!handler) return { ignored: event };
  return handler(db, payload);
}

export const HANDLED_EVENTS = Object.keys(HANDLERS);
