/**
 * One drilldown subject's rows, fetched from D1 and shaped back into records.
 *
 * The drilldown is the one panel that is not reimplemented in SQL. Every other
 * one aggregates in the database and caches a blob; this one fetches a single
 * subject's rows and hands them to the same fold the build runs, because a full
 * materialisation is not expensive but impossible — three separate limits, and
 * `handoff.md` carries the numbers. So the job here is narrow: get the rows,
 * make them look like store records, and get out of the way.
 *
 * ## The SQL only has to be a superset
 *
 * This is the important thing about this file, and it is a deliberate departure
 * from how every other rule in this project is paired.
 *
 * The usual arrangement is a JavaScript rule and its SQL twin, generated side by
 * side and asserted against each other, because two implementations of one rule
 * drift silently. That works when both produce a *number*. Here the SQL produces
 * a *row set*, and `subjectRows` in the fold already decides membership exactly.
 * So these queries do not have to agree with it — they have to **contain** it.
 *
 * A superset is then narrowed by the JavaScript predicate, which is the same one
 * the build and the parity test use. That turns the entire class of
 * "SQL is narrower than the JavaScript" bugs — a person quietly missing from
 * their own page, the failure mode this port has produced nine times and always
 * in the flattering direction — into an impossibility rather than a thing to
 * test for. Being too wide costs a few milliseconds and cannot be wrong.
 *
 * It is also why the assignee and review-request predicates are `LIKE` against
 * the JSON column rather than `json_each`. `LIKE '%"login"%'` matches a login
 * that is a substring of another one, which under an exact-match contract would
 * be a bug and under this one is just a row that gets discarded. `json_each` was
 * measured as unnecessary once already for the issue panel; there is no reason
 * to reach for an untested D1 feature to answer a question that does not need a
 * precise answer.
 *
 * ## Two things the rows cannot answer
 *
 * `activeDays` used to be one and is not any more: every source of an active day
 * for a person is a row that reaches them, so the fold derives it. Proven
 * against the whole-store index rather than argued.
 *
 * `firstIssueBy` still is, and only for a repo. `newReporters` asks whether a
 * reporter's first issue *ever* falls in the window, and a repo's own issues
 * date it to their first one there — so every returning reporter reads as new.
 * `firstIssueFor` below answers it with one query. The fold refuses to guess it.
 */

/**
 * Columns the fold reads, stated once.
 *
 * Listed rather than `SELECT *` for the reason the issue panel learned the hard
 * way: a column left out of a projection is a rule quietly changed, and
 * `filedUnanswered` read one high for three weeks because `response_unknown`
 * was missing from a SELECT and `isUnanswered` saw `undefined`. Listing them
 * beside the shaper that consumes them is what keeps the two in step.
 */
export const PR_COLUMNS = `repo, number, title, author, created_at, updated_at,
  merged_at, closed_at, state, is_draft, additions, deletions, changed_files,
  commits, comments, thumbs_up, thumbs_down, labels, assignees,
  review_requests`;

export const ISSUE_COLUMNS = `repo, number, title, author, created_at,
  updated_at, closed_at, state, state_reason, labels, assignees, comments,
  first_response_at, first_responder, response_unknown, closed_by, closer_known,
  closed_via_kind, closed_via_repo, closed_via_number, closed_via_author,
  thumbs_up, thumbs_down`;

const json = (s) => {
  try {
    return JSON.parse(s || "[]");
  } catch {
    return [];
  }
};

/** A flat pull request row, plus its reviews, as the store writes it. */
export const prRecord = (r, reviews = []) => ({
  repo: r.repo,
  number: r.number,
  title: r.title,
  author: r.author,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  mergedAt: r.merged_at,
  closedAt: r.closed_at,
  state: r.state,
  // null rather than false: "not a draft" and "never asked" render differently,
  // and the backlog card reads the difference.
  isDraft: r.is_draft == null ? null : r.is_draft === 1,
  additions: r.additions,
  deletions: r.deletions,
  changedFiles: r.changed_files,
  commits: r.commits,
  comments: r.comments,
  thumbsUp: r.thumbs_up,
  thumbsDown: r.thumbs_down,
  labels: json(r.labels),
  assignees: json(r.assignees),
  reviewRequests: json(r.review_requests),
  reviews,
});

/**
 * A flat issue row as the store writes it. `closedVia` is the one that matters:
 * the schema flattened it into four columns so closer attribution could be
 * queried, and the JavaScript expects it nested.
 */
export const issueRecord = (r) => ({
  repo: r.repo,
  number: r.number,
  title: r.title,
  author: r.author,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  closedAt: r.closed_at,
  state: r.state,
  stateReason: r.state_reason,
  labels: json(r.labels),
  assignees: json(r.assignees),
  comments: r.comments,
  firstResponseAt: r.first_response_at,
  firstResponder: r.first_responder,
  responseUnknown: r.response_unknown === 1,
  closedBy: r.closed_by,
  closerKnown: r.closer_known === 1,
  closedVia: r.closed_via_kind
    ? {
        kind: r.closed_via_kind,
        repo: r.closed_via_repo ?? null,
        number: r.closed_via_number ?? null,
        author: r.closed_via_author ?? null,
      }
    : null,
  thumbsUp: r.thumbs_up,
  thumbsDown: r.thumbs_down,
});

/**
 * Where a pull request can reach a contributor. A superset of `subjectRows`.
 *
 * The reviews arm is `EXISTS` rather than a row-value `IN`: D1's tolerance for
 * the latter is untested, and this port has already lost a deploy to a compound
 * SELECT that every local test accepted.
 */
const PR_REACHES = `author = ?1
  OR assignees LIKE ?2
  OR review_requests LIKE ?2
  OR EXISTS (SELECT 1 FROM reviews rv
             WHERE rv.repo = pull_requests.repo
               AND rv.pr_number = pull_requests.number
               AND rv.author = ?1)`;

const ISSUE_REACHES = `author = ?1
  OR first_responder = ?1
  OR closed_by = ?1
  OR closed_via_author = ?1
  OR assignees LIKE ?2`;

/**
 * Fetch one subject's rows. Four queries for a contributor, three for a repo.
 *
 * The reviews query repeats the pull request predicate rather than binding the
 * keys it just fetched: a person with five thousand pull requests would
 * otherwise need five thousand bind parameters, and D1 has a limit on those
 * well below that.
 */
export async function fetchSubjectRows(db, kind, id) {
  const like = `%${JSON.stringify(id)}%`;

  if (kind === "repos") {
    const [prRows, reviewRows, issueRows] = await Promise.all([
      db.prepare(`SELECT ${PR_COLUMNS} FROM pull_requests WHERE repo = ?1`).bind(id).all(),
      db
        .prepare(
          `SELECT repo, pr_number, author, state, submitted_at
             FROM reviews WHERE repo = ?1`,
        )
        .bind(id)
        .all(),
      db.prepare(`SELECT ${ISSUE_COLUMNS} FROM issues WHERE repo = ?1`).bind(id).all(),
    ]);
    return assemble(prRows.results, reviewRows.results, issueRows.results);
  }

  const [prRows, reviewRows, issueRows] = await Promise.all([
    db.prepare(`SELECT ${PR_COLUMNS} FROM pull_requests WHERE ${PR_REACHES}`).bind(id, like).all(),
    db
      .prepare(
        `SELECT rv.repo, rv.pr_number, rv.author, rv.state, rv.submitted_at
           FROM reviews rv
          WHERE EXISTS (SELECT 1 FROM pull_requests
                         WHERE pull_requests.repo = rv.repo
                           AND pull_requests.number = rv.pr_number
                           AND (${PR_REACHES}))`,
      )
      .bind(id, like)
      .all(),
    db.prepare(`SELECT ${ISSUE_COLUMNS} FROM issues WHERE ${ISSUE_REACHES}`).bind(id, like).all(),
  ]);
  return assemble(prRows.results, reviewRows.results, issueRows.results);
}

function assemble(prRows, reviewRows, issueRows) {
  const byPr = new Map();
  for (const r of reviewRows) {
    const key = `${r.repo}#${r.pr_number}`;
    let list = byPr.get(key);
    if (!list) byPr.set(key, (list = []));
    list.push({ author: r.author, state: r.state, submittedAt: r.submitted_at });
  }

  return {
    prs: prRows.map((r) => prRecord(r, byPr.get(`${r.repo}#${r.number}`) ?? [])),
    issues: issueRows.map(issueRecord),
  };
}

/**
 * Earliest issue per reporter, for the reporters of one repo.
 *
 * Restricted to the authors who filed here, because those are the only ones
 * `newReporters` asks about — but the MIN itself is taken over the whole table,
 * which is the entire point. Ordered by `(repo, number)` on a tie for the same
 * reason the issue panel is: GitHub stamps to the second, and two issues filed
 * in the same one would both look like somebody's first.
 */
export async function firstIssueFor(db, repo) {
  const { results } = await db
    .prepare(
      `SELECT author, created_at AS at, repo, number
         FROM issues
        WHERE author IN (SELECT author FROM issues WHERE repo = ?1 AND author IS NOT NULL)
          AND author IS NOT NULL
        ORDER BY author ASC, created_at ASC, repo ASC, number ASC`,
    )
    .bind(repo)
    .all();

  const out = new Map();
  for (const r of results) {
    if (out.has(r.author)) continue;
    out.set(r.author, { at: r.at, id: `${r.repo}#${r.number}` });
  }
  return out;
}
