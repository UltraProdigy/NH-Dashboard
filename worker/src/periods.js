/**
 * Windows, and the machinery for answering the same question about all of them
 * at once.
 *
 * Every windowed panel here has the same shape of problem: seven windows plus
 * the six equal-length periods before them for the deltas, thirteen answers
 * wanted from one pass over the store. `analytics` solved that first and paid
 * for the solution — 6,306ms on its first production recompute, taken down to
 * 3,080ms across three wrong theories and one right one — and `issues` needs
 * exactly the same thing for its `byWindow` rollup.
 *
 * So this is the analytics panel's own code, lifted out rather than copied.
 * Two implementations of a percentile across periods would be two things to be
 * wrong in different ways, and the cost of finding that out is a deploy each.
 * `analytics.parity.test.js` is what makes the extraction safe: it compares 25
 * assertions of that panel's output against the build, so a refactor that moved
 * a bound or dropped a window frame fails immediately.
 */

import { WINDOWS } from "../../src/shared/contributor-rules.js";
import { isoBound, pctRankSql } from "../../src/shared/analytics-rules.js";

const DAY = 86_400_000;

/**
 * Finite stand-ins for the unbounded ends of a period.
 *
 * The JavaScript uses ±Infinity, which cannot cross the D1 wire — parameters
 * are serialised as JSON and `Infinity` becomes `null` on the way, which would
 * silently turn every comparison into NULL and every count into zero.
 *
 * Timestamps in the same fixed-width shape as the stored ones, so they sort
 * with them rather than beside them, and outside anything GitHub can stamp.
 */
export const NEVER = "0000-01-01T00:00:00Z";
export const FOREVER = "9999-12-31T23:59:59Z";

/**
 * The thirteen periods: each window, plus an equal-length one immediately
 * before it for the deltas. All-time has nothing before it.
 *
 * Bounds are ISO strings rather than epoch seconds, so every window comparison
 * is a plain lexical one. `strftime` parses a date per row per call — measured
 * at 43ms a query against 7ms for the string compare, in panels that do this a
 * dozen times over 29,000 rows. `isoBound` carries the argument for why the two
 * are equivalent, and why both ends may ceil the same way.
 */
export function periodsFor(now) {
  const out = [];
  for (const w of WINDOWS) {
    out.push({
      key: w.id,
      from: w.days == null ? NEVER : isoBound(now - w.days * DAY),
      to: FOREVER,
    });
    if (w.days != null) {
      out.push({
        key: `prev:${w.id}`,
        from: isoBound(now - 2 * w.days * DAY),
        to: isoBound(now - w.days * DAY),
      });
    }
  }
  return out;
}

/** `SUM(col in period)` for every period, as one column each. */
export const periodSums = (expr, prefix, periods) =>
  periods
    .map((_, i) => `SUM(${expr("?", "?")}) AS ${prefix}_${i}`)
    .join(",\n           ");

/** The bound pairs those columns consume, in the order they appear. */
export const periodParams = (periods) => periods.flatMap((p) => [p.from, p.to]);

/**
 * One value set, its percentiles taken separately for all thirteen periods, in
 * a single query.
 *
 * The obvious shape is a query per period: filter to the period, `ROW_NUMBER()`
 * over the survivors, take the row `pctRankSql` names. It is much easier to
 * read and it was the first version. It also rebuilds the value set thirteen
 * times, and for first-review hours that set costs a join and a grouping over
 * 41,000 reviews — 6.3 seconds for the panel on D1, against 400ms for
 * contributors.
 *
 * So the set is built once and the ranking is done thirteen times over it
 * instead, with a running count of the rows that belong to each period:
 *
 *   k_i = SUM(row is in period i) OVER (ORDER BY v ROWS UNBOUNDED PRECEDING)
 *
 * For the row at in-period rank `r`, `k_i` first reaches `r`. Rows after it
 * that are outside the period carry the same `k_i` and a larger `v`, and every
 * row before it carries a smaller one — so `MIN(v) WHERE k_i = r` is exactly
 * the row a per-period `ROW_NUMBER()` would have picked.
 *
 * `ROWS UNBOUNDED PRECEDING` is load-bearing and not the default. The default
 * frame is RANGE, which lumps in every row tied on `v` — so a group of three
 * equal values would jump the running count past a rank sitting inside it, and
 * the pick would find no row and return NULL. RANGE is right for a great many
 * things and wrong for counting.
 *
 * An empty period yields NULL, which is the `null` the Node panels return for
 * the same case; the `n_i > 0` guard is what stops rank 0 from matching every
 * row that precedes the first in-period one.
 */
export async function percentilesAcrossPeriods(
  db,
  periods,
  { with: cte, source, at },
  ps,
) {
  const inPeriod = `${at} >= ? AND ${at} < ?`;

  const counts = periods
    .map((_, i) => `SUM(${inPeriod}) AS n_${i}`)
    .join(",\n             ");

  const running = periods
    .map(
      (_, i) =>
        `SUM(CASE WHEN ${inPeriod} THEN 1 ELSE 0 END)
               OVER (ORDER BY v ROWS UNBOUNDED PRECEDING) AS k_${i}`,
    )
    .join(",\n             ");

  const picks = periods
    .flatMap((_, i) =>
      ps.map(
        (p) =>
          `(SELECT MIN(v) FROM ranked
                WHERE n.n_${i} > 0
                  AND k_${i} = ${pctRankSql(`n.n_${i}`, p)}) AS p${p}_${i}`,
      ),
    )
    .join(",\n         ");

  const sql = `
    WITH ${cte ? `${cte},\n    ` : ""}vals AS (${source})
    , n AS (SELECT ${counts} FROM vals)
    , ranked AS (SELECT v, ${running} FROM vals)
    SELECT ${periods.map((_, i) => `n.n_${i}`).join(", ")},
           ${picks}
      FROM n`;

  const bounds = periodParams(periods);
  const row = await db
    .prepare(sql)
    .bind(...bounds, ...bounds)
    .first();

  return periods.map((_, i) => ({
    n: row?.[`n_${i}`] ?? 0,
    ...Object.fromEntries(ps.map((p) => [`p${p}`, row?.[`p${p}_${i}`] ?? null])),
  }));
}
