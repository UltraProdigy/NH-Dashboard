import { API, onTeamExclusionsStamp } from "./live.js";
import { agoText, daysSince, esc, personName, safeUrl } from "./format.js";
import { keyOf, NOTIFY_LABEL, PRIVACY_LABEL } from "./permission-changes.js";
import { stagedFor, stageMany } from "./permission-apply.js";
import { configureTeamsPage, permArchived, permData, personRef, redrawPermissions, teamRef } from "./permissions.js";
import { teamRows } from "./permissions-calc.js";

const REFRESH_MS = 60_000;
const HISTORY_STEP = 50;
const KINDS = { added: "Added", removed: "Removed", role: "Role changed", invited: "Invited", team: "Team changes" };
const DID = {
  pr: "opened a pull request", review: "reviewed a pull request", filed: "filed an issue",
  replied: "replied to an issue", closed: "closed an issue", pushed: "pushed a commit",
};

let tm = null;
let failed = null;
let fetchedAt = 0;
let inFlight = null;
let timer = null;
let wired = false;
let showing = false;

const ui = {
  history: { team: "", kind: "", shown: HISTORY_STEP },
  ticks: { inactive: new Map(), hiatus: new Map() },
  excluding: null,
  openExcluded: { inactive: false, hiatus: false },
  notice: { inactive: "", hiatus: "" },
  xref: { teams: [], mode: "all" },
  requests: "",
};

const low = (s) => String(s ?? "").toLowerCase();
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const data = () => permData();
const teams = () => Object.values(data()?.teams ?? {});
const teamOf = (id) => data()?.teams?.[id] ?? null;
const teamBySlug = (slug) => teams().find((t) => t.slug === slug) ?? null;
const refOf = (t) => ({ id: t.id, slug: t.slug, name: t.name });
const keyIn = (obj, login) => Object.keys(obj ?? {}).find((k) => low(k) === low(login)) ?? null;
const github = (path) => `https://github.com/${path}`;
const org = () => data()?.org?.login ?? "GTNewHorizons";

function when(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) })} ${time}`;
}

const dateText = (iso) => (iso ? new Date(iso).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" }) : "");

function family(id) {
  const out = new Set([String(id)]);
  for (let grew = true; grew;) {
    grew = false;
    for (const t of teams()) {
      if (t.parent != null && out.has(String(t.parent)) && !out.has(String(t.id))) { out.add(String(t.id)); grew = true; }
    }
  }
  return out;
}

/* ---- activity ---- */

function lastAct(login) {
  const store = tm?.activity?.[login] ?? tm?.activity?.[keyIn(tm?.activity, login)] ?? null;
  const seen = tm?.seen?.[low(login)] ?? null;
  const fromSeen = Boolean(seen?.at && (!store?.at || seen.at > store.at));
  return { at: fromSeen ? seen.at : store?.at ?? null, store, seen, fromSeen };
}

function storeUrl(a) {
  if (!a?.repo || a.ref == null) return null;
  const base = `${org()}/${encodeURIComponent(a.repo)}`;
  if (a.kind === "pr" || a.kind === "review") return github(`${base}/pull/${a.ref}`);
  if (a.kind === "pushed") return github(`${base}/commit/${encodeURIComponent(a.ref)}`);
  return github(`${base}/issues/${a.ref}`);
}

function lastCell(login) {
  const a = lastAct(login);
  if (!a.at) return `<span class="sub" title="Nothing in the store or in webhook deliveries">nothing recorded</span>`;
  const what = a.fromSeen
    ? `${a.seen.text ?? a.seen.event ?? "a delivery"}${a.seen.repo ? ` in ${a.seen.repo}` : ""} (seen in a webhook delivery)`
    : `${DID[a.store.kind] ?? a.store.kind}${a.store.excluded ? " in an excluded repo" : a.store.repo ? ` in ${a.store.repo}` : ""}`;
  const url = a.fromSeen ? (a.seen.url?.startsWith("https://github.com/") ? a.seen.url : null) : storeUrl(a.store);
  const text = `<span class="num">${esc(agoText(daysSince(a.at)))}</span>`;
  const tip = esc(`${what} · ${dateText(a.at)}`);
  return url ? `<a href="${safeUrl(url)}" target="_blank" rel="noopener" title="${tip}">${text}</a>` : `<span title="${tip}">${text}</span>`;
}

function sinceText(teamId, login) {
  const at = tm?.since?.[teamId]?.[low(login)];
  if (at) return `<span title="${esc(dateText(at))}">${esc(agoText(daysSince(at)))}</span>`;
  const from = tm?.historySince ? new Date(tm.historySince).toLocaleDateString([], { month: "short", year: "numeric" }) : "tracking began";
  return `<span class="sub" title="GitHub doesn't record when someone joined a team, so only additions since tracking began have a date">before ${esc(from)}</span>`;
}

/* ---- review requests ---- */

function requestsFor(team) {
  const prs = tm?.requests?.prs ?? [];
  const members = new Set(Object.keys(team.members ?? {}).map(low));
  const direct = prs.filter((p) => p.teams.some((id) => String(id) === String(team.id)));
  const directSet = new Set(direct);
  const viaMember = prs
    .filter((p) => !directSet.has(p) && p.people.some((l) => members.has(low(l))))
    .map((p) => ({ ...p, asked: p.people.filter((l) => members.has(low(l))) }));
  return { direct, viaMember };
}

const prUrl = (p) => github(`${org()}/${encodeURIComponent(p.repo)}/pull/${p.number}`);

function prRow(p, asked) {
  return `<tr>
    <td><a href="${safeUrl(prUrl(p))}" target="_blank" rel="noopener">${esc(p.title ?? `#${p.number}`)}</a>${p.draft ? ` <span class="pill draft">draft</span>` : ""}
      <div class="sub">${esc(p.repo)} #${esc(p.number)}</div></td>
    <td>${p.author ? esc(p.author) : `<span class="sub">ghost</span>`}</td>
    <td>${asked}</td>
    <td class="num" title="${esc(dateText(p.created))}">${esc(agoText(daysSince(p.created)))}</td>
    <td class="num" title="${esc(dateText(p.updated))}">${esc(agoText(daysSince(p.updated)))}</td>
  </tr>`;
}

const prHead = ["Pull request", "Author", "Asked", "Opened", "Last update"];

/* ---- shared markup ---- */

function card(title, sub, body, { span = 12, cls = "", extra = "" } = {}) {
  return `<section class="card perm-card tm-card ${cls}" style="--span:${span}">
    <header><h2>${esc(title)}</h2>${sub ? `<span class="sub">${sub}</span>` : ""}${extra}</header>
    <div class="body flush">${body}</div>
  </section>`;
}

const table = (head, rows, empty, cls = "") =>
  rows.length
    ? `<div class="tscroll perm-scroll ${cls}"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`
    : `<div class="empty">${esc(empty)}</div>`;

const options = (list, selected) => list.map(([v, text]) => `<option value="${esc(v)}"${String(v) === String(selected) ? " selected" : ""}>${esc(text)}</option>`).join("");
const teamChip = (t, on = false) => `<span class="tm-chip${on ? " on" : ""}">${esc(t.name)}</span>`;

/* ---- recent changes ---- */

function actorHtml(e) {
  if (e.via === "dashboard") return `<span class="log-actor">${esc(personName(e.actor))}</span><span class="log-actor log-via" title="Made from the dashboard, by Org-Manager">via dashboard</span>`;
  if (e.via) return `<span class="log-actor log-via" title="Found by the 10-minute check, not a webhook">${esc(e.via)}</span>`;
  return e.actor ? `<span class="log-actor">${esc(personName(e.actor))}</span>` : "";
}

function historyCard() {
  const all = tm?.history ?? [];
  const f = ui.history;
  const rows = all.filter((e) => (!f.team || String(e.teamId) === f.team) && (!f.kind || e.kind === f.kind));
  const shown = rows.slice(0, f.shown);
  const row = (e) => {
    const safe = typeof e.url === "string" && e.url.startsWith("https://github.com/");
    const text = safe ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.text)}</a>` : esc(e.text);
    const team = teamOf(e.teamId) ? `<span class="log-repo">${teamRef(e.teamId)}</span>` : e.team ? `<span class="log-repo">${esc(e.team)}</span>` : "";
    return `<li class="log-row${e.tone ? ` tone-${esc(e.tone)}` : ""}">
      <time datetime="${esc(e.at)}" title="${esc(new Date(e.at).toLocaleString())}">${esc(when(e.at))}</time>
      <span class="log-what">${team}${actorHtml(e)}${text}</span>
    </li>`;
  };
  const teamOpts = [["", "Every team"], ...teams().sort((a, b) => a.name.localeCompare(b.name)).map((t) => [t.id, t.name])];
  const kindOpts = [["", "Every change"], ...Object.entries(KINDS)];
  const filters = `<span class="tm-filters">
    <select class="perm-sel" data-tm-history="team" aria-label="Team">${options(teamOpts, f.team)}</select>
    <select class="perm-sel" data-tm-history="kind" aria-label="Kind of change">${options(kindOpts, f.kind)}</select></span>`;
  const since = tm?.historySince ? `since ${esc(dateText(tm.historySince))}` : "";
  const list = !tm ? `<li class="log-empty">${failed ? esc(failed) : "Loading the team history…"}</li>`
    : shown.length ? shown.map(row).join("") : `<li class="log-empty">No team changes${f.team || f.kind ? " match" : " yet"}.</li>`;
  const more = rows.length > shown.length ? `<button type="button" class="ghost mini tm-more" data-tm-more>Show ${Math.min(HISTORY_STEP, rows.length - shown.length)} more</button>` : "";
  return card("Recent team changes", `${plural(rows.length, "change")} ${since} · from webhooks, the 10-minute check and the dashboard`,
    `<ol class="log-rows perm-changes tm-history">${list}</ol>${more}`, { extra: filters });
}

/* ---- Developers ⇄ Hiatus ---- */

function teamsSetUp() {
  const cfg = tm?.config;
  if (!cfg || !data()?.teams) return null;
  const dev = teamBySlug(cfg.developers);
  const hi = teamBySlug(cfg.hiatus);
  return { cfg, dev, hi, fam: dev ? [...family(dev.id)].map(teamOf).filter(Boolean) : [] };
}

const excludedFrom = (panel, login) => keyIn(tm?.exclusions?.[panel], login);

function developerRows(s) {
  const people = new Map();
  for (const t of s.fam) {
    for (const login of Object.keys(t.members ?? {})) {
      const k = low(login);
      if (!people.has(k)) people.set(k, { login, teams: [] });
      people.get(k).teams.push(t);
    }
  }
  return [...people.values()].map((p) => {
    const a = lastAct(p.login);
    const days = a.at ? daysSince(a.at) : null;
    const staged = Boolean(stagedFor(keyOf({ kind: "team_member", team: { id: s.hi?.id }, login: p.login }))) ||
      p.teams.some((t) => stagedFor(keyOf({ kind: "team_member", team: { id: t.id }, login: p.login })));
    return { ...p, at: a.at, days, staged, onHiatus: Boolean(s.hi && keyIn(s.hi.members, p.login)) };
  });
}

function hiatusRows(s) {
  return Object.keys(s.hi?.members ?? {}).map((login) => {
    const a = lastAct(login);
    const days = a.at ? daysSince(a.at) : null;
    const staged = Boolean(stagedFor(keyOf({ kind: "team_member", team: { id: s.hi.id }, login })));
    return { login, at: a.at, days, staged, back: days != null && days < s.cfg.returnDays, onDevelopers: Boolean(s.dev && keyIn(s.dev.members, login)) };
  });
}

function ticked(panel, row, fallback) {
  const v = ui.ticks[panel].get(low(row.login));
  return v ?? fallback;
}

function excludeForm(panel, login = "") {
  return `<form class="tm-exclude-form" data-tm-exclude-form="${esc(panel)}" data-login="${esc(login)}">
    ${login ? "" : `<input name="login" class="perm-input" list="perm-people" placeholder="GitHub login" aria-label="GitHub login" autocomplete="off" spellcheck="false" required>`}
    <input name="note" class="perm-input" maxlength="200" placeholder="Why (optional)" aria-label="Why they're excluded">
    <button type="submit" class="ghost mini">Exclude</button>
    ${login ? `<button type="button" class="ghost mini" data-tm-exclude-cancel>Cancel</button>` : ""}
    <span class="perm-add-err sub" aria-live="polite"></span>
  </form>`;
}

function excludedBlock(panel) {
  const list = Object.entries(tm?.exclusions?.[panel] ?? {}).sort((a, b) => a[0].localeCompare(b[0]));
  const items = list.map(([login, e]) => `<li>${personRef(login)}${e.note ? ` <span class="tm-note">${esc(e.note)}</span>` : ""}
    <span class="sub">${e.by ? `by ${esc(personName(e.by))}` : ""}${e.at ? ` · ${esc(agoText(daysSince(e.at)))}` : ""}</span>
    <button type="button" class="ghost mini" data-tm-include="${esc(panel)}:${esc(login)}">Include again</button></li>`).join("");
  return `<details class="tm-excluded" data-tm-excluded="${esc(panel)}"${ui.openExcluded[panel] ? " open" : ""}>
    <summary>Excluded <span class="sub">${list.length}</span> <span class="sub">· everyone sees the same list</span></summary>
    ${items ? `<ul>${items}</ul>` : `<p class="sub">Nobody is excluded.</p>`}
    ${excludeForm(panel)}
  </details>`;
}

function moverCard(panel, s) {
  const isInactive = panel === "inactive";
  const title = isInactive ? "Inactive developers" : "Developers on Hiatus";
  if (!s) return card(title, "", `<div class="empty">${failed ? esc(failed) : "Loading…"}</div>`, { span: 6, cls: "tm-mover" });
  const missing = isInactive ? (!s.dev ? s.cfg.developers : !s.hi ? s.cfg.hiatus : null) : !s.hi ? s.cfg.hiatus : !s.dev ? s.cfg.developers : null;
  if (missing) {
    return card(title, "", `<div class="empty">There's no team with the slug “${esc(missing)}”. Set ${isInactive && missing === s.cfg.developers ? "DEVELOPERS_TEAM" : "HIATUS_TEAM"} in wrangler.app.toml to the right slug.</div>`, { span: 6, cls: "tm-mover" });
  }
  const { inactiveDays, returnDays } = s.cfg;
  const all = isInactive
    ? developerRows(s).filter((r) => r.days == null || r.days >= inactiveDays).sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""))
    : hiatusRows(s).sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "") || a.login.localeCompare(b.login));
  const excluded = all.filter((r) => excludedFrom(panel, r.login));
  const rows = all.filter((r) => !excludedFrom(panel, r.login));
  const def = (r) => !r.staged && (isInactive || r.back);
  const picked = rows.filter((r) => !r.staged && ticked(panel, r, def(r)));
  const sinceTeam = isInactive ? s.dev : s.hi;
  const html = rows.map((r) => {
    const box = r.staged
      ? `<span class="pill neutral" title="Already waiting in the tray">staged</span>`
      : `<input type="checkbox" data-tm-tick="${esc(panel)}:${esc(r.login)}"${ticked(panel, r, def(r)) ? " checked" : ""} aria-label="Move ${esc(r.login)}">`;
    const editing = ui.excluding?.panel === panel && low(ui.excluding.login) === low(r.login);
    const flags = [
      !isInactive && r.back ? `<span class="pill tm-back" title="Active in the last ${returnDays} days">back</span>` : "",
      isInactive && r.onHiatus ? `<span class="pill neutral" title="Also on ${esc(s.hi.name)}">on hiatus too</span>` : "",
      !isInactive && r.onDevelopers ? `<span class="pill neutral" title="Also on ${esc(s.dev.name)}">on Developers too</span>` : "",
    ].join(" ");
    const teamsCell = isInactive ? `<td>${r.teams.map((t) => teamChip(t)).join(" ")}</td>` : "";
    return `<tr>
      <td class="tm-tick">${box}</td>
      <td>${personRef(r.login)} ${flags}</td>
      <td>${lastCell(r.login)}</td>
      <td>${sinceText(sinceTeam.id, r.login)}</td>
      ${teamsCell}
      <td class="tm-row-act">${editing ? excludeForm(panel, r.login) : `<button type="button" class="ghost mini" data-tm-exclude="${esc(panel)}:${esc(r.login)}">Exclude</button>`}</td>
    </tr>`;
  });
  const head = ["", "Who", "Last active", isInactive ? `On ${esc(s.dev.name)}` : "On hiatus", ...(isInactive ? ["Teams they'd leave"] : []), ""];
  const sub = isInactive
    ? `${plural(rows.length, "person", "people")} on ${esc(s.dev.name)} or a team under it with nothing in ${inactiveDays} days`
    : `${plural(rows.length, "person", "people")}, most recently active first · back means active in the last ${returnDays} days`;
  const toolbar = `<div class="tm-toolbar">
    <button type="button" class="ghost mini" data-tm-all="${panel}:on">Tick all</button>
    <button type="button" class="ghost mini" data-tm-all="${panel}:off">Untick all</button>
    <span class="tm-notice sub" aria-live="polite">${esc(ui.notice[panel])}</span>
    <button type="button" class="daily-go" data-tm-move="${panel}"${picked.length ? "" : " disabled"}>${isInactive ? `Move ${picked.length} to ${esc(s.hi.name)}` : `Move ${picked.length} to ${esc(s.dev.name)}`}</button>
  </div>`;
  const note = isInactive
    ? `<p class="hint tm-hint">Moving someone adds them to ${esc(s.hi.name)} and takes them off ${esc(s.dev.name)} and every team under it. It waits in the tray until you apply it.</p>`
    : `<p class="hint tm-hint">Moving someone back adds them to ${esc(s.dev.name)} and takes them off ${esc(s.hi.name)}. Sub-teams they left aren't restored.</p>`;
  const hidden = excluded.length ? ` · ${excluded.length} excluded` : "";
  return card(title, `${sub}${hidden}`, `${toolbar}${table(head, html, isInactive ? "Nobody here has been inactive that long." : "Nobody is on hiatus.", "tm-mover-scroll")}${note}${excludedBlock(panel)}`,
    { span: 6, cls: "tm-mover" });
}

function moveChanges(panel, s) {
  const isInactive = panel === "inactive";
  const all = isInactive ? developerRows(s) : hiatusRows(s);
  const rows = all.filter((r) => !r.staged && !excludedFrom(panel, r.login) && ticked(panel, r, isInactive || r.back) &&
    (!isInactive || r.days == null || r.days >= s.cfg.inactiveDays));
  const adds = [];
  const removes = [];
  for (const r of rows) {
    const to = isInactive ? s.hi : s.dev;
    if (!keyIn(to.members, r.login)) adds.push({ kind: "team_member", team: refOf(to), login: r.login, from: null, to: "member" });
    const leaving = isInactive ? r.teams : [s.hi];
    for (const t of leaving) {
      const k = keyIn(t.members, r.login);
      if (k) removes.push({ kind: "team_member", team: refOf(t), login: k, from: t.members[k] ?? "unknown", to: null });
    }
  }
  return { people: rows.length, changes: [...adds, ...removes] };
}

/* ---- teams ---- */

function teamsCard() {
  const rows = teamRows(data(), { archived: permArchived() });
  const html = rows.map((row) => {
    const t = teamOf(row.team);
    const req = requestsFor(t);
    const newest = Object.keys(t.members ?? {})
      .map((login) => ({ login, at: tm?.since?.[t.id]?.[low(login)] ?? null }))
      .filter((m) => m.at).sort((a, b) => b.at.localeCompare(a.at))[0];
    const pills = [
      t.privacy === "secret" ? `<span class="pill draft">${esc(PRIVACY_LABEL.secret)}</span>` : "",
      t.notifications === "disabled" ? `<span class="pill neutral" title="Team notifications ${esc(NOTIFY_LABEL.disabled)}">quiet</span>` : "",
    ].join(" ");
    return `<tr>
      <td style="padding-left:${12 + row.depth * 18}px">${row.depth ? `<span class="sub">↳ </span>` : ""}${teamRef(row.team)} ${pills}
        ${t.description ? `<div class="sub tm-desc">${esc(t.description)}</div>` : ""}</td>
      <td class="num">${row.members}${row.maintainers ? ` <span class="sub">· ${row.maintainers} maint.</span>` : ""}</td>
      <td class="num">${row.repos}</td>
      <td class="num">${tm ? `${req.direct.length}${req.viaMember.length ? ` <span class="sub" title="Asked of a member directly">+${req.viaMember.length}</span>` : ""}` : "…"}</td>
      <td>${newest ? `${personRef(newest.login)} <span class="sub">${esc(agoText(daysSince(newest.at)))}</span>` : `<span class="sub">—</span>`}</td>
    </tr>`;
  });
  return card("Teams", `${plural(rows.length, "team")} · child teams sit under their parent and count the repos they inherit · open one to edit it`,
    table(["Team", "Members", "Repos", "Review requests", "Newest member"], html, "No teams."),
    { extra: `<button type="button" class="ghost mini perm-ext" data-new-team>New team</button>` });
}

/* ---- review requests ---- */

function requestsCard() {
  const r = tm?.requests;
  if (!r) return card("Review requests", "", `<div class="empty">${failed ? esc(failed) : "Loading…"}</div>`);
  const counts = teams().map((t) => ({ t, ...requestsFor(t) }));
  const opts = [["", "Every team"], ...counts.sort((a, b) => b.direct.length - a.direct.length || a.t.name.localeCompare(b.t.name))
    .map((c) => [c.t.id, `${c.t.name} (${c.direct.length}${c.viaMember.length ? ` + ${c.viaMember.length}` : ""})`])];
  const picked = ui.requests && teamOf(ui.requests);
  let body;
  if (picked) {
    const { direct, viaMember } = requestsFor(picked);
    body = `<h3 class="tm-sub">Asked of ${esc(picked.name)} <span class="sub">${direct.length}</span></h3>` +
      table(prHead, direct.map((p) => prRow(p, teamChip(picked, true))), `No open pull request is waiting on ${picked.name}.`) +
      `<h3 class="tm-sub">Asked of a member directly <span class="sub">${viaMember.length}</span></h3>` +
      table(prHead, viaMember.map((p) => prRow(p, p.asked.map(esc).join(", "))), "None.");
  } else {
    const prs = r.prs.filter((p) => p.teams.length).sort((a, b) => a.updated.localeCompare(b.updated));
    body = table(prHead, prs.map((p) => prRow(p, p.teams.map((id) => (teamOf(id) ? teamChip(teamOf(id), true) : `<span class="tm-chip">team ${esc(id)}</span>`)).join(" "))),
      r.teams ? "No open pull request is waiting on a team." : "Team review requests show up once migration 013 has run.");
  }
  const note = r.teams ? "" : `<p class="hint tm-hint">Only people asked directly are shown until migration 013 has run and the team requests are backfilled.</p>`;
  return card("Review requests", "open pull requests, the longest waiting first · teams with auto-assignment hand requests to members, which is what the + counts",
    `${note}${body}`, { extra: `<select class="perm-sel" data-tm-requests aria-label="Team">${options(opts, ui.requests)}</select>` });
}

/* ---- cross reference ---- */

function xrefCard() {
  const all = teams().sort((a, b) => a.name.localeCompare(b.name));
  const picked = ui.xref.teams.map(teamOf).filter(Boolean);
  const chips = all.map((t) => `<label class="tm-pick"><input type="checkbox" data-tm-xref="${esc(t.id)}"${picked.includes(t) ? " checked" : ""}> ${esc(t.name)} <span class="sub">${Object.keys(t.members ?? {}).length}</span></label>`).join("");
  const modes = [["all", "In all of them"], ["any", "In any of them"], ["only", `Only in ${picked[0] ? esc(picked[0].name) : "the first"}`]];
  const seg = `<div class="seg mini" role="group" aria-label="Which members">${modes.map(([m, label]) =>
    `<button type="button" data-tm-xmode="${m}" class="${ui.xref.mode === m ? "on" : ""}" aria-pressed="${ui.xref.mode === m}">${label}</button>`).join("")}</div>`;
  const sets = new Map(all.map((t) => [t.id, new Set(Object.keys(t.members ?? {}).map(low))]));
  let body = "";
  if (picked.length < 2) {
    body = `<p class="sub tm-pad">Tick two or more teams to compare their members.</p>`;
  } else {
    const matrix = `<div class="tscroll"><table class="tm-matrix"><thead><tr><th></th>${picked.map((t) => `<th>${esc(t.name)}</th>`).join("")}</tr></thead><tbody>${
      picked.map((a) => `<tr><th>${esc(a.name)}</th>${picked.map((b) => {
        const n = [...sets.get(a.id)].filter((l) => sets.get(b.id).has(l)).length;
        return `<td class="num${a === b ? " sub" : ""}">${n}</td>`;
      }).join("")}</tr>`).join("")}</tbody></table></div>`;
    const names = new Map();
    for (const t of picked) for (const l of Object.keys(t.members ?? {})) names.set(low(l), l);
    const inAll = (k) => picked.every((t) => sets.get(t.id).has(k));
    const only = (k) => sets.get(picked[0].id).has(k) && picked.slice(1).every((t) => !sets.get(t.id).has(k));
    const keep = ui.xref.mode === "all" ? inAll : ui.xref.mode === "only" ? only : () => true;
    const people = [...names.entries()].filter(([k]) => keep(k)).map(([, l]) => l).sort((a, b) => a.localeCompare(b));
    const rows = people.map((l) => `<tr><td>${personRef(l)}</td><td>${all.filter((t) => sets.get(t.id).has(low(l))).map((t) => teamChip(t, picked.includes(t))).join(" ")}</td><td>${lastCell(l)}</td></tr>`);
    body = `${matrix}<h3 class="tm-sub">${plural(people.length, "person", "people")}</h3>${table(["Who", "Teams", "Last active"], rows, "Nobody matches.")}`;
  }
  return card("Cross reference", "shared members between teams; the grid counts who two teams have in common",
    `<div class="tm-picks">${chips}</div><div class="tm-toolbar">${seg}</div>${body}`);
}

/* ---- the page ---- */

function body() {
  if (!data()?.org) return "";
  const s = tm ? teamsSetUp() : null;
  return `<div class="grid perm-grid tm-grid">${historyCard()}${moverCard("inactive", s)}${moverCard("hiatus", s)}${teamsCard()}${requestsCard()}${xrefCard()}</div>`;
}

function status() {
  if (failed) return `<span class="lb-warn">${esc(failed)}</span>`;
  const notes = [];
  if (tm?.activityMissing?.length) notes.push(`last active leaves out ${tm.activityMissing.map((k) => DID[k]).join(", ")} until migration 014 runs`);
  for (const p of tm?.problems ?? []) notes.push(`${p.part} couldn't be read`);
  return notes.map((n) => `<span class="lb-warn">${esc(n)}</span>`).join(" · ");
}

function memberHead() {
  return tm ? ["Since", "Last active"] : [];
}

function memberCells(teamId, login) {
  return tm ? `<td class="sub">${sinceText(teamId, login)}</td><td>${lastCell(login)}</td>` : "";
}

function sections(team) {
  if (!tm) return "";
  const { direct, viaMember } = requestsFor(team);
  const reqRows = [...direct.map((p) => prRow(p, teamChip(team, true))), ...viaMember.map((p) => prRow(p, p.asked.map(esc).join(", ")))];
  const lines = (tm.history ?? []).filter((e) => String(e.teamId) === String(team.id)).slice(0, 25);
  const history = lines.length
    ? `<ol class="log-rows perm-changes tm-history">${lines.map((e) => `<li class="log-row${e.tone ? ` tone-${esc(e.tone)}` : ""}">
        <time datetime="${esc(e.at)}" title="${esc(new Date(e.at).toLocaleString())}">${esc(when(e.at))}</time>
        <span class="log-what">${actorHtml(e)}${esc(e.text)}</span></li>`).join("")}</ol>`
    : `<p class="sub perm-none">Nothing since ${esc(dateText(tm.historySince) || "tracking began")}.</p>`;
  return `<section class="perm-sec"><h3>Review requests <span class="sub">${direct.length}${viaMember.length ? ` + ${viaMember.length} asked of a member` : ""}</span></h3>
      ${reqRows.length ? `<table class="perm-ptable"><thead><tr>${prHead.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${reqRows.join("")}</tbody></table>` : `<p class="sub perm-none">No open pull request is waiting on this team.</p>`}</section>
    <section class="perm-sec"><h3>History <span class="sub">${lines.length}</span></h3>${history}</section>`;
}

configureTeamsPage({ body, status, memberHead, memberCells, sections });

/* ---- loading and events ---- */

async function load() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await fetch(`${API}/api/teams`, { cache: "no-store" });
      if (!res.ok) throw new Error(res.status === 403 ? "Only the admin team can see Team Management." : `Team Management couldn't be loaded (${res.status}).`);
      tm = await res.json();
      failed = null;
      fetchedAt = Date.now();
    } catch (err) {
      failed = err instanceof TypeError ? "Team Management couldn't be loaded." : err.message;
    } finally {
      inFlight = null;
      redrawPermissions();
    }
  })();
  return inFlight;
}

async function exclude(panel, login, on, note, form) {
  const err = form?.querySelector(".perm-add-err");
  try {
    const res = await fetch(`${API}/api/teams/exclusions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ panel, login, on, ...(note ? { note } : {}) }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error ?? `couldn't save (${res.status})`);
    if (tm) { tm.exclusions = out.exclusions; tm.exclusionsAt = out.stamp; }
    ui.excluding = null;
    ui.ticks[panel].delete(low(login));
    redrawPermissions();
  } catch (e) {
    if (err) err.textContent = String(e.message ?? e);
  }
}

const inPage = (el) => Boolean(el?.closest?.("[data-perm].tm"));

function wire() {
  if (wired) return;
  wired = true;
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (!inPage(t)) return;
    if (t.matches("[data-tm-tick]")) {
      const [panel, ...rest] = t.dataset.tmTick.split(":");
      ui.ticks[panel].set(low(rest.join(":")), t.checked);
      ui.notice[panel] = "";
      return redrawPermissions();
    }
    if (t.matches("[data-tm-history]")) {
      ui.history[t.dataset.tmHistory] = t.value;
      ui.history.shown = HISTORY_STEP;
      return redrawPermissions();
    }
    if (t.matches("[data-tm-xref]")) {
      const id = t.dataset.tmXref;
      ui.xref.teams = t.checked ? [...ui.xref.teams, id] : ui.xref.teams.filter((x) => x !== id);
      return redrawPermissions();
    }
    if (t.matches("[data-tm-requests]")) {
      ui.requests = t.value;
      return redrawPermissions();
    }
  });
  document.addEventListener("toggle", (e) => {
    const d = e.target;
    if (d?.matches?.("[data-tm-excluded]")) ui.openExcluded[d.dataset.tmExcluded] = d.open;
  }, true);
  document.addEventListener("click", (e) => {
    const t = e.target;
    if (!inPage(t)) return;
    const all = t.closest("[data-tm-all]");
    if (all) {
      const [panel, how] = all.dataset.tmAll.split(":");
      const s = teamsSetUp();
      const rows = panel === "inactive" ? developerRows(s) : hiatusRows(s);
      for (const r of rows) ui.ticks[panel].set(low(r.login), how === "on");
      return redrawPermissions();
    }
    const move = t.closest("[data-tm-move]");
    if (move) {
      const panel = move.dataset.tmMove;
      const s = teamsSetUp();
      if (!s?.dev || !s.hi) return;
      const { people, changes } = moveChanges(panel, s);
      if (!changes.length) return;
      ui.ticks[panel].clear();
      ui.notice[panel] = `${plural(people, "person", "people")} staged as ${plural(changes.length, "change")}. Review & apply them below.`;
      return stageMany(changes);
    }
    const ex = t.closest("[data-tm-exclude]");
    if (ex) {
      const [panel, ...rest] = ex.dataset.tmExclude.split(":");
      ui.excluding = { panel, login: rest.join(":") };
      redrawPermissions();
      return document.querySelector(`[data-tm-exclude-form="${panel}"][data-login] input[name="note"]`)?.focus();
    }
    if (t.closest("[data-tm-exclude-cancel]")) {
      ui.excluding = null;
      return redrawPermissions();
    }
    const inc = t.closest("[data-tm-include]");
    if (inc) {
      const [panel, ...rest] = inc.dataset.tmInclude.split(":");
      return exclude(panel, rest.join(":"), false);
    }
    const mode = t.closest("[data-tm-xmode]");
    if (mode) {
      ui.xref.mode = mode.dataset.tmXmode;
      return redrawPermissions();
    }
    if (t.closest("[data-tm-more]")) {
      ui.history.shown += HISTORY_STEP;
      return redrawPermissions();
    }
  });
  document.addEventListener("submit", (e) => {
    const form = e.target.closest?.("form[data-tm-exclude-form]");
    if (!form || !inPage(form)) return;
    e.preventDefault();
    const f = new FormData(form);
    const login = (form.dataset.login || String(f.get("login") ?? "")).trim().replace(/^@/, "");
    if (!login) return;
    exclude(form.dataset.tmExcludeForm, login, true, String(f.get("note") ?? "").trim(), form);
  });
  document.addEventListener("visibilitychange", () => {
    if (showing && document.visibilityState === "visible" && Date.now() - fetchedAt > REFRESH_MS) load();
  });
}

onTeamExclusionsStamp((at) => {
  if (showing && tm && at && at !== tm.exclusionsAt) load();
});

export function syncTeams(on) {
  showing = on;
  if (!on) {
    clearInterval(timer);
    timer = null;
    return;
  }
  wire();
  if (!tm || Date.now() - fetchedAt > REFRESH_MS) load();
  if (!timer) {
    timer = setInterval(() => {
      if (document.visibilityState !== "hidden") load();
    }, REFRESH_MS);
  }
}
