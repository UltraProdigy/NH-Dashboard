import { API } from "./live.js";
import { esc } from "./format.js";
import { describe, keyOf, listOf, normValue, rulesetHits, sameDef, sameValue, showValue } from "./properties-calc.js";

const KEY = "nh:props-staged";
const FILTER_KEYS = { "nh:rel-filter": "Releases & Tags", "nh:labels-filter": "Labels", "nh:props-grid": "this page's grid", "nh:props-compare": "this page's Compare tab" };
const STATUS_TEXT = { done: "done", conflict: "changed on GitHub", invalid: "refused", failed: "failed", blocked: "skipped", cancelled: "didn't run" };

let staged = new Map();
let running = null;
let last = null;
let dismissed = false;
let hooks = { data: () => null, state: () => null, reload: () => {}, redraw: () => {} };

try {
  const saved = JSON.parse(localStorage.getItem(KEY) ?? "[]");
  if (Array.isArray(saved)) for (const c of saved) if (c?.kind) staged.set(keyOf(c), c);
} catch {}

const save = () => { try { localStorage.setItem(KEY, JSON.stringify([...staged.values()])); } catch {} };
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export const configureApply = (h) => { hooks = { ...hooks, ...h }; };
export const stagedList = () => [...staged.values()];
export const stagedFor = (key) => staged.get(key) ?? null;
export const isRunning = () => Boolean(running);

function changed() {
  save();
  dismissed = false;
  hooks.redraw();
}

function put(c) {
  const key = keyOf(c);
  const had = staged.get(key);
  const next = had && c.kind === "value" ? { ...c, from: had.from } : had && c.kind === "update" ? { ...c, from: had.from } : c;
  if (next.kind === "value" && sameValue(next.from, next.to)) staged.delete(key);
  else if (next.kind === "update" && sameDef(next.from, next.to)) staged.delete(key);
  else staged.set(key, next);
}

export function stage(c) { put(c); changed(); }
export function stageMany(list) { for (const c of list) put(c); changed(); }
export function unstage(key) { staged.delete(key); changed(); }
export function clearStaged() { staged.clear(); changed(); }

export function staleKeys(data, st) {
  const out = new Set();
  if (!st) return out;
  for (const c of staged.values()) {
    if (c.kind === "value") {
      if (!st.repos.has(c.repo)) out.add(keyOf(c));
      else if (st.defs.has(c.prop) && !sameValue(st.values.get(c.repo)?.[c.prop], c.from)) out.add(keyOf(c));
    } else if (c.kind === "create") {
      if (st.defs.has(c.def.name)) out.add(keyOf(c));
    } else if (!sameDef(st.defs.get(c.name), c.from)) out.add(keyOf(c));
  }
  return out;
}

function savedFilterUses(prop) {
  const out = [];
  const walk = (n) => (n?.items ? n.items.some(walk) : n?.prop === prop);
  for (const [key, label] of Object.entries(FILTER_KEYS)) {
    try { if (walk(JSON.parse(localStorage.getItem(key) ?? "null"))) out.push(label); } catch {}
  }
  return out;
}

export function warningsFor(changes, data, st) {
  const out = [];
  const repos = [...(st?.values ?? [])];
  const using = (prop, values) => repos.filter(([, p]) => listOf(p[prop]).some((v) => !values || values.includes(v))).length;
  const rulesetLine = (prop, what, values) => {
    for (const r of rulesetHits(data?.rulesets, st?.values ?? new Map(), prop, values)) {
      const how = r.conditions?.length
        ? `${r.conditions.some((c) => c.side === "exclude") ? "excludes" : "targets"} repos by ${esc(prop)}${r.conditions.flatMap((c) => c.values).length ? ` = ${esc(r.conditions.flatMap((c) => c.values).join(", "))}` : ""}`
        : `covers ${plural(r.covers, "repo")} with ${esc(prop)}${values ? ` = ${esc(values.join(", "))}` : ""}`;
      out.push({ tone: "bad", html: `Ruleset <a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)}</a> (${esc(r.enforcement ?? "?")}) ${how}. ${what} Check it on GitHub.` });
    }
  };
  for (const c of changes) {
    if (c.kind === "delete") {
      const n = using(c.name);
      out.push({ tone: "bad", html: `Deleting ${esc(c.name)} removes it from ${plural(n, "repo")} for good. GitHub can't undo it.` });
      rulesetLine(c.name, "After the delete it won't match anything.");
    }
    if (c.kind === "rename") {
      rulesetLine(c.name, `It won't follow the rename to ${esc(c.to)}.`);
    }
    if (c.kind === "revalue") {
      rulesetLine(c.name, `It won't follow ${esc(c.sources.join(", "))} becoming ${esc(c.target)}.`, c.sources);
    }
    if (c.kind === "delete" || c.kind === "rename") {
      const filters = savedFilterUses(c.name);
      if (filters.length) out.push({ tone: "warn", html: `Saved filters in this browser use ${esc(c.name)}: ${esc(filters.join(", "))}. They'll stop matching until you change them.` });
    }
    if (c.kind === "update") {
      const gone = (c.from.allowed ?? []).filter((v) => !(c.to.allowed ?? []).includes(v));
      const n = gone.length ? using(c.name, gone) : 0;
      if (n) out.push({ tone: "bad", html: `${plural(n, "repo uses", "repos use")} ${esc(gone.join(", "))}, which ${gone.length === 1 ? "is" : "are"} being removed from ${esc(c.name)}. To move them to another value, use Rename value instead.` });
      if (gone.length) rulesetLine(c.name, "Values it names are being removed.", gone);
      if (c.to.required && !c.from.required) {
        const unset = repos.length - using(c.name);
        if (unset) out.push({ tone: "warn", html: `${esc(c.name)} becomes required, so GitHub gives ${plural(unset, "repo")} without a value the default, ${esc(showValue(c.to.default))}.` });
      }
    }
    if (c.kind === "create" && c.def.required) {
      out.push({ tone: "warn", html: `${esc(c.def.name)} is required, so every repo gets ${esc(showValue(c.def.default))} until it's changed.` });
    }
  }
  const risky = changes.some((c) => c.kind === "delete" || c.kind === "rename" || c.kind === "revalue");
  const scan = data?.rulesetScan;
  if (risky && scan?.state !== "ready") {
    out.push({ tone: "warn", html: scan?.state === "scanning"
      ? "Rulesets are still being checked, so any that use these properties may not be listed yet."
      : `Rulesets ${scan?.at ? "weren't re-checked for the latest changes" : "haven't been checked yet"}, so check <a href="https://github.com/organizations/GTNewHorizons/settings/rules" target="_blank" rel="noopener">the org's rulesets</a> yourself.` });
  }
  const stale = staleKeys(data, st);
  if (stale.size) out.push({ tone: "warn", html: `${plural(stale.size, "change was", "changes were")} staged against values GitHub has since changed. ${stale.size === 1 ? "It" : "They"}'ll be skipped, not overwritten.` });
  if (data?.running) out.push({ tone: "warn", html: `${esc(data.running.by)} is applying property changes right now.` });
  return out;
}

function valueGroups(changes) {
  const groups = new Map();
  for (const c of changes) {
    const k = `${c.prop}\u0000${JSON.stringify(normValue(c.to))}`;
    if (!groups.has(k)) groups.set(k, { prop: c.prop, to: c.to, list: [] });
    groups.get(k).list.push(c);
  }
  return [...groups.values()].sort((a, b) => a.prop.localeCompare(b.prop) || b.list.length - a.list.length);
}

const removeBtn = (key) => `<button type="button" class="perm-x" data-cp-unstage="${esc(key)}" title="Remove from the batch" aria-label="Remove from the batch">×</button>`;

function reviewHtml() {
  const data = hooks.data();
  const st = hooks.state();
  const list = stagedList();
  const stale = staleKeys(data, st);
  const defs = list.filter((c) => c.kind !== "value");
  const values = list.filter((c) => c.kind === "value");
  const warn = warningsFor(list, data, st);
  const flag = (c) => (stale.has(keyOf(c)) ? ` <span class="pill perm-risky">changed on GitHub</span>` : "");
  const defHtml = defs.length ? `<div class="perm-rgroup"><h4>Definitions</h4><ul>${defs.map((c) =>
    `<li><span>${esc(describe(c))}</span>${flag(c)}${removeBtn(keyOf(c))}</li>`).join("")}</ul></div>` : "";
  const valHtml = valueGroups(values).map((g) => `<div class="perm-rgroup"><h4>${esc(g.prop)} → ${esc(showValue(g.to) || "unset")} <span class="sub">${plural(g.list.length, "repo")}</span></h4>
    <ul>${g.list.map((c) => `<li><span>${esc(c.repo)} <span class="sub">was ${esc(showValue(c.from) || "unset")}</span></span>${flag(c)}${removeBtn(keyOf(c))}</li>`).join("")}</ul></div>`).join("");
  const viewer = data?.viewer ?? {};
  const can = viewer.canApply !== false && list.length && !running;
  return `<h3>Review ${plural(list.length, "change")}</h3>
    <p class="sub">Org-Manager makes these on GitHub, with your name kept in the history. Right before writing, GitHub is read again, and anything someone else changed in the meantime is skipped.</p>
    ${warn.length ? `<ul class="cp-warn">${warn.map((w) => `<li class="cp-${w.tone}">${w.html}</li>`).join("")}</ul>` : ""}
    <div class="perm-review-list">${defHtml}${valHtml || ""}${!list.length ? `<p class="sub cp-pad">Nothing staged.</p>` : ""}</div>
    ${viewer.canApply === false ? `<p class="daily-warn">Org-Manager's key isn't set on the app Worker, so these can be staged but not applied.</p>` : ""}
    ${viewer.dry ? `<p class="hint">Local dev: this is a dry run, nothing is sent to GitHub.</p>` : ""}
    <div class="daily-actions">
      <button type="button" class="ghost" data-dlg="cancel" autofocus>Close</button>
      <button type="button" class="daily-go" data-dlg="apply"${can ? "" : " disabled"}>Apply ${plural(list.length, "change")}</button>
    </div>`;
}

function dialog(cls, html, onClose) {
  const d = document.createElement("dialog");
  d.className = `daily-dialog perm-review ${cls}`;
  d.innerHTML = html;
  d.addEventListener("click", (e) => {
    const un = e.target.closest("[data-cp-unstage]");
    if (un) {
      staged.delete(un.dataset.cpUnstage);
      save();
      d.innerHTML = reviewHtml();
      hooks.redraw();
      return;
    }
    const pick = e.target.closest("[data-dlg]")?.dataset.dlg;
    if (pick) d.close(pick);
  });
  d.addEventListener("close", () => {
    const v = d.returnValue;
    d.remove();
    onClose?.(v);
  });
  document.body.appendChild(d);
  d.showModal();
  return d;
}

export function openReview() {
  dialog("cp-review", reviewHtml(), (v) => { if (v === "apply") apply(); });
}

function resultsHtml(r) {
  const rows = r.results.map((x) => {
    const c = r.sent.get(x.key);
    return `<li><span class="pill perm-st perm-st-${esc(x.status === "conflict" || x.status === "invalid" ? "skipped" : x.status)}">${esc(STATUS_TEXT[x.status] ?? x.status)}</span>
      <span>${esc(c ? describe(c) : x.key)}${x.error ? ` <span class="sub">— ${esc(x.error)}</span>` : ""}</span></li>`;
  }).join("");
  return `<h3>${r.dry ? "Dry run finished" : "Applied"}</h3>
    <p class="sub">${esc(countsText(r))}${r.history === false ? ". History couldn't be written for this batch" : ""}</p>
    ${r.error ? `<p class="daily-warn">${esc(r.error)}</p>` : ""}
    <ul class="perm-results-list">${rows}</ul>
    <div class="daily-actions"><button type="button" class="daily-go" data-dlg="ok" autofocus>OK</button></div>`;
}

function countsText(r) {
  const n = {};
  for (const x of r.results) n[x.status] = (n[x.status] ?? 0) + 1;
  return Object.entries(n).map(([k, v]) => `${v} ${STATUS_TEXT[k] ?? k}`).join(", ") || "Nothing changed";
}

export const showResults = () => last && dialog("cp-results", resultsHtml(last));

async function apply() {
  const changes = stagedList();
  if (!changes.length || running) return;
  running = { total: 0, done: 0, label: "Reading GitHub…", failed: 0 };
  last = null;
  paintTray();
  const sent = new Map(changes.map((c) => [keyOf(c), c]));
  let result = null;
  try {
    const res = await fetch(`${API}/api/properties/apply`, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ changes }),
    });
    if (!(res.headers.get("content-type") ?? "").includes("ndjson")) {
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `The apply was refused (${res.status})`);
      result = { results: body.results ?? [], dry: body.dry };
    } else {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          if (msg.type === "start") running.total = msg.total;
          if (msg.type === "step") {
            running.done++;
            running.label = msg.label;
            if (msg.state === "failed") running.failed++;
          }
          if (msg.type === "done" || msg.type === "error") result = { results: msg.results ?? [], dry: msg.dry, history: msg.history, error: msg.error };
          paintTray();
        }
      }
      if (!result) throw new Error("The connection dropped while applying. The batch keeps going on the server, so refresh in a minute to see where it got to.");
    }
  } catch (err) {
    result = { results: [], error: err instanceof TypeError ? "The dashboard couldn't be reached." : err.message };
  }
  for (const x of result.results) {
    if (x.status === "done" || x.status === "conflict" || x.status === "invalid") staged.delete(x.key);
  }
  save();
  last = { ...result, sent };
  running = null;
  dismissed = false;
  hooks.reload();
  hooks.redraw();
  showResults();
}

function trayHtml() {
  const n = staged.size;
  if (running) {
    const pct = running.total ? Math.round((running.done / running.total) * 100) : 4;
    return `<div class="perm-tray perm-running" role="status">
      <div class="perm-bar-track"><div class="perm-bar-fill" style="width:${pct}%"></div></div>
      <span>Applying: ${running.done} of ${running.total || "?"} writes${running.failed ? `, ${running.failed} failed` : ""}</span>
      <span class="sub perm-tray-now">${esc(running.label)}</span>
    </div>`;
  }
  if (!n && (!last || dismissed)) return "";
  return `<div class="perm-tray" role="status">
    ${last && !dismissed ? `<span>Last batch: ${esc(countsText(last))}</span>
      <button type="button" class="ghost" data-cp-tray="results">Results</button>
      ${n ? "" : `<button type="button" class="ghost" data-cp-tray="dismiss">Dismiss</button>`}` : ""}
    <span class="perm-tray-gap"></span>
    ${n ? `<span class="perm-tray-count"><strong>${n}</strong> staged ${n === 1 ? "change" : "changes"}</span>
      <button type="button" class="daily-go" data-cp-tray="review">Review & apply</button>
      <button type="button" class="ghost" data-cp-tray="clear">Clear</button>` : ""}
  </div>`;
}

export function paintTray() {
  const el = document.querySelector("[data-cp-tray]");
  if (el) el.innerHTML = trayHtml();
  document.querySelector("[data-cp]")?.classList.toggle("has-tray", Boolean(el?.innerHTML.trim()));
}

export const trayMarkup = () => `<div class="perm-tray-wrap" data-cp-tray>${trayHtml()}</div>`;

export function trayClick(e) {
  const t = e.target.closest("[data-cp-tray]")?.dataset.cpTray;
  if (!t) return false;
  if (t === "review") openReview();
  if (t === "results") showResults();
  if (t === "dismiss") { dismissed = true; paintTray(); }
  if (t === "clear") clearStaged();
  return true;
}

