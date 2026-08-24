/* ==========================================================================
   State
   ========================================================================== */

const state = {
  data: null,
  page: "analytics",
  // A module id, or "@<group>" for a tab holding several cards. Null = the
  // page's overview grid.
  tab: null,
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
  minActivity: 3,
  // Module id -> { key, dir }. Per module rather than per page because a group
  // tab stacks several sortable tables that share column keys — see table.js.
  sort: {},

  // ---- Dream Panel ----
  // Repos and labels to hide, per card. Per card rather than per page because
  // the cards ask different questions: a repo whose releases somebody else
  // cuts is noise on Needs a release and perfectly relevant on Approved, and one
  // shared list forced those two answers to be the same.
  // Filled in by loadExclusions(); shape is panel id -> { repos, labels }, held
  // as arrays rather than Sets so they serialize to localStorage.
  dreamExcl: {},
  // Which exclusion popup is open, if any: null, or "<panelId>:<kind>".
  exclOpen: null,
  exclQ: {},          // search text, keyed the same way
  // Which labels By label is showing, one column each, in the order they
  // appear. Filled in by loadLabels(); see DREAM_LABELS_DEFAULT.
  dreamLabels: [],

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
  // Pull requests card: all | open | merged | dropped. Open and resolved PRs
  // used to be two cards, which meant the same question — "what has this person
  // got in this repo" — was answered in two places with two different tables
  // and no way to read them against each other.
  prState: "all",
  reviewKind: "all", // Reviews card: all | requested | reviewing | assigned
  // Reviews card, second axis: all | open | merged | dropped. Opens on `open`,
  // because the card's question is "what is waiting on this person" and a
  // review request on a PR that merged last spring is not waiting on anybody.
  // The other three are there because "what did I own last quarter" is a fair
  // question too — it's just not the one the card is for.
  reviewState: "open",
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

/** Pull requests toggle. Key order is the order the buttons appear in. */
const PR_STATE_LABEL = { all: "All", open: "Opened", merged: "Merged", dropped: "Closed" };

/**
 * Reviews toggle. "Requested" is what somebody asked them to look at,
 * "Reviewing" is what they've already said something about and hasn't landed,
 * and a PR can honestly be both — a re-request after a round of changes is
 * exactly that. All shows one row per PR with every reason it's there.
 */
const REVIEW_KIND_LABEL = {
  all: "All", requested: "Requested", reviewing: "Reviewing", assigned: "Assigned",
};

/**
 * The Reviews card's other axis, and deliberately not PR_STATE_LABEL.
 *
 * The two say nearly the same words about different things: on Pull requests
 * "Opened" is when the person started it, while here the row is somebody else's
 * PR and "Open" is where it currently sits. Sharing a map would make one of the
 * two labels wrong, and they'd have to stay wrong together.
 */
const REVIEW_STATE_LABEL = {
  all: "All", open: "Open", merged: "Merged", dropped: "Closed",
};

/**
 * x-axis granularity. `bucketDays` is what turns a period in days into a bucket
 * count when slicing a series.
 */
const GRANS = [
  { id: "day",   label: "by day",   bucketDays: 1 },
  { id: "week",  label: "by week",  bucketDays: 7 },
  { id: "month", label: "by month", bucketDays: 30.4 },
];

/**
 * Which kinds of exclusion each Dream card offers, in the order the buttons
 * appear in its header. Needs a release is repo-level data with no labels on
 * it, and Changes requested is a list you want to read whole — the only thing
 * worth hiding there is a repo that isn't yours.
 */
const DREAM_EXCL_KINDS = {
  approvedUnmerged: ["repos", "labels"],
  changesRequested: ["repos"],
  needsRelease: ["repos"],
  depUpdates: ["repos"],
  byLabel: ["repos", "labels"],
};

/**
 * Defaults, applied on a first visit and whenever a card has nothing saved.
 * Repo names are bare — the PR panels carry `owner/name` and the release panel
 * carries the name alone, and `bareRepo` is what reconciles them.
 */
const DREAM_EXCL_DEFAULT = {
  approvedUnmerged: {
    repos: ["Angelica", "Galaxia", "UtilitiesInExcess", "Horizon-QA", "lwjgl3ify"],
    labels: ["⚠️ AUTHOR MERGE ONLY"],
  },
  changesRequested: { repos: [], labels: [] },
  needsRelease: {
    repos: [
      "DreamAssemblerXXL", "TC4Tweaks", "GTNewHorizons.github.io", "StargateNH",
      "UtilitiesInExcess", "MergeMasterXXL-TestRepo", "GTNH-Web-Map",
      "Ic2ExpReactorPlanner", "Angelica", "TaskNH", "MaterialLib", "MergePreMaster",
      "BugTorch", "TinkersGregworks", "GTNH-Translations",
    ],
    labels: [],
  },
  depUpdates: { repos: [], labels: [] },
  byLabel: { repos: [], labels: [] },
};

/**
 * The labels By label opens on, one column each.
 *
 * These three are the ones an admin is actually gating on: what's on Zeta,
 * what changes the game's balance, and what can't move without somebody with
 * the rights to move it. Every column is swappable and the card remembers what
 * you left it on — this is only what it ships with, and what Reset goes back
 * to. Names must match Label-Sync-GTNH exactly, emoji shortcodes and all; a
 * name the org no longer carries just leaves that column empty.
 */
const DREAM_LABELS_DEFAULT = [
  ":construction: Testing on Zeta",
  "Affects Balance",
  "Requires Admin",
];

/**
 * Ceilings on columns — the overview's is lower than the card's own tab's.
 *
 * On the overview the card is one of five and shares the page; four 240px
 * columns is about what a laptop shows without the row wrapping, and a card
 * that wraps to two rows of columns stops being something you take in at a
 * glance, which is the only reason to show labels side by side at all.
 *
 * Its own tab has the whole page and nothing to be glanced past, so it goes to
 * twelve. Columns over the overview's limit stay configured and stay saved;
 * they're just not drawn there, and the card says how many it's holding back.
 */
const DREAM_LABELS_MAX = 12;
const DREAM_LABELS_OVERVIEW = 4;

export {
  PR_STATE_LABEL,
  REVIEW_KIND_LABEL,
  REVIEW_STATE_LABEL,
  DREAM_EXCL_DEFAULT,
  DREAM_EXCL_KINDS,
  DREAM_LABELS_DEFAULT,
  DREAM_LABELS_MAX,
  DREAM_LABELS_OVERVIEW,
  DRILL,
  GRANS,
  isDrill,
  state,
};
