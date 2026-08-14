import { COLUMNS } from "../table.js";
import { exclControlsHtml, labelPickerHtml } from "../dream.js";

/* The filters live in each card's header rather than the page toolbar: they
   hide rows from that one card, and a control sitting above a grid of four
   reads as page-wide, which is what it used to be. */

export const dreamModules = {
  /* ---------------- Dream Panel ---------------- */

  approvedUnmerged: {
    page: "dream", label: "Approved, not merged", span: 6, flush: true,
    panelId: "approvedUnmerged", cols: () => COLUMNS.pr,
    sub: () => "green light, still sitting",
    controlsHtml: () => exclControlsHtml("approvedUnmerged"),
  },
  changesRequested: {
    page: "dream", label: "Changes requested", span: 6, flush: true,
    panelId: "changesRequested", cols: () => COLUMNS.pr,
    sub: () => "waiting on the author",
    controlsHtml: () => exclControlsHtml("changesRequested"),
  },
  needsRelease: {
    page: "dream", label: "Needs a release", span: 6, flush: true,
    panelId: "needsRelease", cols: () => COLUMNS.release,
    sub: () => "merged but unreleased",
    controlsHtml: () => exclControlsHtml("needsRelease"),
  },
  byLabel: {
    page: "dream", label: "By label", span: 6, flush: true,
    panelId: "byLabel", cols: () => COLUMNS.pr,
    // The label picker is this card's caption — it's the only thing that says
    // what the rows underneath are.
    subHtml: () => labelPickerHtml(),
    controlsHtml: () => exclControlsHtml("byLabel"),
  },
};
