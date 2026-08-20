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
 */
const PAGES = [
  {
    id: "analytics", label: "General Analytics",
    icon: `<path d="M1.5 14.5V2a.5.5 0 0 1 1 0v11.5H15a.5.5 0 0 1 0 1H2a.5.5 0 0 1-.5-.5Z"/><path d="M4 11h2v2H4v-2Zm3.5-4h2v6h-2V7ZM11 3h2v10h-2V3Z"/>`,
    // 12 / 8+4 / 6+6 / 6+6 / 6+6 / 12 / 12 — every row fills its twelve columns,
    // so nothing wraps and leaves a hole. See the note on the repo page.
    modules: ["pulse", "volume", "backlog", "latency", "growth", "repos", "reviewload", "labels", "heatmap", "grossing", "actions"],
    groups: [
      // Volume and the hour/day heatmap are both "when do PRs arrive". Backlog
      // stays out: "how many are open right now" is the number people come to
      // this page for, and it isn't a question about time at all.
      { id: "volume", label: "Volume", modules: ["volume", "heatmap"] },
      { id: "review", label: "Review", modules: ["latency", "reviewload"] },
      { id: "repos",  label: "Repos",  modules: ["repos", "grossing"] },
    ],
  },
  {
    id: "dream", label: "Dream Panel",
    icon: `<path d="M8 1.5 2 4.2v4.1c0 3.4 2.4 6 6 6.2 3.6-.2 6-2.8 6-6.2V4.2L8 1.5Zm2.8 4.9-3.3 4a.7.7 0 0 1-1 .05L4.9 8.9a.7.7 0 1 1 .95-1l1 .95 2.8-3.4a.7.7 0 1 1 1.1.9Z"/>`,
    // 6+6 / 6+6 / 12. By label is the full width because it draws a column per
    // label and three of them in half a row is three columns of nothing.
    modules: ["approvedUnmerged", "needsRelease", "changesRequested", "depUpdates", "byLabel"],
  },
  {
    id: "issues", label: "Issue Analytics",
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
    id: "people", label: "Contributor Activity",
    icon: `<path d="M5.5 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm6 0a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM.5 14c0-2.5 2.2-4.5 5-4.5s5 2 5 4.5H.5Zm11 0c0-1.6-.6-3-1.6-4 .5-.3 1-.4 1.6-.4 2.2 0 4 1.6 4 4.4h-4Z"/>`,
    modules: ["topAuthors", "topReviewers", "leaderboard", "newcomers", "lapsed"],
  },
  {
    id: "contributor", label: "Contributor Drilldown",
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
    id: "repo", label: "Repo Drilldown",
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

export { PAGES };
