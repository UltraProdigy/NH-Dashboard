import { API, onUpdatesStamp } from "./live.js";
import { state } from "./state.js";
import { esc, fmt, personName, repoLink, safeUrl } from "./format.js";
import { applyFilter, renderTable, sortRows } from "./table.js";
import { cardReposFrom, exclControlsHtml, isExcludedRepo } from "./dream.js";
import { planUpdates, summarize, UPDATE_KINDS } from "./updates-calc.js";
import { compareVersions } from "./release-tags.js";

const STALE_MS = 5 * 60_000;
const WATCH_MS = 5000;
const JOB_POLL_MS = 3000;
const ONLY_KEY = "nh:updates:onlyOut";
const DEPS_KEY = "nh:updates:countDeps";

let data = null;
let error = null;
let loading = null;
let fetchedAt = 0;
let busy = false;
let seen = null;
let watch = null;
let note = "";
const pinning = new Set();
const opened = new Set();
let redraw = () => {};
let onlyOut = true;
let countDeps = false;
let memo = null;
let behindOn = "any";
const picked = new Set();
const kinds = { buildscript: true, gradle: true, dependencies: true };
let jobs = null;
let jobsError = "";
let jobsLoading = false;
let jobTimer = null;
let jobsOpen = false;
let submitting = false;

try {
  onlyOut = localStorage.getItem(ONLY_KEY) !== "0";
  countDeps = localStorage.getItem(DEPS_KEY) === "1";
} catch {}

const remember = (key, on) => { try { localStorage.setItem(key, on ? "1" : "0"); } catch {} };

export function onUpdatesChange(fn) {
  redraw = fn;
}

onUpdatesStamp((at) => {
  if (data && at && at !== seen && !busy && !watch) loadUpdates();
});

cardReposFrom("updates", () => (data?.scan?.repos ?? []).map((r) => r.name));

function summary() {
  if (!data?.scan) return null;
  if (memo?.scan === data.scan && memo.pins === data.pins && memo.countDeps === countDeps) return memo.value;
  memo = { scan: data.scan, pins: data.pins, countDeps, value: summarize(data.scan, { pins: data.pins, countDeps }) };
  return memo.value;
}

function ago(iso) {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 90) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 36 ? `${hours} hr ago` : `${Math.round(hours / 24)} days ago`;
}

async function readBody(res) {
  const body = await res.json().catch(() => ({}));
  if (res.status === 403) throw new Error("Only the admin team can see build updates.");
  if (!res.ok) throw new Error(body.error ?? `The dashboard answered ${res.status}.`);
  return body;
}

const reachError = (err) => (err instanceof TypeError ? "The dashboard couldn't be reached." : err.message);

export function loadUpdates() {
  if (loading) return loading;
  loading = (async () => {
    await null;
    try {
      data = await readBody(await fetch(`${API}/api/updates`, { cache: "no-store" }));
      seen = data.stamp ?? null;
      error = null;
    } catch (err) {
      error = reachError(err);
    } finally {
      fetchedAt = Date.now();
      loading = null;
      watchOthers();
      redraw();
    }
  })();
  return loading;
}

const othersScan = () => (!busy && data?.scanning) || null;

function watchOthers() {
  clearTimeout(watch);
  watch = othersScan() ? setTimeout(loadUpdates, WATCH_MS) : null;
}

async function scan() {
  if (busy || othersScan()) return;
  busy = true;
  note = "";
  redraw();
  try {
    const res = await fetch(`${API}/api/updates/scan`, { method: "POST", cache: "no-store" });
    if (res.status === 409) {
      const body = await res.json().catch(() => ({}));
      data = { ...data, scanning: body.scanning ?? { by: "another admin" } };
      return;
    }
    data = await readBody(res);
    seen = data.stamp ?? seen;
    fetchedAt = Date.now();
    error = null;
    const errs = data.scan?.errors?.length ?? 0;
    note = errs ? `Scanned, but ${errs} part${errs === 1 ? "" : "s"} couldn't be read. See the list under the table.` : "";
  } catch (err) {
    note = reachError(err);
    loadUpdates();
  } finally {
    busy = false;
    watchOthers();
    redraw();
  }
}

async function pin(repo, dep, pinned) {
  const key = `${repo}\n${dep}`;
  if (pinning.has(key)) return;
  pinning.add(key);
  redraw();
  try {
    const body = await readBody(await fetch(`${API}/api/updates/pin`, {
      method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo, dep, pinned }),
    }));
    data = { ...data, pins: body.pins };
    seen = body.stamp ?? seen;
  } catch (err) {
    note = reachError(err);
  } finally {
    pinning.delete(key);
    redraw();
  }
}

function ensureLoaded() {
  if (!loading && (!data || Date.now() - fetchedAt > STALE_MS)) loadUpdates();
}

function visibleRows(s) {
  return applyFilter(s.rows.map((r) => ({ ...r, repo: r.name })).filter((r) => !isExcludedRepo("updates", r.name)));
}

const BEHIND = {
  buildscript: (r) => r.bsStatus === "behind",
  gradle: (r) => r.gradleStatus === "behind",
  dependencies: (r) => r.depsBehind > 0,
};

function shownRows(all, expanded) {
  if (!expanded) return all.filter((r) => r.outOfSync);
  if (BEHIND[behindOn]) return all.filter(BEHIND[behindOn]);
  return onlyOut ? all.filter((r) => r.outOfSync) : all;
}

export const updatesTier = () => (error && !data ? "down" : "manual");

export function updatesCount() {
  const s = summary();
  return s ? visibleRows(s).filter((r) => r.outOfSync).length : null;
}

const repoUrl = (name) => `https://github.com/${encodeURIComponent(data?.scan?.org ?? "GTNewHorizons")}/${encodeURIComponent(name)}`;

function depRepoName(dep) {
  const lower = dep.toLowerCase();
  return data?.scan?.repos?.find((r) => r.name.toLowerCase() === lower)?.name ?? dep;
}

function bsText(r) {
  if (!r.buildscript) return `<span class="sub">—</span>`;
  const v = r.buildscript.kind === "legacy"
    ? `<span title="Old buildscript, no settings convention plugin">legacy <code>${esc(r.buildscript.version)}</code></span>`
    : `<code>${esc(r.buildscript.version)}</code>`;
  if (r.bsStatus === "behind") return `${v} <span class="pill neutral">behind</span>`;
  if (r.bsStatus === "legacy") return `${v} <span class="pill dropped">migrate</span>`;
  return v;
}

function gradleText(r) {
  if (!r.gradle) return `<span class="sub">—</span>`;
  return `<code>${esc(r.gradle)}</code>${r.gradleStatus === "behind" ? ` <span class="pill neutral">behind</span>` : ""}`;
}

function depLine(r, d) {
  const busyPin = pinning.has(`${r.name}\n${d.name}`);
  const latest = d.latest
    ? `<a href="${safeUrl(`${repoUrl(depRepoName(d.name))}/releases/tag/${encodeURIComponent(d.latest)}`)}" target="_blank" rel="noopener"><code>${esc(d.latest)}</code></a>`
    : "";
  const pinBtn = `<button class="ghost upd-pin" data-upd-pin="${esc(r.name)}" data-dep="${esc(d.name)}" data-on="${d.pinned ? 0 : 1}"${busyPin ? " disabled" : ""}
    title="${d.pinned ? "Count this dependency again" : "Stop counting this dependency as behind in this repo"}">${d.pinned ? "Unpin" : "Pin"}</button>`;
  const tag = d.status === "pinned" ? ` <span class="pill draft">pinned</span>` : "";
  return `<li><span class="upd-dep">${esc(d.name)}</span> <code>${esc(d.version)}</code> → ${latest}${tag} ${pinBtn}</li>`;
}

function depsText(r, expanded) {
  const behind = r.depRows.filter((d) => d.status === "behind" || d.status === "pinned");
  if (!r.depRows.length) return `<span class="sub">—</span>`;
  if (!behind.length) return `<span class="sub">${fmt(r.depRows.length)} up to date</span>`;
  const label = `${fmt(r.depsBehind)} behind${r.depsBehind < behind.length ? `, ${behind.length - r.depsBehind} pinned` : ""}`;
  if (!expanded) return r.depsBehind ? `<span class="num">${fmt(r.depsBehind)}</span>` : `<span class="sub">pinned</span>`;
  return `<details class="upd-deps" data-upd-open="${esc(r.name)}"${opened.has(r.name) ? " open" : ""}><summary>${label}</summary><ul>${behind.map((d) => depLine(r, d)).join("")}</ul></details>`;
}

function statusText(r) {
  if (!r.outOfSync) return `<span class="pill open">In sync</span>`;
  const names = { buildscript: "Buildscript", gradle: "Gradle", dependencies: "Deps" };
  return r.reasons.map((k) => `<span class="pill neutral">${names[k]}</span>`).join(" ");
}

const KIND = { legacy: 1, plugin: 2 };

// Repos missing the thing sink to the bottom whichever way the column is sorted.
function byVersion(pick) {
  return (a, b, dir) => {
    const x = pick(a), y = pick(b);
    if (!x || !y) return (x ? 0 : 1) - (y ? 0 : 1);
    return dir * ((KIND[x.kind] ?? 0) - (KIND[y.kind] ?? 0) || compareVersions(x.version, y.version)) || a.name.localeCompare(b.name);
  };
}

const bsOf = (r) => r.buildscript;
const gradleOf = (r) => (r.gradle ? { version: r.gradle } : null);

function selectCol(shown) {
  const on = shown.filter((r) => picked.has(r.name)).length;
  const all = shown.length > 0 && on === shown.length;
  return {
    key: "pick", sortable: false,
    label: `<input type="checkbox" data-upd-pickall aria-label="Select every repo shown"${all ? " checked" : ""}>`,
    render: (r) => `<input type="checkbox" data-upd-pick="${esc(r.name)}" aria-label="Select ${esc(r.name)}"${picked.has(r.name) ? " checked" : ""}>`,
  };
}

function columns(expanded, shown = []) {
  const cols = [
    { key: "repo", label: "Repo", get: (r) => r.name.toLowerCase(), render: (r) => `${repoLink(r.name)}${r.fork ? ` <span class="pill draft">fork</span>` : ""}` },
    { key: "buildscript", label: "Buildscript", compare: byVersion(bsOf), render: bsText },
    { key: "gradle", label: "Gradle", compare: byVersion(gradleOf), render: gradleText },
    { key: "deps", label: expanded ? "Dependencies" : "Deps behind", get: (r) => r.depsBehind, render: (r) => depsText(r, expanded) },
  ];
  if (expanded) cols.push({ key: "status", label: "Needs", get: (r) => r.reasons.length, sortable: true, render: statusText });
  if (expanded) cols.unshift(selectCol(shown));
  return cols;
}

function targetsLine(s) {
  const bs = s.target.buildscript;
  const bsText = bs ? (bs.kind === "plugin" ? `buildscript <code>${esc(bs.version)}</code>` : `buildscript <code>${esc(bs.version)}</code> (legacy)`) : "no buildscript found";
  return `Newest in the org: ${bsText} · Gradle ${s.target.gradle ? `<code>${esc(s.target.gradle)}</code>` : "—"}`;
}

function scanLine() {
  const sc = data.scan;
  const skipped = sc.skipped ?? {};
  const bits = [`Scanned ${esc(ago(sc.scannedAt))}${sc.by ? ` by ${esc(personName(sc.by))}` : ""}`];
  bits.push(`${fmt(sc.repos.length)} repos with Gradle files`);
  const left = [
    skipped.noGradle && `${fmt(skipped.noGradle)} without`,
    skipped.archived && `${fmt(skipped.archived)} archived`,
    skipped.excluded && `${fmt(skipped.excluded)} excluded`,
  ].filter(Boolean);
  if (left.length) bits.push(`skipped ${left.join(", ")}`);
  return bits.join(" · ");
}

function togglesHtml() {
  const opt = (v, label) => `<option value="${v}"${behindOn === v ? " selected" : ""}>${label}</option>`;
  return `<div class="upd-bar">
    <label class="minlabel">behind on <select class="inline-sel" data-upd-behind>${opt("any", "anything")}${opt("buildscript", "buildscript")}${opt("gradle", "Gradle")}${opt("dependencies", "dependencies")}</select></label>
    <label class="minlabel${BEHIND[behindOn] ? " upd-off" : ""}"><input type="checkbox" data-upd-only${onlyOut ? " checked" : ""}${BEHIND[behindOn] ? " disabled" : ""}> only out of sync</label>
    <label class="minlabel" title="Off by default: nearly every repo is behind on something, so deps would drown out the buildscript and Gradle gaps"><input type="checkbox" data-upd-deps${countDeps ? " checked" : ""}> count dependencies as out of sync</label>
  </div>`;
}

const KIND_NAME = { buildscript: "Buildscript", gradle: "Gradle", dependencies: "Dependencies" };

function pickedNames() {
  const names = new Set((data?.scan?.repos ?? []).map((r) => r.name));
  for (const n of picked) if (!names.has(n)) picked.delete(n);
  return [...picked];
}

function prBarHtml(shown) {
  const n = pickedNames().length;
  const anyKind = UPDATE_KINDS.some((k) => kinds[k]);
  const active = jobActive();
  const why = !n ? "Select repos in the table first" : !anyKind ? "Tick at least one part to update" : active ? "Another update PR job is still running" : "";
  return `<div class="upd-bar upd-prbar">
    <span class="minlabel"><strong>Update PRs</strong></span>
    ${UPDATE_KINDS.map((k) => `<label class="minlabel"><input type="checkbox" data-upd-kind="${k}"${kinds[k] ? " checked" : ""}> ${k === "gradle" ? "Gradle" : k}</label>`).join("")}
    <span class="upd-sep"></span>
    <button class="ghost mini" data-upd-pickshown${shown.length ? "" : " disabled"}>Select ${fmt(shown.length)} shown</button>
    <button class="ghost mini" data-upd-pickclear${n ? "" : " disabled"}>Clear</button>
    <span class="minlabel">${fmt(n)} selected</span>
    <button class="daily-go" data-upd-open${why || submitting ? " disabled" : ""} title="${esc(why || "Review what each repo gets, then open the PRs as Org-Manager")}">${submitting ? "Queueing…" : "Open PRs…"}</button>
  </div>`;
}

export function updatesHtml(expanded) {
  ensureLoaded();
  if (expanded) ensureJobs();
  if (!data) {
    if (error) return `<div class="error">${esc(error)}</div>`;
    return `<div class="empty">Loading the last scan…</div>`;
  }
  if (!data.scan) {
    return `<div class="empty">${busy || othersScan() ? "Reading every repo's Gradle files from GitHub. This takes a few seconds…"
      : "Nothing scanned yet. Press <strong>Refresh</strong> to read every repo's buildscript, Gradle wrapper and dependencies."}</div>`;
  }
  const s = summary();
  const all = visibleRows(s);
  const shown = shownRows(all, expanded);
  const cols = columns(expanded, shown);
  const head = expanded
    ? `<div class="upd-head"><p class="sub">${targetsLine(s)}</p><p class="sub">${scanLine()}</p>${togglesHtml()}${prBarHtml(shown)}${jobHtml()}</div>`
    : "";
  const errors = expanded && data.scan.errors?.length
    ? `<div class="upd-errors"><p class="sub">Some files couldn't be read, so these repos may show less than they have:</p><ul>${
      data.scan.errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>`
    : "";
  if (!shown.length) {
    const why = BEHIND[behindOn] ? `Nothing is behind on ${KIND_NAME[behindOn].toLowerCase()}.`
      : all.length ? "Every repo is on the newest buildscript and Gradle." : "No repos match.";
    return `${head}<div class="empty">${why}</div>${errors}`;
  }
  const table = renderTable(expanded ? sortRows(shown, cols) : shown, cols, { sortable: expanded, limit: expanded ? null : 10 });
  return `${head}${table}${errors}`;
}

export function updatesSubHtml() {
  const s = summary();
  const scanning = busy || othersScan();
  if (!s) return `<span class="sub">${scanning ? "scanning…" : "buildscript, Gradle and dependencies"}</span>`;
  const c = s.counts;
  const parts = [`${fmt(updatesCount())} of ${fmt(c.repos)} out of sync`];
  if (scanning) parts.push("scanning…");
  else parts.push(`scanned ${ago(data.scan.scannedAt)}`);
  return `<span class="sub">${esc(parts.join(" · "))}</span>`;
}

export function updatesControlsHtml() {
  const other = othersScan();
  const title = other
    ? `${personName(other.by)} started a scan ${ago(other.at)}. This card reloads when it lands.`
    : "Read every repo's settings.gradle, gradle-wrapper.properties and dependencies.gradle from GitHub again";
  const refresh = `<button class="ghost" data-upd-scan${busy || other ? " disabled" : ""} title="${esc(title)}">${
    busy ? "Scanning…" : other ? `Scanning… (${esc(personName(other.by))})` : "Refresh"}</button>${
    note ? `<span class="minlabel upd-note">${esc(note)}</span>` : ""}`;
  return exclControlsHtml("updates", refresh);
}

globalThis.document?.addEventListener("click", (e) => {
  if (e.target.closest?.("button[data-upd-scan]")) return scan();
  if (e.target.closest?.("button[data-upd-open]")) return confirmPrs();
  if (e.target.closest?.("button[data-upd-cancel]")) return cancelJob(e.target.closest("button").dataset.updCancel);
  if (e.target.closest?.("button[data-upd-pickshown]")) {
    const s = summary();
    if (s) for (const r of shownRows(visibleRows(s), true)) picked.add(r.name);
    return redraw();
  }
  if (e.target.closest?.("button[data-upd-pickclear]")) {
    picked.clear();
    return redraw();
  }
  const p = e.target.closest?.("button[data-upd-pin]");
  if (p) {
    e.preventDefault();
    pin(p.dataset.updPin, p.dataset.dep, p.dataset.on === "1");
  }
});

globalThis.document?.addEventListener("change", (e) => {
  if (e.target.matches?.("[data-upd-pick]")) {
    if (e.target.checked) picked.add(e.target.dataset.updPick);
    else picked.delete(e.target.dataset.updPick);
    redraw();
  } else if (e.target.matches?.("[data-upd-pickall]")) {
    const s = summary();
    const shown = s ? shownRows(visibleRows(s), true) : [];
    for (const r of shown) e.target.checked ? picked.add(r.name) : picked.delete(r.name);
    redraw();
  } else if (e.target.matches?.("[data-upd-kind]")) {
    kinds[e.target.dataset.updKind] = e.target.checked;
    redraw();
  } else if (e.target.matches?.("[data-upd-behind]")) {
    behindOn = e.target.value;
    redraw();
  } else if (e.target.matches?.("[data-upd-only]")) {
    onlyOut = e.target.checked;
    remember(ONLY_KEY, onlyOut);
    redraw();
  } else if (e.target.matches?.("[data-upd-deps]")) {
    countDeps = e.target.checked;
    remember(DEPS_KEY, countDeps);
    redraw();
  }
});

globalThis.document?.addEventListener("toggle", (e) => {
  if (e.target.matches?.("[data-upd-job]")) {
    jobsOpen = e.target.open;
    return;
  }
  const name = e.target.dataset?.updOpen;
  if (name == null) return;
  if (e.target.open) opened.add(name);
  else opened.delete(name);
}, true);

/* ---- update PRs ---- */

const jobActive = () => Boolean(jobs?.jobs?.some((j) => j.state === "queued" || j.state === "running"));

function ensureJobs() {
  if (!jobs && !jobsLoading && !jobsError) loadJobs();
}

async function loadJobs() {
  if (jobsLoading) return;
  jobsLoading = true;
  clearTimeout(jobTimer);
  try {
    jobs = await readBody(await fetch(`${API}/api/updates/prs`, { cache: "no-store" }));
    jobsError = "";
  } catch (err) {
    jobsError = reachError(err);
  } finally {
    jobsLoading = false;
    jobTimer = jobActive() ? setTimeout(loadJobs, JOB_POLL_MS) : null;
    redraw();
  }
}

const STATUS_PILL = {
  done: ["open", "done"], skipped: ["draft", "skipped"], failed: ["dropped", "failed"],
  pending: ["unknown", "waiting"], cancelled: ["draft", "cancelled"],
};

function partsText(plan) {
  return [
    plan.buildscript && `buildscript ${plan.buildscript.from} → ${plan.buildscript.to}`,
    plan.gradle && `Gradle ${plan.gradle.from} → ${plan.gradle.to}`,
    plan.dependencies?.length && `${plan.dependencies.length} dep${plan.dependencies.length === 1 ? "" : "s"}`,
  ].filter(Boolean).join(", ");
}

function jobHtml() {
  if (jobsError && !jobs) return `<p class="sub upd-job-err">${esc(jobsError)}</p>`;
  const f = jobs?.focus;
  if (!f) return "";
  const c = f.counts ?? {};
  const settled = f.total - (c.pending ?? 0);
  const running = f.state === "running" || f.state === "queued";
  const queued = (jobs.jobs ?? []).filter((j) => j.state === "queued" && j.id !== f.id).length;
  const head = [
    `${f.dry ? "Dry run" : "Update PRs"} by ${esc(personName(f.by))}`,
    running ? `${fmt(settled)} of ${fmt(f.total)}` : esc(f.state),
    c.done ? `${fmt(c.done)} ${f.dry ? "ready" : "opened"}` : "",
    c.skipped ? `${fmt(c.skipped)} skipped` : "",
    c.failed ? `${fmt(c.failed)} failed` : "",
    f.waitUntil && running ? `waiting until ${new Date(f.waitUntil).toLocaleTimeString()} (${esc(f.waitNote ?? "")})` : "",
    queued ? `${queued} more queued` : "",
    f.state === "cancelled" && f.cancelledBy ? `cancelled by ${esc(personName(f.cancelledBy))}` : "",
  ].filter(Boolean).join(" · ");
  const cancel = running ? ` <button class="ghost mini" data-upd-cancel="${esc(f.id)}"${f.cancelling ? " disabled" : ""}>${f.cancelling ? "Cancelling…" : "Cancel"}</button>` : "";
  const rows = f.items.map((it) => {
    const [cls, word] = STATUS_PILL[it.status] ?? ["unknown", it.status];
    const link = it.url ? ` <a href="${safeUrl(it.url)}" target="_blank" rel="noopener">PR</a>` : "";
    return `<li><span class="pill ${cls}">${esc(word)}</span> ${repoLink(it.repo)} <span class="sub">${esc(it.note ?? partsText(it.plan))}</span>${link}</li>`;
  }).join("");
  return `<details class="upd-job" data-upd-job${jobsOpen || running ? " open" : ""}>
    <summary>${head}</summary>${cancel}<ul>${rows}</ul></details>`;
}

async function cancelJob(id) {
  try {
    await readBody(await fetch(`${API}/api/updates/prs/cancel`, {
      method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ job: id }),
    }));
  } catch (err) {
    note = reachError(err);
  }
  loadJobs();
}

function prDialog(html, onClose) {
  const d = document.createElement("dialog");
  d.className = "daily-dialog upd-dialog";
  d.innerHTML = html;
  d.addEventListener("click", (e) => {
    const pick = e.target.closest("[data-dlg]")?.dataset.dlg;
    if (pick) d.close(pick);
  });
  d.addEventListener("close", () => {
    const dry = d.querySelector("[data-dlg-dry]")?.checked;
    const value = d.returnValue;
    d.remove();
    onClose(value, dry);
  });
  document.body.appendChild(d);
  d.showModal();
}

function confirmPrs() {
  if (!data?.scan) return;
  const repos = pickedNames();
  const plan = planUpdates(data.scan, { pins: data.pins ?? [], repos, kinds });
  const t = plan.target;
  const parts = [
    kinds.buildscript && t.buildscript && `<li>Buildscript → <code>${esc(t.buildscript.version)}</code> in <code>settings.gradle</code></li>`,
    kinds.gradle && t.gradle && `<li>Gradle → <code>${esc(t.gradle)}</code>, wrapper files copied from ${plan.source ? repoLink(plan.source) : "—"}</li>`,
    kinds.dependencies && `<li>GTNH dependencies → each one's newest tag, pinned ones left alone</li>`,
  ].filter(Boolean).join("");
  const rows = plan.items.map((i) => `<li>${repoLink(i.repo)} <span class="sub">${esc(partsText(i))}</span></li>`).join("");
  const skipped = plan.skipped.length
    ? `<details><summary class="sub">${fmt(plan.skipped.length)} selected repo${plan.skipped.length === 1 ? "" : "s"} won't get a PR</summary><ul>${
      plan.skipped.map((x) => `<li>${esc(x.repo)} <span class="sub">${esc(x.why)}</span></li>`).join("")}</ul></details>`
    : "";
  const n = plan.items.length;
  prDialog(`<h3>Open update PRs on ${fmt(n)} repo${n === 1 ? "" : "s"}?</h3>
    <p>Org-Manager opens one PR per repo against its default branch, with a commit for each part:</p>
    <ul>${parts}</ul>
    ${n ? `<div class="upd-plan"><ul>${rows}</ul></div>` : `<p class="daily-warn">None of the selected repos have anything to update for the ticked parts.</p>`}
    ${skipped}
    <p class="sub">Files are re-read when each PR is made, so anything already updated since the scan is left out. Repos with an open update PR are skipped.</p>
    <label class="minlabel"><input type="checkbox" data-dlg-dry> dry run: read the repos and report what would change, without opening anything</label>
    <div class="daily-actions"><span class="daily-link"></span>
      <button type="button" class="ghost" data-dlg="cancel" autofocus>Cancel</button>
      <button type="button" class="daily-go" data-dlg="go"${n ? "" : " disabled"}>Open ${fmt(n)} PR${n === 1 ? "" : "s"}</button></div>`,
  (v, dry) => { if (v === "go") submitPrs(repos, dry); });
}

async function submitPrs(repos, dry) {
  if (submitting) return;
  submitting = true;
  note = "";
  redraw();
  try {
    const body = await readBody(await fetch(`${API}/api/updates/prs`, {
      method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repos, kinds, dry: Boolean(dry) }),
    }));
    note = `${body.dry ? "Dry run" : "PRs"} queued for ${body.total} repo${body.total === 1 ? "" : "s"}${body.ahead ? `, after ${body.ahead} other job${body.ahead === 1 ? "" : "s"}` : ""}.`;
    jobsOpen = true;
    picked.clear();
  } catch (err) {
    note = reachError(err);
  } finally {
    submitting = false;
    loadJobs();
  }
}
