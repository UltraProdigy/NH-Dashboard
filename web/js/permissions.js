import { API } from "./live.js";
import { avatar, contribHref, esc, personName, repoHref } from "./format.js";
import { KEEP_PER_BOX } from "./log-boxes.js";
import {
  adminRows, directRows, indexSnapshot, LEVELS, personAccess, problems, rank, repoAccess, repoRoles, repoTeams, teamAncestors, teamRoles, teamRows,
} from "./permissions-calc.js";
import { describe, keyOf, MAX_DESCRIPTION, NOTIFY_LABEL, PRIVACY_LABEL, TEAM_ROLES, validLogin, validTeamName } from "./permission-changes.js";
import {
  configureApply, flagsOf, ownerOnly, paintTray, stage, stagedFor, stagedList, stageMany, syncApply, trayClick, trayMarkup, unstage,
} from "./permission-apply.js";
import { bulkCard, bulkEvent, configureBulk, setBulkSubject } from "./permission-bulk.js";
import { keepScroll } from "./scroll.js";

const REFRESH_MS = 60_000;
const ARCHIVED_KEY = "nh:perm-archived";

let data = null;
let idx = null;
let failed = null;
let fetchedAt = 0;
let inFlight = null;
let timer = null;
let wired = false;
let showArchived = false;
let query = "";
let active = 0;
let searchFocus = null;
let open = null;
let pending = null;
const trail = [];
let mode = "permissions";
let teamsPage = { body: () => "", status: () => "", memberHead: () => [], memberCells: () => "", sections: () => "" };

try { showArchived = localStorage.getItem(ARCHIVED_KEY) === "1"; } catch {}

// Team Management draws its own body inside this page's shell, so it shares the search, the panels and the tray.
export function configureTeamsPage(next) {
  teamsPage = { ...teamsPage, ...next };
}
export const permData = () => data;
export const permIdx = () => idx;
export const permArchived = () => showArchived;

const github = (path) => `https://github.com/${path}`;

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
const teamOf = (id) => data?.teams?.[id];
const roleName = (id) => data?.org?.roles?.[id]?.label ?? `role ${id}`;
const rolePill = (id) => `<span class="pill neutral perm-role" title="Organization role">${esc(roleName(id))}</span>`;
const repoOf = (id) => data?.repos?.[id];
const repoByName = (name) => Object.values(data?.repos ?? {}).find((r) => r.name === name) ?? null;
const teamBySlug = (slug) => Object.values(data?.teams ?? {}).find((t) => t.slug === slug) ?? null;
const shownRepo = (repo) => showArchived || !repo.archived;

export const levelPill = (level) =>
  level ? `<span class="pill lv lv-${esc(level)}">${esc(level)}</span>` : `<span class="pill lv lv-unknown" title="Not known until the next 10-minute read">?</span>`;

const opener = (kind, key, inner, cls = "") => `<button type="button" class="perm-link${cls ? ` ${cls}` : ""}" data-perm-open="${kind}:${esc(key)}">${inner}</button>`;

export const personRef = (login) => opener("person", login, `<span class="namelink">${avatar(login, 16)}<span>${esc(login)}</span></span>`);
export const teamRef = (id) => (teamOf(id) ? opener("team", id, `<span class="perm-team">${esc(teamOf(id).name)}</span>`) : `<span class="perm-team">team ${esc(id)}</span>`);
export const repoRef = (id) => {
  const repo = repoOf(id);
  if (!repo) return `<span class="repo">repo ${esc(id)}</span>`;
  return `${opener("repo", id, `<span class="repo">${esc(repo.name)}</span>`)}${repo.archived ? ` <span class="pill draft">archived</span>` : ""}`;
};

function repoList(ids, max = 3) {
  const sorted = [...ids].sort((a, b) => String(repoOf(a)?.name).localeCompare(String(repoOf(b)?.name)));
  const head = sorted.slice(0, max).map((id) => repoRef(id)).join(", ");
  return sorted.length > max ? `${head} <span class="sub">+${sorted.length - max} more</span>` : head;
}

function card(title, sub, body, { span = 6, cls = "", extra = "" } = {}) {
  return `<section class="card perm-card ${cls}" style="--span:${span}">
    <header><h2>${esc(title)}</h2>${sub ? `<span class="sub">${sub}</span>` : ""}${extra}</header>
    <div class="body flush">${body}</div>
  </section>`;
}

const table = (head, rows, empty) =>
  rows.length
    ? `<div class="tscroll perm-scroll"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`
    : `<div class="empty">${esc(empty)}</div>`;

function orgCard() {
  const members = Object.entries(data.org.members ?? {});
  const owners = members.filter(([, r]) => r === "owner").map(([l]) => l).sort((a, b) => a.localeCompare(b));
  const outside = idx.people.filter((l) => !(l in data.org.members)).length;
  const repos = Object.values(data.repos);
  const archived = repos.filter((r) => r.archived).length;
  const base = data.org.base ?? "unknown";
  const v = data.viewer ?? {};
  const notes = [
    v.ownerCheck === "not set" ? "Owner-only edits (owners, and the admin team itself) are off for everyone until ORG_OWNER_EMAILS is set on the app Worker." : "",
    v.ownerCheck === "emails" && !v.ownerEdits ? "Owners, and the admin team itself, can only be changed by org owners." : "",
    v.ownerMismatch ? `ORG_OWNER_EMAILS lists ${plural(v.ownerMismatch.listed, "email")}, but the org has ${plural(v.ownerMismatch.owners, "owner")}. Bring it up to date so owner-only edits go to the right people.` : "",
    v.canApply === false ? "Org-Manager's key isn't set on the app Worker, so changes can be staged but not applied." : "",
  ].filter(Boolean);
  if (data.org.rolesError) notes.push("NH-Dashbot can't read organization roles, so access from a role like All-repository admin isn't counted anywhere on this page. Give it organization Custom organization roles: Read.");
  const ownerNote = notes.map((n) => `<p class="hint perm-note">${esc(n)}</p>`).join("");
  const granting = repoRoles(data).filter((r) => (r.teams ?? []).length || Object.values(r.users ?? {}).some((u) => u.direct));
  const fact = (label, value, extra = "") => `<div class="perm-fact"><span class="sub">${esc(label)}</span><strong>${value}</strong>${extra}</div>`;
  return `<section class="card perm-card perm-org" style="--span:12">
    <header><h2>Org level</h2><span class="sub">${esc(data.org.login ?? "")}</span>
      <a class="perm-ext" href="${github(`orgs/${encodeURIComponent(data.org.login ?? "")}/people`)}" target="_blank" rel="noopener">People on GitHub</a></header>
    <div class="body">
      <div class="perm-facts">
        <div class="perm-fact perm-owners"><span class="sub">Owners</span><div class="perm-people">${owners.map(personRef).join("") || "—"}</div></div>
        ${fact("Base permission", esc(base), `<span class="sub">${base === "none" ? "members get no repo access just for being members" : "every member has this on every repo"}; changed on GitHub, not here</span>`)}
        ${fact("Members", members.length.toLocaleString())}
        ${fact("Outside collaborators", outside.toLocaleString())}
        ${fact("Teams", Object.keys(data.teams).length.toLocaleString())}

        ${fact("Repos", repos.length.toLocaleString(), archived ? `<span class="sub">${archived} archived${showArchived ? "" : ", hidden below"}</span>` : "")}
        ${granting.length ? `<div class="perm-fact perm-owners"><span class="sub">Org roles that give repo access</span><div class="perm-people">${granting.map((r) =>
          `<span class="perm-role-line">${rolePill(r.id)} ${[...(r.teams ?? []).map((t) => teamRef(t)), ...Object.entries(r.users ?? {}).filter(([, u]) => u.direct).map(([l]) => personRef(l))].join(" ")}</span>`).join("")}</div></div>` : ""}
      </div>
      ${ownerNote}
    </div>
  </section>`;
}

function fromText(row) {
  if (row.kind === "team" && row.from.role != null) return `org role ${esc(roleName(row.from.role))} · ${plural(row.members, "member")}`;
  if (row.kind === "team") {
    const own = row.repos.length - row.from.inherited;
    const grant = !row.from.inherited ? "own grant" : !own ? "inherited from parent" : `${own} own, ${row.from.inherited} inherited`;
    return `${grant} · ${plural(row.members, "member")}`;
  }
  return Object.entries(row.from)
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => {
      const label = key === "direct" ? "direct" : key === "base" ? "base permission" : key.startsWith("role:") ? `org role ${esc(roleName(key.slice(5)))}` : `via ${esc(teamOf(key.slice(5))?.name ?? key)}`;
      return Object.keys(row.from).length > 1 ? `${label} (${n})` : label;
    })
    .join(", ");
}

function adminsCard() {
  const rows = adminRows(data, idx, { archived: showArchived });
  const owners = Object.values(data.org.members).filter((r) => r === "owner").length;
  const html = rows.map((row) => `<tr>
    <td>${row.kind === "team" ? `${teamRef(row.team)} <span class="pill draft">team</span>` : `${personRef(row.login)}${row.outside ? ` <span class="pill neutral">outside</span>` : ""}`}</td>
    <td>${levelPill(row.level)}</td>
    <td><span class="num">${row.repos.length}</span> <span class="perm-repos">${repoList(row.repos, 2)}</span></td>
    <td class="sub">${fromText(row)}</td>
  </tr>`);
  return card("Repo admins & maintainers", `${plural(rows.length, "row")} · not the ${owners} owners, or people who only get it from a team`,
    table(["Who", "Level", "Repos", "From"], html, "Nobody but the owners has admin or maintain."));
}

function directCard() {
  const rows = directRows(data, { archived: showArchived });
  const outside = rows.filter((r) => r.outside).length;
  const html = rows.map((row) => {
    const counts = LEVELS.slice().reverse()
      .map((l) => [l, row.grants.filter((g) => g.level === l).length])
      .filter(([, n]) => n)
      .map(([l, n]) => `${levelPill(l)} <span class="num">${n}</span>`).join(" ");
    return `<tr>
      <td>${personRef(row.login)}${row.outside ? ` <span class="pill neutral">outside</span>` : ""}</td>
      <td class="perm-levels">${counts}${row.grants.some((g) => !g.level) ? ` ${levelPill(null)}` : ""}</td>
      <td class="perm-repos">${repoList(row.grants.map((g) => g.repo), 3)}</td>
    </tr>`;
  });
  return card("Direct grants & outside collaborators", `${plural(rows.length, "person", "people")} · ${outside} outside the org`,
    table(["Who", "Grants", "Repos"], html, "Nobody has been given a repo directly."));
}

function teamsCard() {
  const rows = teamRows(data, { archived: showArchived });
  const html = rows.map((row) => {
    const t = teamOf(row.team);
    const levels = LEVELS.slice().reverse().map((l) => `<td class="num${row.levels[l] ? "" : " sub"}">${row.levels[l] || "–"}</td>`).join("");
    return `<tr>
      <td style="padding-left:${12 + row.depth * 16}px">${row.depth ? `<span class="sub">↳ </span>` : ""}${teamRef(row.team)}${t.privacy === "secret" ? ` <span class="pill draft">secret</span>` : ""}${row.orgRoles.map((r) => ` ${rolePill(r)}`).join("")}</td>
      <td class="num">${row.members}${row.maintainers ? ` <span class="sub">· ${row.maintainers} maint.</span>` : ""}</td>
      ${levels}
    </tr>`;
  });
  return card("Teams overview", `${plural(rows.length, "team")} · child teams count what they inherit`,
    table(["Team", "Members", ...LEVELS.slice().reverse().map((l) => l[0].toUpperCase() + l.slice(1))], html, "No teams."),
    { extra: `<button type="button" class="ghost mini perm-ext" data-new-team>New team</button>` });
}

function problemsCard() {
  const p = problems(data, idx, { archived: showArchived });
  const sections = [];
  const item = (title, n, body) => `<details class="perm-problem"${n ? "" : " data-none"}><summary><span>${esc(title)}</span><span class="num${n ? " lb-warn" : " sub"}">${n}</span></summary>${n ? `<div class="perm-problem-body">${body}</div>` : ""}</details>`;

  sections.push(item("Pending org invites", p.orgInvites.length, `<ul>${p.orgInvites.map((i) =>
    `<li>${i.login ? personRef(i.login) : esc(i.email ?? "someone")} <span class="sub">as ${esc(i.role === "admin" ? "owner" : "member")}${i.by ? `, by ${esc(i.by)}` : ""}${i.at ? `, ${esc(ago(i.at))}` : ""}</span></li>`).join("")}</ul>`));

  sections.push(item("Pending repo invites", p.repoInvites.length, `<ul>${p.repoInvites.map((i) =>
    `<li>${i.login ? personRef(i.login) : "someone"} to ${repoRef(i.repo)} ${levelPill(i.level)} <span class="sub">${i.by ? `by ${esc(i.by)}, ` : ""}${esc(ago(i.at))}${i.expired ? ", expired" : ""}</span></li>`).join("")}</ul>`));

  sections.push(item("Teams with no members", p.emptyTeams.length, `<ul>${p.emptyTeams.map((id) => `<li>${teamRef(id)}</li>`).join("")}</ul>`));
  sections.push(item("Teams with no repos", p.teamsWithoutRepos.length, `<ul>${p.teamsWithoutRepos.map((id) => `<li>${teamRef(id)}</li>`).join("")}</ul>`));
  sections.push(item("Repos with no admin or maintainer besides owners", p.unowned.length, `<ul class="perm-cols">${p.unowned
    .sort((a, b) => repoOf(a).name.localeCompare(repoOf(b).name)).map((id) => `<li>${repoRef(id)}</li>`).join("")}</ul>`));

  const { checked, total } = p.invitesChecked;
  const coverage = checked < total ? `repo invites read for ${checked} of ${total} repos so far` : "repo invites read for every repo, each about once a day";
  return card("Problems & pending", esc(coverage), `<div class="perm-problems">${sections.join("")}</div>`);
}

function changesCard() {
  const rows = data.changes ?? [];
  const row = (e) => {
    const safe = typeof e.url === "string" && e.url.startsWith("https://github.com/");
    const text = safe ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.text)}</a>` : esc(e.text);
    return `<li class="log-row${e.tone ? ` tone-${esc(e.tone)}` : ""}">
      <time datetime="${esc(e.at)}" title="${esc(new Date(e.at).toLocaleString())}">${esc(when(e.at))}</time>
      <span class="log-what">${e.repo ? `<span class="log-repo">${repoByName(e.repo) ? opener("repo", repoByName(e.repo).id, esc(e.repo)) : esc(e.repo)}</span>` : ""}${
        e.via === "dashboard" ? `<span class="log-actor">${esc(personName(e.actor))}</span><span class="log-actor log-via" title="Made from this page, by Org-Manager">via dashboard</span>`
          : e.via ? `<span class="log-actor log-via" title="Found by the 10-minute check, not a webhook">${esc(e.via)}</span>`
            : e.actor ? `<span class="log-actor">${esc(personName(e.actor))}</span>` : ""}${text}</span>
    </li>`;
  };
  const count = rows.length >= KEEP_PER_BOX ? `latest ${KEEP_PER_BOX}` : plural(rows.length, "change");
  return card("Recent changes", `${count} · from webhooks, the 10-minute check and this page`,
    `<ol class="log-rows perm-changes">${rows.length ? rows.map(row).join("") : `<li class="log-empty">No access changes since the snapshot started.</li>`}</ol>`,
    { span: 12 });
}


/* ---- search ---- */

export function searchResults(q, limit = 12) {
  const needle = q.trim().toLowerCase();
  if (!needle || !data?.org) return { results: [], hiddenArchived: 0 };
  const score = (text) => {
    const t = String(text).toLowerCase();
    if (t === needle) return 0;
    if (t.startsWith(needle)) return 1;
    const i = t.indexOf(needle);
    return i < 0 ? null : 2 + i / 100;
  };
  const hits = [];
  for (const login of idx.people) {
    const s = score(login);
    if (s != null) hits.push({ kind: "person", key: login, label: login, s, note: data.org.members[login] === "owner" ? "owner" : login in data.org.members ? "member" : "outside" });
  }
  for (const t of Object.values(data.teams)) {
    const s = Math.min(score(t.name) ?? Infinity, score(t.slug) ?? Infinity);
    if (s !== Infinity) hits.push({ kind: "team", key: t.id, label: t.name, s, note: plural(Object.keys(t.members ?? {}).length, "member") });
  }
  let hiddenArchived = 0;
  for (const r of Object.values(data.repos)) {
    const s = score(r.name);
    if (s == null) continue;
    if (!shownRepo(r)) { hiddenArchived++; continue; }
    hits.push({ kind: "repo", key: r.id, label: r.name, s, note: [r.visibility !== "public" ? r.visibility : null, r.archived ? "archived" : null].filter(Boolean).join(", ") });
  }
  const order = { person: 0, team: 1, repo: 2 };
  hits.sort((a, b) => a.s - b.s || order[a.kind] - order[b.kind] || a.label.localeCompare(b.label));
  return { results: hits.slice(0, limit), more: Math.max(0, hits.length - limit), hiddenArchived };
}

const KIND_LABEL = { person: "Person", team: "Team", repo: "Repo" };

function searchListHtml() {
  if (!query.trim()) return "";
  const { results, more, hiddenArchived } = searchResults(query);
  if (active >= results.length) active = Math.max(0, results.length - 1);
  const items = results.map((r, i) => `<li role="option" id="perm-opt-${i}" class="perm-opt" aria-selected="${i === active}" data-perm-open="${r.kind}:${esc(r.key)}">
      <span class="pill draft">${KIND_LABEL[r.kind]}</span>
      ${r.kind === "person" ? `<span class="namelink">${avatar(r.label, 16)}<span>${esc(r.label)}</span></span>` : `<span class="${r.kind === "repo" ? "repo" : "perm-team"}">${esc(r.label)}</span>`}
      ${r.note ? `<span class="sub">${esc(r.note)}</span>` : ""}
    </li>`).join("");
  const foot = [
    more ? `${more} more, keep typing to narrow it` : "",
    hiddenArchived ? `${plural(hiddenArchived, "archived repo")} also ${hiddenArchived === 1 ? "matches" : "match"}, hidden while Show archived repos is off` : "",
  ].filter(Boolean).map((t) => `<li class="perm-opt-note sub">${esc(t)}</li>`).join("");
  return items || foot ? `${items}${foot}` : `<li class="perm-opt-note sub">Nothing matches “${esc(query.trim())}”.</li>`;
}

function paintSearch() {
  const list = document.querySelector("[data-perm-results]");
  const input = document.querySelector("[data-perm-search]");
  if (!list || !input) return;
  const html = searchListHtml();
  list.innerHTML = html;
  list.hidden = !html || searchFocus === null;
  input.setAttribute("aria-expanded", String(!list.hidden));
  const opt = list.querySelector('[aria-selected="true"]');
  if (opt) input.setAttribute("aria-activedescendant", opt.id);
  else input.removeAttribute("aria-activedescendant");
}

/* ---- detail panels ---- */

export function permQuery() {
  const target = open ?? pending;
  if (!target) return "";
  if (open) {
    const key = open.kind === "person" ? open.key : open.kind === "team" ? teamOf(open.key)?.slug : repoOf(open.key)?.name;
    if (key) return `?${open.kind}=${encodeURIComponent(key)}`;
  }
  return pending ? `?${pending.kind}=${encodeURIComponent(pending.key)}` : "";
}

export function readPermQuery(search) {
  const params = new URLSearchParams(search);
  const kind = ["person", "team", "repo"].find((k) => params.has(k));
  pending = kind ? { kind, key: params.get(kind) } : null;
  open = null;
  trail.length = 0;
  resolvePending();
}

function resolvePending() {
  if (!pending || !data?.org) return;
  const { kind, key } = pending;
  if (kind === "person" && idx.people.includes(key)) open = { kind, key };
  if (kind === "team" && teamBySlug(key)) open = { kind, key: String(teamBySlug(key).id) };
  if (kind === "repo" && repoByName(key)) open = { kind, key: String(repoByName(key).id) };
  pending = open ? null : pending;
}

function syncAddress() {
  const url = location.pathname + permQuery();
  if (location.pathname + location.search !== url) history.replaceState(null, "", url);
}

let sourceShown = "all";

function openPanel(kind, key, { push = true } = {}) {
  if (!(open?.kind === kind && open?.key === String(key))) sourceShown = "all";
  if (push && open && !(open.kind === kind && open.key === String(key))) trail.push(open);
  open = { kind, key: String(key) };
  pending = null;
  syncAddress();
  paintPanel();
  document.querySelector("[data-perm-panel] h2")?.focus();
}

function closePanel({ force = false } = {}) {
  if (drafts.size && !force) {
    closeBlocked = true;
    return paintPanel();
  }
  open = null;
  pending = null;
  trail.length = 0;
  syncAddress();
  paintPanel();
}

const sourceText = (s) => {
  if (s.kind === "owner") return "org owner";
  if (s.kind === "role") return `org role ${esc(roleName(s.role))} ${levelPill(s.level)}${s.team ? ` <span class="sub">via</span> ${teamRef(s.team)}` : ""}`;
  if (s.kind === "base") return `base permission ${esc(s.level)}`;
  if (s.kind === "direct") return `direct ${levelPill(s.level)}`;
  const via = `via ${teamRef(s.team)} ${levelPill(s.level)}`;
  return s.from ? `${via} <span class="sub">inherited from</span> ${teamRef(s.from)}` : via;
};

function sourceOptions(rows) {
  const found = new Map();
  for (const r of rows) {
    for (const s of r.sources) {
      if (s.kind === "direct") found.set("direct", [0, "direct access"]);
      else if (s.kind === "owner") found.set("owner", [1, "org owners"]);
      else if (s.kind === "base") found.set("base", [2, "base permission"]);
      else if (s.kind === "role") found.set(`role:${s.role}`, [3, `org role ${roleName(s.role)}`]);
      if (s.team != null) found.set(`team:${s.team}`, [4, `team ${teamOf(s.team)?.name ?? s.team}`]);
      if (s.from != null) found.set(`team:${s.from}`, [4, `team ${teamOf(s.from)?.name ?? s.from}`]);
    }
  }
  return [...found].sort((a, b) => a[1][0] - b[1][0] || a[1][1].localeCompare(b[1][1])).map(([v, [, text]]) => [v, text]);
}

const fromSource = (f) => (s) => f === "all" || s.kind === f || `role:${s.role}` === f || `team:${s.team}` === f || `team:${s.from}` === f;

function sourceFilter(rows) {
  const opts = sourceOptions(rows);
  if (!opts.some(([v]) => v === sourceShown)) sourceShown = "all";
  const shown = rows.filter((r) => r.sources.some(fromSource(sourceShown)));
  const control = opts.length > 1
    ? `<label class="sub perm-filter">From <select class="perm-sel" data-perm-source aria-label="Only show access from">${options([["all", "anywhere"], ...opts], sourceShown)}</select>${
      sourceShown !== "all" ? ` <span>${shown.length} of ${rows.length}</span>` : ""}</label>`
    : "";
  return { shown, control };
}

const levelCounts = (rows) => LEVELS.slice().reverse()
  .map((l) => [l, rows.filter((r) => r.level === l).length])
  .filter(([, n]) => n)
  .map(([l, n]) => `${levelPill(l)} <span class="num">${n}</span>`)
  .join(" ");

const section = (title, sub, body) => `<section class="perm-sec"><h3>${esc(title)}${sub ? ` <span class="sub">${sub}</span>` : ""}</h3>${body}</section>`;
const ptable = (head, rows, empty) => rows.length
  ? `<table class="perm-ptable"><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`
  : `<p class="sub perm-none">${esc(empty)}</p>`;

/* ---- editing ---- */

const same = (a, b) => (a ?? null) === (b ?? null);
const showValue = (v) => (v == null ? "none" : v === true ? "archived" : v === false ? "not archived" : String(v));
const teamRefOf = (t) => ({ id: t.id, slug: t.slug, name: t.name });
const repoRefOf = (r) => ({ id: r.id, name: r.name });
const nameOfTeam = (id) => teamOf(id)?.name ?? `team ${id}`;
const loginIn = (obj, login) => Object.keys(obj ?? {}).find((k) => k.toLowerCase() === login.toLowerCase()) ?? null;
const valueIn = (obj, login) => {
  const k = loginIn(obj, login);
  return k == null ? null : obj[k] ?? "unknown";
};
const LEVEL_OPTIONS = [...LEVELS.map((l) => [l, l]), [null, "remove"]];
const ROLE_OPTIONS = [...TEAM_ROLES.map((r) => [r, r]), [null, "remove"]];

const drafts = new Map();
let closeBlocked = false;

function setDraft(c) {
  const key = keyOf(c);
  const st = stagedFor(key);
  if (c.kind !== "team_create" && same(st ? st.to : c.from, c.to)) drafts.delete(key);
  else drafts.set(key, c);
  closeBlocked = false;
  paintPanel();
}

function dropDraft(key) {
  drafts.delete(key);
  closeBlocked = false;
  paintPanel();
}

function saveDrafts() {
  const list = [...drafts.values()];
  drafts.clear();
  closeBlocked = false;
  stageMany(list);
}

const pendingFor = (key) => drafts.get(key) ?? stagedFor(key);

function undoButton(key) {
  const d = drafts.get(key);
  const st = stagedFor(key);
  if (d) return `<button type="button" class="perm-undo" data-undraft="${esc(key)}" title="Not saved yet. Was ${esc(showValue(st ? st.to : d.from))}">undo</button>`;
  if (st) return `<button type="button" class="perm-undo" data-unstage="${esc(key)}" title="Saved, waiting to be applied. Was ${esc(showValue(st.from))}">undo</button>`;
  return "";
}

function editSelect(base, current, options, label) {
  const key = keyOf(base);
  const d = drafts.get(key);
  const st = stagedFor(key);
  const value = d ? d.to : st ? st.to : current;
  const locked = ownerOnly(base, data);
  const unknown = current === "unknown" && !d && !st ? `<option value="unknown" selected disabled>?</option>` : "";
  const opts = options.map(([v, text]) => `<option value="${esc(v ?? "")}"${!unknown && same(v, value) ? " selected" : ""}>${esc(text)}</option>`).join("");
  return `<span class="perm-edit${d ? " is-draft" : st ? " is-staged" : ""}"><select class="perm-sel" aria-label="${esc(label)}" data-edit="${esc(JSON.stringify({ ...base, from: current }))}"${
    locked ? ` disabled title="Only an org owner can change this"` : ""}>${unknown}${opts}</select>${undoButton(key)}</span>`;
}

const removing = (base) => (pendingFor(keyOf(base))?.to === null && base.kind !== "archived" ? ` class="perm-removing"` : "");

function stagedHere(match) {
  const unsaved = [...drafts.values()].filter(match);
  const saved = stagedList().filter((c) => match(c) && !drafts.has(keyOf(c)));
  if (!unsaved.length && !saved.length) return "";
  const row = (c, draft) => {
    const f = flagsOf(c, data);
    return `<li><span>${esc(describe(c, { teamName: nameOfTeam }))}</span>
      <span class="pill ${draft ? "perm-unsaved" : "neutral"}">${draft ? "not saved" : "saved"}</span>${f.invite ? ` <span class="pill neutral">invite</span>` : ""}${
      f.blocked ? ` <span class="pill perm-blocked">${f.blocked.startsWith("only") ? "owner only" : "gone"}</span>` : ""}
      <button type="button" class="perm-undo" ${draft ? "data-undraft" : "data-unstage"}="${esc(keyOf(c))}">undo</button></li>`;
  };
  return section("Changes here", String(unsaved.length + saved.length),
    `<ul class="perm-plist perm-staged-list">${unsaved.map((c) => row(c, true)).join("")}${saved.map((c) => row(c, false)).join("")}</ul>`);
}

function footHtml() {
  const n = drafts.size;
  const waiting = stagedList().length;
  if (n) {
    return `<div class="perm-pfoot${closeBlocked ? " is-blocked" : ""}">
      <span>${closeBlocked ? "Save or discard your edits before closing." : `<strong>${n}</strong> unsaved edit${n === 1 ? "" : "s"}`}</span>
      <span class="perm-tray-gap"></span>
      <button type="button" class="ghost" data-drafts="discard">Discard</button>
      <button type="button" class="daily-go" data-drafts="save">Save ${n === 1 ? "edit" : `${n} edits`}</button>
    </div>`;
  }
  return `<div class="perm-pfoot">
    <span class="sub">${waiting ? `${waiting} saved change${waiting === 1 ? "" : "s"} waiting to be applied.` : "Edits aren't kept until you save them, and nothing reaches GitHub until you apply them."}</span>
    <span class="perm-tray-gap"></span>
    ${waiting ? `<button type="button" class="daily-go" data-tray="review">Review &amp; apply</button>` : ""}
  </div>`;
}

const options = (list, selected) => list.map(([v, text]) => `<option value="${esc(v)}"${String(v) === String(selected) ? " selected" : ""}>${esc(text)}</option>`).join("");

function addForm(kind, base, inner, button = "Add", locked = false) {
  return `<form class="perm-add" data-add="${esc(kind)}" data-base="${esc(JSON.stringify(base))}">${inner}
    <button type="submit" class="ghost mini"${locked ? ` disabled title="Only an org owner can change this"` : ""}>${esc(button)}</button>
    <span class="perm-add-err sub" aria-live="polite"></span></form>`;
}

const teamPicker = (exclude = () => false) => `<select name="team" class="perm-sel" aria-label="Team"><option value="">Team…</option>${
  Object.values(data.teams).filter((t) => !exclude(t)).sort((a, b) => a.name.localeCompare(b.name)).map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("")}</select>`;
const levelPicker = (name = "level", picked = "read") => `<select name="${name}" class="perm-sel" aria-label="Level">${options(LEVELS.map((l) => [l, l]), picked)}</select>`;
const rolePicker = () => `<select name="role" class="perm-sel" aria-label="Role">${options(TEAM_ROLES.map((r) => [r, r]), "member")}</select>`;
const repoInput = () => `<input name="repo" class="perm-input" list="perm-repos" placeholder="Repo" aria-label="Repo" autocomplete="off" spellcheck="false">`;
const loginInput = () => `<input name="login" class="perm-input" list="perm-people" placeholder="GitHub login" aria-label="GitHub login" autocomplete="off" spellcheck="false">`;

function descendantIds(id) {
  const out = new Set([String(id)]);
  for (let grew = true; grew;) {
    grew = false;
    for (const t of Object.values(data.teams)) {
      if (t.parent != null && out.has(String(t.parent)) && !out.has(String(t.id))) { out.add(String(t.id)); grew = true; }
    }
  }
  return out;
}

function changeFromForm(form) {
  const kind = form.dataset.add;
  const c = { kind, ...JSON.parse(form.dataset.base || "{}") };
  const f = new FormData(form);
  if (f.has("team")) {
    const t = teamOf(f.get("team"));
    if (!t) return { error: "Pick a team." };
    c.team = teamRefOf(t);
  }
  if (f.has("repo")) {
    const r = repoByName(String(f.get("repo")).trim());
    if (!r) return { error: "No repo by that name." };
    c.repo = repoRefOf(r);
  }
  if (f.has("login")) {
    const typed = String(f.get("login")).trim().replace(/^@/, "");
    if (!validLogin(typed)) return { error: "That isn't a GitHub login." };
    c.login = idx.people.find((p) => p.toLowerCase() === typed.toLowerCase()) ?? typed;
  }
  if (kind === "team_member") {
    c.from = valueIn(teamOf(c.team.id).members, c.login);
    c.to = String(f.get("role"));
  } else if (kind === "team_repo") {
    const own = idx.direct[c.team.id] ?? {};
    c.from = c.repo.id in own ? own[c.repo.id] ?? "unknown" : null;
    c.to = String(f.get("level"));
  } else if (kind === "collaborator") {
    c.from = valueIn(repoOf(c.repo.id).collaborators, c.login);
    c.to = String(f.get("level"));
  } else if (kind === "team_rename") {
    const name = String(f.get("name")).trim();
    if (!validTeamName(name)) return { error: "A team needs a name." };
    if (Object.values(data.teams).some((t) => t.id !== c.team.id && t.name.toLowerCase() === name.toLowerCase())) return { error: "There's already a team with that name." };
    c.from = teamOf(c.team.id).name;
    c.to = name;
  } else if (kind === "team_description") {
    const text = String(f.get("description") ?? "").trim();
    if (text.length > MAX_DESCRIPTION) return { error: `Keep it under ${MAX_DESCRIPTION} characters.` };
    c.from = teamOf(c.team.id).description ?? "";
    c.to = text;
  } else if (kind === "team_create") {
    const name = String(f.get("name")).trim();
    if (!validTeamName(name)) return { error: "A team needs a name." };
    if (Object.values(data.teams).some((t) => t.name.toLowerCase() === name.toLowerCase())) return { error: "There's already a team with that name." };
    c.name = name;
    c.parent = f.get("parent") ? Number(f.get("parent")) : null;
    c.from = null;
    c.to = "created";
  }
  if (c.kind !== "team_create" && same(c.from, c.to)) return { error: `Already ${showValue(c.to)}.` };
  if (ownerOnly(c, data)) return { error: "Only an org owner can make this change." };
  return { change: c };
}

function bulkButton(kind, key, label) {
  return `<button type="button" class="ghost mini" data-perm-bulk="${esc(kind)}:${esc(key)}">${esc(label)}</button>`;
}

const readValue = (kind, raw) => (kind === "archived" ? raw === "true" : kind === "team_parent" ? (raw === "" ? null : Number(raw)) : raw === "" ? null : raw);

/* ---- panels ---- */

function personPanel(login) {
  const role = data.org.members[login];
  const access = personAccess(data, idx, login, { archived: showArchived });
  const teams = (idx.teamsOf.get(login) ?? []).map(({ id, role: r }) => ({ team: teamOf(id), role: r })).sort((a, b) => a.team.name.localeCompare(b.team.name));
  const invites = [
    ...(data.org.invites ?? []).filter((i) => i.login === login).map((i) => `<li>Invited to the org as ${esc(i.role === "admin" ? "an owner" : "a member")}${i.by ? ` by ${esc(i.by)}` : ""} <span class="sub">${esc(ago(i.at))}</span></li>`),
    ...Object.entries(data.repoInvites ?? {}).flatMap(([id, e]) => (e.invites ?? []).filter((i) => i.login === login && repoOf(id) && shownRepo(repoOf(id)))
      .map((i) => `<li>Invited to ${repoRef(id)} ${levelPill(i.level)}${i.by ? ` by ${esc(i.by)}` : ""} <span class="sub">${esc(ago(i.at))}${i.expired ? ", expired" : ""}</span></li>`)),
  ];
  const roleText = role === "owner" ? "Org owner" : role === "member" ? "Org member" : "Outside collaborator";
  const roleEdit = role ? editSelect({ kind: "owner", login }, role, [["owner", "owner"], ["member", "member"]], `${login}'s org role`) : "";
  const head = `<div class="perm-phead">${avatar(login, 40)}<div><h2 tabindex="-1">${esc(login)}</h2><span class="sub">${roleText}</span></div></div>
    <div class="perm-plinks"><a href="${github(encodeURIComponent(login))}" target="_blank" rel="noopener">GitHub profile</a>
      <a href="${contribHref({ login })}" data-drilllink>Contributor Drilldown</a></div>
    <div class="perm-pedit">${role ? `<label class="sub">Org role ${roleEdit}</label>` : ""}${bulkButton("person", login, "Bulk change for this person")}</div>`;
  const teamRows = teams.map(({ team, role: r }) => {
    const ups = teamAncestors(data.teams, team.id);
    const base = { kind: "team_member", team: teamRefOf(team), login };
    return `<tr${removing(base)}><td>${teamRef(team.id)}${ups.length ? ` <span class="sub">under</span> ${ups.map((u) => teamRef(u.id)).join(" › ")}` : ""}</td>
      <td>${editSelect(base, r ?? "unknown", ROLE_OPTIONS, `${login}'s role on ${team.name}`)}</td></tr>`;
  });
  const repoFilter = sourceFilter(access);
  const repoRows = repoFilter.shown.map((a) => {
    const direct = a.sources.find((s) => s.kind === "direct");
    const base = { kind: "collaborator", repo: repoRefOf(repoOf(a.repo)), login };
    return `<tr${direct ? removing(base) : ""}><td>${repoRef(a.repo)}</td><td>${levelPill(a.level)}</td><td class="perm-src">${a.sources.map(sourceText).join("<br>")}</td>
      <td>${direct ? editSelect(base, direct.level ?? "unknown", LEVEL_OPTIONS, `${login}'s direct access to ${repoOf(a.repo).name}`) : `<span class="sub">–</span>`}</td></tr>`;
  });
  const inTeams = new Set(teams.map((t) => String(t.team.id)));
  const orgRoles = Object.values(data.org.roles ?? {}).flatMap((r) => {
    if (r.users?.[login]?.direct) return [`${rolePill(r.id)}`];
    const via = (r.teams ?? []).find((t) => inTeams.has(String(t)));
    return via != null ? [`${rolePill(r.id)} <span class="sub">via</span> ${teamRef(via)}`] : r.users?.[login] ? [rolePill(r.id)] : [];
  });
  return head +
    (orgRoles.length ? `<div class="perm-roles"><span class="sub">Org roles</span> ${orgRoles.join(" ")}</div>` : "") +
    stagedHere((c) => c.login && c.login.toLowerCase() === login.toLowerCase()) +
    (role === "owner" ? `<p class="hint perm-pnote">Owners are admin on every repo, and that can't be lowered from a repo.</p>` : "") +
    (invites.length ? section("Pending invites", "", `<ul class="perm-plist">${invites.join("")}</ul>`) : "") +
    section("Teams", teams.length ? String(teams.length) : "", ptable(["Team", "Role"], teamRows, role ? "Not on any team." : "Not on any team, and not an org member.") +
      addForm("team_member", { login }, `${teamPicker((t) => inTeams.has(String(t.id)))}${rolePicker()}`, role ? "Add to team" : "Invite to team")) +
    section("Repos", `${access.length} ${levelCounts(access)}`, repoFilter.control + ptable(["Repo", "Level", "From", "Direct"], repoRows, "No access to any repo" + (showArchived ? "." : " that isn't archived.")) +
      addForm("collaborator", { login }, `${repoInput()}${levelPicker()}`, "Give direct access"));
}

function teamPanel(id) {
  const team = teamOf(id);
  const ups = teamAncestors(data.teams, team.id);
  const kids = Object.values(data.teams).filter((t) => String(t.parent) === String(team.id)).sort((a, b) => a.name.localeCompare(b.name));
  const members = Object.entries(team.members ?? {}).sort((a, b) => (a[1] === "maintainer" ? 0 : 1) - (b[1] === "maintainer" ? 0 : 1) || a[0].localeCompare(b[0]));
  const repos = Object.entries(team.repos ?? {})
    .filter(([rid]) => repoOf(rid) && shownRepo(repoOf(rid)))
    .map(([rid, level]) => {
      const from = repoTeams(data, idx, rid).find((t) => String(t.team) === String(team.id))?.from ?? null;
      return { repo: rid, level, from };
    })
    .sort((a, b) => rank(b.level) - rank(a.level) || repoOf(a.repo).name.localeCompare(repoOf(b.repo).name));
  const inherited = repos.filter((r) => r.from).length;
  const orgRoles = teamRoles(data, team.id);
  const allRepos = orgRoles.filter((r) => r.level).sort((a, b) => rank(b.level) - rank(a.level))[0] ?? null;
  const ref = teamRefOf(team);
  const locked = ownerOnly({ kind: "team_rename", team: ref }, data);
  const below = descendantIds(team.id);
  const parentOptions = [["", "(top level)"], ...Object.values(data.teams).filter((t) => !below.has(String(t.id))).sort((a, b) => a.name.localeCompare(b.name)).map((t) => [t.id, t.name])];
  const deleting = pendingFor(keyOf({ kind: "team_delete", team: ref }));
  const head = `<div class="perm-phead"><div><h2 tabindex="-1">${esc(team.name)}</h2><span class="sub">Team · ${esc(team.slug)}${team.privacy ? ` · ${esc(PRIVACY_LABEL[team.privacy] ?? team.privacy)}` : ""}</span></div></div>
    <div class="perm-plinks"><a href="${github(`orgs/${encodeURIComponent(data.org.login)}/teams/${encodeURIComponent(team.slug)}`)}" target="_blank" rel="noopener">Team on GitHub</a>
      <a href="${github(`orgs/${encodeURIComponent(data.org.login)}/teams/${encodeURIComponent(team.slug)}/edit/review_assignment`)}" target="_blank" rel="noopener" title="GitHub has no API for these, so they're changed there">Code review settings</a></div>
    <div class="perm-pedit">
      ${addForm("team_rename", { team: ref }, `<input name="name" class="perm-input" value="${esc(team.name)}" aria-label="Team name" spellcheck="false">`, "Rename", locked)}
      ${addForm("team_description", { team: ref }, `<input name="description" class="perm-input perm-desc" value="${esc(pendingFor(keyOf({ kind: "team_description", team: ref }))?.to ?? team.description ?? "")}" maxlength="${MAX_DESCRIPTION}" placeholder="No description" aria-label="Team description">`, "Save description", locked)}
      <label class="sub">Parent ${editSelect({ kind: "team_parent", team: ref }, team.parent ?? null, parentOptions.map(([v, t]) => [v === "" ? null : v, t]), `${team.name}'s parent team`)}</label>
      <label class="sub">Visibility ${editSelect({ kind: "team_privacy", team: ref }, team.privacy ?? "unknown", Object.entries(PRIVACY_LABEL), `${team.name}'s visibility`)}</label>
      <label class="sub">Notifications ${editSelect({ kind: "team_notifications", team: ref }, team.notifications ?? "unknown", Object.entries(NOTIFY_LABEL), `${team.name}'s notifications`)}</label>
      ${deleting
        ? `<button type="button" class="ghost mini" ${drafts.has(keyOf({ kind: "team_delete", team: ref })) ? "data-undraft" : "data-unstage"}="${esc(keyOf({ kind: "team_delete", team: ref }))}">Don't delete</button>`
        : `<button type="button" class="ghost mini perm-danger" data-stage="${esc(JSON.stringify({ kind: "team_delete", team: ref, from: "exists", to: null }))}"${locked ? ` disabled title="Only an org owner can change this"` : ""}>Delete team</button>`}
      ${bulkButton("team", team.id, "Bulk change for this team")}
    </div>
    ${orgRoles.length ? `<div class="perm-roles"><span class="sub">Org roles</span> ${orgRoles.map((r) => rolePill(r.id)).join(" ")}</div>` : ""}
    ${locked ? `<p class="hint perm-pnote">This is the admin team. Only org owners can change its members, its repos, its name, its parent or delete it.</p>` : ""}`;
  const family = [
    ups.length ? `<li><span class="sub">Parent</span> ${ups.map((u) => teamRef(u.id)).join(" › ")}</li>` : "",
    kids.length ? `<li><span class="sub">Child teams</span> ${kids.map((k) => teamRef(k.id)).join(", ")}</li>` : "",
  ].filter(Boolean).join("");
  const memberRows = members.map(([login, r]) => {
    const base = { kind: "team_member", team: ref, login };
    return `<tr${removing(base)}><td>${personRef(login)}</td><td>${editSelect(base, r ?? "unknown", ROLE_OPTIONS, `${login}'s role on ${team.name}`)}</td>${teamsPage.memberCells(team.id, login)}</tr>`;
  });
  const repoRows = repos.map((r) => {
    const base = { kind: "team_repo", team: ref, repo: repoRefOf(repoOf(r.repo)) };
    const level = r.from ? levelPill(r.level) : editSelect(base, r.level ?? "unknown", LEVEL_OPTIONS, `${team.name} on ${repoOf(r.repo).name}`);
    return `<tr${r.from ? "" : removing(base)}><td>${repoRef(r.repo)}</td><td>${level}</td><td class="sub">${r.from ? `inherited from ${teamRef(r.from)}` : "own grant"}</td></tr>`;
  });
  return head +
    stagedHere((c) => (c.team && String(c.team.id) === String(team.id)) || (c.kind === "team_create" && String(c.parent) === String(team.id))) +
    (family ? `<ul class="perm-plist perm-family">${family}</ul>` : "") +
    section("Members", `${members.length}${members.some(([, r]) => r === "maintainer") ? ` · ${plural(members.filter(([, r]) => r === "maintainer").length, "maintainer")}` : ""}`,
      ptable(["Who", "Role", ...teamsPage.memberHead()], memberRows, "Nobody is on this team.") +
      addForm("team_member", { team: ref }, `${loginInput()}${rolePicker()}`, "Add member", locked)) +
    section("Repos", `${repos.length} ${levelCounts(repos)}${inherited ? ` · ${inherited} inherited` : ""}`,
      (allRepos ? `<p class="hint perm-pnote">${levelPill(allRepos.level)} on every repo through the ${esc(allRepos.label)} org role, whatever's listed below. Org roles are changed on GitHub.</p>` : "") +
      ptable(["Repo", "Level", "From"], repoRows, allRepos ? "No repos of its own." : "This team has no repos" + (showArchived ? "." : " that aren't archived.")) +
      addForm("team_repo", { team: ref }, `${repoInput()}${levelPicker()}`, "Give this team a repo", locked) +
      (inherited ? `<p class="sub perm-none">An inherited grant is changed on the parent team. Giving this team a higher level of its own works here.</p>` : "")) +
    teamsPage.sections(team);
}

function repoPanel(id) {
  const repo = repoOf(id);
  const teams = repoTeams(data, idx, String(repo.id));
  const people = repoAccess(data, idx, String(repo.id));
  const invites = (data.repoInvites?.[repo.id]?.invites ?? []);
  const checked = data.repoInvites?.[repo.id]?.checkedAt;
  const ref = repoRefOf(repo);
  const head = `<div class="perm-phead"><div><h2 tabindex="-1">${esc(repo.name)}</h2><span class="sub">Repo · ${esc(repo.visibility)}${repo.archived ? " · archived" : ""}</span></div></div>
    <div class="perm-plinks"><a href="${github(`${encodeURIComponent(data.org.login)}/${encodeURIComponent(repo.name)}/settings/access`)}" target="_blank" rel="noopener">Access settings on GitHub</a>
      <a href="${repoHref(repo.name)}" data-drilllink>Repo Drilldown</a></div>
    <div class="perm-pedit">
      <label class="sub">Visibility ${editSelect({ kind: "visibility", repo: ref }, repo.visibility, [["public", "public"], ["private", "private"]], `${repo.name}'s visibility`)}</label>
      <label class="sub">Archived ${editSelect({ kind: "archived", repo: ref }, Boolean(repo.archived), [[false, "no"], [true, "yes"]], `Whether ${repo.name} is archived`)}</label>
    </div>`;
  const teamRows = teams.map((t) => {
    const base = { kind: "team_repo", team: teamRefOf(teamOf(t.team)), repo: ref };
    const own = t.grant !== undefined && !t.from;
    const from = [
      t.role != null ? `org role ${rolePill(t.role)}` : "",
      t.grant === undefined ? "" : t.from ? `inherited from ${teamRef(t.from)}` : `own grant ${levelPill(t.grant)}`,
    ].filter(Boolean).join("<br>");
    return `<tr${own ? removing(base) : ""}><td>${teamRef(t.team)}</td><td>${levelPill(t.level)}</td><td class="perm-src sub">${from}</td>
      <td>${own ? editSelect(base, t.grant ?? "unknown", LEVEL_OPTIONS, `${teamOf(t.team).name} on ${repo.name}`) : `<span class="sub">–</span>`}</td></tr>`;
  });
  const peopleFilter = sourceFilter(people);
  const peopleRows = peopleFilter.shown.map((p) => {
    const direct = p.sources.find((s) => s.kind === "direct");
    const base = { kind: "collaborator", repo: ref, login: p.login };
    return `<tr${direct ? removing(base) : ""}><td>${personRef(p.login)}${p.outside ? ` <span class="pill neutral">outside</span>` : ""}</td><td>${levelPill(p.level)}</td><td class="perm-src">${p.sources.map(sourceText).join("<br>")}</td>
      <td>${direct ? editSelect(base, direct.level ?? "unknown", LEVEL_OPTIONS, `${p.login}'s direct access`) : `<span class="sub">–</span>`}</td></tr>`;
  });
  const onRepo = new Set(teams.filter((t) => t.grant !== undefined && !t.from).map((t) => String(t.team)));
  return head +
    stagedHere((c) => c.repo && String(c.repo.id) === String(repo.id)) +
    (repo.archived ? `<p class="hint perm-pnote">Archived: nobody can push to it, whatever their level.</p>` : "") +
    section("Teams", String(teams.length), ptable(["Team", "Level", "From", "Own grant"], teamRows, "No team has access.") +
      addForm("team_repo", { repo: ref }, `${teamPicker((t) => onRepo.has(String(t.id)))}${levelPicker()}`, "Give a team access")) +
    section("People", `${people.length} ${levelCounts(people)}`, peopleFilter.control + ptable(["Who", "Level", "From", "Direct"], peopleRows, "Nobody has access.") +
      addForm("collaborator", { repo: ref }, `${loginInput()}${levelPicker()}`, "Give someone direct access")) +
    section("Pending invites", checked ? `checked ${esc(ago(checked))}` : "not checked yet",
      invites.length ? `<ul class="perm-plist">${invites.map((i) => `<li>${i.login ? personRef(i.login) : "someone"} ${levelPill(i.level)}${i.by ? ` <span class="sub">by ${esc(i.by)}</span>` : ""} <span class="sub">${esc(ago(i.at))}${i.expired ? ", expired" : ""}</span></li>`).join("")}</ul>`
        : `<p class="sub perm-none">${checked ? "None." : "Repo invites are read a few repos a tick, each about once a day."}</p>`);
}

function openNewTeam() {
  const dialog = document.createElement("dialog");
  dialog.className = "daily-dialog";
  const parents = [["", "(top level)"], ...Object.values(data.teams).sort((a, b) => a.name.localeCompare(b.name)).map((t) => [t.id, t.name])];
  dialog.innerHTML = `<h3>New team</h3>
    <form class="perm-newteam" data-add="team_create" data-base="{}">
      <label>Name <input name="name" class="perm-input" required autocomplete="off" spellcheck="false"></label>
      <label>Parent <select name="parent" class="perm-sel">${options(parents, "")}</select></label>
      <p class="daily-last">New teams are closed (visible to the whole org), so they can have a parent. Saving it adds it to the changes waiting to be applied.</p>
      <span class="perm-add-err sub" aria-live="polite"></span>
      <div class="daily-actions"><span class="ra-count"></span>
        <button type="button" class="ghost" data-close>Cancel</button>
        <button type="submit" class="daily-go">Save</button></div>
    </form>`;
  dialog.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) dialog.close(); });
  dialog.addEventListener("submit", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const { change, error } = changeFromForm(e.target);
    if (error) { e.target.querySelector(".perm-add-err").textContent = error; return; }
    stage(change);
    dialog.close();
  });
  dialog.addEventListener("close", () => dialog.remove());
  document.body.appendChild(dialog);
  dialog.showModal();
}

function panelHtml() {
  if (!open || !data?.org) return "";
  const { kind, key } = open;
  const exists = kind === "person" ? idx.people.includes(key) : kind === "team" ? teamOf(key) : repoOf(key);
  const body = !exists
    ? `<p class="sub">This ${kind} isn't in the snapshot any more.</p>`
    : kind === "person" ? personPanel(key) : kind === "team" ? teamPanel(key) : repoPanel(key);
  return `<div class="perm-modal" data-perm-backdrop><div class="perm-panel" role="dialog" aria-modal="true" aria-label="${esc(KIND_LABEL[kind])} details">
    <div class="perm-pbar">
      ${trail.length ? `<button type="button" class="ghost" data-perm-back>← Back</button>` : "<span></span>"}
      <button type="button" class="icon-btn" data-perm-close aria-label="Close">✕</button>
    </div>
    <div class="perm-pbody">${body}</div>
    ${footHtml()}
  </div></div>`;
}

function paintPanel() {
  const el = document.querySelector("[data-perm-panel]");
  const top = el?.querySelector(".perm-pbody")?.scrollTop ?? 0;
  const stay = el?.dataset.showing === (open ? `${open.kind}:${open.key}` : "");
  if (el) {
    el.innerHTML = panelHtml();
    el.dataset.showing = open ? `${open.kind}:${open.key}` : "";
    if (stay) { const body = el.querySelector(".perm-pbody"); if (body) body.scrollTop = top; }
  }
  document.querySelector("[data-perm]")?.classList.toggle("has-panel", Boolean(open));
  document.documentElement.classList.toggle("perm-modal-open", Boolean(open) && Boolean(el));
}

function bodyHtml() {
  if (failed && !data) return `<div class="error">${esc(failed)}</div>`;
  if (!data) return `<div class="empty">Loading the permissions snapshot…</div>`;
  if (!data.org) {
    return `<section class="card stub" style="--span:12"><div class="body">
      <h2>No snapshot yet</h2><p>The first read runs on the 10-minute tick after the webhook Worker deploys.</p></div></section>`;
  }
  const people = idx.people.map((l) => `<option value="${esc(l)}">`).join("");
  const repos = Object.values(data.repos).filter(shownRepo).map((r) => r.name).sort((a, b) => a.localeCompare(b)).map((n) => `<option value="${esc(n)}">`).join("");
  const body = mode === "teams" ? teamsPage.body()
    : `<div class="grid perm-grid">${orgCard()}${adminsCard()}${directCard()}${teamsCard()}${problemsCard()}${changesCard()}${bulkCard()}</div>`;
  return `${body}<datalist id="perm-people">${people}</datalist><datalist id="perm-repos">${repos}</datalist>`;
}

function statusHtml() {
  if (!data?.readAt) return "";
  const extra = mode === "teams" ? teamsPage.status() : "";
  return `Read ${esc(ago(data.readAt))} by the 10-minute check${failed ? ` · <span class="lb-warn">${esc(failed)}</span>` : ""}${extra ? ` · ${extra}` : ""}`;
}

export function permissionsBody(page = "permissions") {
  mode = page === "teams" ? "teams" : "permissions";
  return `<div class="perm${open ? " has-panel" : ""}${mode === "teams" ? " tm" : ""}" data-perm>
    <div class="perm-bar">
      <div class="perm-search">
        <input type="search" data-perm-search value="${esc(query)}" placeholder="Search people, teams and repos" aria-label="Search people, teams and repos"
          role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="perm-results" autocomplete="off" spellcheck="false">
        <ul class="perm-results" id="perm-results" role="listbox" data-perm-results hidden></ul>
      </div>
      <label class="perm-toggle"><input type="checkbox" data-perm-archived${showArchived ? " checked" : ""}> Show archived repos</label>
      <span class="perm-status sub" data-perm-status>${statusHtml()}</span>
    </div>
    <div data-perm-body>${bodyHtml()}</div>
    <div data-perm-panel>${panelHtml()}</div>
    ${trayMarkup()}
  </div>`;
}

export function redrawPermissions() {
  if (document.querySelector("[data-perm]")) redraw();
}

function redraw() {
  const body = document.querySelector("[data-perm-body]");
  const focused = document.activeElement?.closest?.("[data-bulk]") ? document.activeElement : null;
  const keep = focused?.dataset.bulkField ? { field: focused.dataset.bulkField, at: focused.selectionStart ?? null } : null;
  if (body) keepScroll(body, () => { body.innerHTML = bodyHtml(); });
  if (keep) {
    const el = document.querySelector(`[data-bulk-field="${keep.field}"]`);
    el?.focus();
    if (keep.at != null) el?.setSelectionRange?.(keep.at, keep.at);
  }
  const status = document.querySelector("[data-perm-status]");
  if (status) status.innerHTML = statusHtml();
  paintPanel();
  paintSearch();
  paintTray();
}

configureApply({ data: () => data, redraw: () => redraw(), reload: () => load() });
configureBulk({ data: () => data, idx: () => idx, archived: () => showArchived, levelPill, repoRef });

async function load() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await fetch(`${API}/api/permissions`, { cache: "no-store" });
      if (!res.ok) throw new Error(res.status === 403 ? "Only the admin team can see permissions." : `The permissions snapshot couldn't be loaded (${res.status}).`);
      data = await res.json();
      idx = data.org ? indexSnapshot(data) : null;
      failed = null;
      resolvePending();
      if (open || pending) syncAddress();
      fetchedAt = Date.now();
    } catch (err) {
      failed = err instanceof TypeError ? "The permissions snapshot couldn't be loaded." : err.message;
    } finally {
      inFlight = null;
      redraw();
    }
  })();
  return inFlight;
}

function pick(el) {
  const [kind, ...rest] = el.dataset.permOpen.split(":");
  const key = rest.join(":");
  openPanel(kind, key);
}

function wire() {
  if (wired) return;
  wired = true;
  document.addEventListener("change", (e) => {
    if (bulkEvent(e)) return;
    if (e.target.matches?.("[data-perm-source]")) {
      sourceShown = e.target.value;
      return paintPanel();
    }
    const sel = e.target.closest?.("select[data-edit]");
    if (sel && sel.closest("[data-perm]")) {
      const base = JSON.parse(sel.dataset.edit);
      return setDraft({ ...base, to: readValue(base.kind, sel.value) });
    }
    if (!e.target.matches?.("[data-perm-archived]")) return;
    showArchived = e.target.checked;
    try { localStorage.setItem(ARCHIVED_KEY, showArchived ? "1" : "0"); } catch {}
    redraw();
  });
  document.addEventListener("input", (e) => {
    if (bulkEvent(e)) return;
    if (!e.target.matches?.("[data-perm-search]")) return;
    query = e.target.value;
    active = 0;
    paintSearch();
  });
  document.addEventListener("focusin", (e) => {
    if (!e.target.matches?.("[data-perm-search]")) return;
    searchFocus = e.target.selectionStart ?? query.length;
    paintSearch();
  });
  document.addEventListener("selectionchange", () => {
    const el = document.activeElement;
    if (el?.matches?.("[data-perm-search]")) searchFocus = el.selectionStart ?? query.length;
  });
  document.addEventListener("focusout", (e) => {
    if (!e.target.matches?.("[data-perm-search]")) return;
    setTimeout(() => {
      if (document.activeElement?.matches?.("[data-perm-search]")) return;
      searchFocus = null;
      paintSearch();
    }, 150);
  });
  document.addEventListener("mousedown", (e) => {
    if (e.target.closest?.(".perm-opt[data-perm-open]")) e.preventDefault();
  });
  document.addEventListener("submit", (e) => {
    const form = e.target.closest?.("form[data-add]");
    if (!form || !form.closest("[data-perm]")) return;
    e.preventDefault();
    const { change, error } = changeFromForm(form);
    const err = form.querySelector(".perm-add-err");
    if (error) { if (err) err.textContent = error; return; }
    setDraft(change);
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest?.("[data-perm]")) return;
    if (trayClick(e)) return;
    if (bulkEvent(e)) return;
    const bulk = e.target.closest("[data-perm-bulk]");
    if (bulk) {
      const [kind, ...key] = bulk.dataset.permBulk.split(":");
      closePanel();
      if (open) return;
      return setBulkSubject(kind, key.join(":"));
    }
    const un = e.target.closest("[data-unstage]");
    if (un) return unstage(un.dataset.unstage);
    const undraft = e.target.closest("[data-undraft]");
    if (undraft) return dropDraft(undraft.dataset.undraft);
    const act = e.target.closest("[data-drafts]")?.dataset.drafts;
    if (act === "save") return saveDrafts();
    if (act === "discard") { drafts.clear(); closeBlocked = false; return paintPanel(); }
    const st = e.target.closest("[data-stage]");
    if (st) return setDraft(JSON.parse(st.dataset.stage));
    if (e.target.closest("[data-new-team]")) return openNewTeam();
  });
  document.addEventListener("click", (e) => {
    const opt = e.target.closest?.("[data-perm-open]");
    if (opt && opt.closest("[data-perm]")) {
      if (opt.classList.contains("perm-opt")) {
        document.querySelector("[data-perm-search]")?.blur();
      }
      return pick(opt);
    }
    if (e.target.closest?.("[data-perm-close]") || e.target.matches?.("[data-perm-backdrop]")) return closePanel();
    if (e.target.closest?.("[data-perm-back]")) {
      const back = trail.pop();
      if (back) openPanel(back.kind, back.key, { push: false });
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.target.matches?.("[data-perm-search]")) {
      const n = document.querySelectorAll("[data-perm-results] .perm-opt").length;
      if (e.key === "ArrowDown" && n) { e.preventDefault(); active = (active + 1) % n; paintSearch(); }
      else if (e.key === "ArrowUp" && n) { e.preventDefault(); active = (active - 1 + n) % n; paintSearch(); }
      else if (e.key === "Enter") {
        const opt = document.querySelector('[data-perm-results] .perm-opt[aria-selected="true"]');
        if (opt) { e.preventDefault(); e.target.blur(); pick(opt); }
      } else if (e.key === "Escape") {
        if (query) { query = ""; e.target.value = ""; paintSearch(); } else e.target.blur();
      }
      return;
    }
    if (e.key === "Escape" && open && document.querySelector("[data-perm]") && !document.querySelector("dialog[open]")) closePanel();
  });
  document.addEventListener("visibilitychange", () => {
    if (timer && document.visibilityState === "visible" && Date.now() - fetchedAt > REFRESH_MS) load();
  });
}

export function syncPermissions(on) {
  syncApply(on);
  if (!on) document.documentElement.classList.remove("perm-modal-open");
  if (!on) {
    clearInterval(timer);
    timer = null;
    return;
  }
  wire();
  if (searchFocus !== null) {
    const input = document.querySelector("[data-perm-search]");
    if (input) {
      input.focus();
      input.setSelectionRange(searchFocus, searchFocus);
    }
  }
  paintSearch();
  if (!data || Date.now() - fetchedAt > REFRESH_MS) load();
  if (!timer) {
    timer = setInterval(() => {
      if (document.visibilityState !== "hidden") load();
    }, REFRESH_MS);
  }
}
