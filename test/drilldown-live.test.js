/**
 * The drilldown's two clocks, and the 23 MB file they exist to stop fetching.
 *
 *   node test/drilldown-live.test.js
 *
 * Every other panel on this dashboard is one fetch. This one is an index once
 * per session plus one payload per subject you navigate to, and the interesting
 * behaviour is all in the seams between them — which fetch happens when, what
 * renders while one is in flight, and which of two label tables a chip resolves
 * against. None of that is visible from a panel's output, and none of it is
 * reachable from the parity suites: those compare two readings of one store and
 * never run the frontend at all.
 *
 * Four things here are worth more than the rest.
 *
 * **The build file must not be fetched when the API works.** It is 23 MB and
 * removing that download is the entire reason this change exists, so the check
 * is on the fetch log rather than on anything rendered — a fallback that is
 * "lazy" because nothing has needed it yet is not lazy, and only the log can
 * tell the two apart.
 *
 * **A chip resolves against its own subject's table.** Two subjects here carry
 * deliberately *renumbered* tables holding the same names in different orders,
 * which is what the recompute does to a global table underneath a cached row.
 * Resolving by index against the wrong one of them yields the wrong name rather
 * than nothing, raises no error, and is the one failure in this port that no
 * amount of looking at the page would show.
 *
 * **A subject in flight is not a subject that does not exist.** The picker's
 * "nothing named that" was `state.subject && !subject()`, which was the same
 * statement when the whole file was in hand and there was nothing between
 * asking and having.
 *
 * **A version bump keeps rendering the old copy.** The browser caches a payload
 * against the same version the Worker does, so a bump invalidates both — but
 * tearing the page down to a spinner every ten minutes because a fresher copy
 * exists is worse than the ten-minute-old numbers were.
 */

/* ==========================================================================
   Enough browser to import the frontend

   render.js reaches the DOM in every one of its render functions and none of
   them guard, which is correct in a browser and means a stub here rather than
   a rewrite there. Elements are inert bags of properties: nothing asserted
   below reads markup, only which fetches happened and what the accessors
   return, so a real DOM would be a lot of surface for no extra claim.
   ========================================================================== */

const el = () => ({
  innerHTML: "", textContent: "", value: "", href: "", title: "",
  style: {}, dataset: {},
  classList: { add() {}, remove() {}, toggle() {} },
  querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
  getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
  focus() {}, scrollIntoView() {},
});

const nodes = new Map();
globalThis.document = {
  getElementById: (id) => (nodes.has(id) ? nodes.get(id) : nodes.set(id, el()).get(id)),
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: el,
  addEventListener() {},
  body: el(),
  documentElement: el(),
  visibilityState: "visible",
};
globalThis.window = { scrollY: 0, matchMedia: () => ({ matches: false }), innerWidth: 1400 };
globalThis.location = { search: "", pathname: "/", hostname: "localhost", hash: "" };
globalThis.localStorage = {
  _: new Map(),
  getItem(k) { return this._.has(k) ? this._.get(k) : null; },
  setItem(k, v) { this._.set(k, String(v)); },
  removeItem(k) { this._.delete(k); },
};
globalThis.history = { pushState() {}, replaceState() {} };
globalThis.requestAnimationFrame = (f) => f();

/* ==========================================================================
   The fetch log

   Every route the page can ask for, and a record of every ask. `fail` is what
   each route does next, so a test names the outage it wants rather than
   rebuilding the stub.
   ========================================================================== */

const WORKER = "https://nh-dashboard.gtnh.workers.dev";

/** Two subjects, two label tables, holding the same names in *different* order. */
const DREAM = {
  totalPRs: 3,
  first: "2019-01-01T00:00:00Z",
  last: "2026-08-01T00:00:00Z",
  windows: {},
  backlog: { total: 1, unreviewed: 0, drafts: 0, draftsKnown: true, buckets: [], oldest: [
    { number: 1, title: "a", ageDays: 4, labels: [0, 1] },
  ] },
};
const DREAM_LABELS = ["bug", "enhancement"];

const OTHER = {
  totalPRs: 1,
  first: "2020-01-01T00:00:00Z",
  last: "2026-08-02T00:00:00Z",
  windows: {},
  backlog: { total: 1, unreviewed: 0, drafts: 0, draftsKnown: true, buckets: [], oldest: [
    { number: 2, title: "b", ageDays: 9, labels: [0] },
  ] },
};
// Renumbered on purpose: index 0 is "enhancement" here and "bug" for Dream.
const OTHER_LABELS = ["enhancement", "bug"];

const INDEX = {
  windows: [{ id: "all", label: "all time", days: null }],
  seriesFields: ["opened"],
  backlogBuckets: ["0-7d"],
  reviewFields: ["repo", "number"],
  reviewStates: ["APPROVED"],
  assignedFields: ["repo", "number"],
  filedFields: ["number"],
  closedFields: ["number"],
  issueOutcomes: ["completed"],
  issueSeriesFields: ["filed"],
  issueWindowFields: { person: ["filed"], tracker: ["filed"] },
  prFieldCoverage: { openPRs: 2, reviewRequests: 2, total: 4, assignees: 4, labels: 4 },
  issueData: true,
  closerCoverage: { closed: 9, unknown: 0 },
  generatedAt: "2026-09-03T00:00:00Z",
  index: {
    contributors: [{ id: "Dream-Master", n: 3, a: 0, i: 0, last: "2026-08-01T00:00:00Z" },
                   { id: "Other-Person", n: 1, a: 0, i: 0, last: "2026-08-02T00:00:00Z" },
                   // Served by the API and absent from the build file, which is
                   // the only way a session running on the fallback can hold an
                   // API-sourced payload at all — and the case that proves the
                   // recovery drops the file's entries rather than all of them.
                   { id: "Api-Only", n: 2, a: 0, i: 0, last: "2026-08-03T00:00:00Z" }],
    repos: [{ id: "GT5-Unofficial", n: 4, open: 2, i: 0, iOpen: 0, last: null }],
  },
};

// The build file. A *third* ordering, so a payload resolved against the file's
// table when it should have used its own is a wrong name rather than a blank.
const FILE_LABELS = ["stale", "bug", "enhancement"];
const FILE = {
  ...INDEX,
  labelNames: FILE_LABELS,
  contributors: {
    "Dream-Master": { ...DREAM, backlog: { ...DREAM.backlog, oldest: [
      { number: 1, title: "a", ageDays: 4, labels: [1, 2] },
    ] } },
    "Other-Person": OTHER,
    "File-Only": { ...OTHER, totalPRs: 9 },
  },
  repos: { "GT5-Unofficial": OTHER },
};

let version = 7;
const log = [];
const fail = { index: false, subject: false, file: false, missing: new Set() };

/**
 * Held subject responses, for looking at the page mid-fetch.
 *
 * `gate` is what makes "a subject in flight" a state a test can stand in
 * rather than a moment it has to race. Without it the only lever is a timer,
 * and a fetch that resolves on the microtask queue has usually landed and
 * re-rendered before the next `setTimeout` runs — which is how the first draft
 * of this file asserted that a payload was absent and passed because it was
 * checking after it arrived.
 */
let gate = null;
const openGate = async () => {
  const waiting = gate;
  gate = null;
  waiting?.release();
  await new Promise((r) => setTimeout(r, 0));
};

globalThis.AbortSignal = { timeout: () => undefined };

globalThis.fetch = async (url) => {
  log.push(url);
  const ok = (body, headers = {}) => ({
    ok: true, status: 200, headers: new Map(Object.entries(headers)),
    json: async () => body,
  });
  // A Map is not a Headers, and only `.get` is ever called on one here.

  if (url === `${WORKER}/api/version`) return ok({ version });

  if (url === `${WORKER}/api/panel/drilldown`) {
    if (fail.index) throw new Error("index down");
    return ok(INDEX, { "x-refresh": "cron", "x-computed-at": "2026-09-03T00:00:00Z" });
  }

  const m = /\/api\/(contributor|repo)\/(.+)$/.exec(url);
  if (m) {
    const id = decodeURIComponent(m[2]);
    if (gate) await new Promise((release) => { gate = { release }; });
    if (fail.missing.has(id)) return { ok: false, status: 404 };
    if (fail.subject) throw new Error("subject down");
    const body =
      id === "Dream-Master" ? { ...DREAM, labelNames: DREAM_LABELS }
      : id === "Other-Person" ? { ...OTHER, labelNames: OTHER_LABELS }
      : id === "Api-Only" ? { ...OTHER, totalPRs: 2, labelNames: OTHER_LABELS }
      : id === "GT5-Unofficial" ? { ...OTHER, labelNames: OTHER_LABELS }
      : null;
    if (!body) return { ok: false, status: 404 };
    return ok(body, { "x-refresh": "cron", "x-subject-cache": "miss", "x-version": String(version) });
  }

  if (url.endsWith("drilldown.json")) {
    if (fail.file) throw new Error("no file either");
    return ok(FILE);
  }

  throw new Error(`unrouted fetch: ${url}`);
};

/* ========================================================================== */

const { DRILL, state } = await import("../web/js/state.js");
const dd = await import("../web/js/drilldown-data.js");
const { drillOnBuild, freshness } = await import("../web/js/data.js");
const { lineup, addOpponent, clearOpponents } = await import("../web/js/versus-data.js");
const { primeLive } = await import("../web/js/live.js");

let pass = 0;
const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

/** Every fetch since the last call, and clear. */
const since = () => log.splice(0, log.length);

let calls;
const fileFetches = (calls) => calls.filter((u) => u.endsWith("drilldown.json")).length;

/**
 * A fresh render.js, and the reason a test needs one.
 *
 * The lazy fallback is cached in a module-level variable — deliberately, so
 * that two subjects failing at once cost one download rather than two, which
 * is the behaviour asserted below. But that cache is per *session*, and this
 * file plays a dozen sessions, so clearing state alone leaves the second one
 * holding the first one's copy of a 23 MB file it never fetched.
 *
 * Re-imported under a fresh query string rather than given a reset hook:
 * `./state.js` resolves to the same URL from every copy, so state stays shared
 * and only the module's own privates start again. Production gets no
 * test-only export it would otherwise have to carry.
 */
let R;
let loads = 0;
const load = async () => (R = await import(`../web/js/render.js?load=${++loads}`));

/** Back to a page that has never looked at a drilldown. */
async function reset() {
  await load();
  state.data = { panels: { drilldown: { ok: true, file: "drilldown.json", error: null } } };
  state.drill = null;
  state.drillState = "idle";
  state.drillError = null;
  state.drillSource = null;
  state.subjects = { contributors: {}, repos: {} };
  state.subjectState = {};
  state.version = version;
  state.page = "contributor";
  state.subject = null;
  state.tab = null;
  state.drillWindow = "all";
  clearOpponents();
  fail.index = fail.subject = fail.file = false;
  fail.missing = new Set();
  gate = null;
  since();
}

/**
 * Land on a subject and let every fetch it triggers settle.
 *
 * The page drives itself off `render`, so this is what a navigation actually
 * does rather than a shortcut past it: `render` asks, the ask resolves, the ask
 * re-renders and may ask again. Three turns is enough for the deepest chain
 * here — index, subject, and a fallback behind either.
 */
async function visit(page, subject) {
  state.page = page;
  state.subject = subject;
  for (let i = 0; i < 4; i++) {
    R.render();
    await new Promise((r) => setTimeout(r, 0));
  }
}

/* ==========================================================================
   Nobody pays for a picker they are never shown

   The index is ~470 KB and two of the six pages need it, which is the entire
   reason it is not in `LIVE_PANELS` with the other nine. That distinction is
   invisible from anything the drilldown itself renders — every assertion below
   this section passes with `"drilldown"` in the eager list, because by then
   somebody has opened a drilldown and it would have been fetched either way.

   So this is asserted on the org pages instead, through `primeLive`, which is
   the load path that decides it. It is the only check here that would notice
   the laziness being quietly undone.
   ========================================================================== */

console.log("\nthe cost of not opening a drilldown\n");

await reset();
state.page = "analytics";
state.subject = null;
await primeLive();
R.render();
await new Promise((r) => setTimeout(r, 0));
calls = since();
check(
  "**an org page fetches no part of the drilldown**",
  calls.filter((u) => u.includes("drilldown")).length === 0,
  calls.filter((u) => u.includes("drilldown")).join(", "),
);
check("the version was read, so the overlay did run", calls.some((u) => u.endsWith("/api/version")));
check("and the page has no index in hand", state.drill === null);

/* ==========================================================================
   The normal path
   ========================================================================== */

console.log("\nthe two clocks\n");

await reset();
await visit("contributor", "Dream-Master");
const first = since();

check(
  "the index is fetched once",
  first.filter((u) => u.endsWith("/api/panel/drilldown")).length === 1,
  first.join(", "),
);
check(
  "and the subject once",
  first.filter((u) => u.includes("/api/contributor/Dream-Master")).length === 1,
  first.join(", "),
);
check("**the 23 MB build file is never fetched**", fileFetches(first) === 0, first.join(", "));
check("the head came from the API", state.drillSource === "api");
check("the subject renders", dd.subject()?.totalPRs === 3);
check(
  "and carries the Worker's version, not the page's guess",
  dd.subjectEntry().version === 7 && dd.subjectEntry().from === "api",
  `${dd.subjectEntry()?.version} / ${dd.subjectEntry()?.from}`,
);
check("the card reads cron", freshness({ page: "contributor" }, "x")?.tier === "cron");

// Navigating within the same subject must not re-ask for anything.
await visit("contributor", "Dream-Master");
check("a second visit to the same subject fetches nothing", since().length === 0);

/* ==========================================================================
   The label table, which is the trap
   ========================================================================== */

console.log("\nlabels resolve per subject\n");

check(
  "the payload's own table is kept, not the index's",
  JSON.stringify(dd.labelTable()) === JSON.stringify(DREAM_LABELS),
  JSON.stringify(dd.labelTable()),
);
check(
  "a chip resolves through it",
  JSON.stringify(dd.labelsOf({ labels: [0, 1] })) === JSON.stringify(["bug", "enhancement"]),
  JSON.stringify(dd.labelsOf({ labels: [0, 1] })),
);

// The index does not carry a label table at all, which is the reason a payload
// has to bring one: reaching for a global here finds nothing.
check("the index carries no global table to fall back on", state.drill.labelNames === undefined);

await visit("contributor", "Other-Person");
check(
  "and the next subject resolves through *its* renumbered table",
  JSON.stringify(dd.labelsOf({ labels: [0] })) === JSON.stringify(["enhancement"]),
  JSON.stringify(dd.labelsOf({ labels: [0] })),
);
// Same index, two subjects, two different names. Resolving both against one
// table would give "bug" for one of them and raise nothing.
await visit("contributor", "Dream-Master");
check(
  "going back does not resolve through the one just used",
  dd.labelsOf({ labels: [0] })[0] === "bug",
  dd.labelsOf({ labels: [0] })[0],
);

/* ==========================================================================
   A subject in flight
   ========================================================================== */

console.log("\nwhat renders while a fetch is out\n");

await reset();
// Held at the subject route, so the index lands and the subject does not.
gate = { release() {} };
await visit("contributor", "Dream-Master");

check("the index is in hand", !!state.drill);
check(
  "the subject is marked loading, not missing",
  state.subjectState["contributors/Dream-Master"] === "loading",
  state.subjectState["contributors/Dream-Master"],
);
check("and has no payload yet", dd.subject() === null);
// The picker's own words, which is the assertion that matters: the old test
// for "no such subject" was `state.subject && !subject()`, and this state
// satisfies both halves of it.
check(
  "the page does not claim there is no such contributor",
  !R.pickerHtml().includes("Nothing named"),
);
check("a drilldown with a subject in flight counts no cards", R.visibleIds().length === 0);
// And it is not asked for a second time while the first ask is out.
since();
R.render();
check("nor asked for twice while the first ask is out", since().length === 0);

await openGate();
check("it lands", dd.subject()?.totalPRs === 3);
check("and the loading state clears", state.subjectState["contributors/Dream-Master"] === "ready");

/* ==========================================================================
   A subject that is not there
   ========================================================================== */

console.log("\na 404 is not an outage\n");

await reset();
fail.missing = new Set(["Ghost"]);
await visit("contributor", "Ghost");
check("a 404 records missing", state.subjectState["contributors/Ghost"] === "missing");
check("and does not fetch 23 MB looking for it", fileFetches(since()) === 0);
check("and is not retried on the next render", (R.render(), since().length === 0));

/* ==========================================================================
   The lazy fallback
   ========================================================================== */

console.log("\nthe fallback, only once the API has failed\n");

await reset();
fail.index = true;
await visit("contributor", "Dream-Master");
calls = since();
check("an index failure falls through to the file", fileFetches(calls) === 1, calls.join(", "));
check("the head came from the build", state.drillSource === "build");
check("the picker still works", dd.subjectList().length === 3, String(dd.subjectList().length));
check("and so does the subject", dd.subject()?.totalPRs === 3);
check(
  "a subject out of the file says so",
  dd.subjectEntry().from === "build",
  dd.subjectEntry()?.from,
);
check("which reads red rather than blue", drillOnBuild() === true);
check(
  "the card reads down",
  freshness({ page: "contributor" }, "x")?.tier === "down",
  freshness({ page: "contributor" }, "x")?.tier,
);
check(
  "the file's own global table resolves its chips",
  JSON.stringify(dd.labelsOf({ labels: [1, 2] })) === JSON.stringify(["bug", "enhancement"]),
  JSON.stringify(dd.labelsOf({ labels: [1, 2] })),
);
// Everything the file carries is in hand, so a second subject costs no fetch.
await visit("contributor", "File-Only");
check("a second subject out of the file costs no fetch", fileFetches(since()) === 0);
check("and is served", dd.subject()?.totalPRs === 9);

// The index answering while a subject does not: the case where `p.down` alone
// would leave 22 cards a confident blue over the build file.
await reset();
fail.subject = true;
await visit("contributor", "Dream-Master");
calls = since();
check("a subject failure falls through to the file", fileFetches(calls) === 1, calls.join(", "));
check("the head is still the API's", state.drillSource === "api");
check("the panel's own flag is clear", state.data.panels.drilldown.down !== true);
check("but the card still reads down", freshness({ page: "contributor" }, "x")?.tier === "down");

// Two subjects failing at once must cost one download, not two.
await reset();
fail.subject = true;
state.page = "contributor";
state.subject = "Dream-Master";
addOpponent("Other-Person");
await visit("contributor", "Dream-Master");
check(
  "two subjects failing together share one download",
  fileFetches(since()) === 1,
);

await reset();
fail.index = fail.file = true;
await visit("contributor", "Dream-Master");
check("both failing is an error, not a blank page", state.drillState === "error");
check("and it says why", typeof state.drillError === "string" && state.drillError.length > 0);

/* ==========================================================================
   Coming back

   A session that started with the Worker down is serving every subject out of
   the file. When the Worker returns, the picker recovering is not enough: the
   payload on screen has to stop being red, and a build-file entry has no
   version of the Worker's to be found stale against. Both directions are
   checked, because each is a way for a page to sit on build-file numbers
   forever without anything looking wrong.
   ========================================================================== */

console.log("\ncoming back from the fallback\n");

await reset();
fail.index = true;
await visit("contributor", "Dream-Master");
check("down: the subject is the file's", dd.subjectEntry().from === "build");
check("down: and reads red", drillOnBuild() === true);

// A subject the file does not carry is fetched from the Worker even while the
// head is the fallback's, so this session holds one entry of each kind.
await visit("contributor", "Api-Only");
check("down: a subject the file lacks still comes from the API", dd.subjectEntry().from === "api");

// The Worker returns and the page polls. `primeLive` is that poll.
fail.index = false;
await primeLive();
check("up: the head is the API's again", state.drillSource === "api");
check(
  "up: the file's subjects were dropped rather than left red",
  state.subjects.contributors["Dream-Master"] === undefined,
);
// And only those. Re-fetching a payload the Worker already served would be
// work for an answer that has not changed, on up to five subjects at once.
check(
  "up: and the one already from the API was kept",
  state.subjects.contributors["Api-Only"]?.from === "api",
  String(state.subjects.contributors["Api-Only"]?.from),
);
await visit("contributor", "Dream-Master");
check("up: and refetched from the Worker", dd.subjectEntry()?.from === "api");
check("up: so the card reads cron again", freshness({ page: "contributor" }, "x")?.tier === "cron");

// The other direction: the index was fine all along and only the subject fell
// through, so nothing gets dropped and the version bump is what asks again.
await reset();
fail.subject = true;
await visit("contributor", "Dream-Master");
check("subject-only outage: the entry is the file's", dd.subjectEntry().from === "build");
check("and it records the version the page was on", dd.subjectEntry().version === 7);
fail.subject = false;
version = 8;
state.version = 8;
check("so a bump finds it stale", dd.subjectStale() === true);
await visit("contributor", "Dream-Master");
check("and it comes back from the Worker", dd.subjectEntry()?.from === "api");
check("no longer red", drillOnBuild() === false);
version = 7;

/* ==========================================================================
   A version bump
   ========================================================================== */

console.log("\na version bump\n");

await reset();
await visit("contributor", "Dream-Master");
since();
version = 8;
state.version = 8;
check("the cached copy is now stale", dd.subjectStale() === true);
// Rendering asks for a fresh one and keeps drawing the old one meanwhile: a
// drilldown left open must not flicker back to a spinner every ten minutes.
R.render();
check("the old copy still renders while the new one is fetched", dd.subject()?.totalPRs === 3);
await new Promise((r) => setTimeout(r, 0));
calls = since();
check(
  "and exactly one refetch went out",
  calls.filter((u) => u.includes("/api/contributor/")).length === 1,
  calls.join(", "),
);
check("which is no longer stale", dd.subjectStale() === false);
check("and cost no part of the 23 MB", fileFetches(calls) === 0);
version = 7;

/* ==========================================================================
   Head to head

   Not in the handoff, and the only reader of a subject other than the selected
   one. It used to index into the whole file, where all 7,047 were already in
   hand and an opponent cost a property lookup.
   ========================================================================== */

console.log("\nhead to head\n");

await reset();
await visit("contributor", "Dream-Master");
since();
addOpponent("Other-Person");
await visit("contributor", "Dream-Master");
calls = since();
check(
  "adding an opponent fetches it",
  calls.filter((u) => u.includes("/api/contributor/Other-Person")).length === 1,
  calls.join(", "),
);
check("the lineup holds both", lineup().length === 2);
check("subject first, opponent after", lineup()[0].id === "Dream-Master" && lineup()[1].id === "Other-Person");
check("the subject is pinned", lineup()[0].pinned === true);

// A lineup is drawn from the opponents that have arrived, which is the rule it
// already had for one the file did not carry.
addOpponent("Ghost-Rival");
fail.missing = new Set(["Ghost-Rival"]);
await visit("contributor", "Dream-Master");
check("an opponent that does not exist is left out rather than crashing", lineup().length === 2);

// A repo drilldown keeps its own bucket, so a login and a repo of the same name
// could never be served for each other.
await reset();
await visit("repo", "GT5-Unofficial");
check("a repo subject lands in the repos bucket", !!state.subjects.repos["GT5-Unofficial"]);
check("and not in the contributors one", !state.subjects.contributors["GT5-Unofficial"]);
check("the repo route is the one asked for", since().some((u) => u.includes("/api/repo/")));

/* ==========================================================================
   Encoding

   Some repo names are fine and some logins are not, and the route decodes with
   decodeURIComponent.
   ========================================================================== */

console.log("\nids that need encoding\n");

await reset();
fail.missing = new Set(["a/b?c"]);
await visit("contributor", "a/b?c");
calls = since();
const asked = calls.find((u) => u.includes("/api/contributor/"));
check(
  "the id is percent-encoded on the way out",
  asked?.endsWith(`/api/contributor/${encodeURIComponent("a/b?c")}`),
  asked,
);
check("and it resolves to the subject that was asked for", state.subjectState["contributors/a/b?c"] === "missing");

/* ========================================================================== */

console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
