/**
 * What each card claims about its own freshness.
 *
 *   node test/freshness.test.js
 *
 * The tier is read from a header the Worker sets, not from a list in the
 * frontend, and these are the two assertions that make that worth the trouble:
 * promoting a panel from the cron to the delivery path must retint its card
 * with no change here, and a panel the API could not serve must read `build`
 * rather than the tier it would have had. The second is the one that matters
 * in an outage — a dashboard quietly showing yesterday's numbers looks exactly
 * like a fresh one.
 */

const { state } = await import("../web/js/state.js");
const { freshness, sourcePanel: sourceOf } = await import("../web/js/data.js");

let pass = 0, fail = 0;
const check = (n, ok, d="") => { ok ? (pass++, console.log("  ok    "+n))
                                   : (fail++, console.log("  FAIL  "+n+(d?" — "+d:""))); };

state.data = { panels: {
  approvedUnmerged: { ok: true, data: [], live: true,  refresh: "instant", computedAt: "T1" },
  changesRequested: { ok: true, data: [], live: true,  refresh: "cron" },
  needsRelease:     { ok: true, data: [] },                       // never overlaid
  analytics:        { ok: true, data: {}, live: true,  refresh: "cron" },
  issues:           { ok: true, data: {} },                       // built only
  contributors:     { ok: true, data: {}, live: true },           // live, no header
  drilldown:        { ok: true, data: null },
  broken:           { ok: false, error: "nope" },
} };

const t = (m, want, label) => {
  const f = freshness(m, "x");
  check(label, (f?.tier ?? null) === want, `got ${f?.tier ?? null}`);
};

console.log("\nfreshness tiers\n");
t({ panelId: "approvedUnmerged" }, "instant", "webhook-rebuilt card reads instant");
t({ panelId: "changesRequested" }, "cron",    "cron-rebuilt card reads cron");
t({ panelId: "needsRelease" },     "build",   "never-overlaid card reads build");
t({ page: "analytics" },           "cron",    "a page-based card follows its panel");
t({ page: "issues" },              "build",   "issues page reads build until ported");
t({ page: "people" },              "cron",    "live panel with no header defaults to cron");
t({ page: "contributor" },         "build",   "drilldown reads build before its panel is asked for");
t({ panelId: "broken" },           null,      "a failed panel gets no tint");
t({ panelId: "nosuch" },           null,      "an unknown panel gets no tint");
t({ page: "nosuchpage" },          null,      "a card with no panel gets no tint");

// The point of reading the header rather than keeping a list: promoting a panel
// in the Worker must change the card with no frontend edit.
state.data.panels.changesRequested.refresh = "instant";
t({ panelId: "changesRequested" }, "instant", "promoting a panel needs no frontend change");

// An outage is not the same as being built by design, and the whole point of
// the indicator is that those two look different.
state.data.panels.approvedUnmerged = { ok: true, data: [], down: true };
t({ panelId: "approvedUnmerged" }, "down", "a panel whose API failed reads down");
t({ panelId: "needsRelease" }, "build", "a panel built by design stays amber");

// A panel that came back fine on a later poll must stop reading as down.
state.data.panels.approvedUnmerged = {
  ok: true, data: [], live: true, down: false, refresh: "instant",
};
t({ panelId: "approvedUnmerged" }, "instant", "a recovered panel clears down");

/* ==========================================================================
   The drilldown, which arrives in two pieces

   Every other panel is one fetch, so `p.down` says everything. This one is an
   index plus one payload per subject, and either half can fall through to the
   23 MB build file on its own — so a green index over a build-file subject is
   a card that would read a confident blue about data the API never served.
   22 of the 53 cards at once, which is the largest wrong thing the four
   colours exist to prevent.
   ========================================================================== */

console.log("\nthe drilldown's two halves\n");

state.page = "contributor";
state.subject = "Dream-Master";
state.data.panels.drilldown = {
  ok: true, data: {}, live: true, down: false, refresh: "cron",
};
state.drillSource = "api";
state.subjects.contributors["Dream-Master"] = { s: {}, labelNames: [], version: 7, from: "api" };
t({ page: "contributor" }, "cron", "index and subject both from the Worker read cron");

// A subject out of the file says so, whatever version it happens to record.
state.subjects.contributors["Dream-Master"].from = "build";
t({ page: "contributor" }, "down", "a subject from the build file reads down, not blue");

state.subjects.contributors["Dream-Master"].from = "api";
state.drillSource = "build";
t({ page: "contributor" }, "down", "an index from the build file reads down too");

state.drillSource = "api";
state.data.panels.drilldown.down = true;
t({ page: "contributor" }, "down", "and the panel's own flag still counts");

// The other pages must not inherit any of it: `drillOnBuild` is scoped to the
// page being looked at, and a repo drilldown has its own cache bucket.
state.data.panels.drilldown.down = false;
state.page = "analytics";
t({ page: "analytics" }, "cron", "an org page is untouched by the drilldown's source");

state.page = "repo";
state.subject = "GT5-Unofficial";
t({ page: "repo" }, "cron", "a subject nothing has fetched yet is not called stale");

state.page = "contributor";
state.subject = "Dream-Master";

/* ==========================================================================
   The tally in the topbar
   --------------------------------------------------------------------------
   It counted panels and the page tinted cards, so "7 panels live" sat above a
   view where no combination of rings added to seven. These assert the unit:
   one panel behind eleven cards is eleven, and the number only ever describes
   the cards the current view drew.
   ========================================================================== */

const { tierCounts, visibleIds } = await import("../web/js/render.js");
const { PAGES } = await import("../web/js/pages.js");

console.log("\nfreshness tally\n");

state.data.panels.approvedUnmerged = {
  ok: true, data: [], live: true, refresh: "instant",
};
state.data.panels.changesRequested = {
  ok: true, data: [], live: true, refresh: "instant",
};
state.data.panels.depUpdates = { ok: true, data: [], live: true, refresh: "cron" };
state.data.panels.byLabel = { ok: true, data: {}, live: true, refresh: "cron" };
// Deliberately *not* production, which is the point. In production `ciHealth`
// is live and so is `analytics`, so the mis-tinted card was blue over blue data
// and nothing looked wrong. This fixture is the divergence that exposes it —
// the case the tint exists for, and the one no amount of looking at the running
// dashboard would have shown.
state.data.panels.ciHealth = { ok: true, data: {} };
// needsRelease stays un-overlaid from the fixture above, which makes the Dream
// Panel the one page carrying three tiers at once.

const modulesOf = id => PAGES.find(p => p.id === id).modules;

// The analytics page is not one panel. Nine of its eleven cards read
// `analytics`; Label mix reads `byLabel` and Actions load reads `ciHealth`, and
// both were tinted from the page's panel until they said so. The old assertion
// here — eleven of eleven, one tier — was not merely loose, it was the thing
// that made the bug invisible: it asserted the wrong behaviour and passed.
const analytics = tierCounts(modulesOf("analytics"));
check(
  "a page's cards count against the panel each of them reads",
  analytics.cron === 10 && analytics.build === 1,
  JSON.stringify(analytics),
);

const dream = tierCounts(modulesOf("dream"));
check("a mixed page reports every tier it holds",
  dream.instant === 2 && dream.cron === 2 && dream.build === 1, JSON.stringify(dream));

check("a page with no live panel is all build",
  tierCounts(modulesOf("issues")).build === modulesOf("issues").length);

// The tally has to move with the view, or it's a number with nothing on screen
// to check it against — which is the whole complaint it exists to answer.
state.page = "dream";
state.tab = null;
check("the tally follows the current page",
  visibleIds().join() === modulesOf("dream").join(), visibleIds().join());

state.page = "contributor";
state.drillState = "idle";
check("a drilldown with no subject counts nothing", visibleIds().length === 0);

// A tier with no cards must not print a zero, and a tier that gains one must
// appear without any list here being edited.
state.page = "analytics";
check("empty tiers are absent rather than zero",
  !("instant" in analytics) && !("down" in analytics), JSON.stringify(analytics));

// An outage is per panel, not per page. `analytics` going down must not repaint
// the two cards whose data came from somewhere that is still answering — a red
// border on a card that is fine is the same class of lie as a blue one on a
// card that is not.
state.data.panels.analytics.down = true;
const out = tierCounts(modulesOf("analytics"));
check("an outage moves only the cards that read the failed panel",
  out.down === 9 && out.cron === 1 && out.build === 1, JSON.stringify(out));

/* ==========================================================================
   Every card, not just the ones someone thought to test

   The two mis-tinted cards were found by reading the source, and they had been
   wrong since `ciHealth` was registered. Nothing here would have caught them:
   every assertion above names a panel or a page, and the cards that go wrong
   are exactly the ones nobody thought to name. So these walk all 53.
   ========================================================================== */

const { MODULES } = await import("../web/js/modules/index.js");
const ids = Object.keys(MODULES);

console.log(`\nevery card: ${ids.length} of them\n`);

// A card with no resolvable panel gets no border at all, which reads as "this
// is fine" and is the quietest of the four failures. The `dream` page has no
// PAGE_PANEL entry and survives only because all five of its cards carry a
// panelId; a sixth added without one would land here.
const untinted = ids.filter((id) => !sourceOf(MODULES[id]));
check("every card resolves to a panel", untinted.length === 0, untinted.join(", "));

// The real assertion: a card must be tinted by the panel it reads. Read off the
// source rather than declared here, so a card that starts reading a second
// panel fails this until it says so.
const readsOf = (id) =>
  [...(MODULES[id].render?.toString() ?? "").matchAll(/panel\("([A-Za-z]+)"\)/g)].map((m) => m[1]);

const lying = [];
for (const id of ids) {
  const named = readsOf(id);
  if (!named.length) continue;
  const tint = sourceOf(MODULES[id]);
  if (!named.includes(tint)) lying.push(`${id} reads ${named.join("+")} and tints from ${tint}`);
}
check(
  "a card that names a panel in its own render is tinted by it",
  lying.length === 0,
  lying.join("; "),
);
check(
  "and the two that read across pages say so",
  MODULES.labels?.reads === "byLabel" && MODULES.actions?.reads === "ciHealth",
);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
