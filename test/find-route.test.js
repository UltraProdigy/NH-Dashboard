/**
 * The search page keeps its state in the URL, and the two directions must be
 * exact inverses.
 *
 *   node test/find-route.test.js
 *
 * Worth a test rather than care because the failure is a loop rather than a
 * wrong answer. `readRoute` canonicalises: it builds a URL from the state it
 * just parsed and rewrites the address bar when the two differ. If serializing
 * a search does not reproduce the string it was parsed from — a reordered key,
 * a default written out, an encoding that differs by a character — then every
 * load of a search link rewrites itself, and the symptom is an address bar that
 * changes under you rather than an error anybody sees.
 *
 * The relay case is the other one. Deep links on GitHub Pages go through
 * 404.html, which hands the route back in `?route=`; a search's own parameters
 * ride beside it, and dropping them there would make every shared search link
 * open an empty form — on Pages only, which is the deployed site and not the
 * one anybody develops against.
 */

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  ok ? (pass++, console.log("  ok    " + n))
     : (fail++, console.log("  FAIL  " + n + (d ? " — " + d : "")));
};

/* ---- just enough browser ------------------------------------------------
   The modules under test reach for `location`, `history` and a handful of
   elements at import time. Stubbed rather than pulled in with jsdom: the whole
   surface used here is four properties and a map of ids, and a dependency
   would be larger than the thing it tests. */

const el = () => ({
  innerHTML: "", textContent: "", style: {}, hidden: false, dataset: {},
  addEventListener() {}, setAttribute() {}, removeAttribute() {},
  querySelector: () => null, querySelectorAll: () => [], closest: () => null,
  classList: { add() {}, remove() {}, toggle: () => false, contains: () => false },
  focus() {}, setSelectionRange() {}, scrollIntoView() {}, getBoundingClientRect: () => ({}),
});

const nodes = new Map();
globalThis.document = {
  body: el(),
  getElementById: (id) => (nodes.has(id) ? nodes.get(id) : (nodes.set(id, el()), nodes.get(id))),
  querySelector: () => null,
  addEventListener() {},
  createElement: el,
};
globalThis.addEventListener = () => {};
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.matchMedia = () => ({ matches: false });
globalThis.requestAnimationFrame = () => {};
globalThis.scrollTo = () => {};

const loc = { pathname: "/", search: "", hash: "" };
globalThis.location = loc;

const put = (url) => {
  const [path, query = ""] = url.split("?");
  loc.pathname = path;
  loc.search = query ? `?${query}` : "";
};
const here = () => loc.pathname + loc.search;

globalThis.history = {
  replaceState: (_s, _t, url) => put(url),
  pushState: (_s, _t, url) => put(url),
};

const { BASE } = await import("../web/js/paths.js");
const { state, blankFind } = await import("../web/js/state.js");
const { findQuery, readFindQuery } = await import("../web/js/find-data.js");
const { readRoute, go } = await import("../web/js/router.js");

/** Land on a URL the way a fresh page load would. */
function land(url) {
  state.find = blankFind();
  put(BASE + url);
  readRoute();
}

console.log("\nthe query a search spells\n");

state.find = { ...blankFind(), q: "crash", type: "issue", sort: "oldest" };
check("only what differs from the defaults is written",
      findQuery() === "?q=crash&type=issue&sort=oldest", findQuery());

state.find = { ...blankFind(), q: "crash" };
check("defaults are left out", findQuery() === "?q=crash", findQuery());

state.find = blankFind();
check("an untouched form has no query", findQuery() === "", findQuery());

state.find = { ...blankFind(), label: "Bug: Minor", repo: "GT5-Unofficial" };
check("values are encoded", findQuery() === "?repo=GT5-Unofficial&label=Bug%3A+Minor", findQuery());

// Key order is fixed rather than insertion-ordered, so two ways of arriving at
// the same search produce the same string — which is what the canonicalisation
// below compares against.
const a = { ...blankFind(), q: "x", repo: "r", author: "p" };
const b = { ...blankFind(), author: "p", repo: "r", q: "x" };
check("the same search always spells the same URL",
      findQuery(a) === findQuery(b), `${findQuery(a)} vs ${findQuery(b)}`);

console.log("\nreading one back\n");

state.find = blankFind();
readFindQuery("?q=crash&type=pr&state=merged&sort=comments&repo=r&author=p&label=l");
check("every parameter survives the trip",
      state.find.q === "crash" && state.find.type === "pr" && state.find.state === "merged" &&
      state.find.sort === "comments" && state.find.repo === "r" &&
      state.find.author === "p" && state.find.label === "l");

state.find = blankFind();
readFindQuery("?q=x&sort=title&type=elephant&state=pending");
check("a sort the endpoint does not have is dropped", state.find.sort === "updated");
check("so is a type", state.find.type === "both");
check("so is a state", state.find.state === "");
check("and the rest of the query is kept", state.find.q === "x");

console.log("\nlanding on a search link\n");

land("org-search?q=crash&type=issue");
check("the page is the search page", state.page === "find");
check("the form is filled from the URL",
      state.find.q === "crash" && state.find.type === "issue");
check("and the address bar is left exactly as it was found",
      here() === BASE + "org-search?q=crash&type=issue", here());

land("org-search?q=crash&sort=title");
check("a bad parameter is corrected in the address bar rather than kept",
      here() === BASE + "org-search?q=crash", here());

land("org-search");
check("an empty search is a bare path", here() === BASE + "org-search", here());
check("and leaves the form blank", findQuery() === "");

/* ==========================================================================
   URLs are spelled in labels
   --------------------------------------------------------------------------
   The segment is `slugify(page.label)`, not the page id, and the id is still
   accepted so that every link this dashboard has produced to date keeps
   landing. Both halves are asserted: a slug that stopped resolving would break
   the sidebar, and an id that stopped resolving would break other people's
   bookmarks silently, which is worse.
   ========================================================================== */

console.log("\nurls are the visible names\n");

land("pr-analytics/actions-load");
check("a page and a tab both come out of their labels",
      state.page === "analytics" && state.tab === "actions", `${state.page}/${state.tab}`);
check("and the address bar keeps them",
      here() === BASE + "pr-analytics/actions-load", here());

land("contributor-drilldown/Dream-Master/pull-requests");
check("a drilldown keeps its subject between the two",
      state.page === "contributor" && state.subject === "Dream-Master" &&
      state.tab === "@prs", `${state.page}/${state.subject}/${state.tab}`);

land("issue-analytics/needs-attention");
check("a group tab is named by the group's label",
      state.page === "issues" && state.tab === "@attention", `${state.tab}`);

console.log("\nlinks made before the urls carried labels\n");

land("analytics/actions");
check("an old page id and an old tab id both still land",
      state.page === "analytics" && state.tab === "actions", `${state.page}/${state.tab}`);
check("and are rewritten to the names in the sidebar",
      here() === BASE + "pr-analytics/actions-load", here());

land("repo/GT5-Unofficial/@activity");
check("so is an old drilldown, subject and group tab intact",
      state.page === "repo" && state.subject === "GT5-Unofficial" &&
      state.tab === "@activity", `${state.page}/${state.subject}/${state.tab}`);
check("and it too is canonicalised",
      here() === BASE + "repo-drilldown/GT5-Unofficial/activity", here());

land("find?q=crash");
check("an old search link keeps its query across the rename",
      state.page === "find" && state.find.q === "crash", here());
check("and lands on the new path", here() === BASE + "org-search?q=crash", here());

console.log("\nno two names collide\n");

const { PAGES, pageSlug } = await import("../web/js/pages.js");
const { tabsFor, tabSlug } = await import("../web/js/modules/index.js");

// Slugs are derived from labels, so renaming a page or a card is the one edit
// that can quietly make two URLs the same. Nothing else in the app would say
// so — one of the two would simply stop being reachable.
const pageSlugs = PAGES.map(p => pageSlug(p.id));
check("every page's slug is its own",
      new Set(pageSlugs).size === PAGES.length, pageSlugs.join(", "));

// A page's id has to keep resolving to that page, which it cannot do if some
// other page's label happens to slugify to it.
const ids = new Set(PAGES.map(p => p.id));
check("and no page's slug is another page's id",
      PAGES.every(p => !ids.has(pageSlug(p.id)) || pageSlug(p.id) === p.id),
      pageSlugs.join(", "));

/* web/404.html carries its own copy of the page names, because it runs before
   any module loads and cannot import this one. It is the file that decides
   whether the first segment of a deep link is the repo or a page, so a name
   missing from it breaks that link on a user or org site — and nowhere else,
   which is the worst place for a bug to only happen. */
const relay = await (await import("node:fs/promises"))
  .readFile(new URL("../web/404.html", import.meta.url), "utf8");
const listed = new Set(
  (relay.match(/var PAGES = \[([\s\S]*?)\]/)?.[1] ?? "")
    .split(",").map(x => x.trim().replace(/^"|"$/g, "")).filter(Boolean));
const missing = PAGES.flatMap(p => [pageSlug(p.id), p.id]).filter(n => !listed.has(n));
check("the Pages relay knows every page name", !missing.length, missing.join(", "));

let tabDupes = [];
for (const p of PAGES) {
  const slugs = tabsFor(p.id).map(t => tabSlug(p.id, t.id));
  if (new Set(slugs).size !== slugs.length) tabDupes.push(p.id);
}
check("every tab's slug is its own within its page", !tabDupes.length, tabDupes.join(", "));

console.log("\nthe GitHub Pages relay\n");

state.find = blankFind();
put(`${BASE}?route=org-search&q=crash&type=pr`);
readRoute();
check("the route becomes a path", state.page === "find");
check("its parameters ride along", state.find.q === "crash" && state.find.type === "pr");
check("and the relay is gone from the address bar",
      here() === BASE + "org-search?q=crash&type=pr", here());

state.find = blankFind();
put(`${BASE}?route=repo-drilldown%2FGT5-Unofficial`);
readRoute();
check("a relayed drilldown still works",
      state.page === "repo" && state.subject === "GT5-Unofficial", `${state.page}/${state.subject}`);
check("and gains no query", here() === BASE + "repo-drilldown/GT5-Unofficial", here());

console.log("\nnavigating\n");

land("org-search?q=crash");
go("issues");
check("leaving takes the query with it", here() === BASE + "issue-analytics", here());
go("find");
check("coming back brings it along", here() === BASE + "org-search?q=crash", here());

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
