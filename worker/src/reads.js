/**
 * The dashboard's read API, served by the app Worker behind Cloudflare Access.
 * The webhook Worker only uses handleHealth, for the deploy check.
 */

import { refreshTier } from "./recompute.js";
import { facets, parseSearch, search } from "./search.js";
import { subject } from "./panels/drilldown-subject.js";
import { scopedDb } from "./scope.js";
import { panelsFor } from "../../web/js/roles.js";
import { DEFAULT_ORG } from "../../src/shared/analytics-rules.js";

export const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
};

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export async function handleVersion(env) {
  const { results } = await env.DB.prepare(
    "SELECT key, value FROM meta WHERE key IN ('version', 'checked_at', 'behind')",
  ).all();
  const meta = Object.fromEntries(results.map((r) => [r.key, r.value]));

  let behind = [];
  try {
    behind = JSON.parse(meta.behind ?? "[]");
  } catch {}

  return json({
    version: Number(meta.version ?? 0),
    checkedAt: meta.checked_at ?? null,
    behind,
  });
}

/**
 * `repos`, `commits` and `releases` are counted here because their emptiness is
 * invisible everywhere else.
 *
 * The seed never wrote a `repos` row, and the two release panels join it — so
 * "the backfill has not run" and "no repo needs a release" produce the same
 * empty card. A count is the only place the difference shows.
 */
export async function handleHealth(env) {
  const counts = {};
  for (const table of [
    "repos",
    "pull_requests",
    "reviews",
    "issues",
    "commits",
    "releases",
    "workflow_runs",
    "traffic_daily",
  ]) {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM ${table}`,
    ).first();
    counts[table] = row?.n ?? 0;
  }

  // The release panels read far fewer rows than the tables hold, and every
  // stage of that narrowing has been wrong at least once: the seed wrote no
  // repos at all, a flat lookback truncated the commit counts, and a stray
  // `private = 0` withheld seven repos. A row count per table cannot tell any
  // of those apart from "nothing to report", which is the failure mode this
  // whole endpoint exists to prevent.
  //
  // So this reports the funnel itself. If `withCommitsInWindow` matches what
  // the backfill wrote but a panel returns fewer rows, the rows are present and
  // the query is dropping them — which is a different bug from a partial load,
  // and telling those two apart from the outside is otherwise guesswork.
  //
  // Counts only, deliberately: repo names would put the private ones on a
  // public endpoint, and no question here needs them.
  const window = `date('now', '-365 days') || 'T00:00:00Z'`;
  const scope = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM repos WHERE archived = 0) AS live,
       (SELECT COUNT(*) FROM repos WHERE commits_since IS NOT NULL) AS withHorizon,
       (SELECT COUNT(*) FROM repos
         WHERE archived = 0
           AND pushed_at IS NOT NULL
           AND pushed_at < ${window}) AS droppedAsDormant,
       (SELECT COUNT(DISTINCT repo) FROM commits) AS withCommits,
       (SELECT COUNT(DISTINCT repo) FROM commits
         WHERE committed_at >= ${window}) AS withCommitsInWindow,
       (SELECT COUNT(*) FROM commits WHERE via_pr IS NULL) AS commitsAwaitingPrAnswer,
       -- Should be 0. A pushed_at made only of digits is a Unix epoch that was
       -- written where an ISO date belongs, which sorts below every real date
       -- and silently reads as dormant. Counted rather than assumed, because
       -- the symptom is a repo quietly missing from a card.
       (SELECT COUNT(*) FROM repos
         WHERE pushed_at IS NOT NULL
           AND pushed_at NOT GLOB '*[^0-9]*') AS reposWithEpochPushedAt,
       -- The CI panel's own funnel. A run is stored with the branch it ran on,
       -- and the panel keeps only runs matching the repo's *current* default
       -- branch — so a repo that renames master to main keeps every row it had
       -- and shows nothing at all. These two counts are the only place that
       -- difference is visible: reposWithRuns holds steady while
       -- reposWithRunsOnDefault drops, and the card just goes quiet.
       (SELECT COUNT(DISTINCT repo) FROM workflow_runs) AS reposWithRuns,
       (SELECT COUNT(DISTINCT r.repo) FROM workflow_runs r
          JOIN repos p ON p.name = r.repo
         WHERE p.archived = 0
           AND p.default_branch = r.head_branch) AS reposWithRunsOnDefault`,
  ).first();

  return json({ ok: true, counts, scope });
}

/**
 * Answer one search.
 *
 * Not a panel, and the differences are worth stating because every other read
 * route here is one. There is no cache to consult — each query is its own
 * answer — and no `x-refresh` header, because the tables are read directly and
 * a tier would be a claim about a rebuild that never happens. The frontend
 * draws no freshness tint on this page for the same reason.
 *
 * A failure is a 503 rather than an empty result set. "No issue matches that"
 * and "the database did not answer" are the two things a search must never
 * confuse, and an empty array would say the first while meaning the second.
 */
export async function handleSearch(env, url) {
  const db = scopedDb(env.DB, env);
  const opts = parseSearch(url.searchParams);

  try {
    return json(await search(db, opts));
  } catch (err) {
    console.log(JSON.stringify({ at: "search", error: String(err) }));
    return json({ error: "search failed" }, 503);
  }
}

/**
 * What the search page's three pickers can offer.
 *
 * Served from the `facets` panel the recompute builds hourly, since the live
 * query reads ~382k rows per Find visit. Falls back to it when there is no
 * cached row yet.
 */
export async function handleFacets(env) {
  try {
    const row = await env.DB.prepare(
      "SELECT json, computed_at FROM panel_cache WHERE name = 'facets'",
    ).first();
    if (row) {
      return new Response(row.json, {
        headers: { ...JSON_HEADERS, "x-computed-at": row.computed_at },
      });
    }
    return json(await facets(scopedDb(env.DB, env)));
  } catch (err) {
    console.log(JSON.stringify({ at: "facets", error: String(err) }));
    return json({ error: "facets failed" }, 503);
  }
}

/**
 * Serve a cached panel.
 *
 * Straight blob read, no assembly — the recompute already paid that cost, once,
 * rather than once per viewer. That is the point of the cache table, and it
 * holds regardless of plan: rebuilding a 720 KB panel on every page load would
 * be the same work repeated for an answer that changes every ten minutes.
 */
export async function handlePanel(env, name) {
  const row = await env.DB.prepare(
    "SELECT json, computed_at FROM panel_cache WHERE name = ?",
  )
    .bind(name)
    .first();

  if (!row) return json({ error: "no such panel, or never computed" }, 404);

  return new Response(row.json, {
    headers: {
      ...JSON_HEADERS,
      "x-computed-at": row.computed_at,
      // How this panel is rebuilt, so the card can say so without the frontend
      // keeping its own copy of the split. See `refreshTier`.
      "x-refresh": refreshTier(name),
    },
  });
}

/**
 * Serve one drilldown subject.
 *
 * `x-refresh` is `cron` on a hit and on a miss alike, and that is honest rather
 * than convenient: the payload is only as current as the version it was folded
 * against, and a miss folds against that same version. Reporting `instant`
 * because the work just happened would be a confident blue over data that is up
 * to ten minutes old — precisely the lie the four-colour scheme exists to
 * prevent.
 *
 * A missing subject is a 404 rather than an empty payload. The picker only
 * offers subjects the index carries, so a request for one that does not exist
 * is a stale bookmark or a typed URL, and an empty record renders as a person
 * who has done nothing rather than as a person who is not there.
 */
export async function handleSubject(env, ctx, kind, id) {
  const db = scopedDb(env.DB, env);

  let result;
  try {
    result = await subject(env, db, kind, id);
  } catch (err) {
    console.log(JSON.stringify({ at: "subject", kind, id, error: String(err) }));
    return json({ error: "could not compute subject" }, 500);
  }

  if (!result.payload) return json({ error: "no such subject" }, 404);

  // The cache write never blocks the response, and a failed one costs a
  // recomputation next time rather than an error now.
  if (result.write) ctx.waitUntil(result.write.catch(() => {}));

  return new Response(result.payload, {
    headers: {
      ...JSON_HEADERS,
      "x-refresh": "cron",
      "x-subject-cache": result.hit ? "hit" : "miss",
      "x-version": String(result.version),
    },
  });
}


const EMPTY = {
  approvedUnmerged: [],
  changesRequested: [],
  needsRelease: [],
  depUpdates: [],
  byLabel: {},
  ciHealth: { repos: {}, org: null },
  contributors: { windows: [], rows: [] },
  analytics: { windows: [], totals: {}, series: { week: [], month: [] } },
  repos: { windows: [], windowFields: [], org: null, rows: [] },
  issues: {
    windows: [],
    totals: {},
    series: { week: [], month: [] },
    triage: null,
    labels: [],
    repos: [],
  },
};

/**
 * Everything the page needs to render, in one response: the panels this role
 * may read, straight from the cache. The cached JSON is spliced in as text
 * rather than parsed and re-serialised, since it runs to megabytes.
 */
export async function handleDashboard(env, role) {
  const names = panelsFor(role);
  const [{ results }, checked] = await Promise.all([
    env.DB.prepare(
      `SELECT name, json, computed_at FROM panel_cache WHERE name IN (${names.map(() => "?").join(", ")})`,
    )
      .bind(...names)
      .all(),
    env.DB.prepare("SELECT value FROM meta WHERE key = 'checked_at'").first(),
  ]);
  const rows = new Map(results.map((r) => [r.name, r]));

  let trackedLabels = [];
  const byLabel = rows.get("byLabel");
  if (byLabel) {
    try {
      trackedLabels = Object.keys(JSON.parse(byLabel.json));
    } catch {}
  }

  const entries = names.map((name) => {
    const row = rows.get(name);
    const head = {
      ok: Boolean(row),
      error: row ? null : "not computed yet",
      live: true,
      down: !row,
      refresh: refreshTier(name),
      computedAt: row?.computed_at ?? null,
    };
    const data = row ? row.json : JSON.stringify(EMPTY[name] ?? null);
    return `${JSON.stringify(name)}:${JSON.stringify(head).slice(0, -1)},"data":${data}}`;
  });
  entries.push(`"drilldown":${JSON.stringify({ ok: true, error: null, data: null })}`);

  const newest = results.reduce((m, r) => (r.computed_at > m ? r.computed_at : m), "");
  const head = {
    generatedAt: checked?.value ?? (newest || new Date().toISOString()),
    org: env.GITHUB_ORG ?? DEFAULT_ORG,
    trackedLabels,
  };

  return new Response(`${JSON.stringify(head).slice(0, -1)},"panels":{${entries.join(",")}}}`, {
    headers: JSON_HEADERS,
  });
}
