import { COLUMNS } from "../table.js";
import {
  byLabelHtml,
  exclControlsHtml,
  labelCardControlsHtml,
} from "../dream.js";
import { updatesControlsHtml, updatesHtml, updatesSubHtml, updatesTier } from "../updates.js";

/* The filters live in each card's header rather than the page toolbar: they
   hide rows from that one card, and a control sitting above a grid of four
   reads as page-wide, which is what it used to be. */

export const dreamModules = {
  /* ---------------- Dream Panel ---------------- */

  approvedUnmerged: {
    page: "dream", label: "Approved, not merged", span: 6, flush: true,
    panelId: "approvedUnmerged", cols: () => COLUMNS.pr, controls: ["filter"],
    sub: () => "green light, still sitting",
    controlsHtml: () => exclControlsHtml("approvedUnmerged"),
  },
  changesRequested: {
    page: "dream", label: "Changes requested", span: 12, flush: true,
    panelId: "changesRequested", cols: () => COLUMNS.pr, controls: ["filter"],
    sub: () => "waiting on the author",
    controlsHtml: () => exclControlsHtml("changesRequested"),
  },
  needsRelease: {
    page: "dream", label: "Needs a release", span: 6, flush: true,
    panelId: "needsRelease", cols: () => COLUMNS.release, controls: ["filter"],
    sub: () => "merged but unreleased",
    controlsHtml: () => exclControlsHtml("needsRelease"),
  },
  byLabel: {
    page: "dream", label: "By label", span: 12, flush: true,
    panelId: "byLabel", controls: ["filter"],
    sub: () => "one column per label",
    // Its own renderer rather than the generic panel table: this card isn't one
    // list, it's several side by side, and each has a header that picks what
    // it's showing.
    render: (expanded) => byLabelHtml(expanded),
    controlsHtml: () => exclControlsHtml("byLabel", labelCardControlsHtml()),
  },
  updates: {
    page: "dream", label: "Updates", span: 12, flush: true, controls: ["filter"],
    tier: () => updatesTier(),
    subHtml: () => updatesSubHtml(),
    render: (expanded) => updatesHtml(expanded),
    controlsHtml: () => updatesControlsHtml(),
  },
};
