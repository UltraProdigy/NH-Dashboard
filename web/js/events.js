import { state } from "./state.js";
import { windowKey } from "./data.js";
import {
  clearExclusions,
  resetExclusions,
  toggleExclusion,
  updateExclList,
} from "./dream.js";
import {
  closeCombo,
  comboOptions,
  positionExclPop,
  render,
  updateComboPop,
} from "./render.js";
import { drillTo, go, goPage, readHash } from "./router.js";
import { tabTwin } from "./modules/index.js";
import {
  addOpponent,
  clearOpponents,
  closeVs,
  removeOpponent,
  updateVsPop,
  vsOptions,
} from "./versus-data.js";

/* ==========================================================================
   Events
   ========================================================================== */

document.getElementById("pages").addEventListener("click", e => {
  const b = e.target.closest("button[data-page]");
  if (b) goPage(b.dataset.page);
});

document.getElementById("tabs").addEventListener("click", e => {
  const b = e.target.closest("button[data-module]");
  if (b) go(state.page, b.dataset.module || null);
});

document.getElementById("view").addEventListener("click", e => {
  /* ---- card filters ----
     Stopped here rather than left to bubble: the document-level
     close-on-outside-click handler would otherwise see this same click *after*
     render() has torn the button out of the DOM, and decide it landed outside
     the popup it just opened. */
  const eb = e.target.closest("button[data-exclbtn]");
  if (eb) {
    e.stopPropagation();
    // Opening one closes the other — there's one popup, and it belongs to
    // whichever button was asked for it last.
    state.exclOpen = state.exclOpen === eb.dataset.exclbtn ? null : eb.dataset.exclbtn;
    return render();
  }

  /* ---- head to head ----
     Its picker lives inside the card rather than the toolbar, so its events
     arrive here alongside the drilldown links. */
  const add = e.target.closest(".combo-opt[data-vsadd]");
  if (add) {
    addOpponent(add.dataset.vsadd);
    closeVs();
    return render();
  }
  const del = e.target.closest("button[data-vsdel]");
  if (del) { removeOpponent(del.dataset.vsdel); return render(); }
  const clear = e.target.closest("button[data-vsclear]");
  if (clear) { clearOpponents(); return render(); }

  // Contributor names are real anchors to #contributor/<login>, so the browser
  // handles middle-click and cmd-click natively. Plain clicks are intercepted
  // only so they route through go(), which clears the sort and filter the way
  // every other navigation does — letting the hash change on its own would
  // carry a stale filter onto the new subject.
  const link = e.target.closest("a[data-drilllink]");
  if (link && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
    e.preventDefault();
    const [page, subj] = link.getAttribute("href").slice(1).split("/");
    return drillTo(page, decodeURIComponent(subj));
  }

  const pick = e.target.closest("[data-pick]");
  if (pick) return drillTo(state.page, pick.dataset.pick);

  const open = e.target.closest("button[data-open]");
  if (open) return go(state.page, open.dataset.open);

  // A grouped tab renders its members' tabControls in their own card headers
  // rather than the toolbar, so those clicks arrive here instead of there.
  const cs = e.target.closest("button[data-closed]");
  if (cs) { state.closedState = cs.dataset.closed; return render(); }

  const th = e.target.closest("th[data-sort]");
  if (th) {
    const id = th.closest("[data-sortowner]")?.dataset.sortowner;
    if (!id) return;
    const key = th.dataset.sort;
    const cur = state.sort[id];
    state.sort[id] = { key, dir: cur?.key === key ? -cur.dir : -1 };
    render();
  }
});

/* Typing in the head-to-head picker repaints only its popup, for the same
   reason the toolbar's combobox does: render() would redraw every chart on the
   page and drop the caret on each keystroke. */
document.getElementById("view").addEventListener("input", e => {
  if (e.target.id !== "vsInput") return;
  state.vs.q = e.target.value;
  state.vs.open = true;
  state.vs.active = 0;
  updateVsPop();
});

document.getElementById("view").addEventListener("focusin", e => {
  if (e.target.id !== "vsInput") return;
  state.vs.open = true;
  state.vs.q = "";
  e.target.value = "";
  updateVsPop();
});

document.getElementById("view").addEventListener("keydown", e => {
  if (e.target.id !== "vsInput") return;

  if (e.key === "Escape") {
    closeVs();
    updateVsPop();
    e.target.value = "";
    return;
  }

  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!state.vs.open) {
      state.vs.open = true;
      state.vs.active = 0;
      return updateVsPop();
    }
    const n = vsOptions().length;
    if (!n) return;
    state.vs.active =
      (state.vs.active + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
    return updateVsPop();
  }

  if (e.key === "Enter") {
    e.preventDefault();
    const pick = state.vs.open ? vsOptions()[state.vs.active] : null;
    if (!pick) return;
    addOpponent(pick.id);
    closeVs();
    render();
  }
});

/* The By-label picker lives in that card's header rather than the toolbar, so
   its events arrive here. */
document.getElementById("view").addEventListener("change", e => {
  if (e.target.id === "labelPicker") {
    state.label = e.target.value;
    state.sort = {};
    return render();
  }
  // Issue Analytics label view. Changing repo clears the label pick, since a
  // label from one tracker means nothing in another.
  if (e.target.id === "issueLabelRepo") {
    state.issueLabelRepo = e.target.value;
    state.issueLabel = null;
    state.sort = {};
    return render();
  }
  if (e.target.id === "issueLabelPick") {
    state.issueLabel = e.target.value;
    return render();
  }
});

document.getElementById("toolbar").addEventListener("input", e => {
  const t = e.target;
  // Typing in the combobox repaints only the popup. Routing it through
  // render() would redraw every chart on the page on every keystroke.
  if (t.id === "comboInput") {
    state.combo.q = t.value;
    state.combo.open = true;
    state.combo.active = 0;
    return updateComboPop();
  }
  if (t.id === "filter") state.filter = t.value.trim();
  else if (t.id === "minActivity") {
    const v = Number(t.value);
    state.minActivity = Number.isFinite(v) && v >= 0 ? v : 0;
  } else return;
  render();
  // Re-focus the text box: render() replaces the toolbar wholesale, which
  // would otherwise drop the caret after every keystroke.
  if (t.id === "filter") {
    const f = document.getElementById("filter");
    if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
  }
});

document.getElementById("toolbar").addEventListener("click", e => {
  const opt = e.target.closest(".combo-opt[data-pick]");
  if (opt) return drillTo(state.page, opt.dataset.pick);

  const mode = e.target.closest("button[data-mode]");
  if (mode && mode.dataset.mode !== state.page) {
    // Resume the other mode where you left it. Only if you've never been
    // there does it fall back to the equivalent tab, so flipping between a
    // repo and a person doesn't bounce you to Overview either way.
    return goPage(mode.dataset.mode, tabTwin(state.page, state.tab));
  }

  // One control, several homes for its value: the drilldowns keep their own
  // period so looking at a person doesn't reset what Analytics was showing, and
  // New Faces keeps its own so it can default to a shorter span than its page.
  const w = e.target.closest("button[data-window]");
  if (w) {
    state[windowKey()] = w.dataset.window;
    return render();
  }

  const cs = e.target.closest("button[data-closed]");
  if (cs) { state.closedState = cs.dataset.closed; return render(); }

  const g = e.target.closest("button[data-gran]");
  if (g) { state.gran = g.dataset.gran; return render(); }
});

/* ==========================================================================
   The exclusion popup
   --------------------------------------------------------------------------
   It lives in its own layer at the end of <body> rather than inside the card
   that opened it, so its events arrive here rather than with the card's.
   ========================================================================== */

const popLayer = document.getElementById("popLayer");

// Typing in the search repaints only the list, for the same reason the
// combobox does: render() would rebuild the popup and drop the caret.
popLayer.addEventListener("input", e => {
  const key = e.target.dataset?.exclq;
  if (!key) return;
  state.exclQ[key] = e.target.value;
  updateExclList(key);
});

/* Both are scoped to the button they sit under: "Clear" beneath Repos should
   not silently un-hide every label as well, nor touch the card next to it.
   Each stops its click so the document handler doesn't then read it as landing
   outside a popup render() has already replaced. */
popLayer.addEventListener("click", e => {
  const ec = e.target.closest("button[data-exclclear]");
  if (ec) {
    e.stopPropagation();
    clearExclusions(ec.dataset.exclclear);
    return render();
  }
  const er = e.target.closest("button[data-exclreset]");
  if (er) {
    e.stopPropagation();
    resetExclusions(er.dataset.exclreset);
    return render();
  }
});

/**
 * Ticking a box repaints the page — the card, its tab badge and the By-label
 * picker all read the exclusions — but the popup stays open, since the point
 * of a multi-select is picking several without reopening it each time.
 */
popLayer.addEventListener("change", e => {
  const box = e.target.closest("input[data-excl]");
  if (!box) return;
  toggleExclusion(box.dataset.excl, box.value, box.checked);
  // render() rebuilds the popup from scratch; put the list's scroll position
  // back so ticking the fortieth repo doesn't fling you to the top.
  const top = document.getElementById("exclList")?.scrollTop ?? 0;
  render();
  const fresh = document.getElementById("exclList");
  if (fresh) fresh.scrollTop = top;
});

/* Anchored to a button in the page, so it has to follow it. Repositioned
   rather than closed: scrolling the list scrolls the page underneath once the
   list hits its end, and a popup that vanished when that happened would be
   unusable with a trackpad. */
addEventListener("scroll", () => { if (state.exclOpen) positionExclPop(); }, true);
addEventListener("resize", () => { if (state.exclOpen) positionExclPop(); });

/* Combobox keyboard handling. Kept on the toolbar rather than the input
   because render() replaces the input element wholesale. */
document.getElementById("toolbar").addEventListener("keydown", e => {
  if (e.target.id !== "comboInput") return;

  if (e.key === "Escape") {
    closeCombo();
    updateComboPop();
    e.target.value = state.subject ?? "";
    return;
  }

  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!state.combo.open) {
      state.combo.open = true;
      state.combo.active = 0;
      return updateComboPop();
    }
    const n = comboOptions().length;
    if (!n) return;
    state.combo.active =
      (state.combo.active + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
    return updateComboPop();
  }

  if (e.key === "Enter") {
    e.preventDefault();
    const pick = state.combo.open ? comboOptions()[state.combo.active] : null;
    if (pick) drillTo(state.page, pick.id);
  }
});

document.getElementById("toolbar").addEventListener("focusin", e => {
  if (e.target.id !== "comboInput") return;
  state.combo.open = true;
  state.combo.q = "";
  // Emptied rather than selected: select-all only survives until the first
  // click lands, and typing after that would append to the current subject's
  // name instead of starting a fresh query. The name is still in the header.
  e.target.value = "";
  updateComboPop();
});

/* Close on an outside click rather than on blur: blur fires before click, so a
   blur handler would tear the popup down before the option got selected. */
document.addEventListener("click", e => {
  // Closes when the click lands outside the popup. The buttons stop their own
  // clicks before they get here, so opening one while another is open still
  // reads as a toggle rather than a close followed by an open.
  if (state.exclOpen && !e.target.closest("#popLayer")) {
    state.exclOpen = null;
    render();
  }
  // Same deal for the head-to-head picker, which is a second combobox on the
  // page and has to close when you click away from it without taking the first
  // one's handling with it.
  if (state.vs.open && !e.target.closest("#vsCombo")) {
    closeVs();
    updateVsPop();
    const v = document.getElementById("vsInput");
    if (v) v.value = "";
  }

  if (!state.combo.open || e.target.closest("#combo")) return;
  closeCombo();
  updateComboPop();
  // Put the current subject back — the box was cleared on focus.
  const c = document.getElementById("comboInput");
  if (c) c.value = state.subject ?? "";
});

const collapseBtn = document.getElementById("collapse");
collapseBtn.addEventListener("click", () => {
  const c = document.body.classList.toggle("collapsed");
  localStorage.setItem("nh:collapsed", c ? "1" : "0");
  collapseBtn.title = c ? "Expand sidebar" : "Collapse sidebar";
});

window.addEventListener("hashchange", () => { readHash(); render(); });

export { collapseBtn };
