/* ==========================================================================
   Live panels
   ========================================================================== */

/**
 * Panels served from D1 rather than from the built file.
 *
 * The dashboard still loads `data/dashboard.json` exactly as it always has.
 * This overlays the panels that have been ported on top of it, and re-overlays
 * them when the Worker says its data changed. The static file stays the floor:
 * every panel renders from it, and a ported panel is simply fresher.
 *
 * That arrangement is deliberate rather than transitional. It means the Worker
 * being down, blocked, or slow costs freshness and nothing else — the page
 * still renders, from data that is at worst as old as the last build. A design
 * where the page fetched its panels from the API alone would have made an API
 * outage a blank dashboard.
 */

import { state } from "./state.js";

/**
 * Panels the Worker can serve. Anything not listed keeps coming from the built
 * file — which is now `issues` and `drilldown`, neither of which has a panel in
 * `worker/src/panels/` yet. Between them they are 32 of the 53 cards, so most of
 * this page is still static.
 *
 * Each entry was held back until it reconciled against the build rather than
 * merely returning rows, because the tint makes a wrong answer *more* dangerous
 * rather than less: blue means "this is current", and a confidently wrong blue
 * is worse than the amber it replaced. What that discipline caught, in order —
 * a `commitsAhead` that was counting the sweep window instead of commits, floors
 * reading 102 days where the truth was 365, seven private repos withheld from a
 * page that publishes them, a stale-repo cutoff dropping 25 repos that had
 * commits from last week, and six repos with no commits at all vanishing
 * entirely.
 *
 * `ciHealth` is the newest and the only one whose reconciliation was exact to
 * the last integer — 252 repos, 3,156 sampled runs, and a pass rate agreeing to
 * sixteen decimal places. Its one divergence is 10.4 minutes of sampled time out
 * of 11,569, from six repos at the 20-run cap whose sample slid between the
 * build and the backfill. That is live running ahead of the build.
 *
 * `issues` is the largest of them, and its gate caught the one defect that no
 * parity test here could have: every suite compares two readings of one seed,
 * and the seed comes from the GraphQL walk, so the webhook's own writes are
 * outside that loop entirely. Reconciling against production found the handler
 * storing REST's `not_planned` where the seed holds `NOT_PLANNED` — a
 * case-sensitive compare away from counting an issue closed as "not planned" as
 * fixed. Nine rows, growing by roughly one a day. Repaired by migration 004,
 * and production now reads `unknownReason: 0` with `notPlanned` back at the
 * build's 5,105.
 *
 * Where they still differ from the build, and it is worth knowing before
 * trusting a number: `needsRelease` compares commit *dates* against a release,
 * because a release webhook carries no tag SHA, while the Node panel compares
 * *ancestry* (`tagSha...headSha`). The two agree until a tag is cut from an
 * older commit — three repos at last count, where the card reads low or omits
 * the repo. `Calculations.md` has the detail.
 */
const LIVE_PANELS = [
  "contributors",
  "analytics",
  "approvedUnmerged",
  "changesRequested",
  "needsRelease",
  "depUpdates",
  "byLabel",
  "ciHealth",
  "issues",
];

/**
 * Panels nothing fetches until something asks for one — and the reason
 * `drilldown` is not in the list above.
 *
 * It is in `LIVE_PANELS` in every sense that matters: `PAGE_PANEL` tints 22 of
 * the 53 cards from it, `freshness` reads its `refresh` header, and a failure
 * turns those cards red. It is only kept out of the eager list because nothing
 * should fetch it until somebody opens a drilldown. Membership here *is* the
 * promotion, and it was made last — after the payloads render, never before,
 * because until then all 22 would have been blue over the build file.
 *
 * `drilldown` is the only member and the reason the category exists. Its index
 * is ~470 KB and exactly two of the six pages need it, so overlaying it with
 * the rest would make every visitor to Analytics pay for a picker they are
 * never shown — which is most of what this whole port set out to stop.
 *
 * A registered panel is fetched once on registration and then refreshed with
 * every other panel on the poll, so the laziness costs it nothing in freshness
 * after the first ask.
 *
 * The entry in `state.data.panels` is *mutated* rather than replaced, unlike
 * the eager path above. The build's own entry carries `file` and `error`, the
 * lazy fallback in `render.js` needs both, and rebuilding the object from the
 * response would drop them.
 */
const lazy = new Map();

/**
 * Where the API lives.
 *
 * Hardcoded, unlike BASE in paths.js, because there is nothing to derive it
 * from: the Worker is on a different origin from the page by design, and a
 * document cannot know its API's hostname the way a module knows its own path.
 * `?api=` overrides it, which is how you point a local page at production or a
 * preview deployment without editing this file.
 */
const DEFAULT_API = "https://nh-dashboard.gtnh.workers.dev";

/**
 * Exported because the drilldown's per-subject routes are not panels and are
 * fetched from render.js, beside the view that needs them — and `?api=` has to
 * point those at the same Worker as everything else, or a preview deployment
 * would serve nine panels from one origin and its subjects from another.
 */
export const API =
  // Guarded because `test/freshness.test.js` imports render.js, which imports
  // this, under Node — where there is no `location` and a module-scope read of
  // it is a ReferenceError before a single assertion runs.
  (typeof location === "undefined"
    ? null
    : new URLSearchParams(location.search).get("api")) ?? DEFAULT_API;

/** How often to ask whether anything changed. The recompute runs every 10 minutes. */
const POLL_MS = 60_000;

let lastVersion = null;
let timer = null;

async function getJSON(path, ms = 8000) {
  // A hung fetch must not leave the page waiting on it forever — the static
  // data is already rendered and the overlay is an improvement, not a
  // dependency.
  const stop = AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
  const res = await fetch(`${API}${path}`, { cache: "no-store", signal: stop });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

/**
 * A panel plus what the Worker says about its freshness.
 *
 * `x-refresh` is the Worker's own account of how the panel is rebuilt, and
 * `x-computed-at` when it last was. Both are read here rather than inferred,
 * because a list of which panels are fast would be a second copy of a split
 * that lives in the recompute — and it would be wrong the first time a panel
 * moves between tiers.
 */
async function getPanel(name, ms = 8000) {
  const stop = AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
  const res = await fetch(`${API}/api/panel/${name}`, {
    cache: "no-store",
    signal: stop,
  });
  if (!res.ok) throw new Error(`${name} → ${res.status}`);
  return {
    data: await res.json(),
    refresh: res.headers.get("x-refresh") ?? "cron",
    computedAt: res.headers.get("x-computed-at") ?? null,
  };
}

/**
 * Fetch one lazy panel and hand it to whatever registered it.
 *
 * The `down` flag is set on failure exactly as it is on the eager path, which
 * is what turns a drilldown card red rather than leaving it a confident blue
 * over the build file.
 */
async function refreshLazy(name) {
  const apply = lazy.get(name);
  const p = state.data?.panels?.[name];
  try {
    const { data, refresh, computedAt } = await getPanel(name);
    apply(data);
    if (p) {
      p.live = true;
      p.down = false;
      p.refresh = refresh;
      p.computedAt = computedAt;
    }
    return true;
  } catch {
    if (p) p.down = true;
    return false;
  }
}

/**
 * Register a panel to be fetched now and refreshed from here on.
 *
 * `apply` is called with the panel's data on every successful fetch, so a
 * caller holding a reference to it gets re-pointed at the new copy rather than
 * quietly keeping the one it was handed first.
 */
export async function lazyPanel(name, apply) {
  lazy.set(name, apply);
  return state.data?.panels ? refreshLazy(name) : false;
}

/**
 * Replace the ported panels in `state.data` with the Worker's copies.
 *
 * Returns the panels that actually changed. Each is fetched and applied
 * independently: one panel 404ing because it has never been computed must not
 * cost the others their update.
 */
async function overlay() {
  if (!state.data?.panels) return [];

  const applied = [];
  await Promise.all([
    ...[...lazy.keys()].map(async (name) => {
      if (await refreshLazy(name)) applied.push(name);
    }),
    ...LIVE_PANELS.map(async (name) => {
      try {
        const { data, refresh, computedAt } = await getPanel(name);
        state.data.panels[name] = {
          ok: true,
          error: null,
          data,
          live: true,
          down: false,
          refresh,
          computedAt,
        };
        applied.push(name);
      } catch {
        // Keep whatever the built file had — stale data beats none. But record
        // that this panel *should* have been live and was not, because those
        // are different states and only one of them is anybody's fault: a card
        // that is built by design and a card whose API stopped answering look
        // identical otherwise, and the second is the one worth seeing.
        //
        // Still silent in the console. This is expected whenever the Worker is
        // unreachable, and a failure logged on every poll would bury the errors
        // that matter.
        const p = state.data.panels[name];
        if (p) p.down = true;
      }
    }),
  ]);
  return applied;
}

/**
 * Start polling `/api/version`, calling `onChange` when the number moves.
 *
 * The version is one integer bumped by the recompute, so a poll that finds it
 * unchanged costs a single indexed read and no panel transfer. Polling stops
 * while the tab is hidden and checks immediately when it comes back — a
 * backgrounded dashboard left open overnight should not spend the night asking.
 */
export function startPolling(onChange) {
  const tick = async () => {
    if (document.visibilityState === "hidden") return;
    try {
      const { version } = await getJSON("/api/version");
      if (version === lastVersion) return;
      lastVersion = state.version = version;
      const applied = await overlay();
      if (applied.length) onChange(applied);
    } catch {
      // Unreachable Worker: keep the built data, keep polling, say nothing.
    }
  };

  clearInterval(timer);
  timer = setInterval(tick, POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") tick();
  });
}

/**
 * First overlay, before the initial render.
 *
 * Awaited so the page paints live numbers rather than painting the built ones
 * and visibly rewriting them a moment later. It cannot hang the page: every
 * fetch is on a timeout and every failure falls through to the built data.
 */
export async function primeLive() {
  try {
    const { version } = await getJSON("/api/version");
    // Recorded on state as well as here, because a drilldown subject is cached
    // in the browser against the same version the Worker caches it against —
    // see `subjectEntry` in drilldown-data.js. Held in one place so the two
    // caches cannot disagree about which version is current.
    lastVersion = state.version = version;
  } catch {
    // Version unknown just means the next poll treats whatever it finds as new.
  }
  return overlay();
}
