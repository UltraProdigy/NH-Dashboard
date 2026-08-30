/**
 * A database handle that cannot read an excluded repo.
 *
 * Excluded repos stay in D1 — the operator can still query them directly — but
 * nothing the Worker *serves* may contain them, and `/api/panel/:name` is
 * public with permissive CORS. The Node build gets this for free because
 * `readStore` filters on the way out; a SQL panel reads D1 and would bypass
 * that entirely.
 *
 * The obvious fix is a predicate in every query. There are thirty-odd, across
 * two panels and four more to come, and the failure mode of forgetting one is a
 * repo on a public page rather than an error — which is exactly the shape of
 * bug that put an excluded repo on the public site in the first place. So the
 * filtering happens once, here, by wrapping the handle: a panel is handed a
 * `db` that rewrites `FROM issues` into `FROM (SELECT * FROM issues WHERE …)`
 * before preparing anything, and there is no unscoped handle for it to use by
 * mistake.
 *
 * Rewriting SQL by regex is normally a bad idea. It is safe here for reasons
 * worth stating, because they are what would stop being true if someone changed
 * this:
 *
 *   Every query in this Worker is written in this repo. None is assembled from
 *   user input, and no table name arrives as a bound parameter.
 *
 *   The rewrite only ever fires on `FROM`/`JOIN` immediately followed by one of
 *   the known table names. A CTE called `ranked` or `approver` is untouched;
 *   a CTE named after a real table would be rewritten, so do not name one that.
 *
 *   With no exclusions configured it is the identity. The expressions collapse
 *   to bare table names, the SQL is byte-for-byte what the panel wrote, and the
 *   query plans are unchanged.
 */

import { includedRepoSql, parseRepoList } from "../../src/shared/repo-rules.js";

/** Tables carrying a `repo` column, and therefore filterable. */
const TABLES = [
  "pull_requests",
  "reviews",
  "issues",
  "traffic_daily",
  "commits",
  "releases",
  "workflow_runs",
];

const REFERENCE = new RegExp(`\\b(FROM|JOIN)\\s+(${TABLES.join("|")})\\b`, "g");

/**
 * The rewritten SQL for one exclusion list. Exported so the test can assert the
 * rewrite happens, rather than inferring it from a panel's output.
 */
export function scopeSql(sql, patterns) {
  if (!patterns.length) return sql;
  const where = includedRepoSql("repo", patterns);
  return sql.replace(
    REFERENCE,
    (_, keyword, table) =>
      `${keyword} (SELECT * FROM ${table} WHERE ${where})`,
  );
}

/**
 * Wrap a D1 handle so every statement it prepares is scoped.
 *
 * `batch` and `exec` are passed through untouched deliberately: nothing in the
 * read path uses them, and silently rewriting a write would be a much worse
 * surprise than a missing filter on a query that does not exist yet. If a panel
 * ever needs `batch`, scope it there and add a case here.
 */
export function scopedDb(db, env) {
  const patterns = parseRepoList(env?.NH_INGEST_EXCLUDE);
  if (!patterns.length) return db;

  return {
    prepare: (sql) => db.prepare(scopeSql(sql, patterns)),
    batch: (...a) => db.batch(...a),
    exec: (...a) => db.exec(...a),
    excluded: patterns.length,
  };
}
