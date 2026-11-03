import { API } from "./live.js";
import { esc, safeUrl } from "./format.js";
import { panelRows } from "./dream.js";
import { BUMPS, DATED_REPOS, planTag, tagProblem } from "./release-tags.js";

const FILTER_KEY = "nh:rel-filter";
const LIST_STALE_MS = 5 * 60_000;
const PREVIEW_CHUNK = 50;
const DELETE_CHUNK = 20;
const RUN_BATCH = 10;
const BUILD_WARN = 20;
const ORG = "GTNewHorizons";

const BUMP_LABEL = { predicted: "Predicted", patch: "Patch", minor: "Minor", major: "Major", super: "Super" };
const CMP_LABEL = { any: "is any of", none: "is none of", set: "is set", unset: "is not set" };
const POSITION = ["last number", "second-to-last number", "third-to-last number"];

let list = null;
let listError = null;
let listing = null;
let listedAt = 0;
let wired = false;
let ticked = new Set();
let search = "";
let mode = "release";
let pending = null;
let busy = null;
let progress = "";
let note = "";
let nodeId = 0;

const all = { bump: "predicted", pattern: "", pre: false, notLatest: false, branch: "" };
let rows = [];
let previewMeta = null;
let releaseResults = null;

const del = { by: "pattern", pattern: "", release: true, tag: true };
let found = null;
let deleteResults = null;

const newId = () => `n${++nodeId}`;
const blankFilter = () => ({ id: newId(), op: "and", items: [] });

function loadFilter() {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_KEY) ?? "null");
    if (saved?.items) return reId(saved);
  } catch {}
  return blankFilter();
}

function reId(node) {
  if (node.items) return { id: newId(), op: node.op === "or" ? "or" : "and", items: node.items.map(reId) };
  return { id: newId(), prop: node.prop ?? "", cmp: CMP_LABEL[node.cmp] ? node.cmp : "any", values: Array.isArray(node.values) ? node.values : [] };
}

let filter = loadFilter();

function saveFilter() {
  try { localStorage.setItem(FILTER_KEY, JSON.stringify(filter)); } catch {}
}

function findNode(id, node = filter, parent = null) {
  if (node.id === id) return { node, parent };
  for (const child of node.items ?? []) {
    const hit = findNode(id, child, node);
    if (hit) return hit;
  }
  return null;
}

const valuesOf = (v) => (v == null || v === "" ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);

function passes(repo, node = filter) {
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

function isLive(node) {
  if (node.items) return node.items.some(isLive);
  if (!node.prop) return false;
  return node.cmp === "set" || node.cmp === "unset" || node.values.length > 0;
}

const schemaOf = (name) => list?.schema?.find((p) => p.name === name) ?? null;
const shownRepos = () => (list?.repos ?? []).filter((r) => passes(r));
const visibleRepos = () => shownRepos().filter((r) => !search || r.name.toLowerCase().includes(search.toLowerCase()));
const tickedRepos = () => (list?.repos ?? []).filter((r) => ticked.has(r.name)).map((r) => r.name);

function needsRelease() {
  try {
    return panelRows("needsRelease").map((r) => r.repo);
  } catch {
    return [];
  }
}

async function call(path, payload) {
  const res = await fetch(`${API}${path}`, payload === undefined
    ? { cache: "no-store" }
    : { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
}

function ago(iso) {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(mins)) return "";
  if (mins < 1) return "just now";
  if (mins < 90) return `${mins} min ago`;
  return `${Math.round(mins / 60)} hr ago`;
}

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const repoUrl = (name) => `https://github.com/${ORG}/${encodeURIComponent(name)}`;

/* ---- the repo picker ---- */

function condHtml(node) {
  const props = list?.schema ?? [];
  const p = schemaOf(node.prop);
  const opts = [`<option value="">property…</option>`, ...props.map((s) =>
    `<option value="${esc(s.name)}"${s.name === node.prop ? " selected" : ""}>${esc(s.name)}</option>`)].join("");
  const cmps = Object.entries(CMP_LABEL).map(([k, v]) => `<option value="${k}"${k === node.cmp ? " selected" : ""}>${v}</option>`).join("");
  let values = "";
  if (node.prop && (node.cmp === "any" || node.cmp === "none")) {
    const allowed = p?.allowed ?? (p?.type === "true_false" ? ["true", "false"] : null);
    if (allowed?.length) {
      values = `<span class="rl-chips">${allowed.map((v) => `<label class="rl-chip"><input type="checkbox" data-f-val value="${esc(v)}"${node.values.includes(v) ? " checked" : ""}><span>${esc(v)}</span></label>`).join("")}</span>`;
    } else {
      values = `<input type="text" class="rl-input" data-f-text value="${esc(node.values.join(", "))}" placeholder="value, value" spellcheck="false" aria-label="Values">`;
    }
  }
  return `<div class="rl-cond" data-node="${node.id}">
    <select data-f-prop aria-label="Property">${opts}</select>
    <select data-f-cmp aria-label="Comparison">${cmps}</select>
    ${values}
    <button type="button" class="rl-x" data-f-remove title="Remove this condition" aria-label="Remove this condition">×</button>
  </div>`;
}

function groupHtml(node, depth = 0) {
  const op = `<span class="seg mini rl-op">${["and", "or"].map((o) =>
    `<button type="button" data-f-op="${o}" aria-pressed="${node.op === o}">${o.toUpperCase()}</button>`).join("")}</span>`;
  const kids = node.items.map((n) => (n.items ? groupHtml(n, depth + 1) : condHtml(n))).join("");
  return `<div class="rl-group${depth ? " nested" : ""}" data-node="${node.id}">
    <div class="rl-ghead">
      ${node.items.length > 1 ? op : ""}
      <button type="button" class="ghost mini" data-f-add="cond">+ condition</button>
      ${depth < 2 ? `<button type="button" class="ghost mini" data-f-add="group">+ group</button>` : ""}
      ${depth ? `<button type="button" class="rl-x" data-f-remove title="Remove this group" aria-label="Remove this group">×</button>` : ""}
    </div>
    ${kids ? `<div class="rl-gitems">${kids}</div>` : ""}
  </div>`;
}

function filterHtml() {
  if (!list) return "";
  if (list.propertiesError) return `<p class="daily-warn rl-gap">${esc(list.propertiesError)}</p>`;
  if (!list.schema.length) return `<p class="sub rl-gap">The org has no custom properties to filter by.</p>`;
  return `<div class="rl-filter"><span class="sub">Filter by custom property</span>${groupHtml(filter)}</div>`;
}

function countHtml() {
  const shown = new Set(shownRepos().map((r) => r.name));
  const hidden = tickedRepos().filter((n) => !shown.has(n)).length;
  return `<div class="rl-count sub" data-rl-count>${plural(ticked.size, "repo")} ticked · ${visibleRepos().length.toLocaleString()} of ${list.repos.length.toLocaleString()} shown${
    hidden ? ` · ${hidden} ticked ${hidden === 1 ? "repo isn't" : "repos aren't"} shown by the filter` : ""}</div>`;
}

function repoListHtml() {
  if (!list) return "";
  const shown = visibleRepos();
  const items = shown.map((r) => {
    const props = Object.entries(r.properties ?? {}).filter(([, v]) => valuesOf(v).length).map(([k, v]) => `${k}: ${valuesOf(v).join(", ")}`).join("\n");
    return `<label class="rl-repo" title="${esc(props || "No custom properties set")}"><input type="checkbox" data-r-tick value="${esc(r.name)}"${ticked.has(r.name) ? " checked" : ""}><span>${esc(r.name)}</span></label>`;
  }).join("");
  return `${countHtml()}
    <div class="rl-repos">${items || `<div class="empty">No repo matches.</div>`}</div>`;
}

function pickerCard() {
  const status = list ? `${plural(list.repos.length, "repo")}${list.archived ? `, ${list.archived} archived left out` : ""} · read ${esc(ago(list.readAt))}` : "";
  let body;
  if (listError && !list) body = `<div class="error">${esc(listError)}</div>`;
  else if (!list) body = `<div class="empty">Reading the org's repos and custom properties from GitHub…</div>`;
  else {
    const needs = needsRelease().filter((n) => list.repos.some((r) => r.name === n));
    body = `<div class="rl-pickbar">
        <input type="search" class="rl-input rl-search" data-r-search value="${esc(search)}" placeholder="Search repos" aria-label="Search repos" spellcheck="false" autocomplete="off">
        <button type="button" class="ghost" data-r-preset="needs"${needs.length ? "" : " disabled"} title="Tick every repo on the Dream Panel's Needs a release card">Needs a release (${needs.length})</button>
        <button type="button" class="ghost" data-r-preset="shown">Tick all shown</button>
        <button type="button" class="ghost" data-r-preset="none">Untick all</button>
      </div>
      <div data-rl-filter>${filterHtml()}</div>
      <div data-rl-list>${repoListHtml()}</div>`;
  }
  return `<section class="card rl-card" style="--span:12">
    <header><h2>Repos</h2><span class="sub" data-rl-status>${status}</span>
      <button type="button" class="ghost mini rl-refresh" data-r-refresh${listing ? " disabled" : ""}>${listing ? "Reading…" : "Refresh"}</button></header>
    <div class="body">${body}</div>
  </section>`;
}

/* ---- release mode ---- */

function calc(r) {
  const d = r.data;
  const plan = planTag(d, { bump: r.bump, pattern: r.pattern, pre: r.pre });
  const predicted = planTag(d, { pre: r.pre }).tag || null;
  const tag = r.edit ?? plan.tag;
  const invalid = r.edit != null ? tagProblem(tag, new Set(d.taken ?? [])) : plan.invalid;
  return { plan, tag, invalid, predicted, changed: r.edit != null && Boolean(predicted) && r.edit !== predicted };
}

const usable = (r) => !r.data.problem && r.data.sha && !r.done;

function rowNotes(r, c) {
  const d = r.data;
  const out = [];
  if (d.problem) out.push(`<span class="rl-bad">${esc(d.problem)}</span>`);
  if (d.unchanged) out.push(`No commits since ${esc(d.lastTag)}`);
  for (const n of c.plan.notes) out.push(esc(n));
  if (c.invalid && usable(r)) out.push(`<span class="rl-bad">${esc(c.invalid)}</span>`);
  return out.join("<br>");
}

function releaseRowHtml(r, i) {
  const d = r.data;
  const c = calc(r);
  const ok = usable(r);
  const dated = d.dated || DATED_REPOS.has(d.repo);
  const bumpSel = `<select data-x-bump aria-label="Bump for ${esc(d.repo)}"${ok && !dated ? "" : " disabled"}${dated ? ' title="Tagged by date, so there is no number to bump"' : ""}>${
    BUMPS.map((b) => `<option value="${b}"${b === r.bump ? " selected" : ""}>${BUMP_LABEL[b]}</option>`).join("")}</select>`;
  const learned = d.learned && r.bump === "predicted" && !r.pattern
    ? ` <span class="label ra-learned" title="Learned from an earlier correction: bumps the ${esc(POSITION[d.learned.fromEnd] ?? `number ${d.learned.fromEnd + 1} from the end`)}">learned</span>` : "";
  const done = r.done
    ? `<div class="rl-done">${r.done.ok ? `Released <a href="${safeUrl(r.done.url)}" target="_blank" rel="noopener">${esc(r.done.tag)}</a>` : `<span class="rl-bad">${esc(r.done.error)}</span>`}</div>` : "";
  const target = `<input type="text" class="rl-input rl-branch" data-x-branch value="${esc(d.customBranch ? d.branch : "")}" placeholder="${esc(d.defaultBranch ?? "default")}" spellcheck="false" autocomplete="off" aria-label="Branch for ${esc(d.repo)}"${r.done ? " disabled" : ""}>${
    d.sha ? ` <a class="repo" href="${safeUrl(`${repoUrl(d.repo)}/commit/${d.sha}`)}" target="_blank" rel="noopener">${esc(d.sha.slice(0, 7))}</a>` : ""}`;
  return `<tr data-row="${i}" class="${r.include && ok ? "" : "ra-off"}">
    <td><input type="checkbox" data-x-include aria-label="Release ${esc(d.repo)}"${r.include && ok ? " checked" : ""}${ok ? "" : " disabled"}></td>
    <td><a href="${safeUrl(repoUrl(d.repo))}" target="_blank" rel="noopener">${esc(d.repo)}</a><div class="ra-note" data-x-notes>${rowNotes(r, c)}</div>${done}</td>
    <td class="repo">${d.lastTag ? esc(d.lastTag) : "—"}${d.lastWasPre ? ' <span class="label">pre</span>' : ""}</td>
    <td>${bumpSel}</td>
    <td>
      <input type="text" class="ra-tag${c.invalid && r.include && ok ? " ra-invalid" : ""}" data-x-tag value="${esc(c.tag)}" spellcheck="false" autocomplete="off" aria-label="New tag for ${esc(d.repo)}"${ok ? "" : " disabled"}>${learned}
      <label class="rl-pre"><input type="checkbox" data-x-pre${r.pre ? " checked" : ""}${ok ? "" : " disabled"}> pre</label>
      <label class="rl-pre" title="Don't mark this release as the repo's latest"><input type="checkbox" data-x-notlatest${r.notLatest ? " checked" : ""}${ok ? "" : " disabled"}> not latest</label>
      <label class="ra-wrong"${r.bump === "predicted" && !r.pattern && c.changed ? "" : " hidden"}><input type="checkbox" data-x-wrong${r.wrong ? " checked" : ""}> prediction was wrong</label>
    </td>
    <td class="rl-target">${target}</td>
  </tr>`;
}

function releaseCounts() {
  const picked = rows.filter((r) => r.include && usable(r));
  const bad = picked.filter((r) => calc(r).invalid).length;
  return { picked, bad };
}

function releaseFooter() {
  const { picked, bad } = releaseCounts();
  const text = busy === "releasing" ? esc(progress)
    : bad ? `${bad} ticked ${bad === 1 ? "repo needs" : "repos need"} a valid tag`
    : `${picked.length} of ${rows.length} ticked`;
  const blocked = Boolean(busy) || !previewMeta?.ready || !picked.length || bad > 0;
  return `<span class="ra-count minlabel">${text}</span>
    <button type="button" class="daily-go" data-x-go${blocked ? " disabled" : ""}>${picked.length === 1 ? "Release 1 repo" : `Release ${picked.length} repos`}</button>`;
}

function statsLine(s) {
  if (!s?.total) return "";
  return `<p class="daily-last">Predictions kept as-is on past releases: ${s.matched} of ${s.total}, ${s.wrong} marked wrong.</p>`;
}

function resultsHtml(res, kind) {
  if (!res) return "";
  const failed = res.results.filter((r) => !r.ok);
  const made = res.results.length - failed.length;
  const head = res.dryRun
    ? `Dry run: ${plural(made, kind === "release" ? "release" : "deletion")} checked, nothing was sent to GitHub from localhost`
    : kind === "release"
      ? `Released ${plural(made, "repo")}${failed.length ? `, ${failed.length} failed` : ""}. Workflow builds follow over the next few minutes`
      : `Deleted ${plural(res.results.filter((r) => r.release).length, "release")} and ${plural(res.results.filter((r) => r.tagDeleted).length, "tag")}${failed.length ? `, ${failed.length} failed` : ""}`;
  const stopped = res.stopped ? `<p class="daily-warn">${esc(res.stopped)}</p>` : "";
  return `<div class="rl-results">
    <p><b>${esc(head)}</b></p>${stopped}
    ${failed.length ? `<ul class="ra-results">${failed.map((r) => `<li><b>${esc(r.repo)}</b> ${esc(r.tag)}: ${esc(r.error ?? "failed")}</li>`).join("")}</ul>` : ""}
  </div>`;
}

function releaseWork() {
  const bumpOpts = BUMPS.map((b) => `<option value="${b}"${b === all.bump ? " selected" : ""}>${BUMP_LABEL[b]}</option>`).join("");
  const n = ticked.size;
  const controls = `<div class="rl-controls">
    <label class="rl-field"><span class="sub">Bump</span><select data-a-bump>${bumpOpts}</select></label>
    <label class="rl-field grow"><span class="sub">Tag pattern</span><input type="text" class="rl-input" data-a-pattern value="${esc(all.pattern)}" placeholder="blank = the bump, or e.g. {next} or 2.8.0-freeze" spellcheck="false" autocomplete="off"></label>
    <label class="rl-field"><span class="sub">Branch</span><input type="text" class="rl-input" data-a-branch value="${esc(all.branch)}" placeholder="default branch" spellcheck="false" autocomplete="off"></label>
    <label class="rl-check"><input type="checkbox" data-a-pre${all.pre ? " checked" : ""}> Pre-release (adds -pre)</label>
    <label class="rl-check" title="Make the releases without marking them as each repo's latest"><input type="checkbox" data-a-notlatest${all.notLatest ? " checked" : ""}> Not latest</label>
    <button type="button" class="ghost" data-a-preview${busy || !n ? " disabled" : ""}>${busy === "previewing" ? esc(progress) : rows.length ? `Preview ${plural(n, "repo")} again` : `Preview ${plural(n, "repo")}`}</button>
  </div>
  <p class="hint rl-gap">Patch, Minor, Major and Super bump the last, second-to-last, third-to-last and fourth-to-last number of the version.
    A pattern can use <code>{next}</code> (the bump), <code>{last}</code>, <code>{date}</code> and <code>{repo}</code>. Changing these resets every row; a row can then be changed on its own.
    Pre-release adds <code>-pre</code> to the tag, which the release workflow treats as a pre-release.
    Not latest makes the release without marking it as the repo's latest, which only holds on repos whose release workflow keeps it.</p>`;

  if (!rows.length) return `${controls}${note ? `<p class="daily-warn">${esc(note)}</p>` : ""}`;

  const warns = [];
  if (!previewMeta?.ready) warns.push(`<p class="daily-warn">Org-Manager isn't set up on this Worker yet, so nothing can be released.</p>`);
  if (previewMeta?.storeError) warns.push(`<p class="daily-warn">${esc(previewMeta.storeError)}</p>`);
  if (note) warns.push(`<p class="daily-warn">${esc(note)}</p>`);
  return `${controls}${warns.join("")}${statsLine(previewMeta?.stats)}
    <p class="daily-last">If a predicted tag is wrong, type the right one and tick <b>prediction was wrong</b> so it's learned. Leave it unticked for an intentional bump.</p>
    <div class="ra-scroll rl-scroll">
      <table class="ra-table rl-table">
        <thead><tr><th><input type="checkbox" data-x-all aria-label="Tick every repo"></th><th>Repo</th><th>Last tag</th><th>Bump</th><th>New tag</th><th>Target</th></tr></thead>
        <tbody>${rows.map(releaseRowHtml).join("")}</tbody>
      </table>
    </div>
    <div class="daily-actions" data-x-foot>${releaseFooter()}</div>
    ${resultsHtml(releaseResults, "release")}`;
}

/* ---- delete mode ---- */

function willDelete(m) {
  const release = del.release && Boolean(m.release || m.maybeRelease);
  const tag = del.tag && m.tagged;
  return { release, tag };
}

function deleteItems() {
  const out = [];
  for (const repo of found ?? []) {
    for (const m of repo.matches) {
      if (!m.include || m.done) continue;
      const w = willDelete(m);
      if (w.release || w.tag) out.push({ repo: repo.repo, m, ...w });
    }
  }
  return out;
}

function matchRowHtml(repo, m, ri, mi) {
  const w = willDelete(m);
  const nothing = !w.release && !w.tag;
  const pills = [];
  if (m.release) pills.push(`<span class="pill${m.release.draft ? " draft" : ""}">${m.release.draft ? "draft release" : m.release.pre ? "pre-release" : "release"}</span>`);
  else if (m.maybeRelease) pills.push(`<span class="pill unknown" title="This repo has more than 100 releases, so the release is looked up when deleting">release?</span>`);
  if (m.tagged) pills.push(`<span class="pill">tag</span>`);
  const what = m.done
    ? (m.done.ok ? `Deleted ${[m.done.release && "release", m.done.tagDeleted && "tag"].filter(Boolean).join(" and ") || "nothing (already gone)"}` : `<span class="rl-bad">${esc(m.done.error)}</span>`)
    : nothing ? "Nothing, with these options" : `Deletes the ${[w.release && "release", w.tag && "tag"].filter(Boolean).join(" and ")}`;
  const off = !m.include || nothing || m.done;
  return `<tr data-m="${ri}:${mi}" class="${off ? "ra-off" : ""}">
    <td><input type="checkbox" data-m-include aria-label="Delete ${esc(m.tag)} in ${esc(repo.repo)}"${m.include && !m.done ? " checked" : ""}${m.done ? " disabled" : ""}></td>
    <td><a href="${safeUrl(repoUrl(repo.repo))}" target="_blank" rel="noopener">${esc(repo.repo)}</a></td>
    <td class="repo"><a href="${safeUrl(`${repoUrl(repo.repo)}/releases/tag/${encodeURIComponent(m.tag)}`)}" target="_blank" rel="noopener">${esc(m.tag)}</a></td>
    <td>${pills.join(" ")}</td>
    <td class="sub">${m.date ? esc(m.date.slice(0, 10)) : "—"}</td>
    <td class="sub">${what}</td>
  </tr>`;
}

function deleteFooter() {
  const items = deleteItems();
  const releases = items.filter((i) => i.release).length;
  const tags = items.filter((i) => i.tag).length;
  const text = busy === "deleting" ? esc(progress) : items.length ? `${plural(releases, "release")} and ${plural(tags, "tag")} to delete` : "Nothing ticked to delete";
  const blocked = Boolean(busy) || !found?.ready || !items.length;
  return `<span class="ra-count minlabel">${text}</span>
    <button type="button" class="daily-go rl-danger" data-d-go${blocked ? " disabled" : ""}>Delete ${plural(items.length, "match", "matches")}</button>`;
}

function deleteWork() {
  const n = ticked.size;
  const controls = `<div class="rl-controls">
    <label class="rl-check"><input type="radio" name="rl-by" data-d-by value="pattern"${del.by === "pattern" ? " checked" : ""}> Tags matching</label>
    <input type="text" class="rl-input grow" data-d-pattern value="${esc(del.pattern)}" placeholder="e.g. 2.8.0-pre* or *-freeze" spellcheck="false" autocomplete="off" aria-label="Tag pattern"${del.by === "pattern" ? "" : " disabled"}>
    <label class="rl-check"><input type="radio" name="rl-by" data-d-by value="latest"${del.by === "latest" ? " checked" : ""}> Each repo's latest release</label>
  </div>
  <div class="rl-controls">
    <label class="rl-check"><input type="checkbox" data-d-release${del.release ? " checked" : ""}> Delete the release</label>
    <label class="rl-check"><input type="checkbox" data-d-tag${del.tag ? " checked" : ""}> Also delete the tag</label>
    <button type="button" class="ghost" data-d-find${busy || !n || (del.by === "pattern" && !del.pattern.replace(/[*?\s]/g, "")) ? " disabled" : ""}>${busy === "finding" ? esc(progress) : `Find matches in ${plural(n, "repo")}`}</button>
  </div>
  <p class="hint rl-gap"><code>*</code> matches anything and <code>?</code> one character. Deleting a release deletes its jars with it, and nothing deleted can be recovered.
    Deleting only the tag of a published release leaves that release without a tag, and GitHub turns it back into a draft.</p>`;

  if (!found) return `${controls}${note ? `<p class="daily-warn">${esc(note)}</p>` : ""}`;

  const matched = found.filter((r) => r.matches.length);
  const empty = found.filter((r) => !r.matches.length && !r.problem);
  const problems = found.filter((r) => r.problem);
  const notes = found.flatMap((r) => (r.notes ?? []).filter((x) => x !== "No releases").map((x) => `${r.repo}: ${x}`));
  const extra = [];
  if (!found.ready) extra.push(`<p class="daily-warn">Org-Manager isn't set up on this Worker yet, so nothing can be deleted.</p>`);
  if (note) extra.push(`<p class="daily-warn">${esc(note)}</p>`);
  if (problems.length) extra.push(`<p class="daily-warn">${problems.map((r) => `<b>${esc(r.repo)}</b>: ${esc(r.problem)}`).join("<br>")}</p>`);
  if (notes.length) extra.push(`<p class="daily-last">${notes.map(esc).join("<br>")}</p>`);
  if (empty.length) extra.push(`<details class="rl-none"><summary class="sub">No match in ${plural(empty.length, "repo")}</summary><p class="sub">${empty.map((r) => esc(r.repo)).join(", ")}</p></details>`);

  const body = matched.length
    ? `<div class="ra-scroll rl-scroll">
        <table class="ra-table rl-table">
          <thead><tr><th><input type="checkbox" data-m-all aria-label="Tick every match"></th><th>Repo</th><th>Tag</th><th>Has</th><th>Date</th><th>What happens</th></tr></thead>
          <tbody>${found.map((repo, ri) => repo.matches.map((m, mi) => matchRowHtml(repo, m, ri, mi)).join("")).join("")}</tbody>
        </table>
      </div>`
    : `<div class="empty">Nothing matched.</div>`;
  return `${controls}${extra.join("")}${body}
    <div class="daily-actions" data-d-foot>${deleteFooter()}</div>
    ${resultsHtml(deleteResults, "delete")}`;
}

function workCard() {
  const seg = `<span class="seg mini">${[["release", "Make releases"], ["delete", "Delete releases & tags"]].map(([k, v]) =>
    `<button type="button" data-w-mode="${k}" aria-pressed="${mode === k}"${busy ? " disabled" : ""}>${v}</button>`).join("")}</span>`;
  return `<section class="card rl-card" style="--span:12">
    <header><h2>${mode === "release" ? "Make releases" : "Delete releases & tags"}</h2>${seg}</header>
    <div class="body" data-rl-work>${list ? (mode === "release" ? releaseWork() : deleteWork()) : ""}</div>
  </section>`;
}

/* ---- painting ---- */

export function releasesBody() {
  return `<div class="grid rl" data-rl>${pickerCard()}${workCard()}</div>`;
}

function redraw() {
  const root = document.querySelector("[data-rl]");
  if (root) root.innerHTML = pickerCard() + workCard();
}

function paintList() {
  const el = document.querySelector("[data-rl-list]");
  if (el) el.innerHTML = repoListHtml();
  syncWorkCount();
}

function paintFilter() {
  const el = document.querySelector("[data-rl-filter]");
  if (el) el.innerHTML = filterHtml();
  paintList();
}

function paintWork() {
  const el = document.querySelector("[data-rl-work]");
  if (el) el.innerHTML = mode === "release" ? releaseWork() : deleteWork();
}

function syncWorkCount() {
  const btn = document.querySelector(mode === "release" ? "[data-a-preview]" : "[data-d-find]");
  if (!btn || busy) return;
  const n = ticked.size;
  if (mode === "release") {
    btn.disabled = !n;
    btn.textContent = rows.length ? `Preview ${plural(n, "repo")} again` : `Preview ${plural(n, "repo")}`;
  } else {
    btn.disabled = !n || (del.by === "pattern" && !del.pattern.replace(/[*?\s]/g, ""));
    btn.textContent = `Find matches in ${plural(n, "repo")}`;
  }
}

function paintFoot() {
  const r = document.querySelector("[data-x-foot]");
  if (r) r.innerHTML = releaseFooter();
  const d = document.querySelector("[data-d-foot]");
  if (d) d.innerHTML = deleteFooter();
}

function paintRow(i) {
  const tr = document.querySelector(`[data-rl] tr[data-row="${i}"]`);
  if (tr) tr.outerHTML = releaseRowHtml(rows[i], i);
  paintFoot();
}

function liveRow(tr) {
  const i = Number(tr.dataset.row);
  const r = rows[i];
  const c = calc(r);
  tr.querySelector("[data-x-tag]").classList.toggle("ra-invalid", Boolean(c.invalid && r.include && usable(r)));
  tr.querySelector(".ra-wrong").hidden = !(r.bump === "predicted" && !r.pattern && c.changed);
  tr.querySelector("[data-x-notes]").innerHTML = rowNotes(r, c);
  paintFoot();
}

/* ---- loading ---- */

async function loadList() {
  if (listing) return listing;
  listing = (async () => {
    await null;
    try {
      const { ok, status, body } = await call("/api/releases/repos");
      if (!ok) throw new Error(status === 403 ? "Only the admin team can use Releases & Tags." : `The repos couldn't be read: ${body.error ?? status}`);
      list = body;
      listedAt = Date.now();
      listError = null;
      const names = new Set(list.repos.map((r) => r.name));
      ticked = new Set([...ticked].filter((n) => names.has(n)));
      if (pending) {
        ticked = new Set(pending.filter((n) => names.has(n)));
        pending = null;
        listing = null;
        if (ticked.size) return preview();
      }
    } catch (err) {
      listError = err instanceof TypeError ? "The dashboard couldn't be reached." : err.message;
    } finally {
      listing = null;
      redraw();
    }
  })();
  redraw();
  return listing;
}

function freshRow(data, keep) {
  const r = {
    data,
    bump: data.dated ? "predicted" : keep?.bump ?? all.bump,
    pattern: all.pattern,
    pre: keep?.pre ?? all.pre,
    notLatest: keep?.notLatest ?? all.notLatest,
    edit: null,
    wrong: false,
    include: true,
    done: null,
  };
  r.include = Boolean(usable(r) && !calc(r).invalid);
  return r;
}

async function preview() {
  const names = tickedRepos();
  if (!names.length || busy) return;
  busy = "previewing";
  note = "";
  releaseResults = null;
  const branch = all.branch.trim() || null;
  const out = [];
  let meta = null;
  try {
    for (let i = 0; i < names.length; i += PREVIEW_CHUNK) {
      progress = `Reading ${Math.min(i + PREVIEW_CHUNK, names.length)} of ${names.length}…`;
      paintWork();
      const chunk = names.slice(i, i + PREVIEW_CHUNK).map((repo) => ({ repo, branch }));
      const { ok, status, body } = await call("/api/releases/preview", { repos: chunk });
      if (!ok) throw new Error(body.error ?? String(status));
      meta = meta ?? body;
      out.push(...body.repos);
    }
    rows = out.map((d) => freshRow(d));
    previewMeta = { ready: meta.ready, stats: meta.stats, storeError: meta.storeError };
  } catch (err) {
    note = `Couldn't read the repos: ${err instanceof TypeError ? "the dashboard couldn't be reached" : err.message}`;
  } finally {
    busy = null;
    progress = "";
    redraw();
  }
}

async function previewOne(i, branch) {
  const r = rows[i];
  try {
    const { ok, body } = await call("/api/releases/preview", { repos: [{ repo: r.data.repo, branch: branch || null }] });
    if (!ok) throw new Error(body.error);
    rows[i] = freshRow(body.repos[0], r);
  } catch (err) {
    rows[i] = { ...r, data: { ...r.data, problem: `Couldn't read the ${branch || "default"} branch: ${err.message ?? err}` } };
  }
  paintRow(i);
}

async function findMatches() {
  const names = tickedRepos();
  if (!names.length || busy) return;
  busy = "finding";
  note = "";
  deleteResults = null;
  const out = [];
  let ready = false;
  try {
    for (let i = 0; i < names.length; i += DELETE_CHUNK) {
      progress = `Reading ${Math.min(i + DELETE_CHUNK, names.length)} of ${names.length}…`;
      paintWork();
      const payload = { repos: names.slice(i, i + DELETE_CHUNK), ...(del.by === "latest" ? { latest: true } : { pattern: del.pattern.trim() }) };
      const { ok, status, body } = await call("/api/releases/delete-preview", payload);
      if (!ok) throw new Error(body.error ?? String(status));
      ready = body.ready;
      out.push(...body.repos.map((r) => ({ ...r, matches: r.matches.map((m) => ({ ...m, include: true, done: null })) })));
    }
    found = out;
    found.ready = ready;
    found.label = del.by === "latest" ? { latest: true } : { pattern: del.pattern.trim() };
  } catch (err) {
    note = `Couldn't read the tags: ${err instanceof TypeError ? "the dashboard couldn't be reached" : err.message}`;
  } finally {
    busy = null;
    progress = "";
    redraw();
  }
}

/* ---- running ---- */

function dialog(html, onClose) {
  const d = document.createElement("dialog");
  d.className = "daily-dialog rl-dialog";
  d.innerHTML = html;
  d.addEventListener("click", (e) => {
    const pick = e.target.closest("[data-dlg]")?.dataset.dlg;
    if (pick) d.close(pick);
  });
  d.addEventListener("close", () => {
    const value = d.returnValue;
    d.remove();
    onClose(value);
  });
  document.body.appendChild(d);
  d.showModal();
  return d;
}

function confirmRelease() {
  const { picked } = releaseCounts();
  const n = picked.length;
  const branches = new Set(picked.map((r) => (r.data.customBranch ? r.data.branch : null)).filter(Boolean));
  const unchanged = picked.filter((r) => r.data.unchanged).length;
  const bits = [];
  if (n > BUILD_WARN) bits.push(`<p class="daily-warn">This starts about ${n} workflow builds at once.</p>`);
  if (unchanged) bits.push(`<p class="daily-warn">${plural(unchanged, "repo has", "repos have")} no commits since their last release.</p>`);
  if (branches.size) bits.push(`<p>Tagged on ${[...branches].map((b) => `<code>${esc(b)}</code>`).join(", ")} where set, the default branch elsewhere.</p>`);
  dialog(`<h3>Release ${plural(n, "repo")}?</h3>
    <p>Each one gets a new release with GitHub's generated notes, tagged at the commit shown, made by Org-Manager with your name kept here.</p>
    ${bits.join("")}
    <div class="daily-actions"><span class="ra-count"></span>
      <button type="button" class="ghost" data-dlg="cancel" autofocus>Cancel</button>
      <button type="button" class="daily-go" data-dlg="go">Release ${plural(n, "repo")}</button></div>`,
  (v) => { if (v === "go") runReleases(picked); });
}

const runId = () => (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

async function runBatches(path, items, extra, label) {
  const run = runId();
  const results = [];
  let dryRun = false;
  let stopped = null;
  for (let i = 0; i < items.length; i += RUN_BATCH) {
    const batch = items.slice(i, i + RUN_BATCH);
    progress = `${label} ${Math.min(i + RUN_BATCH, items.length)} of ${items.length}…`;
    paintFoot();
    try {
      const { status, body } = await call(path, { run, last: i + RUN_BATCH >= items.length, total: items.length, items: batch.map((b) => b.item), ...extra });
      if (!body.results) {
        stopped = `Stopped after ${results.length} of ${items.length}: ${body.error ?? status}. The rest weren't sent.`;
        break;
      }
      dryRun = dryRun || Boolean(body.dryRun);
      body.results.forEach((r, k) => batch[k].onDone(r));
      results.push(...body.results);
    } catch {
      stopped = `Stopped after ${results.length} of ${items.length}: the dashboard couldn't be reached. The rest weren't sent.`;
      break;
    }
  }
  return { results, dryRun, stopped };
}

async function runReleases(picked) {
  busy = "releasing";
  paintWork();
  const items = picked.map((r) => {
    const c = calc(r);
    return {
      item: {
        repo: r.data.repo,
        tag: c.tag,
        sha: r.data.sha,
        previous: r.data.lastTag,
        predicted: c.predicted,
        bump: r.pattern && r.edit == null ? "pattern" : r.bump,
        wrong: r.bump === "predicted" && !r.pattern && c.changed && r.wrong,
        notLatest: r.notLatest,
      },
      onDone: (res) => { r.done = res.ok ? { ok: true, tag: res.tag, url: res.url ?? `${repoUrl(r.data.repo)}/releases/tag/${encodeURIComponent(res.tag)}` } : { ok: false, error: res.error }; },
    };
  });
  const out = await runBatches("/api/releases/run", items, {}, "Releasing");
  if (out.dryRun) for (const r of picked) r.done = null;
  releaseResults = out;
  busy = null;
  progress = "";
  redraw();
}

function confirmDelete() {
  const items = deleteItems();
  const releases = items.filter((i) => i.release).length;
  const tags = items.filter((i) => i.tag).length;
  const repos = new Set(items.map((i) => i.repo)).size;
  const n = items.length;
  const d = dialog(`<h3>Delete ${plural(releases, "release")} and ${plural(tags, "tag")}?</h3>
    <p>In ${plural(repos, "repo")}, made by Org-Manager with your name kept here. Release assets go with their releases, and none of this can be undone.</p>
    <label class="rl-field"><span class="sub">Type <b>${n}</b> to confirm</span><input type="text" class="rl-input" data-dlg-type inputmode="numeric" autocomplete="off"></label>
    <div class="daily-actions"><span class="ra-count"></span>
      <button type="button" class="ghost" data-dlg="cancel" autofocus>Cancel</button>
      <button type="button" class="daily-go rl-danger" data-dlg="go" disabled>Delete ${plural(n, "match", "matches")}</button></div>`,
  (v) => { if (v === "go") runDeletes(items); });
  const input = d.querySelector("[data-dlg-type]");
  input.addEventListener("input", () => { d.querySelector('[data-dlg="go"]').disabled = input.value.trim() !== String(n); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });
}

async function runDeletes(items) {
  busy = "deleting";
  paintWork();
  const batch = items.map((i) => ({
    item: { repo: i.repo, tag: i.m.tag, releaseId: i.m.release?.id ?? null, release: i.release, deleteTag: i.tag },
    onDone: (res) => { i.m.done = res; },
  }));
  const out = await runBatches("/api/releases/delete", batch, found.label ?? {}, "Deleting");
  if (out.dryRun) for (const i of items) i.m.done = null;
  deleteResults = out;
  busy = null;
  progress = "";
  redraw();
}

/* ---- events ---- */

const inPage = (e) => e.target.closest?.("[data-rl]");

function onClick(e) {
  if (!inPage(e)) return;
  const t = e.target;
  if (t.closest("[data-r-refresh]")) return loadList();
  const preset = t.closest("[data-r-preset]")?.dataset.rPreset;
  if (preset) {
    if (preset === "needs") ticked = new Set(needsRelease().filter((n) => list.repos.some((r) => r.name === n)));
    else if (preset === "shown") for (const r of visibleRepos()) ticked.add(r.name);
    else ticked.clear();
    return paintList();
  }
  const add = t.closest("[data-f-add]");
  if (add) {
    const group = findNode(add.closest("[data-node]").dataset.node).node;
    group.items.push(add.dataset.fAdd === "group" ? { id: newId(), op: "and", items: [{ id: newId(), prop: "", cmp: "any", values: [] }] } : { id: newId(), prop: "", cmp: "any", values: [] });
    saveFilter();
    return paintFilter();
  }
  const remove = t.closest("[data-f-remove]");
  if (remove) {
    const hit = findNode(remove.closest("[data-node]").dataset.node);
    if (hit?.parent) hit.parent.items = hit.parent.items.filter((n) => n !== hit.node);
    saveFilter();
    return paintFilter();
  }
  const op = t.closest("[data-f-op]");
  if (op) {
    findNode(op.closest("[data-node]").dataset.node).node.op = op.dataset.fOp;
    saveFilter();
    return paintFilter();
  }
  const m = t.closest("[data-w-mode]")?.dataset.wMode;
  if (m && m !== mode && !busy) {
    mode = m;
    note = "";
    return redraw();
  }
  if (t.closest("[data-a-preview]")) return preview();
  if (t.closest("[data-x-go]")) return confirmRelease();
  if (t.closest("[data-d-find]")) return findMatches();
  if (t.closest("[data-d-go]")) return confirmDelete();
}

function onChange(e) {
  if (!inPage(e)) return;
  const t = e.target;
  if (t.matches("[data-r-tick]")) {
    if (t.checked) ticked.add(t.value);
    else ticked.delete(t.value);
    const count = document.querySelector("[data-rl-count]");
    if (count) count.outerHTML = countHtml();
    return syncWorkCount();
  }
  const node = t.closest("[data-node]");
  if (node && (t.matches("[data-f-prop]") || t.matches("[data-f-cmp]") || t.matches("[data-f-val]"))) {
    const n = findNode(node.dataset.node).node;
    if (t.matches("[data-f-prop]")) { n.prop = t.value; n.values = []; }
    else if (t.matches("[data-f-cmp]")) n.cmp = t.value;
    else n.values = [...node.querySelectorAll("[data-f-val]:checked")].map((x) => x.value);
    saveFilter();
    return t.matches("[data-f-val]") ? paintList() : paintFilter();
  }
  if (t.matches("[data-a-bump]")) { all.bump = t.value; for (const r of rows) { if (!r.data.dated) r.bump = all.bump; r.edit = null; } return paintWork(); }
  if (t.matches("[data-a-pre]")) { all.pre = t.checked; for (const r of rows) { r.pre = all.pre; r.edit = null; } return paintWork(); }
  if (t.matches("[data-a-notlatest]")) { all.notLatest = t.checked; for (const r of rows) r.notLatest = all.notLatest; return paintWork(); }
  if (t.matches("[data-a-pattern]")) { all.pattern = t.value; for (const r of rows) { r.pattern = all.pattern; r.edit = null; } return paintWork(); }
  if (t.matches("[data-a-branch]")) { all.branch = t.value.trim(); return rows.length ? preview() : undefined; }
  const tr = t.closest("tr[data-row]");
  if (tr) {
    const i = Number(tr.dataset.row);
    const r = rows[i];
    if (t.matches("[data-x-include]")) r.include = t.checked;
    else if (t.matches("[data-x-bump]")) { r.bump = t.value; r.edit = null; }
    else if (t.matches("[data-x-pre]")) { r.pre = t.checked; r.edit = null; }
    else if (t.matches("[data-x-wrong]")) { r.wrong = t.checked; return; }
    else if (t.matches("[data-x-notlatest]")) { r.notLatest = t.checked; return; }
    else if (t.matches("[data-x-branch]")) return previewOne(i, t.value.trim());
    else return;
    return paintRow(i);
  }
  if (t.matches("[data-x-all]")) { for (const r of rows) if (usable(r)) r.include = t.checked; return paintWork(); }
  if (t.matches("[data-d-by]")) { del.by = t.value; return paintWork(); }
  if (t.matches("[data-d-release]")) { del.release = t.checked; return paintWork(); }
  if (t.matches("[data-d-tag]")) { del.tag = t.checked; return paintWork(); }
  const mr = t.closest("tr[data-m]");
  if (mr && t.matches("[data-m-include]")) {
    const [ri, mi] = mr.dataset.m.split(":").map(Number);
    found[ri].matches[mi].include = t.checked;
    mr.outerHTML = matchRowHtml(found[ri], found[ri].matches[mi], ri, mi);
    return paintFoot();
  }
  if (t.matches("[data-m-all]")) { for (const r of found ?? []) for (const x of r.matches) if (!x.done) x.include = t.checked; return paintWork(); }
}

function onInput(e) {
  if (!inPage(e)) return;
  const t = e.target;
  if (t.matches("[data-r-search]")) { search = t.value; return paintList(); }
  if (t.matches("[data-f-text]")) {
    findNode(t.closest("[data-node]").dataset.node).node.values = t.value.split(",").map((v) => v.trim()).filter(Boolean);
    saveFilter();
    return paintList();
  }
  if (t.matches("[data-d-pattern]")) { del.pattern = t.value; return syncWorkCount(); }
  if (t.matches("[data-x-tag]")) {
    const tr = t.closest("tr[data-row]");
    const r = rows[Number(tr.dataset.row)];
    const planned = planTag(r.data, { bump: r.bump, pattern: r.pattern, pre: r.pre }).tag;
    const v = t.value.trim();
    r.edit = v === planned ? null : v;
    return liveRow(tr);
  }
}

function onKey(e) {
  if (!inPage(e)) return;
  if (e.key === "Enter" && e.target.matches("[data-x-tag], [data-x-branch], [data-a-pattern], [data-a-branch], [data-d-pattern], [data-f-text]")) {
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

export function openReleasesFor(names) {
  pending = [...new Set(names)];
  mode = "release";
  rows = [];
  previewMeta = null;
  releaseResults = null;
  note = "";
  if (list) {
    const known = new Set(list.repos.map((r) => r.name));
    ticked = new Set(pending.filter((n) => known.has(n)));
    pending = null;
    setTimeout(preview, 0);
  }
}

export function syncReleases(on) {
  if (!on) return;
  wire();
  if ((!list && !listing) || (list && !busy && Date.now() - listedAt > LIST_STALE_MS)) loadList();
}
