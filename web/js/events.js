import { state } from "./state.js";
import { windowKey } from "./data.js";
import { saveExclusions, updateExclList } from "./dream.js";
import { closeCombo, comboOptions, render, updateComboPop } from "./render.js";
import { drillTo, go, goPage, readHash } from "./router.js";
import { MODULES } from "./modules/index.js";

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

  const th = e.target.closest("th[data-sort]");
  if (th) {
    state.dir = state.sort === th.dataset.sort ? -state.dir : -1;
    state.sort = th.dataset.sort;
    render();
  }
});

/* The By-label picker lives in that card's header rather than the toolbar, so
   its events arrive here. */
document.getElementById("view").addEventListener("change", e => {
  if (e.target.id === "labelPicker") {
    state.label = e.target.value;
    state.sort = null;
    return render();
  }
  // Issue Analytics label view. Changing repo clears the label pick, since a
  // label from one tracker means nothing in another.
  if (e.target.id === "issueLabelRepo") {
    state.issueLabelRepo = e.target.value;
    state.issueLabel = null;
    state.sort = null;
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
  // Typing in an exclusion search repaints only that list, for the same reason
  // the combobox does: render() would rebuild the toolbar and drop the caret.
  if (t.dataset?.exclq) {
    state.exclQ[t.dataset.exclq] = t.value;
    return updateExclList(t.dataset.exclq);
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
    const twin = state.module ? MODULES[state.module].twin ?? null : null;
    return goPage(mode.dataset.mode, twin);
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

  /* ---- exclusions ---- */
  const eb = e.target.closest("button[data-exclbtn]");
  if (eb) {
    // Stopped here rather than left to bubble: the document-level
    // close-on-outside-click handler would otherwise see this same click
    // *after* render() has torn the button out of the DOM, and decide it
    // landed outside the popup it just opened.
    e.stopPropagation();
    // Opening one closes the other. Two popups side by side would overlap, and
    // there's no reason to consult both at once.
    state.exclOpen = state.exclOpen === eb.dataset.exclbtn ? null : eb.dataset.exclbtn;
    return render();
  }
  const ec = e.target.closest("button[data-exclclear]");
  if (ec) {
    // Scoped to its own group: "Clear" inside the Repos popup should not
    // silently un-hide every label as well.
    state.dreamExcl[ec.dataset.exclclear] = [];
    saveExclusions();
    return render();
  }
});

/**
 * Ticking a box repaints the whole page — every card on Dream reads the
 * exclusions — but the popup has to stay open, since the point of a
 * multi-select is picking several without reopening it each time.
 */
document.getElementById("toolbar").addEventListener("change", e => {
  const box = e.target.closest("input[data-excl]");
  if (!box) return;
  const list = state.dreamExcl[box.dataset.excl];
  const i = list.indexOf(box.value);
  if (box.checked) { if (i === -1) list.push(box.value); }
  else if (i !== -1) list.splice(i, 1);
  saveExclusions();
  // render() rebuilds the popup from scratch; put the list's scroll position
  // back so ticking the fortieth repo doesn't fling you to the top.
  const kind = box.dataset.excl;
  const top = document.getElementById(`exclList-${kind}`)?.scrollTop ?? 0;
  render();
  const fresh = document.getElementById(`exclList-${kind}`);
  if (fresh) fresh.scrollTop = top;
});

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
  // Closes when the click lands outside *the open group's* wrapper — clicking
  // the other exclusion button counts as outside, and its own handler opens it.
  if (state.exclOpen &&
      e.target.closest(".excl-wrap")?.dataset.exclgroup !== state.exclOpen) {
    state.exclOpen = null;
    render();
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
