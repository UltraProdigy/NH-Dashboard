/**
 * Shared by every PR query so they can't drift into different shapes —
 * the ingest, the reconcile sweep and the Worker's Dream Panel verify. It lives
 * outside the ingest so the Worker can import it without node:fs. The reconcile
 * having kept its own copy is how `closedAt` ended up in D1 and not in the store.
 */
export const PR_FIELDS = `
  number
  title
  createdAt
  updatedAt
  mergedAt
  # Set on merge as well as on a plain close, so it is only the
  # abandonment timestamp once state has been checked.
  closedAt
  state
  isDraft
  author { login }
  # Diff size and commit count. All scalars on the PR itself, so they cost
  # nothing in nodes — the expensive part of adding them was the one-time
  # re-walk to populate records that predate the field.
  additions
  deletions
  changedFiles
  commits { totalCount }
  # Issue comments on the PR. Review comments are counted separately via
  # reviews below; conflating the two would make a PR with one long review
  # thread look like a contentious one.
  comments { totalCount }
  # Who owns the PR, and who has been asked to look at it. The two behave
  # differently over a PR's life and the records have to reflect that:
  # assignment survives the close, so it's meaningful on every record, while a
  # review request is deleted by GitHub the moment the review lands. On
  # anything closed the request list is therefore empty, and that's the truth
  # rather than a gap — nobody is waiting on a merged PR.
  assignees(first: 10) { nodes { login } }
  # What the PR is tagged as. Ten is generous — the busiest PR in the org
  # carries four — and the connection is cheap next to reviews(first: 50).
  # The Dream Panel gets its labels from a search query instead, because it
  # only ever asks about a handful of tracked names and a search is one
  # request for all of them; these are for the drilldowns, which need whatever
  # happens to be on the PR in front of you.
  labels(first: 10) { nodes { name } }
  # Individual reviewers only. A team request resolves to a Team, which has a
  # name rather than a login, and attributing one to its members needs org
  # read that this token doesn't have — so it selects nothing here and drops
  # out below rather than landing as a null in somebody's queue.
  reviewRequests(first: 20) {
    nodes { requestedReviewer { ... on User { login } } }
  }
  # totalCount only, no nodes — a reaction connection with no pagination args
  # is a scalar as far as the node budget is concerned.
  reactions { totalCount }
  thumbsUp: reactions(content: THUMBS_UP) { totalCount }
  thumbsDown: reactions(content: THUMBS_DOWN) { totalCount }
  # 50 PRs x 50 reviews = 2500 nodes/query, still well inside limits.
  # At 20 this truncated ~90 heavily-reviewed PRs; 50 covers all but a
  # handful, and reviewsTruncated flags whatever still overflows.
  reviews(first: 50) {
    totalCount
    nodes {
      state
      submittedAt
      author { login }
    }
  }
`;

const MAX_TITLE = 160;

export const PR_COLUMNS = [
  "repo", "number", "title", "author", "created_at", "updated_at", "merged_at",
  "closed_at", "state", "is_draft", "additions", "deletions", "changed_files",
  "commits", "comments", "reactions", "thumbs_up", "thumbs_down",
  "review_count", "reviews_truncated", "labels", "assignees", "review_requests",
];

export const reviewsTruncated = (pr) =>
  (pr.reviews?.totalCount ?? 0) > (pr.reviews?.nodes?.length ?? 0);

export function prValues(repo, pr) {
  return [
    repo,
    pr.number,
    pr.title ? pr.title.slice(0, MAX_TITLE) : null,
    pr.author?.login ?? null,
    pr.createdAt,
    pr.updatedAt,
    pr.mergedAt ?? null,
    pr.closedAt ?? null,
    pr.state,
    pr.isDraft == null ? null : pr.isDraft ? 1 : 0,
    pr.additions ?? null,
    pr.deletions ?? null,
    pr.changedFiles ?? null,
    pr.commits?.totalCount ?? null,
    pr.comments?.totalCount ?? null,
    pr.reactions?.totalCount ?? null,
    pr.thumbsUp?.totalCount ?? null,
    pr.thumbsDown?.totalCount ?? null,
    pr.reviews?.totalCount ?? null,
    reviewsTruncated(pr) ? 1 : 0,
    JSON.stringify((pr.labels?.nodes ?? []).map((l) => l.name).filter(Boolean)),
    JSON.stringify((pr.assignees?.nodes ?? []).map((a) => a.login).filter(Boolean)),
    JSON.stringify(
      (pr.reviewRequests?.nodes ?? []).map((n) => n.requestedReviewer?.login).filter(Boolean),
    ),
  ];
}
