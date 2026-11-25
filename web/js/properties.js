import { API } from "./live.js";
import { esc } from "./format.js";
import { keepScroll } from "./scroll.js";
import { propertyFilter } from "./property-filter.js";
import { loadRepoList, repoList as sharedRepoList } from "./repo-list.js";
import {
  crossTab, defDiff, defErrors, distribution, EDITORS, gaps, importCsv, keyOf, listOf, NAME, normDef, normValue,
  sameDef, sameValue, showValue, stateFrom, toCsv, TYPE_LABEL, TYPES, valueError,
} from "./properties-calc.js";
import { configureApply, isRunning, paintTray, stage, stageMany, stagedFor, stagedList, trayClick, trayMarkup, unstage } from "./properties-apply.js";

const STALE_MS = 5 * 60_000;
const PING_MS = 30_000;
const VIEWS = [["overview", "Overview"], ["grid", "Grid"], ["compare", "Compare"], ["gaps", "Gaps"], ["history", "History"]];
const ORG_SETTINGS = "https://github.com/organizations/GTNewHorizons/settings/custom-properties";

let data = null;
let st = null;
let failed = null;
let loading = null;
let fetchedAt = 0;
let wired = false;
let view = "overview";
let open = null;
let pendingOpen = null;
let draft = null;
let draftBase = null;
let draftErrors = [];
let panelNote = "";
let note = "";
let search = "";
let ticked = new Set();
let cross = { row: "", col: "", pick: null };
let hist = { prop: "", repo: "", source: "" };
let bulk = { prop: "", op: "set", value: null };
let held = false;
let timer = null;

let socket = null;
let liveState = "off";
let retryTimer = null;
let retries = 0;
let pingTimer = null;
let liveTimer = null;
let wantLive = false;

const gridFilter = propertyFilter("nh:props-grid", { onChange: () => paintBody() });
const cmpFilter = propertyFilter("nh:props-compare", { onChange: () => paintBody() });

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const repoUrl = (name) => `https://github.com/GTNewHorizons/${encodeURIComponent(name)}/settings`;

function ago(iso) {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 90) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 36 ? `${hours} hr ago` : `${Math.round(hours / 24)} days ago`;
}

function when(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

/* ---- the data, with what's staged laid over it ---- */

const repos = () => data?.repos ?? [];
const now = (repo, prop) => st?.values.get(repo)?.[prop] ?? null;
const stagedValue = (repo, prop) => stagedFor(`value:${repo}:${prop}`);
const shown = (repo, prop) => { const s = stagedValue(repo, prop); return s ? s.to : now(repo, prop); };
const pendingDef = (name) => {
  const c = stagedFor(`def:${name}`);
  if (c) return c;
  return stagedList().find((x) => x.kind === "rename" && x.to === name) ?? stagedList().find((x) => x.kind === "revalue" && x.name === name) ?? null;
};
const PENDING_LABEL = { create: "new", update: "edited", delete: "deleting", rename: "renaming", revalue: "values renamed" };
const pendingText = (c, name) =>
  c.kind === "create" ? "new property, not on GitHub yet" : c.kind === "update" ? "definition edit"
    : c.kind === "delete" ? "delete" : c.kind === "rename" ? (c.to === name ? `rename from ${c.name}` : `rename to ${c.to}`)
      : `${c.sources.join(", ")} → ${c.target}`;
const lockedProp = (name) => {
  const c = stagedFor(`def:${name}`);
  return c && (c.kind === "delete" || c.kind === "rename") ? c : null;
};

function defFor(name) {
  const c = stagedFor(`def:${name}`);
  if (c?.kind === "create") return normDef(c.def);
  if (c?.kind === "update") return normDef({ ...c.to, name });
  return st?.defs.get(name) ?? null;
}

function columns() {
  const out = [...(st?.defs.values() ?? [])];
  for (const c of stagedList()) if (c.kind === "create" && !st?.defs.has(c.def.name)) out.push(normDef(c.def));
  return out;
}

const shownRepos = (filter) => repos().filter((r) => filter.passes({ ...r, properties: Object.fromEntries(columns().map((d) => [d.name, shown(r.name, d.name)])) }));

/* ---- small pieces ---- */

const opener = (kind, key, inner, cls = "") => `<button type="button" class="perm-link${cls ? ` ${cls}` : ""}" data-cp-open="${kind}:${esc(key)}">${inner}</button>`;
const propRef = (name) => opener("prop", name, `<span class="cp-prop">${esc(name)}</span>`);
const repoRef = (name) => opener("repo", name, `<span class="repo">${esc(name)}</span>`);
const typePill = (d) => `<span class="pill neutral">${esc(TYPE_LABEL[d.type] ?? d.type)}</span>`;

function chips(def, v) {
  const list = listOf(v);
  if (!list.length) return `<span class="cp-unset">—</span>`;
  return list.map((x) => `<span class="cp-chip${def?.allowed && !def.allowed.includes(x) ? " is-bad" : ""}"${def?.allowed && !def.allowed.includes(x) ? ` title="Not an allowed value any more"` : ""}>${esc(x)}</span>`).join("");
}

function card(title, sub, body, { span = 12, extra = "", cls = "" } = {}) {
  return `<section class="card perm-card cp-card ${cls}" style="--span:${span}">
    <header><h2>${esc(title)}</h2>${sub ? `<span class="sub">${sub}</span>` : ""}${extra}</header>
    <div class="body flush">${body}</div>
  </section>`;
}

const table = (head, rows, empty, cls = "") =>
  rows.length
    ? `<div class="tscroll perm-scroll ${cls}"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`
    : `<div class="empty">${esc(empty)}</div>`;

function cellHtml(repo, def) {
  const key = `value:${repo}:${def.name}`;
  const s = stagedFor(key);
  const lock = lockedProp(def.name);
  const title = lock ? `${def.name} is being ${lock.kind === "rename" ? "renamed" : "deleted"} in the staged batch` : s ? `Staged: was ${showValue(s.from) || "unset"}` : "Click to change";
  return `<td class="cp-td${s ? " is-staged" : ""}" data-repo="${esc(repo)}" data-prop="${esc(def.name)}">
    <button type="button" class="cp-val" data-cp-edit title="${esc(title)}"${lock ? " disabled" : ""}>${chips(def, s ? s.to : now(repo, def.name))}</button>${s ? `<button type="button" class="perm-undo cp-undo" data-cp-unstage="${esc(key)}" title="Undo this change" aria-label="Undo this change">↺</button>` : ""}
  </td>`;
}

function bar(dist, total) {
  const pct = total ? Math.round((dist.set / total) * 100) : 0;
  return `<span class="cp-cover" title="${dist.set} of ${total} repos"><span class="cp-cover-fill" style="width:${pct}%"></span></span><span class="num">${dist.set}</span><span class="sub">/${total}</span>`;
}

function valueBars(def, dist, max = 8) {
  const list = [...dist.counts].filter(([, n]) => n).sort((a, b) => b[1] - a[1]);
  if (def.type === "string" || def.type === "url") return `<span class="sub">${plural(new Set(repos().map((r) => normValue(now(r.name, def.name))).filter(Boolean)).size, "distinct value")}</span>`;
  if (!list.length) return `<span class="sub">none set</span>`;
  const head = list.slice(0, max).map(([v, n]) => `<span class="cp-chip${def.allowed && !def.allowed.includes(v) ? " is-bad" : ""}">${esc(v)} <b>${n}</b></span>`).join("");
  return head + (list.length > max ? ` <span class="sub">+${list.length - max} more</span>` : "");
}

/* ---- views ---- */

function notesHtml() {
  const out = [];
  if (data?.propertiesError) out.push(["daily-warn", data.propertiesError]);
  if (data?.viewer?.canApply === false) out.push(["hint", "Org-Manager's key isn't set on the app Worker, so changes can be staged but not applied."]);
  if (data?.historyError) out.push(["hint", data.historyError]);
  if (data?.running) out.push(["daily-warn", `${data.running.by} is applying property changes right now.`]);
  return out.map(([cls, t]) => `<p class="${cls} perm-note">${esc(t)}</p>`).join("");
}

function overviewHtml() {
  const defs = columns();
  const total = repos().length;
  const g = gaps(st, repos());
  const fact = (label, value, extra = "") => `<div class="perm-fact"><span class="sub">${esc(label)}</span><strong>${value}</strong>${extra}</div>`;
  const facts = `<section class="card perm-card perm-org" style="--span:12"><header><h2>Custom properties</h2><span class="sub">${esc(data.org ?? "")}</span>
      <a class="perm-ext" href="${ORG_SETTINGS}" target="_blank" rel="noopener">Settings on GitHub</a></header>
    <div class="body"><div class="perm-facts">
      ${fact("Properties", st.defs.size.toLocaleString())}
      ${fact("Active repos", total.toLocaleString(), data.archived ? `<span class="sub">${data.archived} archived left out</span>` : "")}
      ${fact("With nothing set", g.untagged.length.toLocaleString(), g.untagged.length ? `<button type="button" class="ghost mini" data-cp-tick="untagged">Tick them</button>` : "")}
      ${fact("Staged", stagedList().length.toLocaleString())}
    </div>${notesHtml()}</div></section>`;
  const rows = defs.map((d) => {
    const dist = distribution(d, repos());
    const pend = pendingDef(d.name);
    const rules = [d.required ? `<span class="pill neutral">required</span>` : "", d.default != null ? `<span class="sub">default ${esc(showValue(d.default))}</span>` : "",
      d.editableBy === "org_and_repo_actors" ? `<span class="sub">repo admins can edit</span>` : ""].filter(Boolean).join(" ");
    return `<tr>
      <td>${propRef(d.name)}${pend ? ` <span class="pill perm-risky" title="Staged: ${esc(pendingText(pend, d.name))}">${esc(PENDING_LABEL[pend.kind])}</span>` : ""}${d.description ? `<div class="sub cp-desc">${esc(d.description)}</div>` : ""}</td>
      <td>${typePill(d)}</td>
      <td class="cp-cov">${bar(dist, total)}</td>
      <td class="cp-vals">${valueBars(d, dist)}</td>
      <td>${rules || `<span class="sub">—</span>`}</td>
    </tr>`;
  });
  const props = card("Properties", `${plural(defs.length, "property", "properties")} · click one to edit it`,
    table(["Property", "Type", "Set on", "Values", "Rules"], rows, "The org has no custom properties yet."),
    { extra: `<button type="button" class="ghost mini perm-ext" data-cp-act="new">New property</button>` });
  const recent = (data.history ?? []).slice(0, 12).map(historyRow);
  const changes = card("Recent changes", data.historyError ? esc(data.historyError) : "from the dashboard and from GitHub",
    table(["When", "Who", "Repo", "Property", "Change"], recent, data.historyError ? "History is off." : "No changes recorded yet."),
    { extra: recent.length ? `<button type="button" class="ghost mini perm-ext" data-cp-view="history">All history</button>` : "" });
  return `<div class="grid perm-grid">${facts}${props}${changes}</div>`;
}

function tickBar(list) {
  const n = ticked.size;
  return `<div class="cp-tickbar">
    <button type="button" class="ghost mini" data-cp-tickshown>Tick all ${list.length} shown</button>
    ${n ? `<button type="button" class="ghost mini" data-cp-tickclear>Clear ${n} ticked</button>
      <button type="button" class="daily-go cp-mini" data-cp-act="bulk">Bulk edit ${plural(n, "repo")}</button>` : `<span class="sub">Tick repos to change them together.</span>`}
  </div>`;
}

function gridHtml() {
  const defs = columns();
  const list = shownRepos(gridFilter).filter((r) => !search || r.name.toLowerCase().includes(search.toLowerCase()));
  const allOn = list.length && list.every((r) => ticked.has(r.name));
  const head = [`<input type="checkbox" data-cp-tickall aria-label="Tick every shown repo"${allOn ? " checked" : ""}>`, "Repo",
    ...defs.map((d) => `${propRef(d.name)}${lockedProp(d.name) ? ` <span class="pill perm-risky">${esc(PENDING_LABEL[lockedProp(d.name).kind])}</span>` : ""}`)];
  const rows = list.map((r) => `<tr>
    <td class="cp-tick"><input type="checkbox" data-cp-tickone="${esc(r.name)}"${ticked.has(r.name) ? " checked" : ""} aria-label="Tick ${esc(r.name)}"></td>
    <td class="cp-repo">${repoRef(r.name)}</td>
    ${defs.map((d) => cellHtml(r.name, d)).join("")}
  </tr>`);
  const tools = `<div class="cp-tools">
      <input type="search" class="perm-input cp-search" data-cp-search value="${esc(search)}" placeholder="Filter by repo name" aria-label="Filter by repo name" spellcheck="false">
      <button type="button" class="ghost mini" data-cp-act="export">Export ${plural(list.length, "row")}</button>
    </div>${gridFilter.use(data, "").html()}${tickBar(list)}`;
  return `<div class="grid perm-grid">${card("All repos", `${list.length} of ${repos().length} shown · click a cell to change it`,
    `<div class="cp-pad">${tools}</div>${table(head, rows, "No repos match.", "cp-gridscroll")}`)}</div>`;
}

function compareHtml() {
  const defs = columns();
  const list = shownRepos(cmpFilter);
  const active = cmpFilter.use(data, "").active();
  const rows = list.map((r) => `<tr>
    <td class="cp-tick"><input type="checkbox" data-cp-tickone="${esc(r.name)}"${ticked.has(r.name) ? " checked" : ""} aria-label="Tick ${esc(r.name)}"></td>
    <td class="cp-repo">${repoRef(r.name)}</td>
    ${defs.map((d) => `<td>${chips(d, shown(r.name, d.name))}</td>`).join("")}
  </tr>`);
  const find = card("Find repos", active ? `${list.length} of ${repos().length} match` : "add conditions to narrow it down",
    `<div class="cp-pad">${cmpFilter.html()}${tickBar(list)}</div>${table(["", "Repo", ...defs.map((d) => esc(d.name))], rows, "No repos match.", "cp-gridscroll")}`);

  const selects = (which) => `<select class="perm-sel" data-cp-cross="${which}" aria-label="${which === "row" ? "Rows" : "Columns"}"><option value="">${which === "row" ? "Rows…" : "Columns…"}</option>${
    defs.filter((d) => d.type !== "string" && d.type !== "url").map((d) => `<option value="${esc(d.name)}"${cross[which] === d.name ? " selected" : ""}>${esc(d.name)}</option>`).join("")}</select>`;
  let tab = `<p class="sub cp-pad">Pick two select or true/false properties to see how their values line up.</p>`;
  if (cross.row && cross.col && defFor(cross.row) && defFor(cross.col) && cross.row !== cross.col) {
    const view = repos().map((r) => ({ name: r.name, properties: { [cross.row]: shown(r.name, cross.row), [cross.col]: shown(r.name, cross.col) } }));
    const t = crossTab(defFor(cross.row), defFor(cross.col), view);
    const label = (v) => (v == null ? `<span class="sub">unset</span>` : esc(v));
    const body = t.rows.map((a, i) => `<tr><th scope="row">${label(a)}</th>${t.cols.map((b, j) => {
      const n = t.at(a, b).length;
      const on = cross.pick && cross.pick[0] === i && cross.pick[1] === j;
      return `<td class="num">${n ? `<button type="button" class="cp-xcell${on ? " is-on" : ""}" data-cp-xcell="${i}:${j}">${n}</button>` : `<span class="sub">·</span>`}</td>`;
    }).join("")}</tr>`).join("");
    let picked = "";
    if (cross.pick) {
      const [i, j] = cross.pick;
      const names = t.at(t.rows[i], t.cols[j]) ?? [];
      picked = names.length ? `<div class="cp-pad"><p class="sub">${esc(cross.row)} ${t.rows[i] == null ? "unset" : `= ${esc(t.rows[i])}`} and ${esc(cross.col)} ${t.cols[j] == null ? "unset" : `= ${esc(t.cols[j])}`}: ${plural(names.length, "repo")}
        <button type="button" class="ghost mini" data-cp-tickthese="${esc(JSON.stringify(names))}">Tick these</button></p>
        <div class="cp-names">${names.map(repoRef).join("")}</div></div>` : "";
    }
    tab = `<div class="tscroll perm-scroll cp-xtab"><table><thead><tr><th>${esc(cross.row)} ↓ · ${esc(cross.col)} →</th>${t.cols.map((b) => `<th>${label(b)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>${picked}`;
  }
  const xt = card("Cross-tab", "a repo with several values counts once under each", `<div class="cp-pad cp-tools">${selects("row")}${selects("col")}</div>${tab}`);
  return `<div class="grid perm-grid">${find}${xt}</div>`;
}

function gapsHtml() {
  const g = gaps(st, repos());
  const item = (title, n, body, names) => `<details class="perm-problem"${n ? "" : " data-none"}><summary><span>${esc(title)}</span><span class="num${n ? " lb-warn" : " sub"}">${n}</span></summary>${n ? `<div class="perm-problem-body">${names?.length ? `<p><button type="button" class="ghost mini" data-cp-tickthese="${esc(JSON.stringify(names))}">Tick these ${plural(names.length, "repo")}</button></p>` : ""}${body}</div>` : ""}</details>`;
  const names = (list) => `<div class="cp-names">${list.map(repoRef).join("")}</div>`;
  const sections = [
    item("Required but not set", g.required.reduce((n, x) => n + x.repos.length, 0), g.required.map((x) => `<h4>${propRef(x.prop)}</h4>${names(x.repos)}`).join(""), [...new Set(g.required.flatMap((x) => x.repos))]),
    item("Repos with nothing set", g.untagged.length, names(g.untagged), g.untagged),
    ...g.unsetBy.map((x) => item(`${x.prop} not set`, x.repos.length, names(x.repos), x.repos)),
    item("Values that aren't allowed any more", g.stale.reduce((n, x) => n + x.repos.length, 0), g.stale.map((x) => `<h4>${propRef(x.prop)}</h4><ul>${x.repos.map((r) => `<li>${repoRef(r.repo)} <span class="sub">${esc(r.values.join(", "))}</span></li>`).join("")}</ul>`).join(""), [...new Set(g.stale.flatMap((x) => x.repos.map((r) => r.repo)))]),
    item("Properties no repo uses", g.unusedProps.length, `<div class="cp-names">${g.unusedProps.map(propRef).join("")}</div>`),
    item("Allowed values no repo uses", g.unusedValues.reduce((n, x) => n + x.values.length, 0), g.unusedValues.map((x) => `<p>${propRef(x.prop)} <span class="sub">${esc(x.values.join(", "))}</span></p>`).join("")),
  ];
  return `<div class="grid perm-grid">${card("Gaps", `across ${plural(repos().length, "active repo")}`, `<div class="perm-problems">${sections.join("")}</div>`)}</div>`;
}

const parseJson = (s) => { if (s == null) return null; try { return JSON.parse(s); } catch { return s; } };

function changeText(h) {
  if (h.repo != null) {
    return `${chips(defFor(h.property), parseJson(h.before))} <span class="sub">→</span> ${chips(defFor(h.property), parseJson(h.after))}${h.note ? ` <span class="sub">${esc(h.note)}</span>` : ""}`;
  }
  const b = parseJson(h.before);
  const a = parseJson(h.after);
  let text = h.note ?? "";
  if (b && a && typeof b === "object" && typeof a === "object") {
    const diff = defDiff({ ...b, name: h.property }, { ...a, name: h.property });
    if (diff.length && !/renamed/.test(text)) text = `${text ? `${text}: ` : ""}${diff.join("; ")}`;
  }
  return `<span class="sub">definition</span> ${esc(text || "changed")}`;
}

function historyRow(h) {
  const who = h.source === "dashboard" ? esc(h.by) : `${esc(h.by)} <span class="sub">on GitHub</span>`;
  return `<tr>
    <td class="sub" title="${esc(h.at)}">${esc(when(h.at))}</td>
    <td>${who}</td>
    <td>${h.repo ? repoRef(h.repo) : `<span class="sub">org</span>`}</td>
    <td>${propRef(h.property)}</td>
    <td class="cp-change">${changeText(h)}</td>
  </tr>`;
}

function historyHtml() {
  const rows = (data.history ?? []).filter((h) =>
    (!hist.prop || h.property === hist.prop) && (!hist.repo || h.repo === hist.repo) && (!hist.source || h.source === hist.source));
  const props = [...new Set((data.history ?? []).map((h) => h.property))].sort((a, b) => a.localeCompare(b));
  const names = [...new Set((data.history ?? []).map((h) => h.repo).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const sel = (key, label, opts) => `<select class="perm-sel" data-cp-hist="${key}" aria-label="${label}"><option value="">${label}</option>${opts.map(([v, t]) => `<option value="${esc(v)}"${hist[key] === v ? " selected" : ""}>${esc(t)}</option>`).join("")}</select>`;
  const tools = `<div class="cp-pad cp-tools">${sel("prop", "Any property", props.map((p) => [p, p]))}${sel("repo", "Any repo", names.map((n) => [n, n]))}${sel("source", "From anywhere", [["dashboard", "From the dashboard"], ["github", "From GitHub"]])}</div>`;
  return `<div class="grid perm-grid">${card("History", data.historyError ? esc(data.historyError) : `the newest ${(data.history ?? []).length} changes`,
    tools + table(["When", "Who", "Repo", "Property", "Change"], rows.map(historyRow), data.historyError ? "History is off." : "Nothing matches."))}</div>`;
}

function viewHtml() {
  if (failed && !data) return `<div class="error">${esc(failed)}</div>`;
  if (!data) return `<div class="empty">Reading the org's custom properties from GitHub…</div>`;
  if (view === "grid") return gridHtml();
  if (view === "compare") return compareHtml();
  if (view === "gaps") return gapsHtml();
  if (view === "history") return historyHtml();
  return overviewHtml();
}

/* ---- panels ---- */

const section = (title, sub, body) => `<section class="perm-sec"><h3>${esc(title)}${sub ? ` <span class="sub">${sub}</span>` : ""}</h3>${body}</section>`;

function valueInput(def, value, attr) {
  if (!def) return "";
  if (def.type === "string" || def.type === "url") return `<input class="perm-input" ${attr} value="${esc(normValue(value) ?? "")}" spellcheck="false">`;
  if (def.type === "multi_select") {
    const cur = listOf(value);
    return `<span class="pf-chips">${[...new Set([...(def.allowed ?? []), ...cur])].map((v) => `<label class="pf-chip"><input type="checkbox" ${attr} value="${esc(v)}"${cur.includes(v) ? " checked" : ""}><span>${esc(v)}</span></label>`).join("")}</span>`;
  }
  const opts = def.type === "true_false" ? ["true", "false"] : def.allowed ?? [];
  const cur = normValue(value);
  return `<select class="perm-sel" ${attr}><option value="">— none</option>${[...new Set([...opts, ...(cur != null ? [cur] : [])])].map((o) =>
    `<option value="${esc(o)}"${o === cur ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
}

function defForm(isNew) {
  const d = draft;
  const select = d.type === "single_select" || d.type === "multi_select";
  const counts = isNew ? new Map() : new Map(distribution(d, repos()).counts);
  const allowed = select ? `<div class="cp-allowed">${(d.allowed ?? []).map((v, i) => `<div class="cp-arow">
      <span class="cp-chip">${esc(v)}</span>${isNew ? "" : `<span class="sub">${counts.get(v) ?? 0} repos</span>`}
      <span class="perm-tray-gap"></span>
      <button type="button" class="perm-undo" data-cp-move="${i}:-1"${i ? "" : " disabled"} aria-label="Move up">↑</button>
      <button type="button" class="perm-undo" data-cp-move="${i}:1"${i < d.allowed.length - 1 ? "" : " disabled"} aria-label="Move down">↓</button>
      <button type="button" class="perm-x" data-cp-drop="${i}" aria-label="Remove ${esc(v)}">×</button></div>`).join("") || `<p class="sub">No values yet.</p>`}
      <div class="perm-add"><input class="perm-input" data-cp-newval placeholder="New value" spellcheck="false" maxlength="75"><button type="button" class="ghost mini" data-cp-addval>Add value</button></div></div>` : "";
  const field = (label, html) => `<label class="cp-field"><span class="sub">${esc(label)}</span>${html}</label>`;
  return `<form class="cp-defform" data-cp-defform>
    ${isNew ? field("Name", `<input class="perm-input" data-cp-d="name" value="${esc(d.name ?? "")}" spellcheck="false" maxlength="75" autocomplete="off">`) : ""}
    ${isNew ? field("Type", `<select class="perm-sel" data-cp-d="type">${TYPES.map((t) => `<option value="${t}"${d.type === t ? " selected" : ""}>${esc(TYPE_LABEL[t])}</option>`).join("")}</select>`) : ""}
    ${field("Description", `<input class="perm-input cp-wide" data-cp-d="description" value="${esc(d.description ?? "")}" spellcheck="true" maxlength="255">`)}
    ${select ? field("Allowed values", allowed) : ""}
    ${field("Default", valueInput({ ...d, required: false }, d.default, `data-cp-d="default"`))}
    <label class="perm-toggle"><input type="checkbox" data-cp-d="required"${d.required ? " checked" : ""}> Required <span class="sub">every repo must have a value; needs a default</span></label>
    <label class="perm-toggle"><input type="checkbox" data-cp-d="explicit"${d.explicit ? " checked" : ""}> Require explicit values <span class="sub">repos must set it themselves, not inherit the default</span></label>
    ${field("Who can edit values", `<select class="perm-sel" data-cp-d="editableBy">${Object.entries(EDITORS).map(([k, v]) => `<option value="${k}"${d.editableBy === k ? " selected" : ""}>${esc(v)}</option>`).join("")}</select>`)}
    ${draftErrors.length ? `<ul class="cp-warn">${draftErrors.map((e) => `<li class="cp-bad">${esc(e)}</li>`).join("")}</ul>` : ""}
    <div class="cp-actions">
      <button type="button" class="daily-go" data-cp-act="stagedef">${isNew ? "Stage new property" : "Stage these changes"}</button>
      ${isNew ? "" : `<button type="button" class="ghost" data-cp-act="resetdef">Reset</button>`}
    </div>
  </form>`;
}

function propPanel(name) {
  const cur = st.defs.get(name);
  const def = defFor(name);
  if (!def) return `<p class="sub">${esc(name)} isn't a property any more.</p>`;
  const pend = pendingDef(name);
  const staged = stagedFor(`def:${name}`);
  const total = repos().length;
  const dist = distribution(def, repos());
  const select = def.type === "single_select" || def.type === "multi_select";
  const head = `<div class="perm-phead"><h2 tabindex="-1">${esc(name)}</h2>${typePill(def)}${def.required ? `<span class="pill neutral">required</span>` : ""}</div>
    <div class="perm-plinks"><a href="${ORG_SETTINGS}" target="_blank" rel="noopener">Settings on GitHub</a><span class="sub">set on ${dist.set} of ${total} repos</span></div>
    ${pend ? `<p class="daily-warn perm-pnote">Staged: ${esc(pendingText(pend, name))} <button type="button" class="perm-undo" data-cp-unstage="${esc(keyOf(pend))}">Remove from batch</button></p>` : ""}
    ${panelNote ? `<p class="hint perm-pnote">${esc(panelNote)}</p>` : ""}`;
  if (!cur) {
    return `${head}${section("Definition", "staged, not on GitHub yet", draft ? defForm(false) : "")}`;
  }
  const lock = lockedProp(name);
  const sources = [...new Set([...(cur.allowed ?? []), ...dist.counts.map(([v]) => v)])];
  const revalue = select && !lock ? section("Rename or merge values", "pick one to rename it, several to merge them", `<div class="cp-revalue">
      <span class="pf-chips">${sources.map((v) => `<label class="pf-chip"><input type="checkbox" data-cp-src value="${esc(v)}"><span>${esc(v)} <b>${new Map(dist.counts).get(v) ?? 0}</b></span></label>`).join("")}</span>
      <div class="perm-add"><span class="sub">into</span><input class="perm-input" data-cp-target list="cp-allowed-list" placeholder="Value" spellcheck="false" maxlength="75">
        <datalist id="cp-allowed-list">${(cur.allowed ?? []).map((v) => `<option value="${esc(v)}">`).join("")}</datalist>
        <button type="button" class="ghost mini" data-cp-act="revalue">Stage</button></div></div>`) : "";
  const rename = !lock ? section("Rename", "GitHub has no rename, so this creates the new property, copies every value, then deletes this one", `<div class="perm-add">
      <input class="perm-input" data-cp-rename placeholder="New name" value="" spellcheck="false" maxlength="75"><button type="button" class="ghost mini" data-cp-act="rename">Stage rename</button></div>`) : "";
  const del = !lock ? section("Delete", "", `<p class="sub">${dist.set ? `${plural(dist.set, "repo")} lose${dist.set === 1 ? "s" : ""} ${dist.set === 1 ? "its" : "their"} value. GitHub can't undo it.` : "No repo has a value."}</p>
      <button type="button" class="ghost perm-danger" data-cp-act="delete">Stage delete</button>`) : "";
  const which = open.filter ?? "all";
  const filter = `<select class="perm-sel" data-cp-pfilter aria-label="Which repos">${[["all", "All repos"], ["set", "With a value"], ["unset", "Without one"]].map(([k, v]) =>
    `<option value="${k}"${k === which ? " selected" : ""}>${v}</option>`).join("")}</select>`;
  const rows = repos().filter((r) => {
    const has = listOf(shown(r.name, name)).length > 0;
    return which === "all" || (which === "set" ? has : !has);
  }).map((r) => `<tr><td>${repoRef(r.name)}</td>${cellHtml(r.name, def)}</tr>`);
  const historyRows = (data.history ?? []).filter((h) => h.property === name).slice(0, 30).map(historyRow);
  return `${head}
    ${section("Definition", staged?.kind === "update" ? "with the staged edit" : "", lock ? `<p class="sub">Being ${lock.kind === "rename" ? `renamed to ${esc(lock.to)}` : "deleted"} in the staged batch.</p>` : pend?.kind === "revalue" ? `<p class="sub">Its values are being renamed in the staged batch; apply or remove that first.</p>` : draft ? defForm(false) : "")}
    ${revalue}${rename}${del}
    ${section("Repos", `${valueBars(def, dist, 12)}`, `<div class="cp-tools">${filter}</div>${table(["Repo", "Value"], rows, "No repos.")}`)}
    ${section("History", "", table(["When", "Who", "Repo", "Property", "Change"], historyRows, "No changes recorded."))}`;
}

function repoPanel(name) {
  const r = repos().find((x) => x.name === name);
  if (!r) return `<p class="sub">${esc(name)} isn't an active repo any more.</p>`;
  const defs = columns();
  const rows = defs.map((d) => `<tr><td>${propRef(d.name)}<div class="sub">${esc(TYPE_LABEL[d.type])}${d.required ? " · required" : ""}</div></td>${cellHtml(name, d)}</tr>`);
  const historyRows = (data.history ?? []).filter((h) => h.repo === name).slice(0, 30).map(historyRow);
  return `<div class="perm-phead"><h2 tabindex="-1">${esc(name)}</h2>${r.private ? `<span class="pill draft">private</span>` : ""}${r.fork ? `<span class="pill draft">fork</span>` : ""}</div>
    <div class="perm-plinks"><a href="${repoUrl(name)}/custom-properties" target="_blank" rel="noopener">Custom properties on GitHub</a><a href="https://github.com/GTNewHorizons/${encodeURIComponent(name)}" target="_blank" rel="noopener">Repo</a></div>
    ${section("Properties", "click a value to change it", table(["Property", "Value"], rows, "The org has no properties."))}
    ${section("History", "", table(["When", "Who", "Repo", "Property", "Change"], historyRows, "No changes recorded."))}`;
}

function bulkChanges() {
  const def = defFor(bulk.prop);
  if (!def) return { changes: [], errors: [] };
  const changes = [];
  const errors = [];
  const pick = listOf(bulk.value);
  for (const repo of ticked) {
    if (!st.repos.has(repo)) continue;
    const base = shown(repo, def.name);
    let to;
    if (bulk.op === "clear") to = null;
    else if (bulk.op === "add") to = [...listOf(base), ...pick];
    else if (bulk.op === "remove") to = listOf(base).filter((v) => !pick.includes(v));
    else to = bulk.value;
    to = normValue(to);
    if (Array.isArray(to) && def.allowed) to = [...to].sort((a, b) => def.allowed.indexOf(a) - def.allowed.indexOf(b));
    if (sameValue(base, to)) continue;
    const err = valueError(def, to);
    if (err) { errors.push(`${repo}: ${err}`); continue; }
    changes.push({ kind: "value", repo, prop: def.name, from: normValue(now(repo, def.name)), to });
  }
  return { changes, errors };
}

function bulkPanel() {
  const defs = columns().filter((d) => !lockedProp(d.name));
  if (!bulk.prop || !defFor(bulk.prop)) bulk.prop = defs[0]?.name ?? "";
  const def = defFor(bulk.prop);
  const multi = def?.type === "multi_select";
  if (!multi && (bulk.op === "add" || bulk.op === "remove")) bulk.op = "set";
  const ops = [["set", "Set to"], ...(multi ? [["add", "Add"], ["remove", "Remove"]] : []), ["clear", "Clear"]];
  const { changes, errors } = bulkChanges();
  const names = [...ticked].sort((a, b) => a.localeCompare(b));
  return `<div class="perm-phead"><h2 tabindex="-1">Bulk edit ${plural(ticked.size, "repo")}</h2></div>
    <div class="cp-names cp-ticked">${names.map(repoRef).join("")}</div>
    ${section("Change", "", `<div class="cp-bulk">
      <label class="cp-field"><span class="sub">Property</span><select class="perm-sel" data-cp-bulk="prop">${defs.map((d) => `<option value="${esc(d.name)}"${d.name === bulk.prop ? " selected" : ""}>${esc(d.name)}</option>`).join("")}</select></label>
      <span class="seg mini">${ops.map(([k, v]) => `<button type="button" data-cp-bulkop="${k}" aria-pressed="${bulk.op === k}">${v}</button>`).join("")}</span>
      ${bulk.op === "clear" ? "" : `<label class="cp-field"><span class="sub">Value</span>${valueInput(multi || bulk.op !== "set" ? { ...def, type: "multi_select", allowed: def?.allowed } : def, bulk.value, `data-cp-bulk="value"`)}</label>`}
    </div>`)}
    <p class="sub">${plural(changes.length, "repo")} would change${ticked.size - changes.length - errors.length > 0 ? `; ${ticked.size - changes.length - errors.length} already ${ticked.size - changes.length - errors.length === 1 ? "has" : "have"} it` : ""}.</p>
    ${errors.length ? `<ul class="cp-warn">${errors.slice(0, 8).map((e) => `<li class="cp-bad">${esc(e)}</li>`).join("")}${errors.length > 8 ? `<li class="sub">and ${errors.length - 8} more</li>` : ""}</ul>` : ""}
    <div class="cp-actions"><button type="button" class="daily-go" data-cp-act="stagebulk"${changes.length ? "" : " disabled"}>Stage ${plural(changes.length, "change")}</button></div>`;
}

function panelHtml() {
  if (!open || !data) return "";
  const body = open.kind === "prop" ? propPanel(open.key) : open.kind === "repo" ? repoPanel(open.key) : open.kind === "bulk" ? bulkPanel()
    : `<div class="perm-phead"><h2 tabindex="-1">New property</h2></div>${panelNote ? `<p class="hint perm-pnote">${esc(panelNote)}</p>` : ""}${defForm(true)}`;
  return `<div class="perm-modal" data-cp-backdrop><div class="perm-panel cp-panel" role="dialog" aria-modal="true" aria-label="Custom property details">
    <div class="perm-pbar"><span></span><button type="button" class="icon-btn" data-cp-close aria-label="Close">✕</button></div>
    <div class="perm-pbody">${body}</div>
  </div></div>`;
}

/* ---- painting ---- */

function statusHtml() {
  if (!data?.readAt) return loading ? "Reading…" : "";
  const live = liveState === "live" ? `<span class="tier tier-instant" title="Changes on GitHub show up here within seconds"><i></i>live</span> · ` : liveState === "reconnecting" ? `<span class="tier tier-down" title="Live updates are reconnecting; the page still re-reads every five minutes"><i></i>reconnecting</span> · ` : "";
  return `${live}Read from GitHub ${esc(ago(data.readAt))}${failed ? ` · <span class="lb-warn">${esc(failed)}</span>` : ""}`;
}

function barHtml() {
  const views = `<span class="seg">${VIEWS.map(([k, v]) => `<button type="button" data-cp-view="${k}" aria-pressed="${view === k}">${v}</button>`).join("")}</span>`;
  return `<div class="perm-bar cp-bar">
    ${views}
    <button type="button" class="ghost mini" data-cp-act="new">New property</button>
    <label class="ghost mini cp-file">Import CSV<input type="file" accept=".csv,text/csv" data-cp-import hidden></label>
    <button type="button" class="ghost mini" data-cp-act="refresh"${loading ? " disabled" : ""}>Refresh</button>
    ${note ? `<span class="cp-note" data-cp-note>${esc(note)}</span>` : ""}
    <span class="perm-status sub" data-cp-status>${statusHtml()}</span>
  </div>`;
}

export function propertiesBody() {
  return `<div class="perm cp${open ? " has-panel" : ""}" data-cp>
    <div data-cp-bar>${barHtml()}</div>
    <div data-cp-body>${viewHtml()}</div>
    <div data-cp-panel>${panelHtml()}</div>
    ${trayMarkup()}
  </div>`;
}

const editing = () => document.activeElement?.closest?.("[data-cp-cellform], [data-cp-defform], .cp-bulk, [data-cp-search]");

function paintBody() {
  const body = document.querySelector("[data-cp-body]");
  if (!body) return;
  const focus = document.activeElement?.matches?.("[data-cp-search]") ? document.activeElement.selectionStart : null;
  keepScroll(body, () => { body.innerHTML = viewHtml(); });
  if (focus != null) {
    const el = body.querySelector("[data-cp-search]");
    el?.focus();
    el?.setSelectionRange(focus, focus);
  }
}

function paintBar() {
  const el = document.querySelector("[data-cp-bar]");
  if (el) el.innerHTML = barHtml();
}

function paintStatus() {
  const el = document.querySelector("[data-cp-status]");
  if (el) el.innerHTML = statusHtml();
}

function paintPanel() {
  const el = document.querySelector("[data-cp-panel]");
  if (!el) return;
  const top = el.querySelector(".perm-pbody")?.scrollTop ?? 0;
  const same = el.dataset.showing === (open ? `${open.kind}:${open.key ?? ""}` : "");
  el.innerHTML = panelHtml();
  el.dataset.showing = open ? `${open.kind}:${open.key ?? ""}` : "";
  if (same) { const b = el.querySelector(".perm-pbody"); if (b) b.scrollTop = top; }
  document.querySelector("[data-cp]")?.classList.toggle("has-panel", Boolean(open));
  document.documentElement.classList.toggle("perm-modal-open", Boolean(open));
}

function redraw(force = true) {
  if (!force && editing()) { held = true; return; }
  held = false;
  paintBar();
  paintBody();
  paintPanel();
  paintTray();
}

function say(text) {
  note = text;
  paintBar();
  clearTimeout(say.t);
  say.t = setTimeout(() => { note = ""; paintBar(); }, 6000);
}

/* ---- loading and live updates ---- */

async function load() {
  if (loading) return loading;
  loading = (async () => {
    paintStatus();
    try {
      const res = await fetch(`${API}/api/properties`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(res.status === 403 ? "Only the admin team can manage custom properties." : body.error ?? `The properties couldn't be read (${res.status}).`);
      data = body;
      st = stateFrom(data);
      failed = null;
      fetchedAt = Date.now();
      resolvePending();
      if (open?.kind === "prop" && draft && draftBase && sameDef(draft, draftBase)) draftFrom(open.key);
    } catch (err) {
      failed = err instanceof TypeError ? "The dashboard couldn't be reached." : err.message;
    } finally {
      loading = null;
      redraw(false);
    }
  })();
  return loading;
}

const socketUrl = () => `${API || location.origin}/api/logs?only=custom_property,custom_property_values`.replace(/^http/, "ws");

function connectLive() {
  if (socket || retryTimer || !wantLive) return;
  let ws;
  try { ws = new WebSocket(socketUrl()); } catch { return retryLive(); }
  socket = ws;
  ws.addEventListener("open", () => {
    retries = 0;
    liveState = "live";
    paintStatus();
    pingTimer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send("ping"); }, PING_MS);
  });
  ws.addEventListener("message", (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type !== "event") return;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { if (!isRunning()) load(); }, 2000);
  });
  ws.addEventListener("close", () => {
    clearInterval(pingTimer);
    if (socket !== ws) return;
    socket = null;
    if (wantLive) retryLive();
  });
}

function retryLive() {
  liveState = "reconnecting";
  paintStatus();
  const wait = Math.min(30_000, 1000 * 2 ** retries++);
  retryTimer = setTimeout(() => { retryTimer = null; connectLive(); }, wait);
}

function disconnectLive() {
  wantLive = false;
  clearTimeout(retryTimer);
  retryTimer = null;
  clearInterval(pingTimer);
  liveState = "off";
  const ws = socket;
  socket = null;
  ws?.close();
}

/* ---- the address bar ---- */

export function propsQuery() {
  const params = new URLSearchParams();
  if (view !== "overview") params.set("view", view);
  const target = open ?? pendingOpen;
  if (target?.kind === "prop") params.set("property", target.key);
  if (target?.kind === "repo") params.set("repo", target.key);
  const s = params.toString();
  return s ? `?${s}` : "";
}

export function readPropsQuery(q) {
  const params = new URLSearchParams(q);
  view = VIEWS.some(([k]) => k === params.get("view")) ? params.get("view") : "overview";
  pendingOpen = params.has("property") ? { kind: "prop", key: params.get("property") } : params.has("repo") ? { kind: "repo", key: params.get("repo") } : null;
  open = null;
  resolvePending();
}

function resolvePending() {
  if (!pendingOpen || !data) return;
  if (pendingOpen.kind === "prop" && defFor(pendingOpen.key)) { open = pendingOpen; draftFrom(open.key); }
  if (pendingOpen.kind === "repo" && st.repos.has(pendingOpen.key)) open = pendingOpen;
  pendingOpen = null;
}

function syncAddress() {
  const url = location.pathname + propsQuery();
  if (location.pathname + location.search !== url) history.replaceState(null, "", url);
}

/* ---- actions ---- */

function draftFrom(name) {
  const d = defFor(name);
  draft = d ? structuredClone(d) : null;
  draftBase = d ? structuredClone(d) : null;
  draftErrors = [];
}

function openPanel(kind, key) {
  open = { kind, key };
  panelNote = "";
  if (kind === "prop") draftFrom(key);
  if (kind === "new") { draft = normDef({ name: "", type: "single_select", allowed: [] }); draftBase = null; draftErrors = []; }
  syncAddress();
  paintPanel();
  document.querySelector("[data-cp-panel] h2")?.focus();
}

function closePanel() {
  open = null;
  draft = null;
  draftBase = null;
  panelNote = "";
  syncAddress();
  paintPanel();
  if (held) redraw();
}

function stageDef() {
  if (!draft) return;
  const isNew = open?.kind === "new";
  const d = normDef({ ...draft, name: isNew ? (draft.name ?? "").trim() : open.key });
  draftErrors = defErrors(d);
  if (isNew && (st.defs.has(d.name) || stagedFor(`def:${d.name}`))) draftErrors.push(`${d.name} already exists or has a staged change`);
  if (draftErrors.length) return paintPanel();
  if (isNew) {
    stage({ kind: "create", def: d });
    open = { kind: "prop", key: d.name };
    draftFrom(d.name);
    panelNote = "Staged. Values can be set on it now and go in the same batch.";
  } else {
    const cur = st.defs.get(open.key);
    if (cur) stage({ kind: "update", name: open.key, from: cur, to: d });
    else stage({ kind: "create", def: d });
    panelNote = defDiff(cur ?? d, d).length || !cur ? "Staged." : "Nothing differs from GitHub, so nothing is staged.";
  }
  syncAddress();
  redraw();
}

function stageRename() {
  const name = open.key;
  const to = (document.querySelector("[data-cp-rename]")?.value ?? "").trim();
  if (!NAME.test(to)) return (panelNote = "Names are up to 75 letters, digits, _, -, $ or #", paintPanel());
  if (st.defs.has(to) || columns().some((d) => d.name === to)) return (panelNote = `${to} already exists`, paintPanel());
  if (stagedFor(`def:${name}`) || pendingDef(name)) return (panelNote = `${name} already has a staged change; apply or remove it first`, paintPanel());
  stage({ kind: "rename", name, to, from: st.defs.get(name) });
  panelNote = `Rename to ${to} staged.`;
  redraw();
}

function stageRevalue() {
  const name = open.key;
  const sources = [...document.querySelectorAll("[data-cp-src]:checked")].map((x) => x.value);
  const target = (document.querySelector("[data-cp-target]")?.value ?? "").trim();
  if (!sources.length || !target) return (panelNote = "Tick the values to move and type the value they become", paintPanel());
  if (sources.includes(target)) return (panelNote = "The value they become has to be different", paintPanel());
  if (stagedFor(`def:${name}`)) return (panelNote = `${name} has a staged definition edit; apply or remove it first`, paintPanel());
  stage({ kind: "revalue", name, sources, target, from: st.defs.get(name) });
  panelNote = `${sources.join(", ")} → ${target} staged.`;
  redraw();
}

function stageDelete() {
  const name = open.key;
  if (stagedFor(`def:${name}`) || pendingDef(name)) return (panelNote = `${name} already has a staged change; apply or remove it first`, paintPanel());
  const valueOps = stagedList().filter((c) => c.kind === "value" && c.prop === name);
  for (const c of valueOps) unstage(keyOf(c));
  stage({ kind: "delete", name, from: st.defs.get(name) });
  panelNote = `Delete staged${valueOps.length ? `, and ${plural(valueOps.length, "staged value")} on it dropped` : ""}.`;
  redraw();
}

function stageCell(td, raw) {
  const repo = td.dataset.repo;
  const prop = td.dataset.prop;
  const def = defFor(prop);
  if (!def) return;
  const to = normValue(raw);
  const err = valueError(def, to);
  if (err) { say(err); return repaintCell(td); }
  stage({ kind: "value", repo, prop, from: normValue(now(repo, prop)), to });
}

function repaintCell(td) {
  const def = defFor(td.dataset.prop);
  if (def) td.outerHTML = cellHtml(td.dataset.repo, def);
  if (held) redraw();
}

function openCell(td) {
  const def = defFor(td.dataset.prop);
  if (!def) return;
  const repo = td.dataset.repo;
  if (def.type === "multi_select") return multiDialog(repo, def);
  const cur = normValue(shown(repo, def.name));
  let input;
  if (def.type === "string" || def.type === "url") {
    input = `<input class="perm-input cp-in" data-cp-input value="${esc(cur ?? "")}" spellcheck="false" aria-label="${esc(def.name)}">`;
  } else {
    const opts = [...new Set([...(def.type === "true_false" ? ["true", "false"] : def.allowed ?? []), ...(cur != null ? [cur] : [])])];
    input = `<select class="perm-sel cp-in" data-cp-input aria-label="${esc(def.name)}">${def.required ? "" : `<option value="">— none</option>`}${opts.map((o) =>
      `<option value="${esc(o)}"${o === cur ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
  }
  td.innerHTML = `<form data-cp-cellform>${input}</form>`;
  const el = td.querySelector("[data-cp-input]");
  el?.focus();
  if (el?.select) el.select();
}

function ask(html, onClose) {
  const d = document.createElement("dialog");
  d.className = "daily-dialog cp-dialog";
  d.innerHTML = html;
  d.addEventListener("click", (e) => { const v = e.target.closest("[data-dlg]")?.dataset.dlg; if (v) d.close(v); });
  d.addEventListener("close", () => { const v = d.returnValue; onClose(v, d); d.remove(); });
  document.body.appendChild(d);
  d.showModal();
}

function multiDialog(repo, def) {
  const cur = listOf(shown(repo, def.name));
  ask(`<h3>${esc(def.name)} on ${esc(repo)}</h3>
    <span class="pf-chips">${[...new Set([...(def.allowed ?? []), ...cur])].map((v) => `<label class="pf-chip"><input type="checkbox" value="${esc(v)}"${cur.includes(v) ? " checked" : ""}><span>${esc(v)}</span></label>`).join("")}</span>
    <div class="daily-actions"><button type="button" class="ghost" data-dlg="cancel">Cancel</button><button type="button" class="daily-go" data-dlg="ok" autofocus>Stage</button></div>`,
  (v, d) => {
    if (v !== "ok") return;
    const picked = [...d.querySelectorAll("input:checked")].map((x) => x.value);
    const to = normValue(def.allowed ? picked.sort((a, b) => def.allowed.indexOf(a) - def.allowed.indexOf(b)) : picked);
    const err = valueError(def, to);
    if (err) return say(err);
    stage({ kind: "value", repo, prop: def.name, from: normValue(now(repo, def.name)), to });
  });
}

function exportCsv() {
  const list = shownRepos(gridFilter).filter((r) => !search || r.name.toLowerCase().includes(search.toLowerCase()));
  const text = toCsv([...st.defs.values()], list);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  a.download = `custom-properties-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

async function importFile(file) {
  if (!file || !st) return;
  if (file.size > 2_000_000) return say("That file is over 2 MB, which is more than a CSV of this org's repos can be.");
  const text = await file.text();
  const { changes, problems, columns: cols } = importCsv(text, st);
  const locked = changes.filter((c) => lockedProp(c.prop));
  const usable = changes.filter((c) => !lockedProp(c.prop));
  const all = [...problems, ...locked.map((c) => `${c.repo}: ${c.prop} has a staged rename or delete, so it was skipped`)];
  ask(`<h3>Import ${esc(file.name)}</h3>
    <p>${cols.length ? `Read ${plural(cols.length, "column")}: ${esc(cols.join(", "))}.` : "No property columns were found."} Compared with GitHub, <strong>${plural(usable.length, "value")}</strong> ${usable.length === 1 ? "differs" : "differ"}${usable.length ? ` across ${plural(new Set(usable.map((c) => c.repo)).size, "repo")}` : ""}. An empty cell clears the value; columns and repos left out of the file aren't touched.</p>
    ${all.length ? `<p class="daily-warn">${plural(all.length, "thing", "things")} couldn't be used:</p><ul class="cp-warn cp-scrollist">${all.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
    <div class="daily-actions"><button type="button" class="ghost" data-dlg="cancel">Cancel</button><button type="button" class="daily-go" data-dlg="ok" autofocus${usable.length ? "" : " disabled"}>Stage ${plural(usable.length, "change")}</button></div>`,
  (v) => {
    if (v !== "ok") return;
    stageMany(usable);
    say(`Staged ${plural(usable.length, "change")} from ${file.name}.`);
  });
}

function setView(v) {
  view = v;
  syncAddress();
  paintBar();
  paintBody();
}

function tickNames(names) {
  ticked = new Set(names.filter((n) => st.repos.has(n)));
  closePanel();
  setView("grid");
  say(`${plural(ticked.size, "repo")} ticked. Use Bulk edit to change them together.`);
}

function onClick(e) {
  const root = e.target.closest?.("[data-cp]");
  if (!root) return;
  if (trayClick(e)) return;
  const t = e.target;
  const opt = t.closest("[data-cp-open]");
  if (opt) {
    const [kind, ...rest] = opt.dataset.cpOpen.split(":");
    return openPanel(kind, rest.join(":"));
  }
  if (t.closest("[data-cp-close]") || t.matches("[data-cp-backdrop]")) return closePanel();
  const v = t.closest("[data-cp-view]");
  if (v) { if (open) closePanel(); return setView(v.dataset.cpView); }
  const un = t.closest("[data-cp-unstage]");
  if (un) { unstage(un.dataset.cpUnstage); if (open?.kind === "prop") draftFrom(open.key); return; }
  const edit = t.closest("[data-cp-edit]");
  if (edit && !edit.disabled) return openCell(edit.closest("td"));
  const x = t.closest("[data-cp-xcell]");
  if (x) { const [i, j] = x.dataset.cpXcell.split(":").map(Number); cross.pick = cross.pick?.[0] === i && cross.pick?.[1] === j ? null : [i, j]; return paintBody(); }
  const these = t.closest("[data-cp-tickthese]");
  if (these) return tickNames(JSON.parse(these.dataset.cpTickthese));
  if (t.closest("[data-cp-tick]")) return tickNames(gaps(st, repos()).untagged);
  if (t.closest("[data-cp-tickshown]")) {
    const list = view === "compare" ? shownRepos(cmpFilter) : shownRepos(gridFilter).filter((r) => !search || r.name.toLowerCase().includes(search.toLowerCase()));
    for (const r of list) ticked.add(r.name);
    return paintBody();
  }
  if (t.closest("[data-cp-tickclear]")) { ticked.clear(); return paintBody(); }
  const op = t.closest("[data-cp-bulkop]");
  if (op) { bulk.op = op.dataset.cpBulkop; bulk.value = null; return paintPanel(); }
  const move = t.closest("[data-cp-move]");
  if (move && draft?.allowed) {
    const [i, dir] = move.dataset.cpMove.split(":").map(Number);
    const j = i + dir;
    if (j >= 0 && j < draft.allowed.length) [draft.allowed[i], draft.allowed[j]] = [draft.allowed[j], draft.allowed[i]];
    return paintPanel();
  }
  const drop = t.closest("[data-cp-drop]");
  if (drop && draft?.allowed) {
    const [gone] = draft.allowed.splice(Number(drop.dataset.cpDrop), 1);
    if (listOf(draft.default).includes(gone)) draft.default = normValue(listOf(draft.default).filter((x) => x !== gone));
    return paintPanel();
  }
  if (t.closest("[data-cp-addval]")) return addValue();
  const act = t.closest("[data-cp-act]")?.dataset.cpAct;
  if (!act) return;
  if (act === "refresh") return load();
  if (act === "new") return openPanel("new", "");
  if (act === "bulk") { bulk.value = null; return openPanel("bulk", ""); }
  if (act === "export") return exportCsv();
  if (act === "stagedef") return stageDef();
  if (act === "resetdef") { draftFrom(open.key); return paintPanel(); }
  if (act === "rename") return stageRename();
  if (act === "revalue") return stageRevalue();
  if (act === "delete") return stageDelete();
  if (act === "stagebulk") {
    const { changes } = bulkChanges();
    stageMany(changes);
    say(`Staged ${plural(changes.length, "change")}.`);
    return closePanel();
  }
}

function addValue() {
  const input = document.querySelector("[data-cp-newval]");
  const v = (input?.value ?? "").trim();
  if (!v || !draft) return;
  draft.allowed = draft.allowed ?? [];
  if (!draft.allowed.includes(v)) draft.allowed.push(v);
  paintPanel();
  document.querySelector("[data-cp-newval]")?.focus();
}

function readDraft(el) {
  const field = el.dataset.cpD;
  if (field === "required" || field === "explicit") draft[field] = el.checked;
  else if (field === "default") {
    draft.default = draft.type === "multi_select"
      ? normValue([...document.querySelectorAll('[data-cp-d="default"]:checked')].map((x) => x.value))
      : normValue(el.value);
  } else if (field === "type") {
    draft.type = el.value;
    draft.allowed = draft.type === "single_select" || draft.type === "multi_select" ? draft.allowed ?? [] : null;
    draft.default = null;
    return true;
  } else draft[field] = field === "description" ? el.value || null : el.value;
  return false;
}

function onChange(e) {
  const t = e.target;
  if (!t.closest?.("[data-cp]")) return;
  if (t.matches("[data-cp-import]")) { importFile(t.files?.[0]); t.value = ""; return; }
  if (t.matches("[data-cp-input]") && t.tagName === "SELECT") return stageCell(t.closest("td"), t.value);
  if (t.matches("[data-cp-d]")) { if (readDraft(t) || t.dataset.cpD === "required") paintPanel(); return; }
  if (t.matches("[data-cp-tickall]")) {
    const list = shownRepos(gridFilter).filter((r) => !search || r.name.toLowerCase().includes(search.toLowerCase()));
    for (const r of list) t.checked ? ticked.add(r.name) : ticked.delete(r.name);
    return paintBody();
  }
  if (t.matches("[data-cp-tickone]")) { t.checked ? ticked.add(t.dataset.cpTickone) : ticked.delete(t.dataset.cpTickone); return paintBody(); }
  if (t.matches("[data-cp-cross]")) { cross[t.dataset.cpCross] = t.value; cross.pick = null; return paintBody(); }
  if (t.matches("[data-cp-hist]")) { hist[t.dataset.cpHist] = t.value; return paintBody(); }
  if (t.matches("[data-cp-pfilter]")) { open.filter = t.value; return paintPanel(); }
  if (t.matches("[data-cp-bulk]")) {
    if (t.dataset.cpBulk === "prop") { bulk.prop = t.value; bulk.value = null; }
    else if (t.type === "checkbox") bulk.value = normValue([...document.querySelectorAll('[data-cp-bulk="value"]:checked')].map((x) => x.value));
    else bulk.value = normValue(t.value);
    return paintPanel();
  }
}

function onInput(e) {
  const t = e.target;
  if (!t.closest?.("[data-cp]")) return;
  if (t.matches("[data-cp-search]")) { search = t.value; return paintBody(); }
  if (t.matches("[data-cp-d]") && t.type !== "checkbox" && t.tagName !== "SELECT") readDraft(t);
  if (t.matches('[data-cp-bulk="value"]') && t.tagName === "INPUT" && t.type !== "checkbox") bulk.value = normValue(t.value);
}

function onKey(e) {
  const t = e.target;
  if (!t.closest?.("[data-cp]")) return;
  if (t.matches("[data-cp-input]")) {
    if (e.key === "Escape") { e.preventDefault(); return repaintCell(t.closest("td")); }
    if (e.key === "Enter" && t.tagName === "INPUT") { e.preventDefault(); return stageCell(t.closest("td"), t.value); }
  }
  if (t.matches("[data-cp-newval]") && e.key === "Enter") { e.preventDefault(); return addValue(); }
  if (t.matches("[data-cp-d]") && e.key === "Enter") e.preventDefault();
  if (t.matches('[data-cp-bulk="value"]') && e.key === "Enter") { e.preventDefault(); paintPanel(); }
  if (e.key === "Escape" && open && !document.querySelector("dialog[open]") && !t.matches("[data-cp-input]")) closePanel();
}

function onFocusOut(e) {
  const t = e.target;
  if (!t.matches?.("[data-cp-input]")) return;
  setTimeout(() => {
    const td = t.closest("td");
    if (!td?.isConnected || td.contains(document.activeElement)) return;
    if (t.tagName === "INPUT" && !sameValue(normValue(t.value), shown(td.dataset.repo, td.dataset.prop))) return stageCell(td, t.value);
    repaintCell(td);
  }, 120);
  if (held) setTimeout(() => { if (!editing()) redraw(); }, 200);
}

function wire() {
  if (wired) return;
  wired = true;
  document.addEventListener("click", onClick);
  document.addEventListener("change", onChange);
  document.addEventListener("input", onInput);
  document.addEventListener("keydown", onKey);
  document.addEventListener("focusout", onFocusOut);
  document.addEventListener("submit", (e) => { if (e.target.closest?.("[data-cp]")) e.preventDefault(); });
  document.addEventListener("visibilitychange", () => {
    if (timer && document.visibilityState === "visible" && Date.now() - fetchedAt > STALE_MS) load();
  });
}

configureApply({
  data: () => data,
  state: () => st,
  redraw: () => redraw(),
  reload: () => {
    load();
    if (sharedRepoList()) loadRepoList();
  },
});

export function syncProperties(on) {
  if (!on) {
    document.documentElement.classList.remove("perm-modal-open");
    clearInterval(timer);
    timer = null;
    if (wantLive) disconnectLive();
    return;
  }
  wire();
  if (!data || Date.now() - fetchedAt > STALE_MS) load();
  if (!timer) timer = setInterval(() => { if (document.visibilityState !== "hidden" && Date.now() - fetchedAt > STALE_MS) load(); }, 60_000);
  if (!wantLive) { wantLive = true; connectLive(); }
  document.documentElement.classList.toggle("perm-modal-open", Boolean(open));
}

