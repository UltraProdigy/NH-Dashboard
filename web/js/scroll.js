const touched = new Set();

globalThis.addEventListener?.("scroll", (e) => {
  if (e.target instanceof Element) touched.add(e.target);
}, { capture: true, passive: true });

const signature = (el) => el.tagName.toLowerCase() + [...el.classList].map((c) => `.${CSS.escape(c)}`).join("");

export function keepScroll(root, paint) {
  if (!root || !globalThis.scrollTo) return paint();
  const x = scrollX;
  const y = scrollY;
  const saved = [];
  for (const el of touched) {
    if (!el.isConnected) { touched.delete(el); continue; }
    if (el === root || !root.contains(el) || (!el.scrollTop && !el.scrollLeft)) continue;
    const sig = signature(el);
    saved.push({ sig, at: [...root.querySelectorAll(sig)].indexOf(el), top: el.scrollTop, left: el.scrollLeft });
  }
  const out = paint();
  for (const s of saved) {
    const el = root.querySelectorAll(s.sig)[s.at];
    if (!el) continue;
    el.scrollTop = s.top;
    el.scrollLeft = s.left;
    touched.add(el);
  }
  if (scrollX !== x || scrollY !== y) scrollTo(x, y);
  return out;
}

/**
 * A pointer crossing a table should keep scrolling the page. Once it rests
 * over the table briefly, subsequent wheel gestures scroll the table itself.
 * Keyboard, touch, and horizontal scrolling keep their normal behavior.
 */
export function bindNestedWheel(root) {
  const selector = ".tscroll, .scroll, .rl-list, .wh-list, .log-scroll";
  const dwell = 180;
  let hovered = null;
  let enteredAt = 0;
  let lastPageWheel = -Infinity;
  const track = (pane, now) => {
    if (pane === hovered) return;
    hovered = pane;
    enteredAt = now;
  };

  root.addEventListener("pointerover", event => {
    if (event.pointerType === "mouse") track(event.target.closest(selector), performance.now());
  });
  root.addEventListener("pointerout", event => {
    if (event.pointerType === "mouse") track(event.relatedTarget?.closest?.(selector) ?? null, performance.now());
  });
  // Capture the page's gesture even when it starts outside an inner scroller.
  document.addEventListener("wheel", event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY) ||
        !event.target.closest("main") || event.target.closest("dialog")) return;
    const now = performance.now();
    const pane = event.target.closest(selector);
    track(pane, now);
    const max = pane ? pane.scrollHeight - pane.clientHeight : 0;
    const canScroll = max > 1 && (event.deltaY > 0 ? pane.scrollTop < max - 1 : pane.scrollTop > 0);
    if (!canScroll) {
      lastPageWheel = now;
      return;
    }
    if (now - Math.max(enteredAt, lastPageWheel) >= dwell || !event.cancelable) return;
    event.preventDefault();
    lastPageWheel = now;
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
    window.scrollBy({ top: event.deltaY * scale, behavior: "instant" });
  }, { passive: false });
}
