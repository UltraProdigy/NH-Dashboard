import { API } from "./live.js";
import { avatar, esc, safeUrl } from "./format.js";
import { keepScroll } from "./scroll.js";
import { actionLabel, actionsOf, EVENT_ORDER, eventLabel, REASONS, WEBHOOK_EVENTS } from "./webhook-catalog.js";
import { loadRepoList, onRepoList, repoList, repoListDue, repoListError, repoListLoading } from "./repo-list.js";

const REFRESH_MS = 30_000;
const PREVIEW_MS = 350;
const DAY_MS = 86_400_000;

let data = null;
let draft = null;
let failed = null;
let notice = null;
let fetchedAt = 0;
let inFlight = null;
let timer = null;
let wired = false;
let saving = false;
let readingHook = false;
let filter = "all";
let repoQuery = "";
let repoFilter = "all";
let scope = null;
let preview = { key: null, decisions: null, error: null };
let previewTimer = null;
let caret = null;
let active = false;
const opened = new Set();

const lower = (s) => String(s ?? "").toLowerCase();
const listOf = (text) => String(text ?? "").split(/[\n,]/).map((s) => s.trim()).filter(Boolean);

function canonEvents(events) {
  const out = {};
  for (const name of Object.keys(events ?? {}).sort()) {
    const rule = events[name];
    if (rule?.off) out[name] = { off: true };
    else if (rule?.drop?.length) out[name] = { drop: [...new Set(rule.drop)].sort() };
  }
  return out;
}

function canon(rules) {
  const seen = new Set();
  const senders = (rules?.senders ?? []).map((s) => s.trim()).filter((s) => s && !seen.has(lower(s)) && seen.add(lower(s)));
  const taken = new Set();
  const repos = (rules?.repos ?? []).map((s) => s.trim()).filter((s) => s && !taken.has(lower(s)) && taken.add(lower(s))).sort((a, b) => a.localeCompare(b));
  const repoEvents = {};
  for (const repo of Object.keys(rules?.repoEvents ?? {}).sort((a, b) => a.localeCompare(b))) {
    repoEvents[repo] = { events: canonEvents(rules.repoEvents[repo]?.events) };
  }
  return {
    repos,
    skipBots: rules?.skipBots === true,
    senders,
    pushBranches: rules?.pushBranches === "default" ? "default" : "all",
    events: canonEvents(rules?.events),
    repoEvents,
  };
}

const keyOf = (rules) => JSON.stringify(canon(rules));
const dirty = () => Boolean(data && draft && keyOf(draft) !== keyOf(data.rules));
const copy = (rules) => JSON.parse(JSON.stringify(canon(rules)));

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
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const deliveries = () => data?.deliveries ?? [];
const failedSend = (d) => d.send && d.discord !== "pending" && d.discord !== null && !(Number(d.discord) >= 200 && Number(d.discord) < 300);
const excludedSet = () => new Set((draft?.repos ?? []).map(lower));
const overrideKey = (repo) => Object.keys(draft?.repoEvents ?? {}).find((r) => lower(r) === lower(repo)) ?? null;
const overrideOf = (repo) => {
  const key = overrideKey(repo);
  return key ? draft.repoEvents[key] : null;
};

/* The events the org webhook is subscribed to, or null when that isn't known or is everything. */
function subscribed() {
  const events = data?.hook?.events;
  if (!Array.isArray(events) || !events.length || events.includes("*")) return null;
  return events;
}

function listedEvents(rules) {
  const seen = new Set(deliveries().map((d) => d.event));
  const base = subscribed() ?? [...WEBHOOK_EVENTS.map(([e]) => e), ...seen];
  const names = new Set(base);
  const stray = Object.keys(rules ?? {}).filter((e) => !names.has(e));
  const order = (e) => EVENT_ORDER.get(e) ?? 1000;
  const sorted = [...names].sort((a, b) => order(a) - order(b) || a.localeCompare(b));
  return { names: sorted, stray };
}

function seenCounts() {
  const events = new Map();
  const repos = new Map();
  for (const d of deliveries()) {
    const ev = events.get(d.event) ?? { count: 0, actions: new Map() };
    ev.count++;
    if (d.action) ev.actions.set(d.action, (ev.actions.get(d.action) ?? 0) + 1);
    events.set(d.event, ev);
    if (d.repo) repos.set(lower(d.repo), (repos.get(lower(d.repo)) ?? 0) + 1);
  }
  return { events, repos };
}

function hookLine() {
  const hook = data.hook;
  const refresh = `<button type="button" class="ghost wh-mini" data-wh-hook${readingHook ? " disabled" : ""}>${readingHook ? "Reading…" : "Re-read"}</button>`;
  const from = hook?.source === "github" ? "read from GitHub" : hook?.source === "ping" ? "from the webhook's ping" : "";
  let text;
  if (hook?.events?.includes("*")) text = `The webhook sends every event${from ? `, ${from} ${esc(ago(hook.readAt))}` : ""}.`;
  else if (hook?.events?.length) text = `The webhook is subscribed to ${plural(hook.events.length, "event")}${from ? `, ${from}${hook.source === "github" ? ` ${esc(ago(hook.readAt))}` : ""}` : ""}. Only those are listed.`;
  else text = "The webhook's events aren't known yet, so every event is listed.";
  const warn = hook?.error ? `<span class="wh-bad">${esc(hook.error)}</span>` : "";
  const inactive = hook?.active === false ? `<span class="wh-bad">The webhook is switched off on GitHub.</span>` : "";
  return `<p class="wh-hookline"><span class="sub">${text}</span>${inactive}${warn}${refresh}</p>`;
}

function statusCard() {
  const list = deliveries();
  const since = Date.now() - DAY_MS;
  const day = list.filter((d) => new Date(d.at).getTime() >= since);
  const sent = day.filter((d) => d.send).length;
  const failures = day.filter(failedSend).length;
  const fact = (label, value, extra = "") => `<div class="wh-fact"><span class="sub">${esc(label)}</span><strong>${value}</strong>${extra}</div>`;
  const saved = data.updatedAt
    ? `Rules saved ${esc(ago(data.updatedAt))}${data.updatedBy ? ` by ${esc(data.updatedBy)}` : ""}`
    : "No rules saved yet, so everything is sent";
  const empty = list.length
    ? ""
    : `<p class="hint wh-note">Nothing has come through the relay yet. Once the org webhook points at <code>nh-discord-relay</code>, deliveries show up here.</p>`;
  return `<section class="card wh-card" style="--span:12">
    <header><h2>Relay</h2><span class="sub">${saved}</span></header>
    <div class="body" data-wh-status>
      <div class="wh-facts">
        ${fact("Last delivery", list[0] ? esc(ago(list[0].at)) : "none")}
        ${fact("Last 24 hours", day.length.toLocaleString(), `<span class="sub">received</span>`)}
        ${fact("Sent to Discord", sent.toLocaleString())}
        ${fact("Dropped", (day.length - sent).toLocaleString())}
        ${fact("Discord errors", failures.toLocaleString(), failures ? `<span class="sub wh-bad">GitHub shows these as failed; redeliver from the org webhook page</span>` : "")}
      </div>
      ${hookLine()}
      ${empty}
    </div>
  </section>`;
}

function barHtml() {
  const changed = dirty();
  const msg = notice ? `<span class="wh-notice ${notice.tone ?? ""}">${esc(notice.text)}</span>` : "";
  const state = changed
    ? `<span class="wh-unsaved">Unsaved changes. The list below shows what they would do.</span>`
    : `<span class="sub">Anything a rule doesn't mention is sent.</span>`;
  return `${state}${msg}
    <span class="wh-actions">
      <button type="button" class="ghost" data-wh-discard${changed && !saving ? "" : " disabled"}>Discard</button>
      <button type="button" class="daily-go" data-wh-save${changed && !saving ? "" : " disabled"}>${saving ? "Saving…" : "Save"}</button>
    </span>`;
}

function repoRows() {
  const byName = new Map();
  for (const r of repoList()?.repos ?? []) byName.set(lower(r.name), { name: r.name, private: Boolean(r.private), listed: true });
  for (const d of deliveries()) {
    if (!d.repo) continue;
    const row = byName.get(lower(d.repo));
    if (row) row.private ||= Boolean(d.private);
    else byName.set(lower(d.repo), { name: d.repo, private: Boolean(d.private), listed: false });
  }
  for (const name of [...(draft?.repos ?? []), ...Object.keys(draft?.repoEvents ?? {})]) {
    if (!byName.has(lower(name))) byName.set(lower(name), { name, private: false, listed: false });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function shownRepos() {
  const excluded = excludedSet();
  const q = lower(repoQuery).trim();
  return repoRows().filter((r) => {
    if (q && !lower(r.name).includes(q)) return false;
    if (repoFilter === "sending") return !excluded.has(lower(r.name));
    if (repoFilter === "off") return excluded.has(lower(r.name));
    if (repoFilter === "custom") return Boolean(overrideOf(r.name));
    return true;
  });
}

function repoListHtml() {
  const excluded = excludedSet();
  const { repos: seen } = seenCounts();
  const rows = shownRepos();
  if (!rows.length) {
    const why = repoListLoading() && !repoList() ? "Reading the org's repos…" : repoListError() && !repoList() ? repoListError() : "No repos match.";
    return `<div class="empty">${esc(why)}</div>`;
  }
  return rows.map((r) => {
    const off = excluded.has(lower(r.name));
    const custom = overrideOf(r.name);
    const customOff = custom ? Object.keys(custom.events).length : 0;
    const n = seen.get(lower(r.name));
    const label = custom ? `Own events${customOff ? ` (${customOff} changed)` : ""}` : "Events";
    return `<div class="wh-repo${off ? " is-off" : ""}${scope && lower(scope) === lower(r.name) ? " is-scope" : ""}">
      <label class="wh-repo-name"><input type="checkbox" data-wh-repo="${esc(r.name)}"${off ? "" : " checked"}><span class="repo">${esc(r.name)}</span></label>
      ${r.private ? `<span class="pill draft">private</span>` : ""}
      ${r.listed ? "" : `<span class="pill unknown" title="Not in the org's current repo list: archived, renamed or deleted">gone</span>`}
      ${n ? `<span class="sub wh-seen">${n} seen</span>` : ""}
      <button type="button" class="ghost wh-mini${custom ? " is-custom" : ""}" data-wh-scope="${esc(r.name)}" title="Choose which events this repo sends">${label}</button>
    </div>`;
  }).join("");
}

function reposCard() {
  const rows = repoRows();
  const excluded = excludedSet();
  const sending = rows.filter((r) => !excluded.has(lower(r.name))).length;
  const custom = rows.filter((r) => overrideOf(r.name)).length;
  const seg = (value, label) => `<button type="button" data-wh-repo-filter="${value}" aria-pressed="${repoFilter === value}">${label}</button>`;
  return `<section class="card wh-card" style="--span:6">
    <header><h2>Repos</h2><span class="sub" data-wh-repo-count>${sending.toLocaleString()} of ${rows.length.toLocaleString()} sending${custom ? ` · ${custom} with their own events` : ""}</span></header>
    <div class="wh-repo-tools">
      <input type="search" data-wh-repo-search data-wh-caret="repo-search" placeholder="Filter repos…" value="${esc(repoQuery)}" autocomplete="off">
      <div class="seg mini">${seg("all", "All")}${seg("sending", "Sending")}${seg("off", "Unticked")}${seg("custom", "Own events")}</div>
      <span class="wh-actions">
        <button type="button" class="ghost wh-mini" data-wh-repo-bulk="on">Tick shown</button>
        <button type="button" class="ghost wh-mini" data-wh-repo-bulk="off">Untick shown</button>
      </span>
    </div>
    <div class="body flush wh-repolist" data-wh-repolist>${repoListHtml()}</div>
    <p class="hint wh-foot">New repos are ticked until you untick them. "Events" gives a repo its own event list instead of the default one.</p>
  </section>`;
}

function eventsFor(target) {
  if (!target) return draft.events;
  return overrideOf(target)?.events ?? draft.events;
}

function editableEvents(target) {
  if (!target) return draft.events;
  const key = overrideKey(target);
  if (key) return draft.repoEvents[key].events;
  draft.repoEvents[target] = { events: JSON.parse(JSON.stringify(draft.events)) };
  return draft.repoEvents[target].events;
}

function eventsCard() {
  const rules = eventsFor(scope);
  const custom = scope ? overrideOf(scope) : null;
  const { events: seen } = seenCounts();
  const { names, stray } = listedEvents(rules);
  const row = (event, extra = "") => {
    const rule = rules[event] ?? {};
    const off = rule.off === true;
    const dropped = new Set(rule.drop ?? []);
    const counts = seen.get(event);
    const actions = [...actionsOf(event)];
    for (const a of [...(counts?.actions.keys() ?? []), ...dropped]) if (!actions.includes(a)) actions.push(a);
    const offCount = actions.filter((a) => dropped.has(a)).length;
    const summary = off ? "off" : offCount ? `${offCount} of ${actions.length} actions off` : actions.length ? "all actions" : "";
    const head = `<label class="wh-ev-toggle"><input type="checkbox" data-wh-event="${esc(event)}"${off ? "" : " checked"}>
        <span class="wh-ev-name">${esc(eventLabel(event))}</span></label>
      <code class="wh-ev-code">${esc(event)}</code>${extra}
      ${counts?.count ? `<span class="pill draft" title="In the last ${data.keep} deliveries">${counts.count} seen</span>` : ""}
      <span class="sub wh-ev-sum">${esc(summary)}</span>`;
    if (!actions.length) return `<div class="wh-ev${off ? " is-off" : ""}"><div class="wh-ev-head">${head}</div></div>`;
    const chips = actions.map((a) => {
      const n = counts?.actions.get(a);
      return `<button type="button" class="repochip" data-wh-action="${esc(event)}:${esc(a)}" aria-pressed="${!dropped.has(a)}"${off ? " disabled" : ""}>${esc(actionLabel(a))}${n ? `<span class="count">${n}</span>` : ""}</button>`;
    }).join("");
    const id = `${scope ?? ""}|${event}`;
    return `<details class="wh-ev${off ? " is-off" : ""}" data-wh-ev="${esc(id)}"${opened.has(id) ? " open" : ""}>
      <summary class="wh-ev-head">${head}</summary>
      <div class="repochips wh-chips">${chips}</div>
    </details>`;
  };
  const rows = names.map((e) => row(e)).join("") +
    stray.map((e) => row(e, ` <span class="pill unknown" title="The webhook isn't subscribed to this, so the rule never applies">not subscribed</span>`)).join("");
  const title = scope ? `Events for ${esc(scope)}` : "Events";
  const sub = scope
    ? custom
      ? "This repo has its own list. Changes here only apply to it."
      : "Using the default events. Changing anything here gives this repo its own list."
    : "Every repo uses these unless it has its own list. Untick to drop an event; open one to drop single actions.";
  const tools = scope
    ? `<span class="wh-actions">${custom ? `<button type="button" class="ghost wh-mini" data-wh-scope-reset>Use the default events</button>` : ""}<button type="button" class="ghost wh-mini" data-wh-scope-back>Back to the default events</button></span>`
    : "";
  return `<section class="card wh-card${scope ? " wh-scoped" : ""}" style="--span:6">
    <header><h2>${title}</h2>${tools}<span class="sub wh-ev-intro">${sub}</span></header>
    <div class="body flush wh-events" data-wh-events>${rows || `<div class="empty">The webhook isn't subscribed to any events.</div>`}</div>
  </section>`;
}

function sendersCard() {
  const r = draft;
  const seg = (value, label) => `<button type="button" data-wh-push="${value}" aria-pressed="${r.pushBranches === value}">${label}</button>`;
  return `<section class="card wh-card" style="--span:12">
    <header><h2>Senders & branches</h2><span class="sub">Apply to every repo</span></header>
    <div class="body wh-form wh-form-row">
      <div class="wh-field">
        <label class="wh-label" for="wh-senders">Excluded senders</label>
        <textarea id="wh-senders" class="wh-text" data-wh-field="senders" data-wh-caret="senders" rows="3" spellcheck="false" placeholder="GitHub logins, one per line">${esc(r.senders.join("\n"))}</textarea>
        <label class="wh-toggle"><input type="checkbox" data-wh-flag="skipBots"${r.skipBots ? " checked" : ""}> Drop bots (<code>[bot]</code> accounts, dependabot, renovate, github-actions…)</label>
      </div>
      <div class="wh-field">
        <span class="wh-label">Pushes</span>
        <div class="seg mini">${seg("all", "All branches")}${seg("default", "Default branch only")}</div>
        <span class="sub">Tag pushes always go through this rule.</span>
      </div>
    </div>
  </section>`;
}

function resultPill(d) {
  if (!d.send) return `<span class="pill dropped" title="Dropped by the relay">dropped · ${esc(REASONS[d.reason] ?? d.reason ?? "")}</span>`;
  if (d.discord === "pending") return `<span class="pill unknown">sending</span>`;
  if (failedSend(d)) return `<span class="pill fail" title="${esc(d.detail ?? "")}">Discord ${esc(d.discord)}</span>`;
  return `<span class="pill pass"${d.reason ? ` title="${esc(REASONS[d.reason] ?? d.reason)}"` : ""}>sent</span>`;
}

function changeOf(d) {
  if (!dirty() || preview.key !== keyOf(draft) || !preview.decisions) return null;
  const next = preview.decisions[d.id];
  if (!next || next.send === d.send) return null;
  return next;
}

function logCard() {
  const list = deliveries();
  const previewReady = dirty() && preview.key === keyOf(draft) && preview.decisions;
  const changes = previewReady ? list.filter((d) => changeOf(d)).length : 0;
  const shown = list.filter((d) => {
    if (filter === "sent") return d.send;
    if (filter === "dropped") return !d.send;
    if (filter === "changed") return Boolean(changeOf(d));
    return true;
  });
  const seg = (value, label) => `<button type="button" data-wh-filter="${value}" aria-pressed="${filter === value}">${label}</button>`;
  const rows = shown.slice(0, 200).map((d) => {
    const next = changeOf(d);
    const after = next
      ? `<span class="wh-arrow">→</span>${next.send ? `<span class="pill pass">would send</span>` : `<span class="pill dropped">would drop · ${esc(REASONS[next.reason] ?? next.reason)}</span>`}`
      : "";
    const url = safeUrl(d.url);
    const text = url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(d.text ?? "")}</a>` : esc(d.text ?? "");
    const quick = [];
    if (d.send && d.repo) quick.push(`<button type="button" class="ghost wh-quick" data-wh-drop-repo="${esc(d.repo)}" title="Untick ${esc(d.repo)}">Untick repo</button>`);
    if (d.send) {
      const what = d.action ? `${d.event}:${d.action}` : d.event;
      const word = d.action ? `Drop ${esc(actionLabel(d.action))}` : "Drop event";
      quick.push(`<button type="button" class="ghost wh-quick" data-wh-drop="${esc(what)}" title="Stop sending this everywhere">${word}</button>`);
      if (d.repo) quick.push(`<button type="button" class="ghost wh-quick" data-wh-drop="${esc(what)}" data-wh-drop-in="${esc(d.repo)}" title="Stop sending this from ${esc(d.repo)} only">…for this repo</button>`);
    }
    return `<tr class="${next ? "wh-changed" : ""}">
      <td class="sub wh-when" title="${esc(d.at)}">${esc(when(d.at))}</td>
      <td><span class="wh-evcell">${esc(eventLabel(d.event))}</span>${d.action ? ` <span class="sub">${esc(actionLabel(d.action))}</span>` : ""}</td>
      <td>${d.repo ? `<span class="repo">${esc(d.repo)}</span>${d.private ? ` <span class="pill draft">private</span>` : ""}` : `<span class="sub">org</span>`}</td>
      <td>${d.sender ? `<span class="namelink">${avatar(d.sender, 16)}<span>${esc(d.sender)}</span></span>` : ""}</td>
      <td class="wh-text-cell">${text}</td>
      <td class="wh-result">${resultPill(d)}${after}</td>
      <td class="wh-quickcell">${quick.join("")}</td>
    </tr>`;
  });
  const table = rows.length
    ? `<div class="tscroll wh-scroll"><table><thead><tr><th>When</th><th>Event</th><th>Repo</th><th>Sender</th><th>What</th><th>Result</th><th></th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`
    : `<div class="empty">${list.length ? "Nothing matches this filter." : "No deliveries yet."}</div>`;
  const previewNote = dirty()
    ? preview.error
      ? `<span class="sub wh-bad">${esc(preview.error)}</span>`
      : previewReady
        ? `<span class="sub">${plural(changes, "delivery", "deliveries")} would change</span>`
        : `<span class="sub">Checking your changes…</span>`
    : "";
  return `<section class="card wh-card" style="--span:12">
    <header><h2>Recent deliveries</h2><span class="sub">Last ${plural(list.length, "delivery", "deliveries")} the relay has seen</span>${previewNote}
      <div class="seg mini wh-filter">${seg("all", "All")}${seg("sent", "Sent")}${seg("dropped", "Dropped")}${dirty() ? seg("changed", "Would change") : ""}</div></header>
    <div class="body flush" data-wh-log>${table}</div>
  </section>`;
}

function bodyHtml() {
  if (failed && !data) return `<div class="error">${esc(failed)}</div>`;
  if (!data || !draft) return `<div class="empty">Loading the relay…</div>`;
  if (filter === "changed" && !dirty()) filter = "all";
  return `<div class="wh" data-wh>
    ${failed ? `<div class="error">${esc(failed)}</div>` : ""}
    <div class="wh-bar" data-wh-bar>${barHtml()}</div>
    <div class="grid">${statusCard()}${reposCard()}${eventsCard()}${sendersCard()}${logCard()}</div>
  </div>`;
}

export const webhookBody = () => bodyHtml();

function paint() {
  const view = document.getElementById("view");
  if (!active || !view) return;
  keepScroll(view, () => { view.innerHTML = bodyHtml(); });
  restoreCaret();
}

function replaceCard(marker, html) {
  const card = document.querySelector(marker)?.closest(".card");
  if (!card) return;
  const holder = document.createElement("div");
  holder.innerHTML = html;
  card.replaceWith(holder.firstElementChild);
}

function paintLive() {
  if (!active) return;
  const bar = document.querySelector("[data-wh-bar]");
  if (!bar) return paint();
  bar.innerHTML = barHtml();
  replaceCard("[data-wh-status]", statusCard());
  replaceCard("[data-wh-log]", logCard());
}

function paintRepoList() {
  const list = document.querySelector("[data-wh-repolist]");
  if (!list) return paint();
  keepScroll(list, () => { list.innerHTML = repoListHtml(); });
}

function restoreCaret() {
  if (!caret) return;
  const el = document.querySelector(`[data-wh-caret="${caret.key}"]`);
  if (!el) return;
  el.focus();
  try { el.setSelectionRange(caret.start, caret.end); } catch {}
  if (caret.scroll) el.scrollTop = caret.scroll;
}

function changed({ full = true } = {}) {
  notice = null;
  if (full) paint();
  else paintLive();
  schedulePreview();
}

function schedulePreview() {
  clearTimeout(previewTimer);
  if (!dirty()) return;
  const key = keyOf(draft);
  if (preview.key === key && (preview.decisions || preview.error)) return;
  previewTimer = setTimeout(() => runPreview(key), PREVIEW_MS);
}

async function runPreview(key) {
  try {
    const res = await fetch(`${API}/api/webhook/preview`, {
      method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rules: canon(draft) }),
    });
    const body = await res.json().catch(() => ({}));
    if (key !== keyOf(draft)) return;
    preview = res.ok ? { key, decisions: body.decisions, error: null } : { key, decisions: null, error: body.error ?? `Preview failed (${res.status})` };
  } catch {
    if (key !== keyOf(draft)) return;
    preview = { key, decisions: null, error: "The preview couldn't be loaded." };
  }
  paintLive();
}

function adopt(state) {
  const wasDirty = dirty();
  data = state;
  if (!draft || !wasDirty) draft = copy(state.rules);
  preview = { key: null, decisions: null, error: null };
  fetchedAt = Date.now();
}

async function load(path = "/api/webhook", init = { cache: "no-store" }) {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await fetch(`${API}${path}`, init);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(res.status === 403 ? "Only the admin team can see the webhook rules." : body.error ?? `The relay couldn't be read (${res.status}).`);
      adopt(body);
      failed = null;
    } catch (err) {
      failed = err instanceof TypeError ? "The dashboard couldn't be reached." : err.message;
    } finally {
      inFlight = null;
      if (document.querySelector("[data-wh]") && dirty()) paintLive();
      else paint();
      schedulePreview();
    }
  })();
  return inFlight;
}

async function rereadHook() {
  if (readingHook) return;
  readingHook = true;
  paintLive();
  await load("/api/webhook/hook", { method: "POST", cache: "no-store" });
  readingHook = false;
  paint();
}

async function save() {
  if (!dirty() || saving) return;
  saving = true;
  paintLive();
  try {
    const res = await fetch(`${API}/api/webhook/rules`, {
      method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rules: canon(draft), base: data.updatedAt ?? null }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 409 && body.rules) {
      data = body;
      draft = copy(body.rules);
      notice = { tone: "wh-bad", text: "Someone else saved while you were editing. Their rules are loaded; make your change again." };
    } else if (!res.ok) {
      notice = { tone: "wh-bad", text: body.error ?? `Saving failed (${res.status}).` };
    } else {
      data = body;
      draft = copy(body.rules);
      notice = { tone: "wh-good", text: "Saved. The relay uses the new rules from the next delivery." };
    }
  } catch {
    notice = { tone: "wh-bad", text: "The dashboard couldn't be reached, so nothing was saved." };
  } finally {
    saving = false;
    preview = { key: null, decisions: null, error: null };
    caret = null;
    paint();
  }
}

function setEvent(target, event, send) {
  const events = editableEvents(target);
  if (send) delete events[event];
  else events[event] = { off: true };
}

function setAction(target, event, action, send) {
  const current = eventsFor(target)[event];
  if (current?.off) return;
  const events = editableEvents(target);
  const drop = new Set(events[event]?.drop ?? []);
  if (send) drop.delete(action);
  else drop.add(action);
  if (drop.size) events[event] = { drop: [...drop].sort() };
  else delete events[event];
}

function setRepo(name, send) {
  const repos = draft.repos.filter((r) => lower(r) !== lower(name));
  if (!send) repos.push(name);
  draft.repos = repos;
}

function wire() {
  if (wired) return;
  wired = true;
  const inside = (e) => e.target.closest?.("[data-wh]");
  const keepCaret = (el) => {
    if (el?.dataset?.whCaret) caret = { key: el.dataset.whCaret, start: el.selectionStart, end: el.selectionEnd, scroll: el.scrollTop };
  };

  document.addEventListener("input", (e) => {
    if (!inside(e) || !draft) return;
    keepCaret(e.target);
    if (e.target.matches("[data-wh-repo-search]")) {
      repoQuery = e.target.value;
      return paintRepoList();
    }
    const field = e.target.dataset?.whField;
    if (!field) return;
    draft[field] = listOf(e.target.value);
    changed({ full: false });
  });

  document.addEventListener("selectionchange", () => keepCaret(document.activeElement));
  document.addEventListener("focusout", (e) => {
    if (!e.target.dataset?.whCaret) return;
    setTimeout(() => {
      if (!document.activeElement?.dataset?.whCaret) caret = null;
    }, 0);
  });

  document.addEventListener("change", (e) => {
    if (!inside(e) || !draft) return;
    const d = e.target.dataset ?? {};
    if (d.whFlag) {
      draft[d.whFlag] = e.target.checked;
      return changed();
    }
    if (d.whRepo) {
      setRepo(d.whRepo, e.target.checked);
      return changed();
    }
    if (d.whEvent) {
      setEvent(scope, d.whEvent, e.target.checked);
      return changed();
    }
  });

  document.addEventListener("toggle", (e) => {
    const id = e.target.dataset?.whEv;
    if (!id) return;
    if (e.target.open) opened.add(id);
    else opened.delete(id);
  }, true);

  document.addEventListener("click", (e) => {
    if (!inside(e) || !draft) return;
    const el = e.target.closest("button");
    if (!el || el.disabled) return;
    const d = el.dataset;
    if ("whSave" in d) return save();
    if ("whHook" in d) return rereadHook();
    if ("whDiscard" in d) {
      draft = copy(data.rules);
      if (scope && !repoRows().some((r) => lower(r.name) === lower(scope))) scope = null;
      caret = null;
      return changed();
    }
    if (d.whFilter) {
      filter = d.whFilter;
      return paintLive();
    }
    if (d.whRepoFilter) {
      repoFilter = d.whRepoFilter;
      return paint();
    }
    if (d.whRepoBulk) {
      for (const r of shownRepos()) setRepo(r.name, d.whRepoBulk === "on");
      return changed();
    }
    if (d.whScope) {
      scope = lower(scope) === lower(d.whScope) ? null : d.whScope;
      return paint();
    }
    if ("whScopeBack" in d) {
      scope = null;
      return paint();
    }
    if ("whScopeReset" in d) {
      const key = overrideKey(scope);
      if (key) delete draft.repoEvents[key];
      return changed();
    }
    if (d.whPush) {
      draft.pushBranches = d.whPush;
      return changed();
    }
    if (d.whAction) {
      const [event, action] = d.whAction.split(":");
      setAction(scope, event, action, el.getAttribute("aria-pressed") !== "true");
      return changed();
    }
    if (d.whDrop) {
      const [event, action] = d.whDrop.split(":");
      const target = d.whDropIn ?? null;
      if (action) {
        setAction(target, event, action, false);
        opened.add(`${target ?? ""}|${event}`);
      } else setEvent(target, event, false);
      if (target) scope = target;
      return changed();
    }
    if (d.whDropRepo) {
      setRepo(d.whDropRepo, false);
      return changed();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (timer && document.visibilityState === "visible" && Date.now() - fetchedAt > REFRESH_MS) load();
  });

  onRepoList(() => {
    if (document.querySelector("[data-wh]")) paint();
  });
}

export function syncWebhook(on) {
  active = on;
  if (!on) {
    clearInterval(timer);
    timer = null;
    return;
  }
  wire();
  restoreCaret();
  if (!data || Date.now() - fetchedAt > REFRESH_MS) load();
  if (repoListDue() && !repoList()) loadRepoList();
  if (!timer) {
    timer = setInterval(() => {
      if (document.visibilityState !== "hidden" && !saving) load();
    }, REFRESH_MS);
  }
}
