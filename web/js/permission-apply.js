import { API } from "./live.js";
import { esc, personName } from "./format.js";
import { describe, isInvite, isRisky, keyOf, needsOwner } from "./permission-changes.js";

const DRAFT_KEY = "nh:perm-staged";
const DISMISSED_KEY = "nh:perm-dismissed";
const PING_MS = 25_000;
const MAX_RETRY_MS = 30_000;

const staged = new Map();
let ctx = { data: () => null, redraw: () => {}, reload: () => {} };
let jobs = [];
let focus = null;
let socket = null;
let wanted = false;
let retries = 0;
let retryTimer = null;
let pingTimer = null;
let reloadTimer = null;
let dismissed = null;
let applying = false;

try {
  for (const c of JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "[]")) if (keyOf(c)) staged.set(keyOf(c), c);
  dismissed = localStorage.getItem(DISMISSED_KEY);
} catch {}

function save() {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify([...staged.values()])); } catch {}
}

export function configureApply(next) {
  ctx = { ...ctx, ...next };
}

const same = (a, b) => (a ?? null) === (b ?? null);

export const stagedFor = (key) => staged.get(key) ?? null;
export const stagedList = () => [...staged.values()];
export const stagedCount = () => staged.size;

export function stage(change, { quiet = false } = {}) {
  const key = keyOf(change);
  if (!key) return;
  const before = staged.get(key);
  const c = before ? { ...change, from: before.from } : change;
  if (c.kind !== "team_create" && same(c.from, c.to)) staged.delete(key);
  else staged.set(key, c);
  save();
  if (!quiet) ctx.redraw();
}

export function stageMany(changes) {
  for (const c of changes) stage(c, { quiet: true });
  ctx.redraw();
}

export function unstage(key) {
  staged.delete(key);
  save();
  ctx.redraw();
}

function clearStaged() {
  staged.clear();
  save();
  ctx.redraw();
}

/* ---- what a staged change needs flagged ---- */

export function adminTeamId(data = ctx.data()) {
  return Object.values(data?.teams ?? {}).find((t) => t.slug === data?.viewer?.adminTeam)?.id ?? null;
}

export const ownerOnly = (c, data = ctx.data()) => needsOwner(c, adminTeamId(data)) && !data?.viewer?.ownerEdits;

const teamName = (data) => (id) => data?.teams?.[id]?.name ?? `team ${id}`;

function gone(c, data) {
  if (c.team && !data.teams?.[c.team.id]) return "that team isn't there any more";
  if (c.repo && !data.repos?.[c.repo.id]) return "that repo isn't there any more";
  return null;
}

export function flagsOf(c, data = ctx.data()) {
  const isMember = (login) => Object.keys(data?.org?.members ?? {}).some((m) => m.toLowerCase() === login.toLowerCase());
  return {
    invite: isInvite(c, isMember),
    risky: isRisky(c),
    blocked: ownerOnly(c, data) ? "only an org owner can make this change" : gone(c, data),
    deletesChildren: c.kind === "team_delete" && Object.values(data?.teams ?? {}).some((t) => String(t.parent) === String(c.team.id)),
  };
}

const flagPills = (f) => [
  f.invite ? `<span class="pill neutral" title="GitHub will send an invite, and nothing changes until it's accepted">invite</span>` : "",
  f.risky ? `<span class="pill perm-risky">check</span>` : "",
  f.deletesChildren ? `<span class="pill perm-risky" title="GitHub deletes a team's child teams with it">deletes child teams</span>` : "",
  f.blocked ? `<span class="pill perm-blocked" title="${esc(f.blocked)}">${f.blocked.startsWith("only") ? "owner only" : "gone"}</span>` : "",
].join(" ");

function subjectOf(c, data) {
  if (c.kind === "team_create") return { key: "new", label: "New teams" };
  if (c.team) return { key: `team:${c.team.id}`, label: `Team ${data.teams?.[c.team.id]?.name ?? c.team.name}` };
  if (c.kind === "visibility" || c.kind === "archived") return { key: `repo:${c.repo.id}`, label: c.repo.name };
  return { key: `person:${c.login.toLowerCase()}`, label: c.login };
}

/* ---- review ---- */

function reviewHtml(data, problem = null) {
  const list = stagedList();
  const groups = new Map();
  for (const c of list) {
    const s = subjectOf(c, data);
    if (!groups.has(s.key)) groups.set(s.key, { label: s.label, rows: [] });
    groups.get(s.key).rows.push(c);
  }
  const blocked = list.filter((c) => flagsOf(c, data).blocked).length;
  const canApply = data?.viewer?.canApply;
  const groupHtml = [...groups.values()].map((g) => `<section class="perm-rgroup"><h4>${esc(g.label)}</h4><ul>${g.rows.map((c) => {
    const f = flagsOf(c, data);
    return `<li class="${f.blocked ? "perm-rblocked" : ""}"><span>${esc(describe(c, { teamName: teamName(data) }))}</span> ${flagPills(f)}
      <button type="button" class="perm-x" data-unstage="${esc(keyOf(c))}" aria-label="Remove this change">✕</button></li>`;
  }).join("")}</ul></section>`).join("");
  const running = jobs.some((j) => j.state === "running" || j.state === "queued");
  const notes = [
    !canApply ? `<p class="daily-warn">Org-Manager's key isn't set on the app Worker, so nothing can be applied yet.</p>` : "",
    blocked ? `<p class="daily-warn">${blocked === 1 ? "One change" : `${blocked} changes`} can't be applied by you. Remove ${blocked === 1 ? "it" : "them"} to go on.</p>` : "",
    running ? `<p class="daily-last">A batch is running. This one will start when it's finished.</p>` : "",
    problem ? `<div class="daily-warn">${problem}</div>` : "",
  ].join("");
  return `<h3>Review ${list.length === 1 ? "1 change" : `${list.length} changes`}</h3>
    <p>Nothing has been sent yet. Each change is made by Org-Manager, one at a time, and checked against GitHub right before it's made. One that no longer
      matches what you saw is skipped, not forced. Your name goes on each line in Recent changes.</p>
    <div class="perm-review-list">${groupHtml || `<p class="sub">Nothing staged.</p>`}</div>
    ${notes}
    <div class="daily-actions">
      <button type="button" class="ghost" data-review="clear"${list.length ? "" : " disabled"}>Clear all</button>
      <span class="ra-count"></span>
      <button type="button" class="ghost" data-review="close">Keep editing</button>
      <button type="button" class="daily-go" data-review="apply"${!list.length || blocked || !canApply || applying ? " disabled" : ""}>${applying ? "Sending…" : `Apply ${list.length === 1 ? "1 change" : `${list.length} changes`}`}</button>
    </div>`;
}

function problemText(body, list, data) {
  if (!body?.problems?.length) return esc(body?.error ?? "The batch couldn't be sent.");
  return `${esc(body.error)}:<ul>${body.problems.map((p) => {
    const c = list[p.n];
    return `<li>${c ? esc(describe(c, { teamName: teamName(data) })) : esc(p.kind ?? "a change")}: ${esc(p.error)}</li>`;
  }).join("")}</ul>`;
}

export function openReview() {
  const dialog = document.createElement("dialog");
  dialog.className = "daily-dialog perm-review";
  let problem = null;
  const paint = () => { dialog.innerHTML = reviewHtml(ctx.data(), problem); };
  dialog.addEventListener("click", async (e) => {
    const un = e.target.closest("[data-unstage]");
    if (un) { unstage(un.dataset.unstage); return paint(); }
    const act = e.target.closest("[data-review]")?.dataset.review;
    if (act === "close") return dialog.close();
    if (act === "clear") { clearStaged(); return dialog.close(); }
    if (act === "apply") {
      const list = stagedList();
      applying = true;
      problem = null;
      paint();
      try {
        const res = await fetch(`${API}/api/permissions/apply`, {
          method: "POST",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ changes: list }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) problem = problemText(body, list, ctx.data());
        else {
          for (const c of list) staged.delete(keyOf(c));
          save();
          dismissed = null;
          try { localStorage.removeItem(DISMISSED_KEY); } catch {}
          connect();
          applying = false;
          dialog.close();
          ctx.redraw();
          return;
        }
      } catch {
        problem = "The batch couldn't be sent.";
      }
      applying = false;
      paint();
    }
  });
  dialog.addEventListener("close", () => { dialog.remove(); ctx.redraw(); });
  document.body.appendChild(dialog);
  paint();
  dialog.showModal();
}

/* ---- the running batch ---- */

const STATUS_LABEL = { done: "done", invited: "invited", skipped: "skipped", failed: "failed", cancelled: "not run", pending: "waiting" };

function resultsHtml(job, data) {
  const items = job.items ?? [];
  const order = { failed: 0, skipped: 1, cancelled: 2, invited: 3, done: 4, pending: 5 };
  const rows = [...items].sort((a, b) => order[a.status] - order[b.status] || a.i - b.i).map((it) =>
    `<li><span class="pill perm-st perm-st-${esc(it.status)}">${esc(STATUS_LABEL[it.status] ?? it.status)}</span>
      <span>${esc(describe(it.change, { teamName: teamName(data) }))}</span>${it.note ? ` <span class="sub">${esc(it.note)}</span>` : ""}</li>`).join("");
  return `<h3>${job.state === "running" ? "Applying" : job.state === "cancelled" ? "Cancelled" : "Finished"}: ${countsText(job)}</h3>
    <p class="daily-last">Sent by ${esc(personName(job.by))}${job.dry ? ", as a dry run" : ""}${job.cancelledBy ? `, cancelled by ${esc(personName(job.cancelledBy))}` : ""}.
      Results stay here until the next batch starts.</p>
    <ul class="perm-results-list">${rows}</ul>
    <div class="daily-actions"><span class="ra-count"></span><button type="button" class="ghost" data-close autofocus>Close</button></div>`;
}

let resultsDialog = null;

export function openResults() {
  if (!focus) return;
  const dialog = document.createElement("dialog");
  dialog.className = "daily-dialog perm-review";
  dialog.innerHTML = resultsHtml(focus, ctx.data());
  dialog.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) dialog.close(); });
  dialog.addEventListener("close", () => { dialog.remove(); resultsDialog = null; });
  resultsDialog = dialog;
  document.body.appendChild(dialog);
  dialog.showModal();
}

function countsText(job) {
  const c = job.counts ?? {};
  const parts = [
    c.done ? `${c.done} done` : "",
    c.invited ? `${c.invited} invited` : "",
    c.skipped ? `${c.skipped} skipped` : "",
    c.failed ? `${c.failed} failed` : "",
    c.cancelled ? `${c.cancelled} not run` : "",
  ].filter(Boolean);
  return parts.join(" · ") || "nothing yet";
}

function trayHtml() {
  const data = ctx.data();
  const n = staged.size;
  const running = focus?.state === "running" ? focus : null;
  const queued = jobs.filter((j) => j.state === "queued").length;
  const stagedBit = n
    ? `<span class="perm-tray-count"><strong>${n}</strong> saved ${n === 1 ? "change" : "changes"} waiting to be applied</span>
       <button type="button" class="daily-go" data-tray="review">Review &amp; apply</button>`
    : "";
  if (running) {
    const total = running.total || 1;
    const left = running.counts?.pending ?? 0;
    const done = total - left;
    const current = running.items?.find((it) => it.status === "pending");
    return `<div class="perm-tray perm-running" role="status">
      <div class="perm-bar-track"><div class="perm-bar-fill" style="width:${Math.round((done / total) * 100)}%"></div></div>
      <span><strong>${running.dry ? "Dry run" : "Applying"}</strong> ${done} of ${total}${countsText(running) !== "nothing yet" ? ` · ${countsText(running)}` : ""}</span>
      ${current ? `<span class="sub perm-tray-now">now: ${esc(describe(current.change, { teamName: teamName(data) }))}</span>` : ""}
      ${running.waitNote ? `<span class="sub lb-warn">${esc(running.waitNote)}</span>` : ""}
      ${queued ? `<span class="sub">+${queued} waiting</span>` : ""}
      <span class="perm-tray-gap"></span>
      ${stagedBit}
      <button type="button" class="ghost" data-tray="results">Details</button>
      <button type="button" class="ghost" data-tray="cancel"${running.cancelling ? " disabled" : ""}>${running.cancelling ? "Cancelling…" : "Cancel"}</button>
    </div>`;
  }
  const finished = focus && focus.state !== "queued" && focus.id !== dismissed ? focus : null;
  if (!n && !finished && !queued) return "";
  return `<div class="perm-tray" role="status">
    ${finished ? `<span>Last batch ${finished.state === "cancelled" ? "cancelled" : "finished"}: ${countsText(finished)}</span>
      <button type="button" class="ghost" data-tray="results">Results</button>
      ${n ? "" : `<button type="button" class="ghost" data-tray="dismiss">Dismiss</button>`}` : ""}
    ${queued ? `<span class="sub">${queued} batch${queued === 1 ? "" : "es"} waiting to start</span>` : ""}
    <span class="perm-tray-gap"></span>
    ${stagedBit}
    ${n ? `<button type="button" class="ghost" data-tray="clear">Clear</button>` : ""}
  </div>`;
}

export function paintTray() {
  const el = document.querySelector("[data-perm-tray]");
  if (el) el.innerHTML = trayHtml();
  document.querySelector("[data-perm]")?.classList.toggle("has-tray", Boolean(el?.innerHTML.trim()));
}

export const trayMarkup = () => `<div class="perm-tray-wrap" data-perm-tray>${trayHtml()}</div>`;

async function cancel() {
  if (!focus) return;
  await fetch(`${API}/api/permissions/cancel`, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job: focus.id }),
  }).catch(() => {});
}

export function trayClick(e) {
  const act = e.target.closest?.("[data-tray]")?.dataset.tray;
  if (!act) return false;
  if (act === "review") openReview();
  else if (act === "results") openResults();
  else if (act === "cancel") cancel();
  else if (act === "clear") clearStaged();
  else if (act === "dismiss") {
    dismissed = focus?.id ?? null;
    try { localStorage.setItem(DISMISSED_KEY, dismissed ?? ""); } catch {}
    paintTray();
  }
  return true;
}

/* ---- progress socket ---- */

const socketUrl = () => `${API || location.origin}/api/permissions/jobs`.replace(/^http/, "ws");

function soonReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => ctx.reload(), 1500);
}

function receive(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (msg.type === "state") {
    jobs = msg.jobs ?? [];
    const was = focus?.state;
    focus = msg.focus ?? null;
    if (was === "running" && focus?.state !== "running") soonReload();
  } else if (msg.type === "item" && msg.job) {
    jobs = jobs.map((j) => (j.id === msg.job.id ? msg.job : j));
    if (focus?.id === msg.job.id) {
      focus = { ...focus, ...msg.job, items: (focus.items ?? []).map((it) => (it.i === msg.item.i ? msg.item : it)) };
    }
    if (msg.item.status === "done" || msg.item.status === "invited") soonReload();
  }
  paintTray();
  if (resultsDialog && focus) {
    const list = resultsDialog.querySelector(".perm-results-list");
    const top = list?.scrollTop ?? 0;
    resultsDialog.innerHTML = resultsHtml(focus, ctx.data());
    const next = resultsDialog.querySelector(".perm-results-list");
    if (next) next.scrollTop = top;
  }
}

function scheduleRetry() {
  const wait = Math.min(MAX_RETRY_MS, 1000 * 2 ** retries++);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (wanted) connect();
  }, wait);
}

function connect() {
  wanted = true;
  if (socket || retryTimer) return;
  let ws;
  try { ws = new WebSocket(socketUrl()); } catch { scheduleRetry(); return; }
  socket = ws;
  ws.addEventListener("open", () => {
    retries = 0;
    pingTimer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send("ping"); }, PING_MS);
  });
  ws.addEventListener("message", (e) => receive(e.data));
  ws.addEventListener("close", () => {
    clearInterval(pingTimer);
    if (socket !== ws) return;
    socket = null;
    if (wanted) scheduleRetry();
  });
}

function disconnect() {
  wanted = false;
  clearTimeout(retryTimer);
  retryTimer = null;
  clearInterval(pingTimer);
  if (!socket) return;
  const ws = socket;
  socket = null;
  ws.close();
}

export function syncApply(on) {
  if (on) connect();
  else disconnect();
}
