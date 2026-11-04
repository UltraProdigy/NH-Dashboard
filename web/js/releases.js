import { API } from "./live.js";
import { esc, safeUrl } from "./format.js";
import { panelRows } from "./dream.js";
import { BUMPS, DATED_REPOS, planTag, tagProblem } from "./release-tags.js";
import { propertyFilter, valuesOf } from "./property-filter.js";
import { loadRepoList, repoList, repoListError, repoListStale } from "./repo-list.js";
import { findSnapshot, initSnapshots, loadSnapshots, openSnapshots, saveFromPreview, snapChange, snapClick, snapInput, snapshotCount, takeNewer } from "./release-snapshots.js";

const PREVIEW_CHUNK = 50;
const DELETE_CHUNK = 20;
const RUN_BATCH = 10;
const BUILD_WARN = 20;
const ORG = "GTNewHorizons";

const BUMP_LABEL = { predicted: "Predicted", patch: "Patch", minor: "Minor", major: "Major", super: "Super" };
const POSITION = ["last number", "second-to-last number", "third-to-last number"];

let list = null;
let listError = null;
let listing = null;
let wired = false;
let ticked = new Set();
let search = "";
let mode = "release";
let pending = null;
let busy = null;
let progress = "";
let note = "";

const all = { bump: "predicted", pattern: "", pre: false, notLatest: false, branch: "" };
let rows = [];
let previewMeta = null;
let releaseResults = null;
let using = null;
let usingNote = "";
let watch = null;
let watchNote = "";

const del = { by: "pattern", pattern: "", release: true, tag: true };
let found = null;
let deleteResults = null;

const filter = propertyFilter("nh:rel-filter", { live: true, onChange: () => paintList() });

const shownRepos = () => (list?.repos ?? []).filter((r) => filter.passes(r));
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
  if (mins < 48 * 60) return `${Math.round(mins / 60)} hr ago`;
  return `${Math.round(mins / 1440)} days ago`;
}

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const repoUrl = (name) => `https://github.com/${ORG}/${encodeURIComponent(name)}`;

/* ---- the repo picker ---- */

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

function snapshotsLabel() {
  const n = snapshotCount();
  return n ? `Snapshots (${n})` : "Snapshots";
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
        <button type="button" class="ghost rl-snapbtn" data-r-snapshots title="Saved release lines: save, load, edit, revert, import and export">${snapshotsLabel()}</button>
      </div>
      ${filter.html()}
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
  if (d.lastNote) out.push(esc(d.lastNote));
  if (d.unchanged) out.push(`No commits since ${esc(d.lastTag)}`);
  else if (d.branchCheck) out.push(branchCheckNote(d));
  if (d.snapshot?.newer && !r.done) out.push(`<button type="button" class="ghost mini" data-x-newer${busy ? " disabled" : ""}>Count from ${esc(d.snapshot.newer)}</button>`);
  for (const n of c.plan.notes) out.push(esc(n));
  if (c.invalid && usable(r)) out.push(`<span class="rl-bad">${esc(c.invalid)}</span>`);
  return out.join("<br>");
}

function branchCheckNote(d) {
  const c = d.branchCheck;
  if (c.failed) return `Couldn't check the commits since ${esc(d.lastTag)} (${esc(c.failed)}), so it's left ticked`;
  const commits = plural(c.since, "commit");
  if (c.viaPr) return `${commits} since ${esc(d.lastTag)}, ${c.viaPr === c.since ? (c.since === 1 ? "through a pull request" : "all through pull requests") : `${c.viaPr} through a pull request`}`;
  if (c.since > c.checked) return `${commits} since ${esc(d.lastTag)}. None of the newest ${c.checked} came through a pull request, but that many still needs a release`;
  return `${commits} since ${esc(d.lastTag)}, ${c.since === 1 ? "pushed directly" : "all pushed directly"}, so it doesn't need a release`;
}

function branchSummary() {
  const checked = rows.filter((r) => r.data.needsRelease != null);
  if (!checked.length) return "";
  const need = checked.filter((r) => r.data.needsRelease).length;
  const branches = [...new Set(checked.map((r) => r.data.branch))];
  return `<p class="daily-last">On ${branches.map((b) => `<code>${esc(b)}</code>`).join(", ")}, ${need} of ${plural(checked.length, "repo")} ${need === 1 ? "needs" : "need"} a release:
    commits since the last tag, at least one through a pull request, the same rule as the Needs a release card. The others start unticked.</p>`;
}

const FINAL = new Set(["rebuilt", "failed", "built", "unknown"]);
const WATCH_EVERY = 15_000;
const WATCH_FOR = 3 * 3_600_000;
const WATCH_CHUNK = 300;

function rebuildHtml(done) {
  const s = done.status;
  if (!s && !done.watched) return "";
  const run = s?.buildUrl ? ` <a href="${safeUrl(s.buildUrl)}" target="_blank" rel="noopener">run</a>` : "";
  const quiet = (t) => ` <span class="sub">· ${t}</span>`;
  switch (s?.state ?? "waiting") {
    case "waiting": return quiet("waiting for the release workflow");
    case "rebuilding": return quiet("the workflow is rebuilding it");
    case "rebuilt": return ` · re-released by the workflow ✓${run}`;
    case "built": return quiet("build passed, the release wasn't replaced") + run;
    case "quiet": return quiet("no rebuild seen yet");
    case "failed": {
      const what = s.rebuilt ? "re-released, but the build failed" : s.removed ? "the build failed and the release is gone" : "the build failed, and the dashboard's release is still there";
      return ` · <span class="rl-bad">${what}</span>${run}`;
    }
    default: return "";
  }
}

function rebuildSummary() {
  const released = rows.filter((r) => r.done?.ok && r.done.watched);
  if (!released.length) return "";
  const n = (state) => released.filter((r) => (r.done.status?.state ?? "waiting") === state).length;
  const bits = [
    [n("rebuilt"), "re-released"],
    [n("rebuilding"), "rebuilding"],
    [n("waiting"), "waiting"],
    [n("quiet"), "with no rebuild seen yet"],
    [n("built"), "built without replacing the release"],
    [n("failed"), "failed"],
  ].filter(([k]) => k).map(([k, t]) => `${k} ${t}`);
  const still = watch ? " Updating every 15 seconds." : "";
  return `${bits.length ? `Release workflow: ${bits.join(", ")}.` : ""}${still}${watchNote ? ` ${esc(watchNote)}` : ""}`;
}

function stopWatch() {
  if (watch) clearTimeout(watch.timer);
  watch = null;
}

function startWatch() {
  stopWatch();
  watchNote = "";
  for (const r of rows) if (r.done?.ok) r.done.watched = true;
  watch = { until: Date.now() + WATCH_FOR, timer: setTimeout(checkRebuilds, 5000) };
  paintRebuilds();
}

function paintRebuilds() {
  rows.forEach((r, i) => { if (r.done?.watched) paintRow(i); });
  const el = document.querySelector("[data-x-rebuilds]");
  if (el) el.innerHTML = rebuildSummary();
}

async function checkRebuilds() {
  if (!watch) return;
  const mine = watch;
  const pending = rows.filter((r) => r.done?.ok && !FINAL.has(r.done.status?.state));
  if (!pending.length || Date.now() > watch.until) {
    stopWatch();
    return paintRebuilds();
  }
  if (!document.hidden) {
    try {
      for (let i = 0; i < pending.length; i += WATCH_CHUNK) {
        const part = pending.slice(i, i + WATCH_CHUNK);
        const { ok, body } = await call("/api/releases/status", { items: part.map((r) => ({ repo: r.data.repo, tag: r.done.tag })) });
        if (watch !== mine) return;
        if (!ok) throw new Error(body.error ?? "failed");
        if (body.unavailable) {
          watchNote = body.unavailable;
          stopWatch();
          return paintRebuilds();
        }
        body.statuses.forEach((st, k) => { part[k].done.status = st; });
      }
      watchNote = "";
    } catch (err) {
      watchNote = `Couldn't check the rebuilds (${err instanceof TypeError ? "the dashboard couldn't be reached" : err.message}), trying again`;
    }
  }
  if (watch !== mine) return;
  paintRebuilds();
  watch.timer = setTimeout(checkRebuilds, WATCH_EVERY);
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
    ? `<div class="rl-done">${r.done.ok ? `Released <a href="${safeUrl(r.done.url)}" target="_blank" rel="noopener">${esc(r.done.tag)}</a>${rebuildHtml(r.done)}` : `<span class="rl-bad">${esc(r.done.error)}</span>`}</div>` : "";
  const target = `<input type="text" class="rl-input rl-branch" data-x-branch value="${esc(d.customBranch ? d.branch : "")}" placeholder="${esc(d.defaultBranch ?? "default")}" spellcheck="false" autocomplete="off" aria-label="Branch for ${esc(d.repo)}"${r.done ? " disabled" : ""}>${
    d.sha ? ` <a class="repo" href="${safeUrl(`${repoUrl(d.repo)}/commit/${d.sha}`)}" target="_blank" rel="noopener">${esc(d.sha.slice(0, 7))}</a>` : ""}`;
  return `<tr data-row="${i}" class="${r.done || (r.include && ok) ? "" : "ra-off"}">
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
  const moved = res.results.filter((r) => r.snapshot);
  const snapLine = moved.length ? `<p>Moved ${plural(moved.length, "repo")} forward on the <b>${esc(moved[0].snapshot)}</b> snapshot.</p>` : "";
  const notes = res.results.filter((r) => r.ok && r.note);
  const noteLine = notes.length ? `<p class="daily-warn">${notes.map((r) => esc(r.note)).join("<br>")}</p>` : "";
  const rebuilds = kind === "release" && !res.dryRun ? `<p class="daily-last" data-x-rebuilds>${rebuildSummary()}</p>` : "";
  return `<div class="rl-results">
    <p><b>${esc(head)}</b></p>${stopped}${snapLine}${noteLine}${rebuilds}
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
    ${rows.length && !using ? `<button type="button" class="ghost" data-a-savesnap${busy ? " disabled" : ""} title="Save each previewed repo's last tag as a snapshot to release a line from later">Save as snapshot</button>` : ""}
  </div>
  ${using ? `<p class="sn-using">Counting from the <b>${esc(using)}</b> snapshot: each of its repos starts from the snapshot's tag, and releasing moves that tag forward.${usingNote ? ` ${esc(usingNote)}` : ""}
    <button type="button" class="ghost mini" data-x-unsnap${busy ? " disabled" : ""}>Stop using it</button></p>` : ""}
  <p class="hint rl-gap">Patch, Minor, Major and Super bump the last, second-to-last, third-to-last and fourth-to-last number of the version.
    A pattern can use <code>{next}</code> (the bump), <code>{last}</code>, <code>{date}</code> and <code>{repo}</code>. Changing these resets every row; a row can then be changed on its own.
    Pre-release adds <code>-pre</code> to the tag, which the release workflow treats as a pre-release.
    Not latest makes the release without marking it as the repo's latest.</p>`;

  if (!rows.length) return `${controls}${note ? `<p class="daily-warn">${esc(note)}</p>` : ""}`;

  const warns = [];
  if (!previewMeta?.ready) warns.push(`<p class="daily-warn">Org-Manager isn't set up on this Worker yet, so nothing can be released.</p>`);
  if (previewMeta?.storeError) warns.push(`<p class="daily-warn">${esc(previewMeta.storeError)}</p>`);
  if (note) warns.push(`<p class="daily-warn">${esc(note)}</p>`);
  return `${controls}${warns.join("")}${branchSummary()}${statsLine(previewMeta?.stats)}
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
  syncAllBoxes();
}

function paintList() {
  const el = document.querySelector("[data-rl-list]");
  if (el) el.innerHTML = repoListHtml();
  syncWorkCount();
}

function paintWork() {
  const el = document.querySelector("[data-rl-work]");
  if (el) el.innerHTML = mode === "release" ? releaseWork() : deleteWork();
  syncAllBoxes();
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

function syncBox(box, items) {
  if (!box) return;
  const on = items.filter((x) => x.include).length;
  box.checked = items.length > 0 && on === items.length;
  box.indeterminate = on > 0 && on < items.length;
  box.disabled = !items.length || Boolean(busy);
}

function syncAllBoxes() {
  syncBox(document.querySelector("[data-x-all]"), rows.filter(usable));
  syncBox(document.querySelector("[data-m-all]"), (found ?? []).flatMap((r) => r.matches).filter((m) => !m.done));
}

function paintFoot() {
  const r = document.querySelector("[data-x-foot]");
  if (r) r.innerHTML = releaseFooter();
  const d = document.querySelector("[data-d-foot]");
  if (d) d.innerHTML = deleteFooter();
  syncAllBoxes();
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

async function loadList({ force = false } = {}) {
  if (listing) return listing;
  listing = (async () => {
    await null;
    try {
      if (force || repoListStale()) await loadRepoList();
      list = repoList();
      listError = repoListError();
      filter.use(list);
      if (!list) return;
      const names = new Set(list.repos.map((r) => r.name));
      ticked = new Set([...ticked].filter((n) => names.has(n)));
      if (pending) {
        ticked = new Set(pending.filter((n) => names.has(n)));
        pending = null;
        listing = null;
        if (ticked.size) return preview();
      }
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
  r.include = Boolean(usable(r) && !calc(r).invalid && data.needsRelease !== false);
  return r;
}

async function preview() {
  const names = tickedRepos();
  if (!names.length || busy) return;
  busy = "previewing";
  note = "";
  releaseResults = null;
  stopWatch();
  const branch = all.branch.trim() || null;
  const out = [];
  let meta = null;
  try {
    for (let i = 0; i < names.length; i += PREVIEW_CHUNK) {
      progress = `Reading ${Math.min(i + PREVIEW_CHUNK, names.length)} of ${names.length}…`;
      paintWork();
      const chunk = names.slice(i, i + PREVIEW_CHUNK).map((repo) => ({ repo, branch, snapshot: using }));
      const { ok, status, body } = await call("/api/releases/preview", { repos: chunk });
      if (!ok) throw new Error(body.error ?? String(status));
      meta = meta ?? body;
      out.push(...body.repos);
    }
    rows = out.map((d) => freshRow(d));
    previewMeta = { ready: meta.ready, stats: meta.stats, storeError: meta.storeError ?? meta.snapshotError };
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
    const { ok, body } = await call("/api/releases/preview", { repos: [{ repo: r.data.repo, branch: branch || null, snapshot: using }] });
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
  const latest = picked.filter((r) => r.data.customBranch && !r.notLatest).length;
  if (latest) bits.push(`<p class="daily-warn">${plural(latest, "release is", "releases are")} on another branch without Not latest, so ${latest === 1 ? "it becomes its repo's" : "each becomes its repo's"} Latest release.</p>`);
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
        branch: r.data.customBranch ? r.data.branch : null,
        tag: c.tag,
        sha: r.data.sha,
        previous: r.data.lastTag,
        predicted: c.predicted,
        bump: r.pattern && r.edit == null ? "pattern" : r.bump,
        wrong: r.bump === "predicted" && !r.pattern && c.changed && r.wrong,
        notLatest: r.notLatest,
        snapshot: r.data.snapshot?.name ?? null,
        observed: r.data.branchTag ?? null,
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
  if (out.results.some((x) => x.snapshot)) loadSnapshots();
  if (!out.dryRun && out.results.some((x) => x.ok)) startWatch();
}

function useSnapshot(s) {
  if (busy) return;
  if (!list) {
    note = "The org's repo list hasn't been read yet. Try again when it has";
    return paintWork();
  }
  const names = new Set(list.repos.map((r) => r.name));
  ticked = new Set(s.repos.map((r) => r.repo).filter((n) => names.has(n)));
  const gone = s.repos.length - ticked.size;
  all.branch = s.branch ?? "";
  using = s.name;
  usingNote = gone ? `${plural(gone, "of its repos isn't", "of its repos aren't")} in the org's repo list, so ${gone === 1 ? "it's" : "they're"} left out.` : "";
  mode = "release";
  rows = [];
  previewMeta = null;
  releaseResults = null;
  redraw();
  return preview();
}

function stopUsing() {
  using = null;
  usingNote = "";
  return rows.length ? preview() : paintWork();
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
  const t = e.target;
  if (t.closest && snapClick(t)) return;
  if (!inPage(e)) return;
  if (t.closest("[data-r-snapshots]")) return openSnapshots();
  if (t.closest("[data-x-unsnap]")) return stopUsing();
  if (t.closest("[data-a-savesnap]")) {
    return saveFromPreview(rows.map((r) => ({ repo: r.data.repo, tag: r.data.lastTag, problem: r.data.problem })), all.branch.trim());
  }
  const newer = t.closest("[data-x-newer]");
  if (newer) {
    const i = Number(newer.closest("tr[data-row]").dataset.row);
    const d = rows[i].data;
    newer.disabled = true;
    return takeNewer(d.snapshot.name, d.repo, d.snapshot.newer, d.snapshot.tag).then((ok) => (ok ? previewOne(i, d.customBranch ? d.branch : "") : paintRow(i)));
  }
  if (t.closest("[data-r-refresh]")) return loadList({ force: true });
  const preset = t.closest("[data-r-preset]")?.dataset.rPreset;
  if (preset) {
    if (preset === "needs") ticked = new Set(needsRelease().filter((n) => list.repos.some((r) => r.name === n)));
    else if (preset === "shown") for (const r of visibleRepos()) ticked.add(r.name);
    else ticked.clear();
    return paintList();
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
  const t = e.target;
  if (t.closest && snapChange(t)) return;
  if (!inPage(e)) return;
  if (t.matches("[data-r-tick]")) {
    if (t.checked) ticked.add(t.value);
    else ticked.delete(t.value);
    const count = document.querySelector("[data-rl-count]");
    if (count) count.outerHTML = countHtml();
    return syncWorkCount();
  }
  if (t.matches("[data-a-bump]")) { all.bump = t.value; for (const r of rows) { if (!r.data.dated) r.bump = all.bump; r.edit = null; } return paintWork(); }
  if (t.matches("[data-a-pre]")) { all.pre = t.checked; for (const r of rows) { r.pre = all.pre; r.edit = null; } return paintWork(); }
  if (t.matches("[data-a-notlatest]")) { all.notLatest = t.checked; for (const r of rows) r.notLatest = all.notLatest; return paintWork(); }
  if (t.matches("[data-a-pattern]")) { all.pattern = t.value; for (const r of rows) { r.pattern = all.pattern; r.edit = null; } return paintWork(); }
  if (t.matches("[data-a-branch]")) {
    all.branch = t.value.trim();
    const left = using && all.branch !== (findSnapshot(using)?.branch ?? "") ? using : null;
    if (left) { using = null; usingNote = ""; }
    const said = () => { if (left) { note = `Stopped counting from the ${left} snapshot, since the branch isn't its branch any more`; paintWork(); } };
    return rows.length ? preview().then(said) : said();
  }
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
  const t = e.target;
  if (t.closest && snapInput(t)) return;
  if (!inPage(e)) return;
  if (t.matches("[data-r-search]")) { search = t.value; return paintList(); }
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
  if (e.key === "Enter" && e.target.matches("[data-x-tag], [data-x-branch], [data-a-pattern], [data-a-branch], [data-d-pattern]")) {
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
  using = null;
  usingNote = "";
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
  if ((!list && !listing) || (list && !busy && repoListStale())) loadList();
  loadSnapshots({ ifNeeded: true });
}

initSnapshots({
  call,
  dialog,
  ago,
  plural,
  onLoad: useSnapshot,
  onDeleted: (name) => { if (using === name) stopUsing(); },
  onChange: () => {
    const b = document.querySelector("[data-r-snapshots]");
    if (b) b.textContent = snapshotsLabel();
  },
});
