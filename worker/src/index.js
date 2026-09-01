/**
 * Webhook receiver and read API.
 *
 * Two jobs, deliberately kept apart: accept deliveries from GitHub as fast as
 * possible, and answer the dashboard's queries. Neither should be able to make
 * the other slow.
 *
 * GitHub gives a delivery ten seconds before it counts as failed, and a failing
 * endpoint eventually gets its subscription disabled. So the handler verifies,
 * writes, and returns.
 *
 * Two cheap panels are then rebuilt through `ctx.waitUntil`, which runs after
 * the response has already gone back — so they cost the delivery nothing and
 * cannot fail one. Everything expensive stays on the debounced cron. The line
 * is drawn by measurement rather than by category: ~120ms for both of those
 * against ~2.6 seconds for analytics alone.
 */

import { handleEvent } from "./handlers.js";
import { recompute, refreshInstant, refreshTier } from "./recompute.js";
import { subject } from "./panels/drilldown-subject.js";
import { scopedDb } from "./scope.js";

/**
 * The read API is public and cross-origin by necessity — the dashboard is
 * served from Pages and this Worker from workers.dev, which are different
 * origins, so without this every panel fetch fails in the browser.
 *
 * `*` rather than an allowlist because the data is public: it is the same
 * content the dashboard renders to anyone who loads it. There is nothing here
 * that an origin check would protect, and an allowlist would only break the
 * next preview deployment. The webhook is a different matter and is not
 * covered by this — it is authenticated by signature, not by origin.
 */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  // Without this the browser hides these from cross-origin JavaScript, and the
  // page cannot tell how stale the panel it is showing actually is, nor how
  // fresh it was entitled to expect.
  "access-control-expose-headers":
    "x-computed-at, x-refresh, x-subject-cache, x-version",
  "access-control-max-age": "86400",
};

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  ...CORS,
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function hexToBytes(hex) {
  if (hex.length % 2) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.substr(i * 2, 2), 16);
    if (Number.isNaN(byte)) return null;
    out[i] = byte;
  }
  return out;
}

/**
 * Verify X-Hub-Signature-256 over the raw body.
 *
 * `crypto.subtle.verify` is used rather than recomputing the digest and
 * comparing strings: a plain `===` on hex leaks how many leading characters
 * matched, which is enough to forge a signature one byte at a time. Verify is
 * constant-time by construction.
 *
 * The body must be the exact bytes GitHub signed, so it is read as text and
 * parsed only after the signature checks out — never `await request.json()`
 * first and re-serialize, which would reorder keys and change the digest.
 */
async function verifySignature(secret, header, rawBody) {
  if (!header || !header.startsWith("sha256=")) return false;

  const signature = hexToBytes(header.slice(7));
  if (!signature || signature.length !== 32) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  return crypto.subtle.verify("HMAC", key, signature, encoder.encode(rawBody));
}

/**
 * Mark the aggregates stale. The recompute job clears this.
 *
 * Cheap on purpose — one write per delivery, no reads. Whether anything
 * actually needs rebuilding is the recompute's problem, not the receiver's.
 */
async function markDirty(db) {
  await db
    .prepare("UPDATE meta SET value = '1' WHERE key = 'dirty'")
    .run();
}

/** Deliveries that can change the approved / changes-requested cards. */
const REVIEW_EVENTS = new Set(["pull_request", "pull_request_review"]);

async function handleWebhook(request, env, ctx) {
  const secret = env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return json({ error: "webhook secret not configured" }, 500);

  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  if (!(await verifySignature(secret, signature, rawBody))) {
    return json({ error: "bad signature" }, 401);
  }

  const event = request.headers.get("x-github-event") ?? "unknown";
  const delivery = request.headers.get("x-github-delivery") ?? "";

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: "unparseable payload" }, 400);
  }

  // The ping GitHub sends when a webhook is first configured. Answering it is
  // how the App's settings page shows a green tick.
  if (event === "ping") {
    return json({ ok: true, pong: payload.zen ?? null });
  }

  const repo = payload.repository?.name ?? null;
  const action = payload.action ?? null;

  let result;
  try {
    result = await handleEvent(env.DB, event, payload);
    await markDirty(env.DB);
  } catch (err) {
    // Still a 200. GitHub retries nothing and disables a webhook that keeps
    // failing, so a handler bug must not cost the subscription — the delivery
    // is logged and the reconcile sweep will correct whatever was missed.
    console.error(
      JSON.stringify({ event, action, repo, delivery, error: String(err) }),
    );
    return json({ ok: false, event, error: "handler failed" });
  }

  console.log(JSON.stringify({ event, action, repo, delivery, result }));

  // The cards an admin watches while merging cost ~120ms together, so they are
  // rebuilt now rather than at the next cron tick. `waitUntil` runs it after
  // this response has gone back to GitHub, so it cannot delay the delivery or
  // fail it — a webhook that keeps failing gets disabled, and silently.
  //
  // Only for events that can change them. A `workflow_run` fires constantly and
  // moves nothing on these two.
  if (ctx && REVIEW_EVENTS.has(event)) {
    ctx.waitUntil(
      refreshInstant(env).catch((err) =>
        console.error(JSON.stringify({ instant: "failed", error: String(err) })),
      ),
    );
  }

  return json({ ok: true, event, action, repo, result });
}

async function handleVersion(env) {
  const row = await env.DB.prepare(
    "SELECT value FROM meta WHERE key = 'version'",
  ).first();

  return json({ version: Number(row?.value ?? 0) });
}

/**
 * `repos`, `commits` and `releases` are counted here because their emptiness is
 * invisible everywhere else.
 *
 * The seed never wrote a `repos` row, and the two release panels join it — so
 * "the backfill has not run" and "no repo needs a release" produce the same
 * empty card. A count is the only place the difference shows.
 */
async function handleHealth(env) {
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
 * Serve a cached panel.
 *
 * Straight blob read, no assembly — the recompute already paid that cost, once,
 * rather than once per viewer. That is the point of the cache table, and it
 * holds regardless of plan: rebuilding a 720 KB panel on every page load would
 * be the same work repeated for an answer that changes every ten minutes.
 */
async function handlePanel(env, name) {
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
async function handleSubject(env, ctx, kind, id) {
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === "/webhook") {
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      return handleWebhook(request, env, ctx);
    }

    if (url.pathname === "/api/version") return handleVersion(env);
    if (url.pathname === "/api/health") return handleHealth(env);

    const panel = url.pathname.match(/^\/api\/panel\/([a-z][a-z0-9]*)$/i);
    if (panel) return handlePanel(env, panel[1]);

    // One drilldown subject. Not `/api/panel/drilldown`, which is the picker
    // index and stays an ordinary cached blob — these two are the 7,047
    // payloads behind it, and they are computed per request.
    const person = url.pathname.match(/^\/api\/contributor\/(.+)$/);
    if (person) return handleSubject(env, ctx, "contributors", decodeURIComponent(person[1]));

    const repo = url.pathname.match(/^\/api\/repo\/(.+)$/);
    if (repo) return handleSubject(env, ctx, "repos", decodeURIComponent(repo[1]));

    // Manual trigger, for checking a rebuild without waiting for the cron. It
    // only rebuilds and cannot destroy anything, so it is unauthenticated on
    // purpose — but it is the one route that costs real work per call, so it
    // requires POST to keep crawlers and link previews off it.
    if (url.pathname === "/api/recompute") {
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      const force = url.searchParams.get("force") === "1";
      return json(await recompute(env, { force }));
    }

    return json({ error: "not found" }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      recompute(env).then((r) => console.log(JSON.stringify({ cron: r }))),
    );
  },
};
