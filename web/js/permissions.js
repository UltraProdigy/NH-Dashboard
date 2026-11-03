import { API } from "./live.js";
import { avatar, esc } from "./format.js";
import { KEEP_PER_BOX } from "./log-boxes.js";
import {
  adminRows, directRows, indexSnapshot, LEVELS, problems, teamRows,
} from "./permissions-calc.js";

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
const teamOf = (id) => data.teams[id];
const repoOf = (id) => data.repos[id];

export const levelPill = (level) =>
  level ? `<span class="pill lv lv-${esc(level)}">${esc(level)}</span>` : `<span class="pill lv lv-unknown" title="Not known until the next 10-minute read">?</span>`;

export const personRef = (login) => `<span class="namelink">${avatar(login, 16)}<span>${esc(login)}</span></span>`;
export const teamRef = (id) => `<span class="perm-team">${esc(teamOf(id)?.name ?? `team ${id}`)}</span>`;
export const repoRef = (id) => {
  const repo = repoOf(id);
  return `<span class="repo">${esc(repo?.name ?? `repo ${id}`)}</span>${repo?.archived ? ` <span class="pill draft">archived</span>` : ""}`;
};

function repoList(ids, max = 3) {
  const names = ids.map((id) => repoOf(id)?.name ?? `repo ${id}`).sort((a, b) => a.localeCompare(b));
  const head = names.slice(0, max).map((n) => `<span class="repo">${esc(n)}</span>`).join(", ");
  return names.length > max ? `${head} <span class="sub">+${names.length - max} more</span>` : head;
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
      <span class="log-what">${e.repo ? `<span class="log-repo">${esc(e.repo)}</span>` : ""}${
        e.via ? `<span class="log-actor log-via" title="Found by the 10-minute check, not a webhook">${esc(e.via)}</span>`
          : e.actor ? `<span class="log-actor">${esc(e.actor)}</span>` : ""}${text}</span>
    </li>`;
  };
  const count = rows.length >= KEEP_PER_BOX ? `latest ${KEEP_PER_BOX}` : plural(rows.length, "change");
  return card("Recent changes", `${count} · from webhooks and the 10-minute check`,
    `<ol class="log-rows perm-changes">${rows.length ? rows.map(row).join("") : `<li class="log-empty">No access changes since the snapshot started.</li>`}</ol>`,
    { span: 12 });
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
  return `<div class="perm" data-perm>
    <div class="perm-bar">
      <label class="perm-toggle"><input type="checkbox" data-perm-archived${showArchived ? " checked" : ""}> Show archived repos</label>
      <span class="perm-status sub" data-perm-status>${statusHtml()}</span>
    </div>
    <div data-perm-body>${bodyHtml()}</div>
  </div>`;
}

function redraw() {
  const body = document.querySelector("[data-perm-body]");
  if (body) body.innerHTML = bodyHtml();
  const status = document.querySelector("[data-perm-status]");
  if (status) status.innerHTML = statusHtml();
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

function wire() {
  if (wired) return;
  wired = true;
  document.addEventListener("change", (e) => {
    if (!e.target.matches?.("[data-perm-archived]")) return;
    showArchived = e.target.checked;
    try { localStorage.setItem(ARCHIVED_KEY, showArchived ? "1" : "0"); } catch {}
    redraw();
  });
  document.addEventListener("visibilitychange", () => {
    if (timer && document.visibilityState === "visible" && Date.now() - fetchedAt > REFRESH_MS) load();
  });
}

export function syncPermissions(active) {
  if (!active) {
    clearInterval(timer);
    timer = null;
    return;
  }
  wire();
  if (!data || Date.now() - fetchedAt > REFRESH_MS) load();
  if (!timer) {
    timer = setInterval(() => {
      if (document.visibilityState !== "hidden") load();
    }, REFRESH_MS);
  }
}
