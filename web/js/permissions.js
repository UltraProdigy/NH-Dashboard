import { API } from "./live.js";
import { avatar, contribHref, esc, repoHref } from "./format.js";
import { KEEP_PER_BOX } from "./log-boxes.js";
import {
  adminRows, directRows, indexSnapshot, LEVELS, personAccess, problems, rank, repoAccess, repoTeams, teamAncestors, teamRows,
} from "./permissions-calc.js";
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

try { showArchived = localStorage.getItem(ARCHIVED_KEY) === "1"; } catch {}

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

function card(title, sub, body, { span = 6, cls = "" } = {}) {
  return `<section class="card perm-card ${cls}" style="--span:${span}">
    <header><h2>${esc(title)}</h2>${sub ? `<span class="sub">${sub}</span>` : ""}</header>
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
  const ownerNote = data.viewer?.ownerEdits
    ? ""
    : `<p class="hint perm-note">Owners and the base permission can only be changed by org owners, and those edits stay off until the dashboard can tell who's an owner.</p>`;
  const fact = (label, value, extra = "") => `<div class="perm-fact"><span class="sub">${esc(label)}</span><strong>${value}</strong>${extra}</div>`;
  return `<section class="card perm-card perm-org" style="--span:12">
    <header><h2>Org level</h2><span class="sub">${esc(data.org.login ?? "")}</span>
      <a class="perm-ext" href="${github(`orgs/${encodeURIComponent(data.org.login ?? "")}/people`)}" target="_blank" rel="noopener">People on GitHub</a></header>
    <div class="body">
      <div class="perm-facts">
        <div class="perm-fact perm-owners"><span class="sub">Owners</span><div class="perm-people">${owners.map(personRef).join("") || "—"}</div></div>
        ${fact("Base permission", esc(base), `<span class="sub">${base === "none" ? "members get no repo access just for being members" : "every member has this on every repo"}</span>`)}
        ${fact("Members", members.length.toLocaleString())}
        ${fact("Outside collaborators", outside.toLocaleString())}
        ${fact("Teams", Object.keys(data.teams).length.toLocaleString())}
        ${fact("Repos", repos.length.toLocaleString(), archived ? `<span class="sub">${archived} archived${showArchived ? "" : ", hidden below"}</span>` : "")}
      </div>
      ${ownerNote}
    </div>
  </section>`;
}

function fromText(row) {
  if (row.kind === "team") {
    const own = row.repos.length - row.from.inherited;
    const grant = !row.from.inherited ? "own grant" : !own ? "inherited from parent" : `${own} own, ${row.from.inherited} inherited`;
    return `${grant} · ${plural(row.members, "member")}`;
  }
  return Object.entries(row.from)
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => {
      const label = key === "direct" ? "direct" : key === "base" ? "base permission" : `via ${esc(teamOf(key.slice(5))?.name ?? key)}`;
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
      <td style="padding-left:${12 + row.depth * 16}px">${row.depth ? `<span class="sub">↳ </span>` : ""}${teamRef(row.team)}${t.privacy === "secret" ? ` <span class="pill draft">secret</span>` : ""}</td>
      <td class="num">${row.members}${row.maintainers ? ` <span class="sub">· ${row.maintainers} maint.</span>` : ""}</td>
      ${levels}
    </tr>`;
  });
  return card("Teams overview", `${plural(rows.length, "team")} · child teams count what they inherit`,
    table(["Team", "Members", ...LEVELS.slice().reverse().map((l) => l[0].toUpperCase() + l.slice(1))], html, "No teams."));
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
        e.via ? `<span class="log-actor log-via" title="Found by the 10-minute check, not a webhook">${esc(e.via)}</span>`
          : e.actor ? `<span class="log-actor">${esc(e.actor)}</span>` : ""}${text}</span>
    </li>`;
  };
  const count = rows.length >= KEEP_PER_BOX ? `latest ${KEEP_PER_BOX}` : plural(rows.length, "change");
  return card("Recent changes", `${count} · from webhooks and the 10-minute check`,
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

function openPanel(kind, key, { push = true } = {}) {
  if (push && open && !(open.kind === kind && open.key === String(key))) trail.push(open);
  open = { kind, key: String(key) };
  pending = null;
  syncAddress();
  paintPanel();
  document.querySelector("[data-perm-panel] h2")?.focus();
}

function closePanel() {
  open = null;
  pending = null;
  trail.length = 0;
  syncAddress();
  paintPanel();
}

const sourceText = (s) => {
  if (s.kind === "owner") return "org owner";
  if (s.kind === "base") return `base permission ${esc(s.level)}`;
  if (s.kind === "direct") return `direct ${levelPill(s.level)}`;
  const via = `via ${teamRef(s.team)} ${levelPill(s.level)}`;
  return s.from ? `${via} <span class="sub">inherited from</span> ${teamRef(s.from)}` : via;
};

const levelCounts = (rows) => LEVELS.slice().reverse()
  .map((l) => [l, rows.filter((r) => r.level === l).length])
  .filter(([, n]) => n)
  .map(([l, n]) => `${levelPill(l)} <span class="num">${n}</span>`)
  .join(" ");

const section = (title, sub, body) => `<section class="perm-sec"><h3>${esc(title)}${sub ? ` <span class="sub">${sub}</span>` : ""}</h3>${body}</section>`;
const ptable = (head, rows, empty) => rows.length
  ? `<table class="perm-ptable"><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`
  : `<p class="sub perm-none">${esc(empty)}</p>`;

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
  const head = `<div class="perm-phead">${avatar(login, 40)}<div><h2 tabindex="-1">${esc(login)}</h2><span class="sub">${roleText}</span></div></div>
    <div class="perm-plinks"><a href="${github(encodeURIComponent(login))}" target="_blank" rel="noopener">GitHub profile</a>
      <a href="${contribHref({ login })}" data-drilllink>Contributor Drilldown</a></div>`;
  const teamRows = teams.map(({ team, role: r }) => {
    const ups = teamAncestors(data.teams, team.id);
    return `<tr><td>${teamRef(team.id)}${ups.length ? ` <span class="sub">under</span> ${ups.map((u) => teamRef(u.id)).join(" › ")}` : ""}</td><td>${r ? esc(r) : `<span class="sub" title="Not known until the next 10-minute read">?</span>`}</td></tr>`;
  });
  const repoRows = access.map((a) => `<tr><td>${repoRef(a.repo)}</td><td>${levelPill(a.level)}</td><td class="perm-src">${a.sources.map(sourceText).join("<br>")}</td></tr>`);
  return head +
    (role === "owner" ? `<p class="hint perm-pnote">Owners are admin on every repo, and that can't be lowered from a repo.</p>` : "") +
    (invites.length ? section("Pending invites", "", `<ul class="perm-plist">${invites.join("")}</ul>`) : "") +
    section("Teams", teams.length ? String(teams.length) : "", ptable(["Team", "Role"], teamRows, role ? "Not on any team." : "Not on any team, and not an org member.")) +
    section("Repos", `${access.length} ${levelCounts(access)}`, ptable(["Repo", "Level", "From"], repoRows, "No access to any repo" + (showArchived ? "." : " that isn't archived.")));
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
  const head = `<div class="perm-phead"><div><h2 tabindex="-1">${esc(team.name)}</h2><span class="sub">Team · ${esc(team.slug)}${team.privacy ? ` · ${esc(team.privacy)}` : ""}</span></div></div>
    <div class="perm-plinks"><a href="${github(`orgs/${encodeURIComponent(data.org.login)}/teams/${encodeURIComponent(team.slug)}`)}" target="_blank" rel="noopener">Team on GitHub</a></div>`;
  const family = [
    ups.length ? `<li><span class="sub">Parent</span> ${ups.map((u) => teamRef(u.id)).join(" › ")}</li>` : "",
    kids.length ? `<li><span class="sub">Child teams</span> ${kids.map((k) => teamRef(k.id)).join(", ")}</li>` : "",
  ].filter(Boolean).join("");
  return head +
    (family ? `<ul class="perm-plist perm-family">${family}</ul>` : "") +
    section("Members", `${members.length}${members.some(([, r]) => r === "maintainer") ? ` · ${plural(members.filter(([, r]) => r === "maintainer").length, "maintainer")}` : ""}`,
      ptable(["Who", "Role"], members.map(([login, r]) => `<tr><td>${personRef(login)}</td><td>${r ? esc(r) : `<span class="sub" title="Not known until the next 10-minute read">?</span>`}</td></tr>`), "Nobody is on this team.")) +
    section("Repos", `${repos.length} ${levelCounts(repos)}${inherited ? ` · ${inherited} inherited` : ""}`,
      ptable(["Repo", "Level", "From"], repos.map((r) => `<tr><td>${repoRef(r.repo)}</td><td>${levelPill(r.level)}</td><td class="sub">${r.from ? `inherited from ${teamRef(r.from)}` : "own grant"}</td></tr>`),
        "This team has no repos" + (showArchived ? "." : " that aren't archived.")));
}

function repoPanel(id) {
  const repo = repoOf(id);
  const teams = repoTeams(data, idx, String(repo.id));
  const people = repoAccess(data, idx, String(repo.id));
  const invites = (data.repoInvites?.[repo.id]?.invites ?? []);
  const checked = data.repoInvites?.[repo.id]?.checkedAt;
  const head = `<div class="perm-phead"><div><h2 tabindex="-1">${esc(repo.name)}</h2><span class="sub">Repo · ${esc(repo.visibility)}${repo.archived ? " · archived" : ""}</span></div></div>
    <div class="perm-plinks"><a href="${github(`${encodeURIComponent(data.org.login)}/${encodeURIComponent(repo.name)}/settings/access`)}" target="_blank" rel="noopener">Access settings on GitHub</a>
      <a href="${repoHref(repo.name)}" data-drilllink>Repo Drilldown</a></div>`;
  return head +
    (repo.archived ? `<p class="hint perm-pnote">Archived: nobody can push to it, whatever their level.</p>` : "") +
    section("Teams", String(teams.length), ptable(["Team", "Level", "From"],
      teams.map((t) => `<tr><td>${teamRef(t.team)}</td><td>${levelPill(t.level)}</td><td class="sub">${t.from ? `inherited from ${teamRef(t.from)}` : "own grant"}</td></tr>`), "No team has access.")) +
    section("People", `${people.length} ${levelCounts(people)}`, ptable(["Who", "Level", "From"],
      people.map((p) => `<tr><td>${personRef(p.login)}${p.outside ? ` <span class="pill neutral">outside</span>` : ""}</td><td>${levelPill(p.level)}</td><td class="perm-src">${p.sources.map(sourceText).join("<br>")}</td></tr>`), "Nobody has access.")) +
    section("Pending invites", checked ? `checked ${esc(ago(checked))}` : "not checked yet",
      invites.length ? `<ul class="perm-plist">${invites.map((i) => `<li>${i.login ? personRef(i.login) : "someone"} ${levelPill(i.level)}${i.by ? ` <span class="sub">by ${esc(i.by)}</span>` : ""} <span class="sub">${esc(ago(i.at))}${i.expired ? ", expired" : ""}</span></li>`).join("")}</ul>`
        : `<p class="sub perm-none">${checked ? "None." : "Repo invites are read a few repos a tick, each about once a day."}</p>`);
}

function panelHtml() {
  if (!open || !data?.org) return "";
  const { kind, key } = open;
  const exists = kind === "person" ? idx.people.includes(key) : kind === "team" ? teamOf(key) : repoOf(key);
  const body = !exists
    ? `<p class="sub">This ${kind} isn't in the snapshot any more.</p>`
    : kind === "person" ? personPanel(key) : kind === "team" ? teamPanel(key) : repoPanel(key);
  return `<aside class="perm-panel" role="dialog" aria-label="${esc(KIND_LABEL[kind])} details">
    <div class="perm-pbar">
      ${trail.length ? `<button type="button" class="ghost" data-perm-back>← Back</button>` : "<span></span>"}
      <span class="sub">Read-only for now</span>
      <button type="button" class="icon-btn" data-perm-close aria-label="Close">✕</button>
    </div>
    <div class="perm-pbody">${body}</div>
  </aside>`;
}

function paintPanel() {
  const el = document.querySelector("[data-perm-panel]");
  if (el) el.innerHTML = panelHtml();
  document.querySelector("[data-perm]")?.classList.toggle("has-panel", Boolean(open));
}

function bodyHtml() {
  if (failed && !data) return `<div class="error">${esc(failed)}</div>`;
  if (!data) return `<div class="empty">Loading the permissions snapshot…</div>`;
  if (!data.org) {
    return `<section class="card stub" style="--span:12"><div class="body">
      <h2>No snapshot yet</h2><p>The first read runs on the 10-minute tick after the webhook Worker deploys.</p></div></section>`;
  }
  return `<div class="grid perm-grid">${orgCard()}${adminsCard()}${directCard()}${teamsCard()}${problemsCard()}${changesCard()}</div>`;
}

function statusHtml() {
  if (!data?.readAt) return "";
  return `Read ${esc(ago(data.readAt))} by the 10-minute check${failed ? ` · <span class="lb-warn">${esc(failed)}</span>` : ""}`;
}

export function permissionsBody() {
  return `<div class="perm${open ? " has-panel" : ""}" data-perm>
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
  </div>`;
}

function redraw() {
  const body = document.querySelector("[data-perm-body]");
  if (body) keepScroll(body, () => { body.innerHTML = bodyHtml(); });
  const status = document.querySelector("[data-perm-status]");
  if (status) status.innerHTML = statusHtml();
  paintPanel();
  paintSearch();
}

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
    if (!e.target.matches?.("[data-perm-archived]")) return;
    showArchived = e.target.checked;
    try { localStorage.setItem(ARCHIVED_KEY, showArchived ? "1" : "0"); } catch {}
    redraw();
  });
  document.addEventListener("input", (e) => {
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
  document.addEventListener("click", (e) => {
    const opt = e.target.closest?.("[data-perm-open]");
    if (opt && opt.closest("[data-perm]")) {
      if (opt.classList.contains("perm-opt")) {
        document.querySelector("[data-perm-search]")?.blur();
      }
      return pick(opt);
    }
    if (e.target.closest?.("[data-perm-close]")) return closePanel();
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
    if (e.key === "Escape" && open && document.querySelector("[data-perm]")) closePanel();
  });
  document.addEventListener("visibilitychange", () => {
    if (timer && document.visibilityState === "visible" && Date.now() - fetchedAt > REFRESH_MS) load();
  });
}

export function syncPermissions(on) {
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
