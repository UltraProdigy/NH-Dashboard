/**
 * Contributor activity, aggregated in SQL.
 *
 * The Node panel of the same name walks the ingest store in JavaScript. Here
 * the counting happens inside D1 instead and this module only stitches three
 * result sets together, because query time is I/O and does not count against a
 * Worker's CPU budget while a loop over 96,000 rows very much does.
 *
 * That was a hard requirement on the free plan's 10ms; on Paid it is headroom
 * rather than survival. It is still the right shape — the alternative reads
 * every row into an isolate to compute numbers SQLite can produce without
 * leaving the database.
 *
 * The output matches the Node panel's exactly. `test/contributors.parity.test.js`
 * asserts that against a real seed rather than trusting it.
 */

import {
  WINDOWS,
  isBot,
  byActivityThenLogin,
} from "../../../src/shared/contributor-rules.js";

const DAY = 86_400_000;

/** The dated windows, as ISO instants — `all` has no lower bound. */
function bounds(now) {
  return WINDOWS.filter((w) => w.days !== null).map((w) => ({
    id: w.id,
    from: new Date(now - w.days * DAY).toISOString(),
  }));
}

/**
 * `SUM(col >= ?)` rather than a CASE: in SQLite a comparison is already 1 or 0,
 * and a comparison against NULL is NULL, which SUM skips. That is exactly the
 * behaviour wanted for `merged_at` — an unmerged PR should not count, and
 * should not need a branch to say so.
 */
function windowSums(column, prefix, dated) {
  return dated.map((w) => `SUM(${column} >= ?) AS ${prefix}_${w.id}`).join(",\n         ");
}

async function prCounts(db, dated) {
  const sql = `
    SELECT author AS login,
           COUNT(*) AS prs_all,
           ${windowSums("created_at", "prs", dated)},
           SUM(merged_at IS NOT NULL) AS merged_all,
           ${windowSums("merged_at", "merged", dated)},
           MIN(created_at) AS first_created,
           MAX(created_at) AS last_created,
           MIN(merged_at) AS first_merged,
           MAX(merged_at) AS last_merged
      FROM pull_requests
     WHERE author IS NOT NULL
     GROUP BY author`;

  const params = [...dated.map((w) => w.from), ...dated.map((w) => w.from)];
  return (await db.prepare(sql).bind(...params).all()).results;
}

/**
 * One approval per reviewer per pull request.
 *
 * Re-approving after changes should not inflate anyone's numbers, so the inner
 * query collapses to a single row per (author, pr) and takes the earliest
 * submission. The Node panel takes the first approval in store order instead;
 * those agree whenever the store is chronological, and MIN is the more
 * defensible of the two when it isn't.
 */
async function approvalCounts(db, dated) {
  const sql = `
    SELECT login,
           COUNT(*) AS approvals_all,
           ${windowSums("first_at", "approvals", dated)},
           MIN(first_at) AS first_seen,
           MAX(first_at) AS last_seen
      FROM (SELECT author AS login, MIN(submitted_at) AS first_at
              FROM reviews
             WHERE state = 'APPROVED' AND author IS NOT NULL
             GROUP BY author, repo, pr_number)
     GROUP BY login`;

  return (await db.prepare(sql).bind(...dated.map((w) => w.from)).all()).results;
}

/**
 * Distinct days each person did something, and their first such day.
 *
 * The six arms mirror `src/panels/activeDays.js` exactly, including what is
 * deliberately absent: somebody else merging your pull request is not a day you
 * worked. `UNION` rather than `UNION ALL` because the same person doing three
 * things on one day is one day.
 *
 * Note the denominator is not computed here. A fixed window's denominator is
 * the window; all-time's is first-active-day to today. Both are decided by the
 * caller so that one definition serves every panel.
 */
async function activeDays(db, dated) {
  // Three queries and a merge, rather than the one six-arm UNION this obviously
  // wants to be. D1 caps the number of terms in a compound SELECT far below
  // SQLite's own default, and rejects six with "too many terms in compound
  // SELECT". Local SQLite accepts it, so this cannot be caught anywhere but
  // against D1 itself.
  //
  // The issue rows come back unpivoted — four possible (login, day) pairs per
  // row — and are expanded here. Deduplication then has to happen in JS, which
  // is what the UNION was doing: one person doing three things on one day is
  // one day.
  const [prs, reviews, issues] = await Promise.all([
    db
      .prepare(
        `SELECT DISTINCT author AS login, substr(created_at, 1, 10) AS day
           FROM pull_requests WHERE author IS NOT NULL`,
      )
      .all(),
    db
      .prepare(
        `SELECT DISTINCT author AS login, substr(submitted_at, 1, 10) AS day
           FROM reviews
          WHERE author IS NOT NULL AND submitted_at IS NOT NULL`,
      )
      .all(),
    db
      .prepare(
        `SELECT author,
                substr(created_at, 1, 10) AS created_day,
                first_responder,
                substr(first_response_at, 1, 10) AS response_day,
                closed_by,
                CASE WHEN closed_via_kind = 'pr' THEN closed_via_author END
                  AS fixer,
                substr(closed_at, 1, 10) AS closed_day
           FROM issues`,
      )
      .all(),
  ]);

  const sets = new Map();
  const mark = (login, day) => {
    if (!day || isBot(login)) return;
    let s = sets.get(login);
    if (!s) sets.set(login, (s = new Set()));
    s.add(day);
  };

  for (const r of prs.results) mark(r.login, r.day);
  for (const r of reviews.results) mark(r.login, r.day);
  for (const r of issues.results) {
    mark(r.author, r.created_day);
    mark(r.first_responder, r.response_day);
    mark(r.closed_by, r.closed_day);
    mark(r.fixer, r.closed_day);
  }

  // Bounds truncated to `YYYY-MM-DD` to match the day keys. Comparing a day
  // against a full instant would put `2026-08-29` before `2026-08-29T00:00:00Z`
  // and silently drop the boundary day.
  const from = dated.map((w) => ({ id: w.id, day: w.from.slice(0, 10) }));

  const out = [];
  for (const [login, days] of sets) {
    const row = { login, days_all: days.size, first_day: null };
    for (const w of from) row[`days_${w.id}`] = 0;
    for (const day of days) {
      if (row.first_day === null || day < row.first_day) row.first_day = day;
      for (const w of from) if (day >= w.day) row[`days_${w.id}`]++;
    }
    out.push(row);
  }
  return out;
}

const minISO = (a, b) => (!a ? b : !b ? a : a < b ? a : b);
const maxISO = (a, b) => (!a ? b : !b ? a : a > b ? a : b);

export async function contributors(db, now = Date.now()) {
  const dated = bounds(now);

  // Three round trips, not one join. D1 allows 50 queries per invocation on the
  // free plan, so the budget is not the constraint; a three-way join over
  // grouped subqueries would be slower and far harder to read.
  const [prs, approvals, active] = await Promise.all([
    prCounts(db, dated),
    approvalCounts(db, dated),
    activeDays(db, dated),
  ]);

  const people = new Map();
  const entry = (login) => {
    let p = people.get(login);
    if (!p) {
      p = { login, firstSeen: null, lastSeen: null };
      for (const w of WINDOWS) p[w.id] = { prs: 0, merged: 0, approvals: 0 };
      people.set(login, p);
    }
    return p;
  };

  for (const r of prs) {
    if (isBot(r.login)) continue;
    const p = entry(r.login);
    p.all.prs = r.prs_all;
    p.all.merged = r.merged_all;
    for (const w of dated) {
      p[w.id].prs = r[`prs_${w.id}`] ?? 0;
      p[w.id].merged = r[`merged_${w.id}`] ?? 0;
    }
    p.firstSeen = minISO(minISO(p.firstSeen, r.first_created), r.first_merged);
    p.lastSeen = maxISO(maxISO(p.lastSeen, r.last_created), r.last_merged);
  }

  for (const r of approvals) {
    if (isBot(r.login)) continue;
    const p = entry(r.login);
    p.all.approvals = r.approvals_all;
    for (const w of dated) p[w.id].approvals = r[`approvals_${w.id}`] ?? 0;
    p.firstSeen = minISO(p.firstSeen, r.first_seen);
    p.lastSeen = maxISO(p.lastSeen, r.last_seen);
  }

  // Active days are indexed separately because they are keyed on a wider set of
  // people than the PR store knows about — a triager who never opened a pull
  // request still has days worked, and the drilldown must agree with this page
  // about how many.
  const byLogin = new Map(active.map((r) => [r.login, r]));
  const today = new Date(now).toISOString().slice(0, 10);
  const dayNo = (key) => Math.round(Date.parse(key) / DAY);

  // Mutating the window objects rather than spreading them into new ones. At
  // seven windows across 1,214 people that spread was ~8,500 allocations, and
  // on a 10ms budget it was most of the cost of this function.
  const todayNo = dayNo(today);
  const rows = [];
  for (const p of people.values()) {
    const a = byLogin.get(p.login);
    const allTimeDenom = a?.first_day ? todayNo - dayNo(a.first_day) + 1 : 0;
    for (const w of WINDOWS) {
      const win = p[w.id];
      if (w.days === null) {
        win.activeDays = a?.days_all ?? 0;
        win.activeDenom = allTimeDenom;
      } else {
        win.activeDays = a?.[`days_${w.id}`] ?? 0;
        win.activeDenom = w.days;
      }
    }
    rows.push(p);
  }

  rows.sort(byActivityThenLogin);

  // `truncated` is not cosmetic: those PRs had more reviews than the ingest
  // fetched, so every approval count here is a floor, not a total. The frontend
  // says so when this is non-zero, and a hardcoded 0 would have quietly turned
  // that warning off.
  const total = await db
    .prepare(
      `SELECT COUNT(*) AS n, SUM(reviews_truncated) AS truncated
         FROM pull_requests`,
    )
    .first();

  return {
    windows: WINDOWS,
    rows,
    totalPRs: total?.n ?? 0,
    truncated: total?.truncated ?? 0,
  };
}
