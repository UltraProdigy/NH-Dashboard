/**
 * One drilldown subject, computed on the request and cached against the version.
 *
 * The only panel here that is not a blob the recompute builds. There are 7,047
 * subjects and materialising them in one pass fails on three limits
 * independently — memory, D1's thousand queries per invocation, and the write
 * cost of 14,100 billed writes every ten minutes — so the recompute builds the
 * two picker indexes and nothing else, and a subject is computed the first time
 * somebody looks at it.
 *
 * A cache entry is valid while its `version` matches the current one, which is
 * the same number `/api/version` serves and the recompute bumps. So a subject
 * costs one fold per version in which somebody views it, and nothing at all in
 * a version where nobody does. The median subject folds in under a millisecond
 * and the worst measures ~1.3 s projected; the row written is one row and one
 * index entry, against the 14,100 a full pass would spend on every tick.
 *
 * The fold is the *build's* fold, imported rather than reimplemented. That
 * trade was rejected for the whole store at 96 MB against a 128 MB isolate
 * ceiling, and one subject is 5.9 MB at the worst, so it runs the other way
 * here. It also means there is no second implementation to drift: the agreement
 * with `data/drilldown.json` is structural.
 */

import { subjectPayload, subjectRows } from "../../../src/shared/drilldown-fold.js";
import { fetchSubjectRows, firstIssueFor } from "../subject-rows.js";

/** Where a subject's rows come from, and what has to be true before folding. */
async function compute(db, kind, id, now) {
  const fetched = await fetchSubjectRows(db, kind, id);

  // The SQL returns a superset and this narrows it exactly — see the header of
  // `subject-rows.js` for why that is the contract rather than an exact twin.
  //
  // It bounds the work rather than deciding the answer, and that is worth
  // saying because it looks load-bearing and is not: the fold is already scoped
  // to one subject and sinks every row that is not about it, so handing it the
  // superset produces the same payload. Removing this line passes the whole
  // suite. Kept because the `LIKE` arms can match a login that is a substring of
  // another one, and folding a busy stranger's rows into a quiet person's
  // request is a cost nobody would ever look for.
  const rows = subjectRows(kind, id, fetched.prs, fetched.issues);

  // Only a repo needs this, and it needs it rather than deriving it: a repo's
  // own issues would date every reporter's first to the first one they filed
  // there, so returning reporters read as new. `subjectPayload` throws without
  // it, which is the behaviour that makes forgetting it loud.
  const firstIssueBy = kind === "repos" ? await firstIssueFor(db, id) : undefined;

  return subjectPayload(kind, id, rows, { now, firstIssueBy });
}

/**
 * Serve one subject, folding it only if the cached row is missing or stale.
 *
 * The write is deliberately not awaited by the response path — the caller hands
 * it to `waitUntil`, so a viewer never pays for the cache write and a failed
 * write costs a recomputation next time rather than an error now.
 */
export async function subject(env, db, kind, id, now = Date.now()) {
  const table = kind === "repos" ? "drilldown_repos" : "drilldown_contributors";
  const key = kind === "repos" ? "repo" : "login";

  const versionRow = await env.DB.prepare(
    "SELECT value FROM meta WHERE key = 'version'",
  ).first();
  const version = Number(versionRow?.value ?? 0);

  const cached = await env.DB.prepare(
    `SELECT payload, version FROM ${table} WHERE ${key} = ?`,
  )
    .bind(id)
    .first();

  if (cached && Number(cached.version) === version) {
    return { payload: cached.payload, version, hit: true, write: null };
  }

  const { payload, labelNames } = await compute(db, kind, id, now);
  if (!payload) return { payload: null, version, hit: false, write: null };

  // The label table travels with the payload rather than pointing into the
  // index blob. A cached row has to be readable on its own — the index it was
  // computed alongside can be rebuilt under it at any tick, and an index into a
  // table that has since been renumbered resolves to the wrong name rather than
  // to nothing, which is the failure that would never raise an error.
  const body = JSON.stringify({ ...payload, labelNames });

  // Written on the raw handle. `scope.js` rewrites `FROM issues` and friends
  // into filtered subqueries, and a write must never go through that.
  const write = env.DB.prepare(
    `INSERT INTO ${table} (${key}, payload, version) VALUES (?, ?, ?)
       ON CONFLICT(${key}) DO UPDATE SET payload = excluded.payload,
                                         version = excluded.version`,
  )
    .bind(id, body, version)
    .run();

  return { payload: body, version, hit: false, write };
}
