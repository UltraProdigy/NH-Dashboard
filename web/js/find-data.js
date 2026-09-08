import { FIND_DEFAULTS, blankFind, state } from "./state.js";
import { API } from "./live.js";
import { render } from "./render.js";
import { resultsHtml } from "./modules/find.js";

/* ==========================================================================
   Find — the query, the URL it lives in, and the fetch

   Every other page on this dashboard reads a panel: a blob computed once by
   the Worker and handed to everyone. This one asks a question and gets an
   answer to that question only, so none of the machinery around panels
   applies — no cache, no version poll, no freshness tier, and nothing in
   `PAGE_PANEL`, which is why its cards draw no tint.

   What it does share is the rule the router opens with: the URL is the state.
   A search worth having is a search worth sending to somebody, and a link that
   arrives without its filters is a link to the wrong list.
   ========================================================================== */

/**
 * The parameters, in this order, so the same search always spells its URL the
 * same way — the canonicalisation in readRoute compares the address bar against
 * a freshly built one, and two spellings of one query would replaceState in a
 * loop.
 *
 * A parameter is written only when it differs from `FIND_DEFAULTS`, so the
 * common case is a short link rather than an address bar full of
 * `type=both&sort=updated` on every search. `readFindQuery` fills the gaps back
 * in, which makes the two exact inverses.
 */
const KEYS = ["q", "type", "state", "sort", "repo", "author", "label"];

const TYPES = ["both", "issue", "pr"];
const STATES = ["", "open", "closed", "merged"];
const SORTS = ["updated", "created", "oldest", "comments"];

const ALLOWED = { type: TYPES, state: STATES, sort: SORTS };

/** The query as it appears in the address bar, or "" when nothing is set. */
function findQuery(f = state.find) {
  const p = new URLSearchParams();
  for (const k of KEYS) if (f[k] && f[k] !== FIND_DEFAULTS[k]) p.set(k, f[k]);
  const s = p.toString();
  return s ? `?${s}` : "";
}

/**
 * Read a query string back into the form.
 *
 * Values from the three fixed vocabularies are checked rather than trusted:
 * a hand-typed `sort=title` would otherwise sit in the state, go out on the
 * next request, and be silently ignored by the Worker — so the control would
 * show a sort the results were not in.
 */
function readFindQuery(search) {
  const p = new URLSearchParams(search);
  const next = blankFind();
  for (const k of KEYS) {
    const v = p.get(k);
    if (v == null) continue;
    if (ALLOWED[k] && !ALLOWED[k].includes(v)) continue;
    next[k] = v;
  }
  // Carry the results across a re-read of the same query. `popstate` and the
  // canonicalisation in readRoute both land here, and blanking the rows on a
  // route the page is already showing would flash the table away and refetch
  // an answer it already has.
  if (findQuery(next) === findQuery(state.find)) {
    next.rows = state.find.rows;
    next.labelColors = state.find.labelColors;
    next.status = state.find.status;
    next.truncated = state.find.truncated;
    next.ran = state.find.ran;
  }
  state.find = next;
}

/* ---- the fetch ---------------------------------------------------------- */

/**
 * Repaint the results and nothing else, when there are results on screen to
 * repaint.
 *
 * A search resolving is not a reason to rebuild the page. `render()` replaces
 * the view wholesale, which destroys the input the user is typing into and
 * takes the caret with it — and this fetch resolves, by design, 250ms after a
 * keystroke. Swapping the results container leaves the form alone.
 *
 * Falls back to a full render when the container is not there: the first search
 * of a session, or one arriving while another page is open.
 */
function paint() {
  const el = document.getElementById("findResults");
  if (el && state.page === "find") el.innerHTML = resultsHtml();
  else render();
}

let timer = null;
let inflight = null;
let seq = 0;

/**
 * Run the current form against the Worker.
 *
 * Typing is debounced and every request supersedes the last, by both an abort
 * and a sequence number. The abort saves the Worker the work; the sequence is
 * what actually protects the result, because an abort that lands after the
 * response has already been read does not un-read it, and two searches racing
 * would otherwise resolve in whichever order the network chose — leaving the
 * table showing the answer to a question the box no longer contains.
 */
async function fire() {
  const mine = ++seq;
  const query = findQuery();

  inflight?.abort();
  inflight = typeof AbortController === "function" ? new AbortController() : null;

  state.find.status = "loading";
  paint();

  try {
    const res = await fetch(`${API}/api/search${query}`, {
      cache: "no-store",
      signal: inflight?.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (mine !== seq) return;
    state.find.rows = body.rows ?? [];
    state.find.labelColors = body.labelColors ?? {};
    state.find.truncated = !!body.truncated;
    state.find.status = "ready";
    state.find.ran = query;
  } catch (err) {
    if (err.name === "AbortError" || mine !== seq) return;
    state.find.rows = [];
    state.find.labelColors = {};
    state.find.truncated = false;
    state.find.status = "down";
    // Recorded on the failure too, so `ensureSearch` sees this query as
    // answered. Without it the card's own render would ask again on every
    // repaint, and a Worker that is down would be asked forever at whatever
    // rate the page happens to render.
    state.find.ran = query;
  }
  paint();
}

/* ---- the pickers' lists -------------------------------------------------- */

/**
 * Fetch what the three pickers can offer, once.
 *
 * They used to be built from panels the page had already loaded, which sounded
 * free and was wrong: `labelsByRepo` is an issue-analytics aggregate covering
 * 21 repos with no pull-request labels in it at all, so a label on a repo
 * without issue labels could not be picked at all. A picker that cannot offer
 * the thing you came to filter by is not a thin hint, it is a broken control.
 *
 * Three scans on the Worker, once, kept for the session. A failure is left as
 * `down` and not retried on every repaint — the same reasoning as `ran` on a
 * failed search, and if this could not be reached then neither can the search
 * it would have filtered.
 */
async function ensureFacets(onDone) {
  if (state.findFacets.status !== "idle") return;
  state.findFacets.status = "loading";
  try {
    const res = await fetch(`${API}/api/search/facets`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    state.findFacets = { status: "ready", ...body };
  } catch {
    state.findFacets.status = "down";
  }
  onDone?.();
}

/** Immediately — for a control that was clicked rather than typed into. */
function searchNow() {
  clearTimeout(timer);
  fire();
}

/**
 * After a pause — for the text boxes.
 *
 * 250ms rather than a per-keystroke request. Each search is a scan of both
 * tables, and "GT5" typed at speed is three of them for two answers nobody
 * saw.
 */
function searchSoon() {
  clearTimeout(timer);
  timer = setTimeout(fire, 250);
}

/**
 * Fetch what the current route asks for, if it isn't already in hand.
 *
 * Called from the card's own render, the way the drilldown asks for its index:
 * a deep link into a search has to run it, and nothing else on the page knows
 * that the route changed under it.
 */
function ensureSearch() {
  if (state.find.status === "loading") return;
  if (state.find.status === "ready" && state.find.ran === findQuery()) return;
  if (state.find.status === "down" && state.find.ran === findQuery()) return;
  searchNow();
}

export { KEYS, SORTS, STATES, TYPES, ensureFacets, ensureSearch, findQuery, readFindQuery, searchNow, searchSoon };
