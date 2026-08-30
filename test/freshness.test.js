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
const { freshness } = await import("../web/js/data.js");

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
t({ page: "contributor" },         "build",   "drilldown reads build");
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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
