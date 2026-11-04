import { esc } from "./format.js";

const CMP_LABEL = { any: "is any of", none: "is none of", set: "is set", unset: "is not set" };
const MAX_DEPTH = 2;

const filters = new Map();
let nodeId = 0;
let wired = false;

const newId = () => `pf${++nodeId}`;
const blankCond = () => ({ id: newId(), prop: "", cmp: "any", values: [] });
const blankTree = () => ({ id: newId(), op: "and", items: [] });

export const valuesOf = (v) => (v == null || v === "" ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);

function reId(node) {
  if (node.items) return { id: newId(), op: node.op === "or" ? "or" : "and", items: node.items.map(reId) };
  return { id: newId(), prop: node.prop ?? "", cmp: CMP_LABEL[node.cmp] ? node.cmp : "any", values: Array.isArray(node.values) ? node.values : [] };
}

function load(key) {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null");
    if (saved?.items) return reId(saved);
  } catch {}
  return blankTree();
}

function save(f) {
  try { localStorage.setItem(f.key, JSON.stringify(f.tree)); } catch {}
}

function findNode(id, node, parent = null) {
  if (node.id === id) return { node, parent };
  for (const child of node.items ?? []) {
    const hit = findNode(id, child, node);
    if (hit) return hit;
  }
  return null;
}

function isLive(node) {
  if (node.items) return node.items.some(isLive);
  if (!node.prop) return false;
  return node.cmp === "set" || node.cmp === "unset" || node.values.length > 0;
}

function passes(repo, node) {
  if (node.items) {
    const live = node.items.filter(isLive);
    if (!live.length) return true;
    return node.op === "or" ? live.some((n) => passes(repo, n)) : live.every((n) => passes(repo, n));
  }
  const have = valuesOf(repo.properties?.[node.prop]);
  if (node.cmp === "set") return have.length > 0;
  if (node.cmp === "unset") return have.length === 0;
  const hit = have.some((v) => node.values.includes(v));
  return node.cmp === "none" ? !hit : hit;
}

function condHtml(f, node) {
  const props = f.list?.schema ?? [];
  const p = props.find((s) => s.name === node.prop) ?? null;
  const opts = [`<option value="">property…</option>`, ...props.map((s) =>
    `<option value="${esc(s.name)}"${s.name === node.prop ? " selected" : ""}>${esc(s.name)}</option>`)].join("");
  const cmps = Object.entries(CMP_LABEL).map(([k, v]) => `<option value="${k}"${k === node.cmp ? " selected" : ""}>${v}</option>`).join("");
  let values = "";
  if (node.prop && (node.cmp === "any" || node.cmp === "none")) {
    const allowed = p?.allowed ?? (p?.type === "true_false" ? ["true", "false"] : null);
    if (allowed?.length) {
      values = `<span class="pf-chips">${allowed.map((v) => `<label class="pf-chip"><input type="checkbox" data-f-val value="${esc(v)}"${node.values.includes(v) ? " checked" : ""}><span>${esc(v)}</span></label>`).join("")}</span>`;
    } else {
      values = `<input type="text" class="pf-input" data-f-text value="${esc(node.values.join(", "))}" placeholder="value, value" spellcheck="false" aria-label="Values">`;
    }
  }
  return `<div class="pf-cond" data-node="${node.id}">
    <select class="pf-input" data-f-prop aria-label="Property">${opts}</select>
    <select class="pf-input" data-f-cmp aria-label="Comparison">${cmps}</select>
    ${values}
    <button type="button" class="pf-x" data-f-remove title="Remove this condition" aria-label="Remove this condition">×</button>
  </div>`;
}

function groupHtml(f, node, depth = 0) {
  const op = `<span class="seg mini">${["and", "or"].map((o) =>
    `<button type="button" data-f-op="${o}" aria-pressed="${node.op === o}">${o.toUpperCase()}</button>`).join("")}</span>`;
  const kids = node.items.map((n) => (n.items ? groupHtml(f, n, depth + 1) : condHtml(f, n))).join("");
  return `<div class="pf-group${depth ? " nested" : ""}" data-node="${node.id}">
    <div class="pf-ghead">
      ${node.items.length > 1 ? op : ""}
      <button type="button" class="ghost mini" data-f-add="cond">+ condition</button>
      ${depth < MAX_DEPTH ? `<button type="button" class="ghost mini" data-f-add="group">+ group</button>` : ""}
      ${depth ? `<button type="button" class="pf-x" data-f-remove title="Remove this group" aria-label="Remove this group">×</button>` : ""}
    </div>
    ${kids ? `<div class="pf-gitems">${kids}</div>` : ""}
  </div>`;
}

function innerHtml(f) {
  const list = f.list;
  if (!list) return f.waiting ? `<p class="sub pf-gap">${esc(f.waiting)}</p>` : "";
  if (list.propertiesError) return `<p class="daily-warn pf-gap">${esc(list.propertiesError)}</p>`;
  if (!list.schema?.length) return `<p class="sub pf-gap">The org has no custom properties to filter by.</p>`;
  return `<div class="pf-filter"><span class="sub">Filter by custom property</span>${groupHtml(f, f.tree)}</div>`;
}

function repaint(f) {
  for (const el of document.querySelectorAll(`[data-pf="${f.key}"]`)) el.innerHTML = innerHtml(f);
}

const filterOf = (e) => {
  const el = e.target.closest?.("[data-pf]");
  return el ? filters.get(el.dataset.pf) ?? null : null;
};

function onClick(e) {
  const f = filterOf(e);
  if (!f) return;
  const t = e.target;
  const add = t.closest("[data-f-add]");
  const remove = t.closest("[data-f-remove]");
  const op = t.closest("[data-f-op]");
  if (add) {
    const group = findNode(add.closest("[data-node]").dataset.node, f.tree).node;
    group.items.push(add.dataset.fAdd === "group" ? { id: newId(), op: "and", items: [blankCond()] } : blankCond());
  } else if (remove) {
    const hit = findNode(remove.closest("[data-node]").dataset.node, f.tree);
    if (hit?.parent) hit.parent.items = hit.parent.items.filter((n) => n !== hit.node);
  } else if (op) {
    findNode(op.closest("[data-node]").dataset.node, f.tree).node.op = op.dataset.fOp;
  } else return;
  save(f);
  repaint(f);
  f.onChange();
}

function onChange(e) {
  const f = filterOf(e);
  if (!f) return;
  const t = e.target;
  const node = t.closest("[data-node]");
  if (!node) return;
  const n = findNode(node.dataset.node, f.tree)?.node;
  if (!n) return;
  if (t.matches("[data-f-prop]")) { n.prop = t.value; n.values = []; }
  else if (t.matches("[data-f-cmp]")) n.cmp = t.value;
  else if (t.matches("[data-f-val]")) n.values = [...node.querySelectorAll("[data-f-val]:checked")].map((x) => x.value);
  else if (t.matches("[data-f-text]")) return f.onChange();
  else return;
  save(f);
  if (!t.matches("[data-f-val]")) repaint(f);
  f.onChange();
}

function onInput(e) {
  const f = filterOf(e);
  if (!f || !e.target.matches("[data-f-text]")) return;
  const n = findNode(e.target.closest("[data-node]").dataset.node, f.tree)?.node;
  if (!n) return;
  n.values = e.target.value.split(",").map((v) => v.trim()).filter(Boolean);
  save(f);
  if (f.live) f.onChange();
}

function onKey(e) {
  if (e.key === "Enter" && filterOf(e) && e.target.matches("[data-f-text]")) {
    e.preventDefault();
    e.target.blur();
  }
}

function wire() {
  if (wired) return;
  wired = true;
  document.addEventListener("click", onClick);
  document.addEventListener("change", onChange);
  document.addEventListener("input", onInput);
  document.addEventListener("keydown", onKey);
}

/**
 * One saved custom-property filter. `live` repaints on every keystroke in a
 * value box; without it the box applies when it loses focus, for pages that
 * redraw the whole card. Until `use` hands it a repo list with a schema, it
 * lets every repo through.
 */
export function propertyFilter(key, { onChange = () => {}, live = false } = {}) {
  const f = filters.get(key) ?? { key, tree: load(key), list: null, waiting: "" };
  Object.assign(f, { onChange, live });
  filters.set(key, f);
  const usable = () => Boolean(f.list?.schema?.length) && !f.list.propertiesError;
  const api = {
    use(list, waiting = "") {
      f.list = list ?? null;
      f.waiting = waiting;
      return api;
    },
    passes: (repo) => !usable() || passes(repo, f.tree),
    active: () => usable() && isLive(f.tree),
    html() {
      wire();
      return `<div data-pf="${esc(key)}">${innerHtml(f)}</div>`;
    },
  };
  return api;
}
