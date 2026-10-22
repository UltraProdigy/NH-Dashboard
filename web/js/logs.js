import { API } from "./live.js";
import { esc } from "./format.js";
import { BOXES, KEEP_PER_BOX } from "./log-boxes.js";

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

const socketUrl = () => `${API || location.origin}/api/logs`.replace(/^http/, "ws");
const boxFor = (entry) => (BOX_IDS.has(entry.box) ? entry.box : "other");
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
      e.actor ? `<span class="log-actor">${esc(e.actor)}</span>` : ""}${text}</span>
  </li>`;
}

const emptyHtml = () =>
  `<li class="log-empty">${loaded ? "Nothing has come in yet." : "Waiting for the feed…"}</li>`;

function boxHtml(box) {
  const rows = feed.get(box.id);
  return `<section class="card logbox" style="--span:6" data-logbox="${box.id}">
    <header><h2>${esc(box.label)}</h2><span class="sub" data-logcount>${countText(rows.length)}</span></header>
    <div class="body flush"><ol class="log-rows">${
      rows.length ? rows.map((e) => rowHtml(e)).join("") : emptyHtml()}</ol></div>
  </section>`;
}

export function logsBody() {
  return `<div class="log-status" data-logstatus="${status}"><i></i><span class="log-state">${STATUS[status]}</span>
    <span class="hint">Every delivery the GitHub App receives, as it arrives. CI is default branches only.</span></div>
  <div class="grid logs">${BOXES.map(boxHtml).join("")}</div>`;
}

function setStatus(next) {
  status = next;
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
  } else if (msg.type === "event" && msg.event) {
    add(msg.event);
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

export function syncLogs(active) {
  wanted = active;
  if (active) connect();
  else disconnect();
}
