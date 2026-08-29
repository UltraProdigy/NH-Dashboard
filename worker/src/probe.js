/**
 * TEMPORARY. Delete once the analytics recompute time is settled.
 *
 * The analytics panel rebuilds in ~5.1 seconds across 33 queries — about 155ms
 * each — where contributors manages ~75ms each across five. Removing ten of
 * those queries bought back only 1.2s, which is what you would expect if most
 * of the cost is charged per query rather than per row.
 *
 * This measures that directly instead of inferring it. Three shapes, two
 * queries, so the two questions come apart:
 *
 *   `trivial` is `SELECT 1` — no table, no rows. Whatever it costs is pure
 *   round trip, and 33 of those is the floor no rewrite can get under.
 *
 *   `scan` counts the pull_requests table. The gap between the two is what the
 *   work itself costs.
 *
 * And three ways of issuing them: one after another, all handed to
 * `Promise.all`, and one `batch()`. The panel currently uses the middle one on
 * the assumption that it overlaps the round trips. If sequential and Promise.all
 * come back the same, it does not, and `batch()` is the only thing that does.
 */

const N = 33;

async function timed(fn) {
  const started = Date.now();
  await fn();
  return Date.now() - started;
}

const SHAPES = {
  trivial: "SELECT 1 AS n",
  scan: "SELECT COUNT(*) AS n FROM pull_requests",
};

export async function probe(env) {
  const out = {};

  for (const [shape, sql] of Object.entries(SHAPES)) {
    const stmt = () => env.DB.prepare(sql);

    // Warm first, and never report the warm-up: the first query of an
    // invocation pays for whatever connection setup the others then reuse, and
    // attributing that to "sequential" purely because it runs first is how a
    // measurement invents the answer it was looking for.
    await stmt().first();

    out[shape] = {
      sequential: await timed(async () => {
        for (let i = 0; i < N; i++) await stmt().first();
      }),
      promiseAll: await timed(() =>
        Promise.all(Array.from({ length: N }, () => stmt().first())),
      ),
      batch: await timed(() =>
        env.DB.batch(Array.from({ length: N }, () => stmt())),
      ),
    };
  }

  return { n: N, ms: out };
}
