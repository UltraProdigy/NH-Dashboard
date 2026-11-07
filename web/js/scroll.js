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
