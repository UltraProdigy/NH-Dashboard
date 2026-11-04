import { esc, safeUrl } from "./format.js";
import { seriesOf, validTagName } from "./release-tags.js";

const KIND = "nh-dashboard-release-snapshot";
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const CHANGE_LABEL = { save: "Saved", import: "Imported", edit: "Edited", remove: "Removed", release: "Released", refresh: "Took the branch's tag", revert: "Reverted" };
const ORG = "GTNewHorizons";

let ctx = null;
let snaps = null;
let error = null;
let loading = null;
let pick = "";
let edits = new Map();
let removes = new Set();
let draft = null;
let busy = false;
let note = "";
let noteBad = false;
let historyOpen = false;

export function initSnapshots(c) {
  ctx = c;
}

export const findSnapshot = (name) => (snaps ?? []).find((s) => s.name === name) ?? null;
const current = () => findSnapshot(pick);
const who = (by) => esc(String(by ?? "someone").split("@")[0]);
const repoUrl = (name) => `https://github.com/${ORG}/${encodeURIComponent(name)}`;

function resetEdits() {
  edits = new Map();
  removes = new Set();
  draft = null;
}

function accept(body) {
  snaps = body.snapshots ?? [];
  error = null;
  if (!findSnapshot(pick)) pick = snaps.at(-1)?.name ?? "";
  resetEdits();
}

export async function loadSnapshots({ ifNeeded = false } = {}) {
  if (loading) return loading;
  if (ifNeeded && snaps) return;
  loading = (async () => {
    try {
      const { ok, status, body } = await ctx.call("/api/releases/snapshots");
      if (!ok) throw new Error(body.error ?? String(status));
      const keep = pick;
      const pending = { edits, removes, draft };
      accept(body);
      if (keep === pick) ({ edits, removes, draft } = pending);
    } catch (err) {
      error = err instanceof TypeError ? "The dashboard couldn't be reached" : err.message;
    } finally {
      loading = null;
      paint();
    }
  })();
  paint();
  return loading;
}

async function send(path, payload, done) {
  busy = true;
  note = "";
  paint();
  try {
    const { ok, status, body } = await ctx.call(path, payload);
    if (body.snapshots) accept(body);
    noteBad = !ok;
    if (!ok) note = body.error ?? `Failed (${status})`;
    else if (done) note = done(body);
    return ok ? body : null;
  } catch (err) {
    noteBad = true;
    note = err instanceof TypeError ? "The dashboard couldn't be reached" : err.message;
    return null;
  } finally {
    busy = false;
    paint();
  }
}

/* ---- the card ---- */

function pendingCount() {
  const s = current();
  if (!s) return 0;
  let n = removes.size;
  for (const [repo, tag] of edits) if (!removes.has(repo) && s.repos.find((r) => r.repo === repo)?.tag !== tag) n++;
  if (draft != null && draft !== s.branch) n++;
  return n;
}

const badEdits = () => [...edits].filter(([repo, tag]) => !removes.has(repo) && !validTagName(tag)).length;

function branchHtml(s) {
  return `<div class="rl-controls">
    <label class="rl-field"><span class="sub">Branch to release from</span><input type="text" class="rl-input sn-branch" data-s-branch value="${esc(draft ?? s.branch)}" placeholder="default branch" spellcheck="false" autocomplete="off"></label>
  </div>`;
}

function rowHtml(r) {
  const edit = edits.get(r.repo);
  const tag = edit ?? r.tag;
  const off = removes.has(r.repo);
  const bad = !off && edit != null && !validTagName(edit);
  const lone = r.series ? "" : `<div class="ra-note">Its line can't be told apart from master's</div>`;
  return `<tr data-sn-repo="${esc(r.repo)}" class="${off ? "ra-off" : ""}">
    <td><a href="${safeUrl(repoUrl(r.repo))}" target="_blank" rel="noopener">${esc(r.repo)}</a>${lone}</td>
    <td><input type="text" class="ra-tag${bad ? " ra-invalid" : ""}" data-s-tag value="${esc(tag)}" spellcheck="false" autocomplete="off" aria-label="Tag for ${esc(r.repo)}"${off || busy ? " disabled" : ""}></td>
    <td class="repo sub">${esc(r.base)}</td>
    <td class="sub">${esc(ctx.ago(r.updatedAt))} by ${who(r.updatedBy)}</td>
    <td><label class="rl-pre"><input type="checkbox" data-s-remove${off ? " checked" : ""}${busy ? " disabled" : ""}> remove</label></td>
  </tr>`;
}

function changeHtml(c) {
  const shown = c.rows.slice(0, 3).map((r) => `${esc(r.repo)} ${esc(r.before ?? "—")} → ${esc(r.after ?? "removed")}`).join(", ");
  const more = c.rows.length > 3 ? `, and ${c.rows.length - 3} more` : "";
  const action = c.reverted
    ? `<span class="label">reverted</span>`
    : `<button type="button" class="ghost mini" data-s-revert="${esc(c.change)}"${busy ? " disabled" : ""}>Revert</button>`;
  return `<li><div><b>${esc(CHANGE_LABEL[c.kind] ?? c.kind)}</b> ${ctx.plural(c.rows.length, "repo")} · ${who(c.by)} · ${esc(ctx.ago(c.at))}
    <div class="sub">${shown}${more}</div></div>${action}</li>`;
}

function bodyHtml() {
  if (error && !snaps) return `<div class="error">${esc(error)}</div>`;
  if (!snaps) return `<div class="empty">Reading the saved snapshots…</div>`;
  const s = current();
  const options = snaps.map((x) => `<option value="${esc(x.name)}"${x.name === pick ? " selected" : ""}>${esc(x.name)} (${x.repos.length})</option>`).join("");
  const off = busy ? " disabled" : "";
  const bar = `<div class="rl-pickbar">
      ${snaps.length ? `<select data-s-pick aria-label="Snapshot"${off}>${options}</select>` : `<span class="sub">No snapshots yet.</span>`}
      <button type="button" class="ghost" data-s-load${s && !busy ? "" : " disabled"} title="Tick its repos and preview them in Make releases on its branch">Load into Make releases</button>
      <button type="button" class="ghost" data-s-export${s ? "" : " disabled"}>Export</button>
      <label class="ghost sn-file${busy ? " sn-off" : ""}">Import<input type="file" accept=".json,application/json" data-s-import hidden${off}></label>
      <button type="button" class="ghost" data-s-delete${s && !busy ? "" : " disabled"}>Delete</button>
    </div>
    <p class="hint rl-gap">A snapshot is a saved tag per repo for a release line, like 2.9.x after 2.9.0. To make one, preview the repos in Make releases with the branch set, then press <b>Save as snapshot</b>.
      Releasing from a loaded snapshot moves its tags forward, and any change can be reverted below.</p>`;
  const msg = note ? `<p class="${noteBad ? "daily-warn" : "daily-last"}">${esc(note)}</p>` : "";
  if (!s) return bar + msg;
  const n = pendingCount();
  const bad = badEdits();
  const foot = `<div class="daily-actions">
      <span class="ra-count minlabel">${bad ? `${ctx.plural(bad, "tag")} not valid` : n ? `${ctx.plural(n, "change")} not saved` : `Saved ${esc(ctx.ago(s.updatedAt))} by ${who(s.updatedBy)}`}</span>
      <button type="button" class="ghost" data-s-discard${n && !busy ? "" : " disabled"}>Discard</button>
      <button type="button" class="daily-go" data-s-save${n && !bad && !busy ? "" : " disabled"}>Save changes</button>
    </div>`;
  const history = s.changes.length
    ? `<details class="rl-none sn-history-box"${historyOpen ? " open" : ""}><summary class="sub" data-s-history>Recent changes (${s.changes.length})</summary>
        <ul class="sn-history">${s.changes.map(changeHtml).join("")}</ul></details>`
    : "";
  return `${bar}${msg}${branchHtml(s)}
    <div class="ra-scroll rl-scroll sn-scroll">
      <table class="ra-table rl-table sn-table">
        <thead><tr><th>Repo</th><th>Counts from</th><th>Saved with</th><th>Last changed</th><th></th></tr></thead>
        <tbody>${s.repos.map(rowHtml).join("") || `<tr><td colspan="5" class="empty">No repos in it.</td></tr>`}</tbody>
      </table>
    </div>
    ${foot}${history}`;
}

function statusHtml() {
  if (!snaps) return "";
  return snaps.length ? ctx.plural(snaps.length, "snapshot") : "";
}

export function snapshotsCard() {
  return `<section class="card rl-card" style="--span:12" data-sn>
    <header><h2>Snapshots</h2><span class="sub" data-sn-status>${statusHtml()}</span>
      <button type="button" class="ghost mini rl-refresh" data-s-refresh${loading ? " disabled" : ""}>${loading ? "Reading…" : "Refresh"}</button></header>
    <div class="body" data-sn-body>${bodyHtml()}</div>
  </section>`;
}

function paint() {
  const body = document.querySelector("[data-sn-body]");
  if (body) body.innerHTML = bodyHtml();
  const status = document.querySelector("[data-sn-status]");
  if (status) status.innerHTML = statusHtml();
  const refresh = document.querySelector("[data-s-refresh]");
  if (refresh) {
    refresh.disabled = Boolean(loading);
    refresh.textContent = loading ? "Reading…" : "Refresh";
  }
  ctx?.onChange?.();
}

function paintFoot() {
  const foot = document.querySelector("[data-sn-body] .daily-actions");
  if (!foot) return paint();
  const tmp = document.createElement("div");
  tmp.innerHTML = bodyHtml();
  const fresh = tmp.querySelector(".daily-actions");
  if (fresh) foot.replaceWith(fresh);
}

/* ---- saving one from a preview ---- */

const nameFromBranch = (branch) => String(branch ?? "").split("/").pop().replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40);

const branchField = (branch) =>
  `<label class="rl-field"><span class="sub">Branch to release from</span><input type="text" class="rl-input" data-dlg-branch value="${esc(branch ?? "")}" placeholder="default branch" spellcheck="false" autocomplete="off"></label>`;

const readBranch = (d) => d.querySelector("[data-dlg-branch]").value.trim();

function diffAgainst(name, repos) {
  const old = findSnapshot(name);
  if (!old) return null;
  const was = new Map(old.repos.map((r) => [r.repo, r.tag]));
  const incoming = new Set(repos.map((r) => r.repo));
  return {
    added: repos.filter((r) => !was.has(r.repo)).length,
    changed: repos.filter((r) => was.has(r.repo) && was.get(r.repo) !== r.tag).length,
    removed: [...was.keys()].filter((r) => !incoming.has(r)).length,
  };
}

function nameAndMode(d, repos, button) {
  const input = d.querySelector("[data-dlg-name]");
  const box = d.querySelector("[data-dlg-exists]");
  const sync = () => {
    const name = input.value.trim();
    const diff = diffAgainst(name, repos);
    box.hidden = !diff;
    if (diff) {
      const replace = d.querySelector('[data-dlg-mode][value="replace"]').checked;
      box.querySelector("[data-dlg-diff]").textContent = `${diff.added} added, ${diff.changed} changed${replace ? `, ${diff.removed} removed` : ""}.`;
    }
    d.querySelector(`[data-dlg="${button}"]`).disabled = !NAME.test(name);
  };
  input.addEventListener("input", sync);
  d.querySelectorAll("[data-dlg-mode]").forEach((r) => r.addEventListener("change", sync));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });
  sync();
}

const existsBox = `<div class="sn-exists" data-dlg-exists hidden>
    <p class="daily-warn">A snapshot with this name already exists.</p>
    <label class="rl-check"><input type="radio" name="sn-mode" data-dlg-mode value="merge" checked> Merge into it</label>
    <label class="rl-check"><input type="radio" name="sn-mode" data-dlg-mode value="replace"> Replace it</label>
    <p class="sub" data-dlg-diff></p>
  </div>`;

export function saveFromPreview(previewRows, branch) {
  const keep = previewRows.filter((r) => !r.problem && r.tag && validTagName(r.tag));
  const left = previewRows.length - keep.length;
  const repos = keep.map((r) => ({ repo: r.repo, tag: r.tag }));
  const loneCount = keep.filter((r) => !seriesOf(r.tag)).length;
  const d = ctx.dialog(`<h3>Save ${ctx.plural(keep.length, "repo")} as a snapshot?</h3>
    <p>Stores each repo's last tag from this preview: the newest tag on the branch, or the repo's last release where the branch has none. The bump, Not latest and Pre-release are chosen each time you release from it.</p>
    ${left ? `<p class="daily-warn">${ctx.plural(left, "repo is", "repos are")} left out, with a problem or no tag.</p>` : ""}
    ${loneCount ? `<p class="daily-warn">${ctx.plural(loneCount, "repo has", "repos have")} one number or a dated tag, so master can't tell its line apart from the snapshot's.</p>` : ""}
    <div class="sn-dialog-fields">
      <label class="rl-field"><span class="sub">Name</span><input type="text" class="rl-input" data-dlg-name value="${esc(nameFromBranch(branch) || "snapshot")}" spellcheck="false" autocomplete="off"></label>
      ${branchField(branch)}
    </div>
    ${existsBox}
    <div class="daily-actions"><span class="ra-count"></span>
      <button type="button" class="ghost" data-dlg="cancel" autofocus>Cancel</button>
      <button type="button" class="daily-go" data-dlg="go"${keep.length ? "" : " disabled"}>Save snapshot</button></div>`,
  async (v) => {
    if (v !== "go") return;
    const name = d.querySelector("[data-dlg-name]").value.trim();
    const exists = Boolean(findSnapshot(name));
    const mode = exists ? d.querySelector("[data-dlg-mode]:checked").value : "new";
    pick = name;
    await send("/api/releases/snapshot-save", { name, branch: readBranch(d), repos, mode, kind: "save" }, (b) => savedNote(b.saved));
  });
  nameAndMode(d, repos, "go");
}

function savedNote(s) {
  if (!s) return "";
  const bits = [`${s.added} added`, `${s.changed} changed`];
  if (s.removed) bits.push(`${s.removed} removed`);
  return `Saved ${s.name}: ${bits.join(", ")}`;
}

/* ---- import and export ---- */

function exportSnapshot(s) {
  const data = {
    kind: KIND,
    version: 1,
    name: s.name,
    branch: s.branch,
    exportedAt: new Date().toISOString(),
    repos: s.repos.map((r) => ({ repo: r.repo, tag: r.tag, base: r.base })),
  };
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `release-snapshot-${s.name}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function parseImport(data) {
  if (!data || typeof data !== "object" || data.kind !== KIND) return { error: "That file isn't a snapshot exported from this page" };
  if (data.version !== 1) return { error: `That file is version ${data.version} of the snapshot format, and this page reads version 1` };
  const list = Array.isArray(data.repos) ? data.repos : null;
  if (!list || !list.length) return { error: "That file has no repos in it" };
  const seen = new Set();
  const repos = [];
  for (const r of list) {
    if (!r || !REPO.test(r.repo ?? "") || !validTagName(r.tag)) return { error: `${String(r?.repo ?? "A repo")} doesn't have a valid tag` };
    if (r.base != null && !validTagName(r.base)) return { error: `${r.repo} doesn't have a valid base tag` };
    if (seen.has(r.repo)) return { error: `${r.repo} is in the file twice` };
    seen.add(r.repo);
    repos.push({ repo: r.repo, tag: r.tag, ...(r.base ? { base: r.base } : {}) });
  }
  return {
    name: NAME.test(data.name ?? "") ? data.name : "",
    branch: typeof data.branch === "string" ? data.branch.trim() : "",
    repos,
  };
}

async function importFile(file) {
  let parsed;
  try {
    parsed = parseImport(JSON.parse(await file.text()));
  } catch {
    parsed = { error: "That file isn't JSON" };
  }
  if (parsed.error) {
    note = parsed.error;
    noteBad = true;
    return paint();
  }
  const d = ctx.dialog(`<h3>Import ${ctx.plural(parsed.repos.length, "repo")}?</h3>
    <p>From <code>${esc(file.name)}</code>. Nothing is saved until you press Import.</p>
    <div class="sn-dialog-fields">
      <label class="rl-field"><span class="sub">Name</span><input type="text" class="rl-input" data-dlg-name value="${esc(parsed.name)}" spellcheck="false" autocomplete="off"></label>
      ${branchField(parsed.branch)}
    </div>
    ${existsBox}
    <div class="daily-actions"><span class="ra-count"></span>
      <button type="button" class="ghost" data-dlg="cancel" autofocus>Cancel</button>
      <button type="button" class="daily-go" data-dlg="go">Import</button></div>`,
  async (v) => {
    if (v !== "go") return;
    const name = d.querySelector("[data-dlg-name]").value.trim();
    const mode = findSnapshot(name) ? d.querySelector("[data-dlg-mode]:checked").value : "new";
    pick = name;
    await send("/api/releases/snapshot-save", { name, branch: readBranch(d), repos: parsed.repos, mode, kind: "import" }, (b) => savedNote(b.saved));
  });
  nameAndMode(d, parsed.repos, "go");
}

/* ---- editing, reverting and deleting ---- */

function saveEdits() {
  const s = current();
  if (!s || busy) return;
  const set = [];
  for (const [repo, tag] of edits) {
    if (removes.has(repo)) continue;
    const was = s.repos.find((r) => r.repo === repo)?.tag ?? null;
    if (tag !== was) set.push({ repo, tag, was });
  }
  const remove = [...removes].map((repo) => ({ repo, was: s.repos.find((r) => r.repo === repo)?.tag ?? null }));
  const branch = draft != null && draft !== s.branch ? draft : undefined;
  return send("/api/releases/snapshot-edit", { name: s.name, set, remove, ...(branch !== undefined ? { branch } : {}) }, () => `Saved ${s.name}`);
}

function confirmRevert(change) {
  const s = current();
  const c = s?.changes.find((x) => x.change === change);
  if (!c) return;
  ctx.dialog(`<h3>Revert this change?</h3>
    <p><b>${esc(CHANGE_LABEL[c.kind] ?? c.kind)}</b> ${ctx.plural(c.rows.length, "repo")} ${esc(ctx.ago(c.at))} by ${who(c.by)}.
      Each repo goes back to the tag it had before, unless it has changed again since. This only changes the snapshot: no release or tag on GitHub is touched.</p>
    <div class="daily-actions"><span class="ra-count"></span>
      <button type="button" class="ghost" data-dlg="cancel" autofocus>Cancel</button>
      <button type="button" class="daily-go" data-dlg="go">Revert</button></div>`,
  (v) => {
    if (v !== "go") return;
    send("/api/releases/snapshot-revert", { name: s.name, change }, (b) => {
      const skipped = b.skipped?.length ? `. Skipped ${b.skipped.map((x) => x.repo).join(", ")}, changed since` : "";
      return `Put back ${ctx.plural(b.reverted ?? 0, "repo")}${skipped}`;
    });
  });
}

function confirmDelete() {
  const s = current();
  if (!s) return;
  const d = ctx.dialog(`<h3>Delete the ${esc(s.name)} snapshot?</h3>
    <p>Its ${ctx.plural(s.repos.length, "tag")} and its history go with it, and this can't be reverted. Export it first if you might want it back.
      Releases and tags on GitHub aren't touched.</p>
    <label class="rl-field"><span class="sub">Type <b>${esc(s.name)}</b> to confirm</span><input type="text" class="rl-input" data-dlg-type autocomplete="off" spellcheck="false"></label>
    <div class="daily-actions"><span class="ra-count"></span>
      <button type="button" class="ghost" data-dlg="cancel" autofocus>Cancel</button>
      <button type="button" class="daily-go rl-danger" data-dlg="go" disabled>Delete snapshot</button></div>`,
  async (v) => {
    if (v !== "go") return;
    const ok = await send("/api/releases/snapshot-delete", { name: s.name, confirm: s.name }, () => `Deleted ${s.name}`);
    if (ok) ctx.onDeleted?.(s.name);
  });
  const input = d.querySelector("[data-dlg-type]");
  input.addEventListener("input", () => { d.querySelector('[data-dlg="go"]').disabled = input.value.trim() !== s.name; });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });
}

export function takeNewer(name, repo, tag, was) {
  return send("/api/releases/snapshot-edit", { name, kind: "refresh", set: [{ repo, tag, was }] }, () => `${repo} on ${name} now counts from ${tag}`);
}

/* ---- events ---- */

export function snapClick(t) {
  if (!t.closest("[data-sn]")) return false;
  if (t.closest("[data-s-refresh]")) loadSnapshots();
  else if (t.closest("[data-s-load]")) { const s = current(); if (s) ctx.onLoad(s); }
  else if (t.closest("[data-s-export]")) { const s = current(); if (s) exportSnapshot(s); }
  else if (t.closest("[data-s-delete]")) confirmDelete();
  else if (t.closest("[data-s-save]")) saveEdits();
  else if (t.closest("[data-s-discard]")) { resetEdits(); paint(); }
  else if (t.closest("[data-s-history]")) historyOpen = !historyOpen;
  else {
    const change = t.closest("[data-s-revert]")?.dataset.sRevert;
    if (change) confirmRevert(change);
  }
  return true;
}

export function snapChange(t) {
  if (!t.closest("[data-sn]")) return false;
  if (t.matches("[data-s-pick]")) {
    const dropped = pendingCount() ? `Dropped the unsaved changes to ${pick}` : "";
    pick = t.value;
    resetEdits();
    note = dropped;
    noteBad = false;
    paint();
  } else if (t.matches("[data-s-import]")) {
    const file = t.files?.[0];
    t.value = "";
    if (file) importFile(file);
  } else if (t.matches("[data-s-remove]")) {
    const repo = t.closest("tr[data-sn-repo]").dataset.snRepo;
    if (t.checked) removes.add(repo);
    else removes.delete(repo);
    paint();
  } else if (t.matches("[data-s-branch]")) {
    draft = t.value.trim();
    paintFoot();
  }
  return true;
}

export function snapInput(t) {
  if (!t.closest("[data-sn]")) return false;
  if (t.matches("[data-s-tag]")) {
    const repo = t.closest("tr[data-sn-repo]").dataset.snRepo;
    const was = current()?.repos.find((r) => r.repo === repo)?.tag;
    const v = t.value.trim();
    if (v === was) edits.delete(repo);
    else edits.set(repo, v);
    t.classList.toggle("ra-invalid", v !== was && !validTagName(v));
    paintFoot();
  }
  return true;
}
