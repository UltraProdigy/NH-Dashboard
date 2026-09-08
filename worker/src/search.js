/**
 * Lookup, as opposed to analysis.
 *
 * Every other read in this Worker answers a question about the org: how many,
 * how fast, by whom. This one answers "where is that issue about NEI crashing
 * on world load", which is a different job and is why it is not a panel.
 *
 * Three properties follow from that, and they are the whole design:
 *
 *   It cannot be cached. `panel_cache` holds one blob per panel because every
 *   viewer of a panel gets the same answer. Every search is a different answer,
 *   so there is nothing to compute once and serve to all.
 *
 *   It has no freshness tier. A panel is `instant`, `cron` or `build`; a search
 *   reads the tables directly and is therefore always as current as the last
 *   webhook delivery. The frontend draws no tint for it, which is honest rather
 *   than a gap — see `PAGE_PANEL` in web/js/data.js.
 *
 *   It reads rows in proportion to the store rather than to the answer. A text
 *   match is a scan of 26,161 issues and 29,091 pull requests, and that is a
 *   deliberate trade: see the note on `instr` below.
 */

import { DEFAULT_ORG } from "../../src/shared/analytics-rules.js";

/**
 * How many rows a search returns, and the reason there is no total.
 *
 * A count of everything that matched would be a second scan of both tables to
 * produce a number nobody acts on — "1,284 results" and "50+ results" lead to
 * exactly the same next move, which is to narrow the filters. So the query asks
 * for one row more than it will show, and the extra row's existence is the
 * whole of what gets reported.
 */
const PAGE = 50;

/** Bounds on list filters, so a hand-written URL cannot ask for 4,000 binds. */
const MAX_TERMS = 20;

/**
 * Sorts, as a fixed map rather than a column name off the query string.
 *
 * The value is interpolated into SQL — it cannot be a bind parameter, since
 * SQLite will not take an ORDER BY column as one — so it must never be caller
 * text. A lookup in a literal map is what makes that structurally true instead
 * of a validation step someone can forget to call.
 *
 * Every one is total. Ties broken on `repo, number` rather than left to the
 * query plan, for the reason `issueOrderSql` gives: 723 pairs in this store
 * share a `(comments, number)`, and an unstable order under a LIMIT returns
 * whichever rows D1 felt like that day. `(repo, number)` is unique across both
 * tables at once, because GitHub numbers issues and pull requests from one
 * sequence per repo — so this is a total order over the union, not merely over
 * each half.
 */
const SORTS = {
  updated: "updated_at DESC, repo ASC, number ASC",
  created: "created_at DESC, repo ASC, number ASC",
  oldest: "created_at ASC, repo ASC, number ASC",
  comments: "comments DESC, repo ASC, number ASC",
};

/**
 * State filters, and why `closed` is not the negation of `open`.
 *
 * A pull request has three states and an issue has two. Reading "closed" as
 * `state <> 'OPEN'` would therefore fold merged pull requests into it, and
 * "closed" is precisely the word this org uses for the ones that were *not*
 * merged. Each filter names the states it means.
 */
const STATES = {
  open: ["OPEN"],
  closed: ["CLOSED"],
  merged: ["MERGED"],
};

const KINDS = { issue: ["issue"], pr: ["pr"], both: ["issue", "pr"] };

/** Comma-separated list from the query string, trimmed and bounded. */
const terms = (raw) =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_TERMS);

/**
 * One half of the union.
 *
 * The two tables carry different columns — a pull request has `merged_at` and
 * `is_draft`, an issue has `state_reason` — so each side pads the other's with
 * NULL and the shapes line up. Written as one UNION ALL rather than two queries
 * merged in JavaScript so that the ORDER BY and the LIMIT are D1's problem:
 * merging two sorted lists here would mean over-fetching from both halves to be
 * sure of the top fifty, which is the extra scan this avoids.
 */
function half(kind, table, where) {
  const extra = kind === "pr"
    ? "merged_at, is_draft, NULL AS state_reason"
    : "NULL AS merged_at, NULL AS is_draft, state_reason";
  return `SELECT '${kind}' AS kind, repo, number, title, author, created_at,
                 updated_at, closed_at, state, labels, comments, ${extra}
            FROM ${table}
           ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
}

/**
 * The predicates one half needs, and the binds that go with them.
 *
 * Every caller-supplied value is a bind. The only things interpolated are the
 * `?` placeholders themselves and the sort expression, both generated here from
 * counts and from a literal map — so there is no path from the query string
 * into the SQL text, and `scopeSql`'s guarantee that no table name arrives as a
 * parameter still holds.
 */
function conditions(kind, opts) {
  const where = [];
  const binds = [];

  // Matched on the lowered title with `instr` rather than `LIKE '%…%'`, which
  // is the same scan with two fewer ways to be wrong: no `%` or `_` in a
  // repo name or a title fragment to escape, and no dependence on SQLite's
  // ASCII-only LIKE case folding. The frontend's own `applyFilter` matches by
  // `String(v).toLowerCase().includes(q)`, and this is that predicate exactly,
  // so a filter typed on a card and a search typed here agree about what a
  // match is.
  //
  // It is a full scan of both tables — 55,252 rows — and that is a measured
  // trade rather than an assumed one: **9.3ms on the local replica**, so about
  // 20ms projected on D1 at the 2.2x ratio `analytics` established. Reads cost
  // 55k rows against the 25 billion a month the Paid plan includes, which is
  // roughly 450,000 searches before the allowance is the constraint.
  //
  // An FTS5 trigram index would make it a lookup instead, and would have to be
  // kept in step with every writer in handlers.js by trigger — a
  // synchronisation whose failure mode is a search quietly returning last
  // week's answers. At 20ms there is nothing to buy with that risk. The number
  // to watch is the scan, not the budget: this doubles as the store does.
  if (opts.q) {
    where.push("instr(lower(title), ?) > 0");
    binds.push(opts.q.toLowerCase());
  }

  if (opts.number != null) {
    where.push("number = ?");
    binds.push(opts.number);
  }

  if (opts.repos.length) {
    where.push(`repo IN (${opts.repos.map(() => "?").join(", ")})`);
    binds.push(...opts.repos);
  }

  if (opts.authors.length) {
    where.push(`lower(author) IN (${opts.authors.map(() => "?").join(", ")})`);
    binds.push(...opts.authors.map((a) => a.toLowerCase()));
  }

  // A state that does not exist on this side of the union is a contradiction
  // rather than an omission: asking for merged issues must return no issues,
  // not every issue. `1 = 0` says so in SQL and lets the other half answer
  // normally.
  if (opts.states.length) {
    const live = opts.states.filter((s) => kind === "pr" || s !== "MERGED");
    if (!live.length) where.push("1 = 0");
    else {
      where.push(`state IN (${live.map(() => "?").join(", ")})`);
      binds.push(...live);
    }
  }

  // Labels are a JSON array of names on the row rather than a link table — see
  // the schema's note on why — so membership is `json_each` rather than a join.
  // Several labels read as "any of these", which is what a row of chips looks
  // like it means.
  if (opts.labels.length) {
    const any = opts.labels
      .map(() => "EXISTS (SELECT 1 FROM json_each(labels) WHERE lower(value) = ?)")
      .join(" OR ");
    where.push(`(${any})`);
    binds.push(...opts.labels.map((l) => l.toLowerCase()));
  }

  return { where, binds };
}

/**
 * Parse the query string into the shape `search` takes.
 *
 * Separated from the query so the tests can assert on what a URL means without
 * a database, and so that a bad parameter has one place to be corrected in
 * rather than being defaulted differently by each reader.
 *
 * A bare `#4821` or `4821` in the text box is read as a number and nothing
 * else. It is the one search that is a lookup rather than a scan — an index
 * hit on the primary key — and it is also what somebody pasting a number from
 * a Discord message means every time.
 */
export function parseSearch(params) {
  const raw = (params.get("q") ?? "").trim();
  const asNumber = /^#?\d+$/.test(raw) ? Number(raw.replace("#", "")) : null;

  const sort = SORTS[params.get("sort")] ? params.get("sort") : "updated";
  const kinds = KINDS[params.get("type")] ?? KINDS.both;

  const states = terms(params.get("state"))
    .flatMap((s) => STATES[s] ?? [])
    // Deduped because `state=open,open` is a hand-written URL, not an error
    // worth refusing.
    .filter((s, i, all) => all.indexOf(s) === i);

  return {
    q: asNumber == null ? raw : "",
    number: asNumber,
    kinds,
    sort,
    repos: terms(params.get("repo")),
    authors: terms(params.get("author")),
    labels: terms(params.get("label")),
    states,
    limit: PAGE,
  };
}

/** The GitHub URL for a row. Derived rather than stored, like every other. */
const urlOf = (r) =>
  `https://github.com/${DEFAULT_ORG}/${r.repo}/${r.kind === "pr" ? "pull" : "issues"}/${r.number}`;

const days = (from, to) =>
  from == null ? null : Math.floor((to - Date.parse(from)) / 86_400_000);

/**
 * Run a search.
 *
 * `db` must be the scoped handle. Every `FROM issues` and `FROM pull_requests`
 * below is rewritten by it into a subquery that cannot see an excluded repo —
 * note that `FROM json_each(labels)` is untouched, since the rewrite only fires
 * on the known table names, and that a search is exactly the endpoint where a
 * missed exclusion would be most visible.
 */
export async function search(db, opts, now = Date.now()) {
  // An empty search is not an error and not every row in the store. There is
  // no query to answer yet, and returning 50 arbitrary issues would look like
  // an answer to one.
  if (!opts.q && opts.number == null && !opts.repos.length &&
      !opts.authors.length && !opts.labels.length && !opts.states.length) {
    return { rows: [], truncated: false, empty: true };
  }

  const parts = [];
  const binds = [];
  for (const kind of opts.kinds) {
    const table = kind === "pr" ? "pull_requests" : "issues";
    const { where, binds: b } = conditions(kind, opts);
    parts.push(half(kind, table, where));
    binds.push(...b);
  }

  const sql = `${parts.join("\n UNION ALL\n")}
     ORDER BY ${SORTS[opts.sort]}
     LIMIT ?`;

  const rows = (await db.prepare(sql).bind(...binds, opts.limit + 1).all()).results;

  const truncated = rows.length > opts.limit;
  return {
    truncated,
    empty: false,
    rows: rows.slice(0, opts.limit).map((r) => ({
      kind: r.kind,
      repo: r.repo,
      number: r.number,
      title: r.title ?? "",
      // Bots are left as themselves. The panels null a bot author because a
      // leaderboard credited to a bot is a wrong answer about people; a search
      // for a bot's pull request is a perfectly ordinary thing to want, and
      // hiding the name would only make the row unattributable.
      author: r.author,
      url: urlOf(r),
      labels: JSON.parse(r.labels || "[]"),
      state: r.state,
      draft: r.is_draft == null ? null : !!r.is_draft,
      reason: r.state_reason,
      comments: r.comments ?? 0,
      ageDays: days(r.created_at, now),
      staleDays: days(r.updated_at, now),
    })),
  };
}
