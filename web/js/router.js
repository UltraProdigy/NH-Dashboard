import { isDrill, state } from "./state.js";
import { BASE } from "./paths.js";
import { PAGES } from "./pages.js";
import { closeCombo, render } from "./render.js";
import { resolveTab } from "./modules/index.js";

/* ==========================================================================
   Routing — the path is the state, so a link is shareable and a reload lands
   where it says
   --------------------------------------------------------------------------
   This used to live in the fragment: `#analytics/actions`. It worked, but a
   fragment is an anchor within a page — it's the part of a URL a server never
   sees and a browser is entitled to scroll to — and using it to mean "which
   page" is a thirty-year-old workaround for hosts that can't rewrite. Real
   paths cost one static file (404.html) on GitHub Pages and one branch in the
   dev server, which is cheaper than the confusion.
   ========================================================================== */

/**
 * Two shapes, because drilldown pages carry a subject:
 *
 *   /people/newcomers
 *   /contributor/Dream-Master/cActivity
 *
 * Logins and repo names can't contain a slash, so splitting on it is safe;
 * they're still percent-encoded, since they can contain plenty else.
 */
/**
 * `_` is the placeholder for "a tab is selected but no subject is". It only
 * shows up when you flip modes with a tab open, and it exists so the subject
 * always sits in the same slot — without it, `/repo/rActivity` would be
 * indistinguishable from a repo that happens to be named rActivity.
 */
const NO_SUBJECT = "_";

/**
 * Where you last were on each page, so the sidebar and the mode toggle put you
 * back rather than resetting to Overview with nothing selected.
 *
 * In memory only. The hash stays the source of truth, so a reload or a shared
 * link still lands exactly where the URL says — this only fills in the blanks
 * when a navigation doesn't specify them.
 */
const lastPlace = Object.create(null);

const remember = () => {
  lastPlace[state.page] = { tab: state.tab, subject: state.subject };
};

function urlFor(page, tab, subject) {
  const seg = [page];
  if (isDrill(page)) {
    if (subject) seg.push(encodeURIComponent(subject));
    else if (tab) seg.push(NO_SUBJECT);
  }
  if (tab) seg.push(tab);
  return BASE + seg.join("/");
}

/**
 * The route as raw segments, from wherever this load happened to put it.
 *
 * Three shapes arrive here. Normally it's the path, which is the whole point.
 * A deep link on GitHub Pages has been through 404.html, which has no way to
 * serve the app under the requested URL and hands the route over in `?route=`
 * instead. And a bookmark or a chat message from before this moved off the
 * fragment still carries it in `#`.
 *
 * The last two are rewritten into the address bar here, before anything
 * renders, so only the first shape ever reaches the rest of the app.
 */
function routeSegments() {
  const relayed = new URLSearchParams(location.search).get("route");
  const legacy = location.hash.slice(1);
  const carried = relayed ?? (legacy || null);
  if (carried != null) history.replaceState(null, "", BASE + carried.replace(/^\/+/, ""));

  // Split before decoding: encodeURIComponent turns a slash in a repo name into
  // %2F, so the raw string is the one where "/" means "next segment".
  return (location.pathname.startsWith(BASE) ? location.pathname.slice(BASE.length) : "")
    .split("/").filter(Boolean);
}

function readRoute() {
  const parts = routeSegments();
  const page = parts[0];
  if (PAGES.some(p => p.id === page)) state.page = page;

  const drill = isDrill(state.page);
  state.subject =
    drill && parts[1] && parts[1] !== NO_SUBJECT ? decodeURIComponent(parts[1]) : null;

  // resolveTab also redirects: a link made before the tab consolidation names a
  // card that is now one of several under a group tab, and lands on the group.
  state.tab = resolveTab(state.page, parts[drill ? 2 : 1]);

  // Canonicalised rather than left alone, which covers the bare root landing on
  // a page, a relayed link still wearing its `?route=`, and a URL naming a tab
  // that no longer exists. `replaceState`, so none of those becomes a history
  // entry you can press Back into.
  const canon = urlFor(state.page, state.tab, state.subject);
  if (location.pathname + location.search !== canon) history.replaceState(null, "", canon);
  remember();
}

/**
 * `subject` left off means "decide for me": keep it when staying on the same
 * drilldown page (switching tabs), drop it otherwise — a login is not a repo
 * name, so carrying one across a mode switch would only ever 404.
 *
 * `restore` is a trail entry being replayed — see goBack. Without one the sort
 * and filter reset, which is what every ordinary navigation wants.
 */
function go(page, tab = null, subject, restore = null) {
  const drill = isDrill(page);
  if (subject === undefined)
    subject = drill && page === state.page ? state.subject : null;

  state.page = page;
  state.tab = resolveTab(page, tab);
  state.subject = drill ? subject : null;
  state.sort = restore ? { ...restore.sort } : {};
  state.filter = restore ? restore.filter : "";
  closeCombo();
  remember();

  history.pushState(null, "", urlFor(page, state.tab, subject));
  render();
  // Next frame, not now: the view has just been replaced wholesale and a scroll
  // set against a page that hasn't been laid out yet gets clamped to whatever
  // height it briefly had.
  if (restore) requestAnimationFrame(() => scrollTo({ top: restore.scrollY }));
}

/* ==========================================================================
   Where you came from
   --------------------------------------------------------------------------
   Repo and contributor names are links into a drilldown nearly everywhere on
   the dashboard, and the only way back to the table you clicked one from was
   the browser's Back — which on a hash-routed page also unwinds every tab and
   period you touched after arriving. This is a trail of the places those links
   were followed *from*, so the drilldown can offer exactly one step back, to
   the card, sort and scroll position you left.
   ========================================================================== */

const trail = [];

/**
 * Where the back button on the current drilldown would take you, or null if
 * you arrived under your own steam.
 *
 * The entry's destination is checked rather than trusted: the browser's own
 * Back and Forward move the hash out from under the trail, and an entry that
 * no longer describes where you are is not somewhere to return *from*.
 */
function backFrom() {
  const top = trail[trail.length - 1];
  if (!top) return null;
  return top.to.page === state.page && top.to.subject === state.subject ? top.from : null;
}

function goBack() {
  const from = backFrom();
  if (!from) return;
  trail.pop();
  go(from.page, from.tab, from.subject, from);
}

/**
 * Jump into a drilldown. Called without an origin — the picker, the search box
 * — it's you navigating yourself, which is the case the trail has to forget:
 * an offer to go back somewhere you left ten minutes ago is worse than none.
 */
function drillTo(page, id, from = null) {
  if (from) trail.push({ from, to: { page, subject: id } });
  else trail.length = 0;
  go(page, null, id);
}

/** Following a repo or contributor link in the page, remembering the spot. */
function drillFromHere(page, id) {
  if (page === state.page && id === state.subject) return drillTo(page, id);
  drillTo(page, id, {
    page: state.page,
    tab: state.tab,
    subject: state.subject,
    sort: { ...state.sort },
    filter: state.filter,
    scrollY: window.scrollY,
  });
}

/** Sidebar and mode-toggle navigation: resume rather than reset. */
function goPage(page, fallbackTab = null) {
  trail.length = 0;
  const last = lastPlace[page];
  go(page, last?.tab ?? fallbackTab, last?.subject ?? null);
}

export { backFrom, drillFromHere, drillTo, go, goBack, goPage, readRoute };
