import { API } from "./live.js";
import { esc } from "./format.js";
import { bulkRows, LEVELS } from "./permissions-calc.js";
import { propertyFilter } from "./property-filter.js";
import { adminTeamId, ownerOnly, stageMany } from "./permission-apply.js";

const bulk = { kind: "team", team: "", login: "", action: "write", name: "", visibility: "any", current: "any", ticks: new Map() };
let ctx = { data: () => null, idx: () => null, archived: () => false, levelPill: (l) => esc(l), repoRef: (id) => esc(id) };
let props = { open: false, list: null, error: null, loading: false, byName: new Map() };

const filter = propertyFilter("nh:perm-bulk-filter", { live: true, onChange: () => paintBulkResults() });

export function configureBulk(next) {
  ctx = { ...ctx, ...next };
}

function subject() {
  const data = ctx.data();
  if (bulk.kind === "team") {
    const t = data?.teams?.[bulk.team];
    return t ? { kind: "team", id: t.id, team: t } : null;
  }
  const typed = bulk.login.trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(typed)) return null;
  const known = ctx.idx()?.people.find((p) => p.toLowerCase() === typed.toLowerCase());
  return { kind: "person", login: known ?? typed };
}

function rows() {
  const s = subject();
  if (!s) return [];
  const list = bulkRows(ctx.data(), ctx.idx(), {
    subject: s,
    to: bulk.action === "remove" ? null : bulk.action,
    archived: ctx.archived(),
    current: bulk.current,
    name: bulk.name,
    visibility: bulk.visibility,
  });
  if (!filter.active()) return list;
  return list.filter((r) => filter.passes({ properties: props.byName.get(ctx.data().repos[r.repo].name) ?? {} }));
}

const ticked = (r) => bulk.ticks.get(r.repo) ?? r.change === "raise";

function changeFor(s, r) {
  const data = ctx.data();
  const repo = { id: Number(r.repo), name: data.repos[r.repo].name };
  return s.kind === "team"
    ? { kind: "team_repo", team: { id: s.team.id, slug: s.team.slug, name: s.team.name }, repo, from: r.now, to: r.to }
    : { kind: "collaborator", repo, login: s.login, from: r.now, to: r.to };
}

const NOTE = {
  raise: "",
  lower: `<span class="pill perm-risky" title="Lowers access, so it isn't ticked">lowers</span>`,
  unknown: `<span class="pill lv lv-unknown" title="The level isn't known until the next 10-minute read">level not known yet</span>`,
};

function resultsHtml() {
  const s = subject();
  const data = ctx.data();
  if (!s) return `<p class="sub perm-bulk-empty">${bulk.kind === "team" ? "Pick a team" : "Type a GitHub login"} to see what would change.</p>`;
  const list = rows();
  const blocked = s.kind === "team" && ownerOnly({ kind: "team_repo", team: { id: s.id } }, data);
  const picked = list.filter(ticked);
  const raises = list.filter((r) => r.change === "raise").length;
  const lowers = list.filter((r) => r.change === "lower").length;
  const unknown = list.length - raises - lowers;
  const who = s.kind === "team" ? `team ${esc(s.team.name)}` : esc(s.login);
  const action = bulk.action === "remove"
    ? s.kind === "team" ? `remove ${who} from` : `remove ${who}'s direct access to`
    : `give ${who} ${s.kind === "team" ? "" : "direct "}${esc(bulk.action)} on`;
  const body = list.map((r) => {
    const repo = data.repos[r.repo];
    const extra = r.role ? `<span class="sub">(${esc(r.role)} from an org role anyway)</span>` : r.inherited ? `<span class="sub">(inherits ${esc(r.inherited)})</span>` : r.effective ? `<span class="sub">(${esc(r.effective)} overall)</span>` : "";
    return `<tr class="${ticked(r) ? "" : "ra-off"}">
      <td><input type="checkbox" data-bulk-tick="${esc(r.repo)}" aria-label="Include ${esc(repo.name)}"${ticked(r) ? " checked" : ""}${blocked ? " disabled" : ""}></td>
      <td>${ctx.repoRef(r.repo)}${repo.visibility !== "public" ? ` <span class="pill draft">${esc(repo.visibility)}</span>` : ""}</td>
      <td>${r.now == null ? `<span class="sub">none</span>` : r.now === "unknown" ? ctx.levelPill(null) : ctx.levelPill(r.now)} ${extra}</td>
      <td>${r.to == null ? `<span class="sub">none</span>` : ctx.levelPill(r.to)}</td>
      <td>${NOTE[r.change]}${r.invite ? ` <span class="pill neutral" title="Not an org member, so GitHub sends an invite">invite</span>` : ""}</td>
    </tr>`;
  }).join("");
  const summary = list.length
    ? `${list.length} repo${list.length === 1 ? "" : "s"} would change: ${raises} up${lowers ? `, ${lowers} down (not ticked)` : ""}${unknown ? `, ${unknown} not known yet (not ticked)` : ""}`
    : "No repo would change.";
  return `<div class="perm-bulk-summary">
      <span>${summary}</span>
      <span class="perm-tray-gap"></span>
      ${blocked ? `<span class="pill perm-blocked">owner only</span> <span class="sub">Only an org owner can change the admin team's repos.</span>` : ""}
      <button type="button" class="daily-go" data-bulk-stage${!picked.length || blocked ? " disabled" : ""}>Save ${picked.length === 1 ? "1 change" : `${picked.length} changes`}</button>
    </div>
    ${list.length ? `<p class="sub perm-bulk-what">This will ${action} each ticked repo. Repos it wouldn't change are hidden.</p>
    <div class="ra-scroll perm-bulk-scroll"><table class="ra-table">
      <thead><tr><th><input type="checkbox" data-bulk-all aria-label="Tick or untick every repo"${picked.length === list.length ? " checked" : ""}${blocked ? " disabled" : ""}></th>
        <th>Repo</th><th>Now</th><th>After</th><th></th></tr></thead>
      <tbody>${body}</tbody></table></div>` : ""}`;
}

function propsHtml() {
  if (!props.open) return `<button type="button" class="ghost mini" data-bulk-props>Filter by custom property</button>`;
  if (props.loading) return `<span class="sub">Loading custom properties…</span>`;
  if (props.error) return `<span class="sub lb-warn">${esc(props.error)}</span>`;
  return filter.html();
}

export function bulkCard() {
  const data = ctx.data();
  if (!data?.org) return "";
  const teams = Object.values(data.teams).sort((a, b) => a.name.localeCompare(b.name));
  const opt = (v, text, sel) => `<option value="${esc(v)}"${String(v) === String(sel) ? " selected" : ""}>${esc(text)}</option>`;
  const admin = adminTeamId(data);
  return `<section class="card perm-card perm-bulk" style="--span:12" data-bulk>
    <header><h2>Bulk change</h2><span class="sub">one team or person, many repos at once · saved changes wait to be applied like any other</span></header>
    <div class="body">
      <div class="perm-bulk-row">
        <label class="sub">For <select class="perm-sel" data-bulk-field="kind">${opt("team", "a team", bulk.kind)}${opt("person", "a person", bulk.kind)}</select></label>
        ${bulk.kind === "team"
          ? `<select class="perm-sel" data-bulk-field="team" aria-label="Team"><option value="">Team…</option>${teams.map((t) => opt(t.id, `${t.name}${String(t.id) === String(admin) ? " (admin team)" : ""}`, bulk.team)).join("")}</select>`
          : `<input class="perm-input" data-bulk-field="login" list="perm-people" value="${esc(bulk.login)}" placeholder="GitHub login" aria-label="GitHub login" autocomplete="off" spellcheck="false">`}
        <label class="sub">Set <select class="perm-sel" data-bulk-field="action">${LEVELS.map((l) => opt(l, l, bulk.action)).join("")}${opt("remove", "remove access", bulk.action)}</select></label>
      </div>
      <div class="perm-bulk-row">
        <input class="perm-input" data-bulk-field="name" value="${esc(bulk.name)}" placeholder="Repo name contains" aria-label="Repo name contains" autocomplete="off" spellcheck="false">
        <label class="sub">Visibility <select class="perm-sel" data-bulk-field="visibility">${opt("any", "any", bulk.visibility)}${opt("public", "public", bulk.visibility)}${opt("private", "private", bulk.visibility)}</select></label>
        <label class="sub">${bulk.kind === "team" ? "Team's own level" : "Direct grant"} <select class="perm-sel" data-bulk-field="current">${opt("any", "any", bulk.current)}${opt("none", "none", bulk.current)}${opt("has", "any level", bulk.current)}${LEVELS.map((l) => opt(l, l, bulk.current)).join("")}</select></label>
        <span class="sub">${ctx.archived() ? "Archived repos are included." : "Archived repos are left out."}</span>
      </div>
      <div class="perm-bulk-row" data-bulk-props-area>${propsHtml()}</div>
      <div data-bulk-results>${resultsHtml()}</div>
    </div>
  </section>`;
}

export function paintBulkResults() {
  const el = document.querySelector("[data-bulk-results]");
  if (!el) return;
  const scroll = el.querySelector(".perm-bulk-scroll")?.scrollTop ?? 0;
  el.innerHTML = resultsHtml();
  const next = el.querySelector(".perm-bulk-scroll");
  if (next) next.scrollTop = scroll;
}

function paintCard() {
  const el = document.querySelector("[data-bulk]");
  if (el) el.outerHTML = bulkCard();
}

async function loadProps() {
  props = { ...props, open: true, loading: true, error: null };
  paintProps();
  try {
    const res = await fetch(`${API}/api/releases/repos`, { cache: "no-store" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `couldn't load (${res.status})`);
    if (body.propertiesError) throw new Error(body.propertiesError);
    props = { ...props, loading: false, list: body, byName: new Map((body.repos ?? []).map((r) => [r.name, r.properties ?? {}])) };
    filter.use(body);
  } catch (err) {
    props = { ...props, loading: false, error: `Custom properties couldn't be loaded: ${err.message}` };
  }
  paintProps();
  paintBulkResults();
}

function paintProps() {
  const el = document.querySelector("[data-bulk-props-area]");
  if (el) el.innerHTML = propsHtml();
}

export function setBulkSubject(kind, key) {
  bulk.kind = kind;
  if (kind === "team") bulk.team = String(key);
  else bulk.login = String(key);
  bulk.ticks.clear();
  paintCard();
  document.querySelector("[data-bulk]")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function bulkEvent(e) {
  const t = e.target;
  if (!t.closest?.("[data-bulk]")) return false;
  if (e.type === "click") {
    if (t.closest("[data-bulk-props]")) { loadProps(); return true; }
    if (t.closest("[data-bulk-stage]")) {
      const s = subject();
      if (!s) return true;
      stageMany(rows().filter(ticked).map((r) => changeFor(s, r)));
      bulk.ticks.clear();
      return true;
    }
    return false;
  }
  const field = t.dataset?.bulkField;
  if (field) {
    const value = t.value;
    if (e.type === "input" && t.tagName === "SELECT") return true;
    if (field === "kind" && value !== bulk.kind) {
      bulk.kind = value;
      bulk.ticks.clear();
      paintCard();
      return true;
    }
    bulk[field] = value;
    if (["team", "login", "action"].includes(field)) bulk.ticks.clear();
    if (field === "current" || field === "visibility" || field === "team" || field === "action") paintBulkResults();
    else if (e.type === "input") paintBulkResults();
    return true;
  }
  if (e.type === "change" && t.dataset?.bulkTick) {
    bulk.ticks.set(t.dataset.bulkTick, t.checked);
    paintBulkResults();
    return true;
  }
  if (e.type === "change" && t.matches("[data-bulk-all]")) {
    for (const r of rows()) bulk.ticks.set(r.repo, t.checked);
    paintBulkResults();
    return true;
  }
  return false;
}
