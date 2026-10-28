/**
 * Which panels the page loads, and which of them only the admin team may read.
 * Shared with the app Worker, which refuses ADMIN_PANELS to everyone else, so
 * the two lists can't drift.
 */

export const LIVE_PANELS = [
  "contributors",
  "analytics",
  "approvedUnmerged",
  "changesRequested",
  "needsRelease",
  "depUpdates",
  "byLabel",
  "ciHealth",
  "issues",
  "repos",
  "labelSync",
  "labelUsage",
];

export const ADMIN_PANELS = ["approvedUnmerged", "changesRequested", "depUpdates", "labelSync", "labelUsage"];

export const isAdmin = (role) => role === "admin";

export const panelsFor = (role) =>
  isAdmin(role) ? LIVE_PANELS : LIVE_PANELS.filter((p) => !ADMIN_PANELS.includes(p));
