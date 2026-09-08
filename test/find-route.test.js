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

land("find?q=crash&type=issue");
check("the page is the search page", state.page === "find");
check("the form is filled from the URL",
      state.find.q === "crash" && state.find.type === "issue");
check("and the address bar is left exactly as it was found",
      here() === BASE + "find?q=crash&type=issue", here());

land("find?q=crash&sort=title");
check("a bad parameter is corrected in the address bar rather than kept",
      here() === BASE + "find?q=crash", here());

land("find");
check("an empty search is a bare path", here() === BASE + "find", here());
check("and leaves the form blank", findQuery() === "");

console.log("\nthe GitHub Pages relay\n");

state.find = blankFind();
put(`${BASE}?route=find&q=crash&type=pr`);
readRoute();
check("the route becomes a path", state.page === "find");
check("its parameters ride along", state.find.q === "crash" && state.find.type === "pr");
check("and the relay is gone from the address bar",
      here() === BASE + "find?q=crash&type=pr", here());

state.find = blankFind();
put(`${BASE}?route=repo%2FGT5-Unofficial`);
readRoute();
check("a relayed drilldown still works",
      state.page === "repo" && state.subject === "GT5-Unofficial", `${state.page}/${state.subject}`);
check("and gains no query", here() === BASE + "repo/GT5-Unofficial", here());

console.log("\nnavigating\n");

land("find?q=crash");
go("issues");
check("leaving takes the query with it", here() === BASE + "issues", here());
go("find");
check("coming back brings it along", here() === BASE + "find?q=crash", here());

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
