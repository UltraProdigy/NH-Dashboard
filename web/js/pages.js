/**
 * `modules` is the overview grid, in order, and nothing below changes it.
 *
 * `groups` is the tab bar only: several cards under one tab that stacks them.
 * A group appears in the bar where its first member sits in `modules`, so
 * there's no second ordering to drift out of sync with the layout — but its own
 * `modules` list is the stacking order, which is not always the grid's. The
 * grid puts Biggest PRs before Closed PRs to fill a twelve-column row; stacked,
 * open-then-closed-then-biggest is how anyone reads them.
 *
 * `count` names the member whose badge the group borrows. Summing members would
 * double-count — Biggest PRs overlaps both Open and Closed — and no badge beats
 * a wrong one. `twin` is the other drilldown mode's equivalent group.
 *
 * `section` is the sidebar heading a page sits under, and it is read off this
 * array in order rather than declared as a second list of memberships — same
 * reasoning as the tab bar above. A heading is drawn wherever the value
 * changes, so moving a page between sections is moving it in this file.
 *
 * A page with an empty `modules` is one that hasn't been built yet. It routes,
 * it sits in the sidebar, and it draws the under-construction card — see
 * `pageBody` in render.js. Nothing else needs to know about it: no tabs, no
 * toolbar, no panel, no freshness ring.
 */
const ADMIN = "Admin Resources";
const ANALYTICS = "Org Analytics";
const QUERIES = "Queries";

const PAGES = [
  {
    id: "dream", label: "Dream Panel", section: ADMIN,
    icon: `<path d="M8 1.5 2 4.2v4.1c0 3.4 2.4 6 6 6.2 3.6-.2 6-2.8 6-6.2V4.2L8 1.5Zm2.8 4.9-3.3 4a.7.7 0 0 1-1 .05L4.9 8.9a.7.7 0 1 1 .95-1l1 .95 2.8-3.4a.7.7 0 1 1 1.1.9Z"/>`,
    // 6+6 / 6+6 / 12. By label is the full width because it draws a column per
    // label and three of them in half a row is three columns of nothing.
    modules: ["approvedUnmerged", "needsRelease", "changesRequested", "depUpdates", "byLabel"],
  },
  {
    id: "ci", label: "CI Health", section: ADMIN,
    icon: `<path d="M6 2c.306 0 .582.187.696.471L10 10.731l1.304-3.26A.751.751 0 0 1 12 7h3.25a.75.75 0 0 1 0 1.5h-2.742l-1.812 4.528a.751.751 0 0 1-1.392 0L6 4.77 4.696 8.03A.75.75 0 0 1 4 8.5H.75a.75.75 0 0 1 0-1.5h2.742l1.812-4.529A.751.751 0 0 1 6 2Z"/>`,
    modules: [],
  },
  {
    id: "labels", label: "Labels", section: ADMIN,
    icon: `<path d="M1 7.775V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 1.75 0 0 1 0 2.474l-5.026 5.026a1.75 1.75 0 0 1-2.474 0l-6.25-6.25A1.752 1.752 0 0 1 1 7.775Zm1.5 0c0 .066.026.13.073.177l6.25 6.25a.25.25 0 0 0 .354 0l5.025-5.025a.25.25 0 0 0 0-.354l-6.25-6.25a.25.25 0 0 0-.177-.073H2.75a.25.25 0 0 0-.25.25ZM6 5a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z"/>`,
    modules: [],
  },
  {
    id: "rulesets", label: "Rulesets", section: ADMIN,
    icon: `<path d="M8.75.75V2h.985c.304 0 .603.08.867.231l1.29.736c.038.022.08.033.124.033h2.234a.75.75 0 0 1 0 1.5h-.427l2.111 4.692a.75.75 0 0 1-.154.838l-.53-.53.529.531-.001.002-.002.002-.006.006-.006.005-.01.01-.045.04c-.21.176-.441.327-.686.45C14.556 10.78 13.88 11 13 11a4.498 4.498 0 0 1-2.023-.454 3.544 3.544 0 0 1-.686-.45l-.045-.04-.016-.015-.006-.006-.004-.004v-.001a.75.75 0 0 1-.154-.838L12.178 4.5h-.162c-.305 0-.604-.079-.868-.231l-1.29-.736a.245.245 0 0 0-.124-.033H8.75V13h2.5a.75.75 0 0 1 0 1.5h-6.5a.75.75 0 0 1 0-1.5h2.5V3.5h-.984a.245.245 0 0 0-.124.033l-1.289.737c-.265.15-.564.23-.869.23h-.162l2.112 4.692a.75.75 0 0 1-.154.838l-.53-.53.529.531-.001.002-.002.002-.006.006-.016.015-.045.04c-.21.176-.441.327-.686.45C4.556 10.78 3.88 11 3 11a4.498 4.498 0 0 1-2.023-.454 3.544 3.544 0 0 1-.686-.45l-.045-.04-.016-.015-.006-.006-.004-.004v-.001a.75.75 0 0 1-.154-.838L2.178 4.5H1.75a.75.75 0 0 1 0-1.5h2.234a.249.249 0 0 0 .125-.033l1.288-.737c.265-.15.564-.23.869-.23h.984V.75a.75.75 0 0 1 1.5 0Zm2.945 8.477c.285.135.718.273 1.305.273s1.02-.138 1.305-.273L13 6.327Zm-10 0c.285.135.718.273 1.305.273s1.02-.138 1.305-.273L3 6.327Z"/>`,
    modules: [],
  },

  {
    id: "overview", label: "Org Overview", section: ANALYTICS,
    icon: `<path d="M1.5 1.75V13.5h13.75a.75.75 0 0 1 0 1.5H.75a.75.75 0 0 1-.75-.75V1.75a.75.75 0 0 1 1.5 0Zm14.28 2.53-5.25 5.25a.75.75 0 0 1-1.06 0L7 7.06 4.28 9.78a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l3.25-3.25a.75.75 0 0 1 1.06 0L10 7.94l4.72-4.72a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042Z"/>`,
    modules: [],
  },
  {
    id: "issues", label: "Issue Analytics", section: ANALYTICS,
    icon: `<path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm9 3a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm-.25-6.25v3.5a.75.75 0 0 1-1.5 0v-3.5a.75.75 0 0 1 1.5 0Z"/>`,
    // 12 / 8+4 / 6+6 / 6+6 / 12 / 12 / 12 — same twelve-column tiling rule as
    // the other pages: a card that doesn't fit the row's remainder wraps and
    // leaves a hole.
    modules: ["iPulse", "iVolume", "iTriage", "iResponse", "iLabels", "iRepos", "iReporters", "iPeople", "iOldest", "iDiscussed"],
    groups: [
      // iReporters is the ranked-bar reading of iPeople's table, and the two
      // were already cross-referencing each other in prose. Grouped rather than
      // given `tab: false` like the People page previews, because its expanded
      // view has a fourth list the collapsed card doesn't show.
      { id: "people", label: "By contributor", count: "iPeople",
        modules: ["iReporters", "iPeople"] },
      { id: "attention", label: "Needs attention", modules: ["iOldest", "iDiscussed"] },
    ],
  },
  {
    id: "analytics", label: "PR Analytics", section: ANALYTICS,
    icon: `<path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"/>`,
    // 12 / 8+4 / 6+6 / 6+6 / 6+6 / 6+6 / 12 / 12 — every row fills its twelve
    // columns, so nothing wraps and leaves a hole. See the note on the repo page.
    modules: ["pulse", "volume", "backlog", "latency", "growth", "repos", "reviewload", "sizes", "outcomes", "labels", "heatmap", "grossing", "actions"],
    groups: [
      // Volume and the hour/day heatmap are both "when do PRs arrive". Backlog
      // stays out: "how many are open right now" is the number people come to
      // this page for, and it isn't a question about time at all.
      { id: "volume", label: "Volume", modules: ["volume", "heatmap"] },
      // Outcomes joins them because "how long did it take" and "what happened
      // to it in the end" are one question read two ways. Size stays out: it is
      // a property of the change, not of how the org handled it.
      { id: "review", label: "Review", modules: ["latency", "reviewload", "outcomes"] },
      { id: "repos",  label: "Repos",  modules: ["repos", "grossing"] },
    ],
  },
  {
    id: "people", label: "Contributor Activity", section: ANALYTICS,
    icon: `<path d="M5.5 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm6 0a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM.5 14c0-2.5 2.2-4.5 5-4.5s5 2 5 4.5H.5Zm11 0c0-1.6-.6-3-1.6-4 .5-.3 1-.4 1.6-.4 2.2 0 4 1.6 4 4.4h-4Z"/>`,
    modules: ["topAuthors", "topReviewers", "leaderboard", "newcomers", "lapsed"],
  },
  {
    // `repos` rather than `repo`, which the drilldown holds. The two are a
    // page id apart in the URL and a section apart in the sidebar: this one is
    // every repo at once, that one is the repo you named.
    id: "repos", label: "Repo Activity", section: ANALYTICS,
    icon: `<path d="M7.122.392a1.75 1.75 0 0 1 1.756 0l5.003 2.902c.83.482.83 1.68 0 2.162L8.878 8.358a1.75 1.75 0 0 1-1.756 0L2.119 5.456a1.251 1.251 0 0 1 0-2.162ZM8.125 1.69a.248.248 0 0 0-.25 0l-4.63 2.685 4.63 2.685a.248.248 0 0 0 .25 0l4.63-2.685ZM1.601 7.789a.75.75 0 0 1 1.025-.273l5.249 3.044a.248.248 0 0 0 .25 0l5.249-3.044a.75.75 0 0 1 .752 1.298l-5.248 3.044a1.75 1.75 0 0 1-1.756 0L1.874 8.814A.75.75 0 0 1 1.6 7.789Zm0 3.5a.75.75 0 0 1 1.025-.273l5.249 3.044a.248.248 0 0 0 .25 0l5.249-3.044a.75.75 0 0 1 .752 1.298l-5.248 3.044a1.75 1.75 0 0 1-1.756 0l-5.248-3.044a.75.75 0 0 1-.273-1.025Z"/>`,
    // 12 / 6+6 / 12, which fills every row — same tiling rule as the pages
    // above. Movers (risers and fallers against the previous equal-length
    // period) is the obvious fifth card and is deliberately absent: the panel
    // ships no per-repo previous period, and approximating one from the
    // overlapping windows would be a plausible number rather than a true one.
    modules: ["oPulse", "oLifecycle", "oStale", "oTable"],
    groups: [
      // Both answer "which repos are in trouble" — one by how long they have
      // been quiet, one by what is rotting in them while they are not.
      { id: "health", label: "Health", modules: ["oLifecycle", "oStale"] },
    ],
  },

  {
    id: "find", label: "Org Search", section: QUERIES,
    icon: `<path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.5 4.5 0 1 0-9 0 4.5 4.5 0 0 0 9 0Z"/>`,
    // One module, and it holds the form as well as the results — see the head
    // of modules/find.js. `tab: false` on it means this page has no tab bar,
    // which is right: there is nothing here to be a second view of.
    //
    // Deliberately absent from `PAGE_PANEL` in data.js. Every other page reads
    // one panel and is tinted by its freshness; a search reads the tables
    // directly and has no rebuild to be fresh or stale relative to, so it draws
    // no tint rather than borrowing a misleading one.
    modules: ["find"],
  },
  {
    id: "contributor", label: "Contributor Drilldown", section: QUERIES,
    icon: `<path d="M10.56 8.07a6 6 0 0 1 3.43 5.15.75.75 0 1 1-1.5.07 4.5 4.5 0 0 0-8.98 0 .75.75 0 0 1-1.5-.07 6 6 0 0 1 3.43-5.15 4 4 0 1 1 5.12 0ZM10.5 5a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"/>`,
    // Tiles 12 / 8+4 / 6+6 / 12 / 12 / 12 / 6+6 / 12 — see the note on the repo
    // page about gaps. The issue cards come after the PR ones rather than
    // interleaved: they answer a different question about the same person, and
    // reading them as a block is how anyone actually uses them.
    // cReviews sits in the six columns Open PRs used to, which is where the
    // "what's outstanding" slot has always been — it's the question that
    // changed, not the position.
    modules: [
      "cProfile", "cActivity", "cRepos", "cCollab", "cReviews", "cBiggest", "cPRs",
      "cIssues", "cTriage", "cFiled", "cVersus",
    ],
    // The twin map is what these were derived from: every `twin:` pair lands in
    // the same-named group on both drilldown pages, and no pair is split. The
    // grouping isn't a new opinion about the data, it's that map read as a
    // partition — which is also why the two pages have to move together.
    groups: [
      { id: "activity", label: "Activity", twin: "@activity",
        modules: ["cActivity", "cRepos", "cCollab"] },
      { id: "prs", label: "Pull requests", twin: "@prs", count: "cPRs",
        modules: ["cReviews", "cPRs", "cBiggest"] },
      { id: "issues", label: "Issues", twin: "@issues", count: "cIssues",
        modules: ["cIssues", "cTriage", "cFiled"] },
    ],
  },
  {
    id: "repo", label: "Repo Drilldown", section: QUERIES,
    icon: `<path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.71 1.7.75.75 0 1 1-1.08 1.05A2.5 2.5 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.71A2.49 2.49 0 0 1 4.5 9h8Z"/>`,
    // Order matters on the overview: the grid is 12 columns and a card that
    // doesn't fit the remainder wraps, leaving a hole. rPeople (6) after
    // rActivity (8) left 4 columns empty; rBacklog (4) fills them exactly, so
    // the rows now tile 12 / 8+4 / 6+6 / 12 / 12 / 6+6 / 12 / 12 with no gaps.
    modules: [
      "rProfile", "rActivity", "rBacklog", "rPeople", "rHealth", "rGrossing",
      "rIssues", "rIssueTriage", "rIssuePeople", "rLabels", "rVersus",
    ],
    groups: [
      { id: "activity", label: "Activity", twin: "@activity",
        modules: ["rActivity", "rPeople", "rHealth"] },
      { id: "prs", label: "Pull requests", twin: "@prs", count: "rBacklog",
        modules: ["rBacklog", "rGrossing"] },
      { id: "issues", label: "Issues", twin: "@issues", count: "rIssues",
        modules: ["rIssues", "rIssueTriage", "rIssuePeople", "rLabels"] },
    ],
  },
];

/* ==========================================================================
   URLs
   --------------------------------------------------------------------------
   A page's URL segment is its label, lowercased and hyphenated — `/pr-analytics`
   rather than `/analytics`. Derived rather than declared, for the same reason
   the sidebar sections and the tab bar are: a slug held in a second field is a
   second name for the page, and the two only have to disagree once for a link
   to say something the sidebar doesn't.

   The id stays what it always was. It keys `PAGE_PANEL`, `DRILL`, and the
   `page:` on forty-six modules, none of which a reader ever sees — renaming
   those to change a URL would be a rename with a blast radius, which is the
   trade the PR Analytics rename declined and this avoids entirely.

   The cost is that renaming a label moves the URL. `pageBySlug` answers to the
   id as well, so every link this dashboard has ever produced still lands and
   gets canonicalised to the current slug by `readRoute` — the same courtesy
   `resolveTab` extends to tab ids retired by the group consolidation, and
   derived the same way rather than from a hand-kept list of old names.
   ========================================================================== */

const slugify = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const pageSlug = (id) => {
  const p = PAGES.find((x) => x.id === id);
  return p ? slugify(p.label) : id;
};

/** Slug first, then id, so a current URL can never be shadowed by an old one. */
const pageBySlug = (seg) =>
  PAGES.find((p) => slugify(p.label) === seg) ??
  PAGES.find((p) => p.id === seg) ??
  null;

export { PAGES, pageBySlug, pageSlug, slugify };
