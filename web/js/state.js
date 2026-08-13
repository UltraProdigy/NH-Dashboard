/* ==========================================================================
   State
   ========================================================================== */

const state = {
  data: null,
  page: "analytics",
  module: null,       // null = the page's overview grid
  // One period control per page, in the same shape the drilldowns use: it
  // scopes the KPI tiles and the charts together. There used to be two — a
  // window dropdown for the aggregates and a separate range picker for the
  // chart's x-axis — which put two time controls on one toolbar answering
  // subtly different questions about the same page.
  // Six months rather than three. Three is short enough that a quiet fortnight
  // moves every number on the page, and on an org this size the question is
  // nearly always "what does the last half-year look like".
  window: "m6",
  // New Faces is the exception, and keeps its own — see OWN_WINDOW. Six months
  // of first-timers is a long list of people who aren't new any more.
  newFacesWindow: "m3",
  gran: "month",      // x-axis granularity: day | week | month
  filter: "",
  label: null,
  minActivity: 3,
  sort: null,
  dir: -1,

  // ---- Dream Panel ----
  // Repos and labels to hide from every card on that page. Some labels mean
  // "this is not yours to merge" and some repos are somebody else's problem;
  // either way they're noise on a page whose whole job is a short actionable
  // list. Held as arrays rather than Sets so they serialize to localStorage.
  dreamExcl: { repos: [], labels: [] },
  // Which exclusion popup is open, if any: null | "repos" | "labels". They're
  // two buttons rather than one popup with two columns — hiding a repo and
  // hiding a label are unrelated decisions, and pairing them meant every rule
  // in that popup had to survive at half width.
  exclOpen: null,
  exclQ: { repos: "", labels: "" },   // search text, per group

  // ---- Issue Analytics ----
  // Which repo's labels the Label mix tab is showing, and which label the
  // trend chart is on. Null means "whatever the panel says is the focus" —
  // held as null rather than seeded with the config value so the default can
  // change in config.js without a stale name pinned in here.
  issueLabelRepo: null,
  issueLabel: null,

  // ---- drilldown ----
  // Its own window, independent of the analytics/people one. Looking at a
  // single subject you almost always want their whole history first and then
  // narrow; looking at the org you want the recent picture. Sharing one
  // setting made each page wrong half the time.
  // ---- head to head ----
  // Who the current subject is being compared against, per mode, plus the
  // state of that card's own search box. Kept per mode rather than one list:
  // flipping from a contributor to a repo shouldn't drag four logins along, and
  // coming back should find the lineup you left.
  vs: { contributor: [], repo: [], q: "", open: false, active: 0 },

  drillWindow: "all",
  closedState: "all", // Closed PRs tab: all | merged | dropped
  subject: null,      // selected login or repo name; null = nothing picked yet
  drill: null,        // contents of drilldown.json, fetched on first visit
  drillState: "idle", // idle | loading | ready | error
  drillError: null,
  combo: { q: "", open: false, active: 0 },
};

/**
 * Drilldown page id -> the key its subjects live under in drilldown.json.
 * Membership in this map is also what marks a page as a drilldown page, which
 * is what the router keys off to expect a subject segment in the hash.
 */
const DRILL = { contributor: "contributors", repo: "repos" };
const isDrill = (page) => Object.hasOwn(DRILL, page);
const otherMode = (page) => (page === "contributor" ? "repo" : "contributor");

/** Closed PRs toggle. Key order is the order the buttons appear in. */
const CLOSED_LABEL = { all: "All", merged: "Merged", dropped: "Closed" };

/**
 * x-axis granularity. `bucketDays` is what turns a period in days into a bucket
 * count when slicing a series.
 */
const GRANS = [
  { id: "day",   label: "by day",   bucketDays: 1 },
  { id: "week",  label: "by week",  bucketDays: 7 },
  { id: "month", label: "by month", bucketDays: 30.4 },
];

/** Defaults for the Dream Panel exclusions, applied on a first visit. */
const DREAM_EXCL_DEFAULT = {
  repos: ["Angelica"],
  labels: ["⚠️ AUTHOR MERGE ONLY"],
};

export { CLOSED_LABEL, DREAM_EXCL_DEFAULT, DRILL, GRANS, isDrill, state };
