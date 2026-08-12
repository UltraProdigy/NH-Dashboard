import { COLUMNS } from "../table.js";
import { labelPickerHtml } from "../dream.js";

export const dreamModules = {
  /* ---------------- Dream Panel ---------------- */

  approvedUnmerged: {
    page: "dream", label: "Approved, not merged", span: 6, flush: true,
    panelId: "approvedUnmerged", cols: () => COLUMNS.pr,
    sub: () => "green light, still sitting",
  },
  changesRequested: {
    page: "dream", label: "Changes requested", span: 6, flush: true,
    panelId: "changesRequested", cols: () => COLUMNS.pr,
    sub: () => "waiting on the author",
  },
  needsRelease: {
    page: "dream", label: "Needs a release", span: 6, flush: true,
    panelId: "needsRelease", cols: () => COLUMNS.release,
    sub: () => "merged but unreleased",
  },
  byLabel: {
    page: "dream", label: "By label", span: 6, flush: true,
    panelId: "byLabel", cols: () => COLUMNS.pr,
    // The picker lives in this card's header rather than the page toolbar:
    // it's the only thing on the page it changes, and a control that far from
    // what it affects reads as a page-wide filter, which it isn't.
    subHtml: () => labelPickerHtml(),
  },
};
