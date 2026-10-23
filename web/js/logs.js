import { API } from "./live.js";
import { esc } from "./format.js";
import { BOXES, FALLBACK_BOX, KEEP_PER_BOX, monitors } from "./log-boxes.js";

const BOX_IDS = new Set(BOXES.map((b) => b.id));
const STATUS = { connecting: "Connecting…", live: "Live", reconnecting: "Reconnecting…" };
const PING_MS = 30_000;
const MAX_RETRY_MS = 30_000;

const feed = new Map(BOXES.map((b) => [b.id, []]));
let socket = null;
let wanted = false;
let retries = 0;
let retryTimer = null;
let pingTimer = null;
let status = "connecting";
let loaded = false;
let notify = () => {};
let tipFor = null;
let tipPinned = false;
let tipWired = false;

const INFO_ICON = `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/></svg>`;

const socketUrl = () => `${API || location.origin}/api/logs`.replace(/^http/, "ws");
const RENAMED = { settings: "repo", other: "community" };
const boxFor = (entry) => {
  const box = RENAMED[entry.box] ?? entry.box;
  return BOX_IDS.has(box) ? box : FALLBACK_BOX;
};
const tier = () => (status === "reconnecting" ? "down" : "instant");
const countText = (n) => (n >= KEEP_PER_BOX ? `latest ${KEEP_PER_BOX}` : String(n));

function when(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

function rowHtml(e, fresh = false) {
  const safe = typeof e.url === "string" && e.url.startsWith("https://github.com/");
  const text = safe
    ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.text)}</a>`
    : esc(e.text);
  const tone = e.tone ? ` tone-${esc(e.tone)}` : "";
  return `<li class="log-row${tone}${fresh ? " fresh" : ""}">
    <time datetime="${esc(e.at)}" title="${esc(new Date(e.at).toLocaleString())}">${esc(when(e.at))}</time>
    <span class="log-what">${e.repo ? `<span class="log-repo">${esc(e.repo)}</span>` : ""}${
      e.via ? `<span class="log-actor log-via" title="Found by the 10-minute settings check, not a webhook">${esc(e.via)}</span>`
        : e.actor ? `<span class="log-actor">${esc(e.actor)}</span>` : ""}${text}</span>
  </li>`;
}

const emptyHtml = () =>
  `<li class="log-empty">${loaded ? "Nothing has come in yet." : "Waiting for the feed…"}</li>`;

function boxHtml(box) {
  const rows = feed.get(box.id);
  return `<section class="card logbox fresh-${tier()}" style="--span:6" data-logbox="${box.id}">
    <header><h2>${esc(box.label)}</h2><span class="sub" data-logcount>${countText(rows.length)}</span>
      <button class="log-info" type="button" data-loginfo="${box.id}" aria-label="What ${esc(box.label)} shows" aria-expanded="false">${INFO_ICON}</button></header>
    <div class="body flush"><ol class="log-rows">${
      rows.length ? rows.map((e) => rowHtml(e)).join("") : emptyHtml()}</ol></div>
  </section>`;
}

export function logsBody() {
  hideTip();
  return `<div class="log-status" data-logstatus="${status}"><i></i><span class="log-state">${STATUS[status]}</span>
    <span class="hint">Every delivery the GitHub App receives, as it arrives. CI is default branches only.</span></div>
  <div class="grid logs">${BOXES.map(boxHtml).join("")}</div>`;
}

export function logsTally() {
  let newest = null;
  for (const list of feed.values()) if (list[0]?.at && (!newest || list[0].at > newest)) newest = list[0].at;
  return { counts: { [tier()]: BOXES.length }, refreshed: newest ? { [tier()]: newest } : {} };
}

function setStatus(next) {
  status = next;
  for (const box of document.querySelectorAll("[data-logbox]")) {
    box.classList.toggle("fresh-instant", tier() === "instant");
    box.classList.toggle("fresh-down", tier() === "down");
  }
  notify();
  const el = document.querySelector("[data-logstatus]");
  if (!el) return;
  el.dataset.logstatus = next;
  el.querySelector(".log-state").textContent = STATUS[next];
}

function redraw() {
  const grid = document.querySelector(".grid.logs");
  if (grid) grid.innerHTML = BOXES.map(boxHtml).join("");
}

function add(entry) {
  const box = boxFor(entry);
  const list = feed.get(box);
  if (list.some((x) => x.id === entry.id)) return;
  list.unshift(entry);
  if (list.length > KEEP_PER_BOX) list.length = KEEP_PER_BOX;

  const el = document.querySelector(`[data-logbox="${box}"]`);
  if (!el) return;
  const ol = el.querySelector(".log-rows");
  ol.querySelector(".log-empty")?.remove();
  ol.insertAdjacentHTML("afterbegin", rowHtml(entry, true));
  while (ol.children.length > KEEP_PER_BOX) ol.lastElementChild.remove();
  el.querySelector("[data-logcount]").textContent = countText(list.length);
}

function receive(data) {
  if (data === "pong") return;
  let msg;
  try { msg = JSON.parse(data); } catch { return; }
  if (msg.type === "history") {
    for (const list of feed.values()) list.length = 0;
    for (const e of msg.events ?? []) {
      const list = feed.get(boxFor(e));
      if (list.length < KEEP_PER_BOX) list.push(e);
    }
    loaded = true;
    redraw();
    notify();
  } else if (msg.type === "event" && msg.event) {
    add(msg.event);
    notify();
  }
}

function scheduleRetry() {
  setStatus("reconnecting");
  const wait = Math.min(MAX_RETRY_MS, 1000 * 2 ** retries++);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (wanted) connect();
  }, wait);
}

function connect() {
  if (socket || retryTimer) return;
  let ws;
  try { ws = new WebSocket(socketUrl()); } catch { scheduleRetry(); return; }
  socket = ws;
  ws.addEventListener("open", () => {
    retries = 0;
    setStatus("live");
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send("ping");
    }, PING_MS);
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
  clearTimeout(retryTimer);
  retryTimer = null;
  clearInterval(pingTimer);
  status = "connecting";
  if (!socket) return;
  const ws = socket;
  socket = null;
  ws.close();
}

function tipHtml(box) {
  const items = monitors(box.id)
    .map(([event, label]) => `<li><span>${esc(label)}</span><code>${esc(event)}</code></li>`)
    .join("");
  return `<h3>${esc(box.label)} shows</h3><ul>${items}</ul>${box.note ? `<p class="note">${esc(box.note)}</p>` : ""}`;
}

function tipLayer() {
  let tip = document.getElementById("logTip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "logTip";
    tip.className = "log-tip";
    tip.setAttribute("role", "tooltip");
    tip.hidden = true;
    document.body.appendChild(tip);
  }
  return tip;
}

function placeTip(button, tip) {
  const r = button.getBoundingClientRect();
  const edge = 8;
  const gap = 6;
  const { offsetWidth: w, offsetHeight: h } = tip;
  const left = Math.max(edge, Math.min(r.right - w, window.innerWidth - w - edge));
  const below = r.bottom + gap;
  const top = below + h > window.innerHeight - edge && r.top - gap - h > edge ? r.top - gap - h : below;
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}

function showTip(button, pinned) {
  const box = BOXES.find((b) => b.id === button.dataset.loginfo);
  if (!box) return;
  if (tipFor && tipFor !== button) tipFor.setAttribute("aria-expanded", "false");
  const tip = tipLayer();
  tip.innerHTML = tipHtml(box);
  tip.hidden = false;
  tipFor = button;
  tipPinned = pinned;
  button.setAttribute("aria-expanded", "true");
  button.setAttribute("aria-describedby", "logTip");
  placeTip(button, tip);
}

function hideTip() {
  const tip = typeof document === "undefined" ? null : document.getElementById("logTip");
  if (tip) tip.hidden = true;
  if (tipFor) {
    tipFor.setAttribute("aria-expanded", "false");
    tipFor.removeAttribute("aria-describedby");
  }
  tipFor = null;
  tipPinned = false;
}

function wireTips() {
  if (tipWired) return;
  tipWired = true;
  document.addEventListener("mouseover", (e) => {
    const b = e.target.closest?.("[data-loginfo]");
    if (b && !tipPinned) showTip(b, false);
  });
  document.addEventListener("mouseout", (e) => {
    const b = e.target.closest?.("[data-loginfo]");
    if (b && b === tipFor && !tipPinned && !b.contains(e.relatedTarget)) hideTip();
  });
  document.addEventListener("click", (e) => {
    const b = e.target.closest?.("[data-loginfo]");
    if (b) {
      if (b === tipFor && tipPinned) hideTip();
      else showTip(b, true);
      return;
    }
    if (tipFor && !e.target.closest?.("#logTip")) hideTip();
  });
  document.addEventListener("focusin", (e) => {
    const b = e.target.closest?.("[data-loginfo]");
    if (b && !tipPinned) showTip(b, false);
  });
  document.addEventListener("focusout", (e) => {
    if (e.target === tipFor && !tipPinned) hideTip();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && tipFor) hideTip();
  });
  window.addEventListener("resize", () => tipFor && placeTip(tipFor, tipLayer()));
  window.addEventListener("scroll", () => tipFor && placeTip(tipFor, tipLayer()), { passive: true });
}

export function syncLogs(active, onChange = () => {}) {
  if (active) wireTips();
  else hideTip();
  wanted = active;
  notify = active ? onChange : () => {};
  if (active) connect();
  else disconnect();
}
