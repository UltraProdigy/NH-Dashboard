import { esc, fmt, repoLink } from "../format.js";
import { panel } from "../data.js";
import { applyFilter, renderTable, sortRows } from "../table.js";
import { state } from "../state.js";

const sync = () => (panel("labelSync")?.ok ? panel("labelSync").data : null);
const usage = () => (panel("labelUsage")?.ok ? panel("labelUsage").data : null);

const key = (name) => String(name ?? "").trim().toLowerCase();

const blankUse = () => ({ issues: [0, 0], prs: [0, 0] });

function addUse(map, k, c) {
  const cur = map.get(k) ?? blankUse();
  for (const t of ["issues", "prs"]) cur[t] = [cur[t][0] + (c[t]?.[0] ?? 0), cur[t][1] + (c[t]?.[1] ?? 0)];
  map.set(k, cur);
}

const indexes = new WeakMap();

function usageIndex() {
  const u = usage();
  if (!u) return null;
  if (indexes.has(u)) return indexes.get(u);
  const byRepo = new Map();
  const org = new Map();
  for (const [repo, labels] of Object.entries(u)) {
    const m = new Map();
    for (const [name, c] of Object.entries(labels)) {
      addUse(m, key(name), c);
      addUse(org, key(name), c);
    }
    byRepo.set(repo, m);
  }
  const idx = { byRepo, org };
  indexes.set(u, idx);
  return idx;
}

const orgUse = (name) => usageIndex()?.org.get(key(name)) ?? blankUse();
const repoUse = (repo, name) => usageIndex()?.byRepo.get(repo)?.get(key(name)) ?? blankUse();
const totalUse = (u) => u.issues[1] + u.prs[1];

const hex = (c) => (/^[0-9a-f]{6}$/i.test(c ?? "") ? c : null);

const chip = (l) => {
  const c = hex(l.color);
  return `<span class="label"${c ? ` style="border-color:#${c}"` : ""}${
    l.description ? ` title="${esc(l.description)}"` : ""}>${esc(l.name)}</span>`;
};

const swatch = (c) => (hex(c)
  ? `<span class="lb-swatch" style="background:#${c}"></span><code>#${esc(c)}</code>`
  : `<code>none</code>`);

const useCols = (get) => [
  { key: "prsOpen", label: "Open PRs", get: (r) => get(r).prs[0], render: (r) => `<span class="num">${fmt(get(r).prs[0])}</span>` },
  { key: "prsTotal", label: "PRs", get: (r) => get(r).prs[1], render: (r) => `<span class="num">${fmt(get(r).prs[1])}</span>` },
  { key: "issuesOpen", label: "Open issues", get: (r) => get(r).issues[0], render: (r) => `<span class="num">${fmt(get(r).issues[0])}</span>` },
  { key: "issuesTotal", label: "Issues", get: (r) => get(r).issues[1], render: (r) => `<span class="num">${fmt(get(r).issues[1])}</span>` },
];

const notReady = () => {
  const p = panel("labelSync");
  if (!p) return `<div class="empty">Not computed yet. The labels panel is built by the Worker's recompute.</div>`;
  if (!p.ok) return `<div class="error">This panel failed to build:<br>${esc(p.error)}</div>`;
  if (!p.data.managed.length) return `<div class="empty">No managed labels in D1 yet. Run <code>npm run backfill:labels</code>.</div>`;
  return null;
};

/* ---- what the nightly run would do, in words ---- */

const quote = (s) => (s ? `“${esc(s)}”` : "no description");

function describe(a) {
  const before = a.before;
  const after = a.after;
  if (a.type === "create") return `Would create ${chip(after)}`;
  if (a.type === "rename") return `Would rename ${chip(before)} to ${chip(after)}, keeping its assignments`;
  if (a.type === "migrate") return `Would move ${chip(before)}'s assignments to ${chip(after)} and delete ${chip(before)}`;
  if (a.type === "delete") {
    const why = {
      "deleted-config": "it's in deleted-labels.jsonc",
      "github-default": "it's an unchanged GitHub default",
      unmanaged: "it isn't managed",
    }[a.reason] ?? a.reason;
    return `Would delete ${chip(before)}, because ${why}`;
  }
  const parts = [];
  if (before.name !== after.name) parts.push(`rename it to “${esc(after.name)}”`);
  if (before.color !== after.color) parts.push(`change its colour from ${swatch(before.color)} to ${swatch(after.color)}`);
  if (before.description !== after.description) parts.push(`change its description from ${quote(before.description)} to ${quote(after.description)}`);
  return `Would ${parts.join(", and ")} on ${chip(before)}`;
}

/* ---- per repo ---- */

const tally = (r) => {
  const n = { missing: 0, wrong: 0, deleted: 0, defaults: 0, replaced: 0 };
  for (const a of r.actions) {
    if (a.type === "create") n.missing++;
    else if (a.type === "update") n.wrong++;
    else if (a.type === "rename" || a.type === "migrate") n.replaced++;
    else if (a.reason === "deleted-config") n.deleted++;
    else if (a.reason === "github-default") n.defaults++;
  }
  return n;
};

const SKIP = { archived: "Skipped: archived", source: "Skipped: the label source repo" };

const repoRows = () => {
  const d = sync();
  if (!d) return [];
  return d.repos.map((r) => ({ ...r, ...tally(r), drift: r.actions.length }));
};

const driftRows = () => repoRows().filter((r) => r.drift > 0);

function syncStatusRows() {
  const rows = repoRows()
    .filter((r) => !state.labelDriftOnly || r.drift > 0)
    .sort((a, b) => b.drift - a.drift || (a.skip ? 1 : 0) - (b.skip ? 1 : 0) || a.repo.localeCompare(b.repo));
  return applyFilter(rows);
}

const num = (n, warn) => `<span class="num${n && warn ? " lb-warn" : ""}">${n ? fmt(n) : "—"}</span>`;

function syncCols(expanded) {
  const checks = sync()?.checks ?? {};
  const cols = [
    { key: "repo", label: "Repo", render: (r) => `<span class="${r.skip || !r.read ? "lb-dim" : ""}">${repoLink(r.repo)}</span>` },
    { key: "missing", label: "Missing", render: (r) => num(r.missing, true) },
    { key: "wrong", label: "Wrong colour, description or case", render: (r) => num(r.wrong, true) },
  ];
  if (checks.deleted) cols.push({ key: "deleted", label: "Deleted, still present", render: (r) => num(r.deleted, true) });
  if (checks.githubDefaults) cols.push({ key: "defaults", label: "GitHub defaults", render: (r) => num(r.defaults, true) });
  if (checks.replacements) cols.push({ key: "replaced", label: "Replacements", render: (r) => num(r.replaced, true) });
  cols.push({
    key: "drift", label: expanded ? "What the nightly run would do" : "Status",
    render: (r) => {
      if (r.skip) return `<span class="sub">${esc(SKIP[r.skip] ?? `Skipped: ${r.skip}`)}</span>`;
      if (!r.read) return `<span class="sub">Labels not read yet</span>`;
      if (!r.drift) return `<span class="pill open">In sync</span>`;
      const n = `${fmt(r.drift)} change${r.drift === 1 ? "" : "s"}`;
      if (!expanded) return `<span class="pill neutral">${n}</span>`;
      return `<details class="lb-actions"><summary>${n}</summary><ul>${
        r.actions.map((a) => `<li>${describe(a)}</li>`).join("")}</ul></details>`;
    },
  });
  return cols;
}

function syncStatusHtml(expanded) {
  const wait = notReady();
  if (wait) return wait;
  const cols = syncCols(expanded);
  const rows = expanded ? sortRows(syncStatusRows(), cols) : syncStatusRows().filter((r) => r.drift > 0);
  if (!rows.length) {
    return `<div class="empty">${state.labelDriftOnly || !expanded
      ? "Every repo's managed labels match the managed set."
      : "No repos match the filter."}</div>`;
  }
  return renderTable(rows, cols, { sortable: expanded, limit: expanded ? null : 8 });
}

function syncSub() {
  const d = sync();
  if (!d) return "";
  const all = d.repos.filter((r) => r.read && !r.skip).length;
  const drift = driftRows().length;
  const checks = d.checks ?? {};
  const partial = checks.deleted && checks.githubDefaults ? "" : " · managed labels only";
  return `${fmt(drift)} of ${fmt(all)} repos would change tonight${partial}`;
}

const driftToggleHtml = () => `<span class="card-filters"><label class="minlabel lb-toggle">
    <input type="checkbox" data-labeldrift${state.labelDriftOnly ? " checked" : ""}> only repos with drift
  </label></span>`;

/* ---- managed labels ---- */

function managedRows() {
  const d = sync();
  if (!d) return [];
  const missing = new Map();
  const wrong = new Map();
  for (const r of d.repos) {
    for (const a of r.actions) {
      const m = a.type === "create" ? missing : a.type === "update" ? wrong : null;
      if (m) m.set(key(a.after.name), (m.get(key(a.after.name)) ?? 0) + 1);
    }
  }
  return d.managed.map((l) => ({
    ...l, use: orgUse(l.name), missing: missing.get(key(l.name)) ?? 0, wrong: wrong.get(key(l.name)) ?? 0,
  }));
}

function managedHtml(expanded) {
  const wait = notReady();
  if (wait) return wait;
  const rows = managedRows();
  if (!expanded) {
    return `<div class="lb-chips">${rows.map((r) => `<div class="lb-chip">${chip(r)}<span class="sub">${
      fmt(r.use.prs[0])} open / ${fmt(r.use.prs[1])} PRs · ${fmt(r.use.issues[0])} open / ${fmt(r.use.issues[1])} issues</span></div>`).join("")}</div>`;
  }
  const cols = [
    { key: "name", label: "Label", render: chip },
    { key: "description", label: "Description", sortable: false, render: (r) => (r.description ? esc(r.description) : `<span class="sub">—</span>`) },
    { key: "color", label: "Colour", sortable: false, render: (r) => swatch(r.color) },
    ...useCols((r) => r.use),
    { key: "missing", label: "Repos missing it", render: (r) => num(r.missing, true) },
    { key: "wrong", label: "Repos with it wrong", render: (r) => num(r.wrong, true) },
  ];
  return renderTable(sortRows(rows, cols), cols, { sortable: true });
}

/* ---- one repo ---- */

function pickableRepos() {
  const d = sync();
  return d ? d.repos.filter((r) => r.read).map((r) => r.repo) : [];
}

function chosenRepo() {
  const list = pickableRepos();
  if (state.labelRepo && list.includes(state.labelRepo)) return state.labelRepo;
  return driftRows().find((r) => r.read && !r.skip)?.repo ?? list[0] ?? null;
}

function repoLabelRows(repo) {
  const d = sync();
  const r = d.repos.find((x) => x.repo === repo);
  if (!r) return [];
  const byName = new Map(r.actions.map((a) => [key(a.after?.name ?? a.name), a]));
  const managed = d.managed.map((m) => {
    const a = byName.get(key(m.name));
    const shown = a?.type === "update" ? a.before : m;
    const status = r.skip ? "skipped" : a?.type === "create" ? "missing" : a?.type === "update" ? "wrong" : "ok";
    return { ...shown, kind: "managed", status, action: a ?? null, use: repoUse(repo, shown.name) };
  });
  const custom = r.custom.map((l) => ({ ...l, kind: "custom", status: "custom", action: null, use: repoUse(repo, l.name) }));
  return [...managed, ...custom];
}

const STATUS = {
  ok: () => `<span class="pill open">In sync</span>`,
  missing: (r) => `<span class="pill neutral">Missing</span> <span class="sub">${describe(r.action)}</span>`,
  wrong: (r) => `<span class="pill neutral">Differs</span> <span class="sub">${describe(r.action)}</span>`,
  custom: () => `<span class="sub">Never touched by the sync</span>`,
  skipped: () => `<span class="sub">Repo skipped by the sync</span>`,
};

function repoPickerHtml(repo) {
  const opts = pickableRepos().map((r) =>
    `<option value="${esc(r)}"${r === repo ? " selected" : ""}>${esc(r)}</option>`).join("");
  return `<span class="card-filters"><select class="inline-sel" id="labelRepoPick">${opts}</select></span>`;
}

function repoHtml(expanded) {
  const wait = notReady();
  if (wait) return wait;
  const repo = chosenRepo();
  if (!repo) return `<div class="empty">No repo's labels have been read yet.</div>`;
  const cols = [
    { key: "name", label: "Label", render: (r) => (r.status === "missing" ? `<span class="lb-dim">${chip(r)}</span>` : chip(r)) },
    { key: "kind", label: "Kind", render: (r) => `<span class="pill${r.kind === "managed" ? " ready" : ""}">${r.kind}</span>` },
    { key: "status", label: "Status", sortable: false, render: (r) => STATUS[r.status](r) },
    ...useCols((r) => r.use),
  ];
  const rows = repoLabelRows(repo);
  return renderTable(expanded ? sortRows(rows, cols) : rows, expanded ? cols : cols.slice(0, 3).concat(cols.slice(4, 5)), {
    sortable: expanded, limit: expanded ? null : 10,
  });
}

/* ---- unmanaged ---- */

function unmanagedRows() {
  const d = sync();
  if (!d) return [];
  return d.unmanaged.map((u) => {
    const uses = u.repos.map((repo) => totalUse(repoUse(repo, u.name)));
    return {
      ...u,
      color: u.variants[0]?.color ?? "",
      description: u.variants[0]?.description ?? "",
      repoCount: u.repos.length,
      colours: new Set(u.variants.map((v) => v.color)).size,
      used: uses.reduce((n, x) => n + x, 0),
      unusedIn: uses.filter((x) => x === 0).length,
    };
  });
}

function unmanagedHtml(expanded) {
  const wait = notReady();
  if (wait) return wait;
  const rows = unmanagedRows();
  if (!rows.length) return `<div class="empty">Every label in the org is managed.</div>`;
  const cols = [
    { key: "name", label: "Label", render: chip },
    { key: "repoCount", label: "Repos", render: (r) => `<span class="num">${fmt(r.repoCount)}</span>` },
    {
      key: "colours", label: "Colours",
      render: (r) => (r.colours > 1
        ? `<span class="pill neutral" title="${esc(r.variants.map((v) => `#${v.color} in ${v.repos.length}`).join(", "))}">${fmt(r.colours)} colours</span>`
        : swatch(r.color)),
    },
    { key: "used", label: "PRs and issues", render: (r) => (r.used ? `<span class="num">${fmt(r.used)}</span>` : `<span class="pill unknown">unused</span>`) },
    {
      key: "unusedIn", label: "Unused in",
      render: (r) => (r.unusedIn ? `<span class="num">${fmt(r.unusedIn)} of ${fmt(r.repoCount)}</span>` : `<span class="sub">—</span>`),
    },
  ];
  if (expanded) {
    cols.push({
      key: "where", label: "Where", sortable: false,
      render: (r) => `<details class="lb-actions"><summary>${fmt(r.repoCount)} repo${r.repoCount === 1 ? "" : "s"}</summary><ul>${
        r.variants.map((v) => `<li>${swatch(v.color)} ${v.description ? quote(v.description) : ""}: ${
          v.repos.map((repo) => repoLink(repo)).join(", ")}</li>`).join("")}</ul></details>`,
    });
  }
  const filtered = applyFilter(rows.map((r) => ({ ...r, title: r.name })));
  const shown = expanded ? sortRows(filtered, cols) : filtered;
  return renderTable(shown, cols, { sortable: expanded, limit: expanded ? null : 8 });
}

/* ---- modules ---- */

const USAGE_LAG = "usage counts can lag by up to an hour";

export const labelModules = {
  lbManaged: {
    page: "labels", label: "Managed labels", span: 12, reads: "labelUsage",
    sub: () => {
      const d = sync();
      return d ? `${fmt(d.managed.length)} labels from Label-Sync-GTNH · ${USAGE_LAG}` : USAGE_LAG;
    },
    render: managedHtml,
  },
  lbSync: {
    page: "labels", label: "Sync status", span: 12, flush: true, reads: "labelSync", controls: ["filter"],
    sub: syncSub,
    controlsHtml: driftToggleHtml,
    render: syncStatusHtml,
  },
  lbRepo: {
    page: "labels", label: "Repo labels", span: 12, flush: true, reads: "labelSync",
    sub: () => USAGE_LAG,
    controlsHtml: () => (sync() ? repoPickerHtml(chosenRepo()) : ""),
    render: repoHtml,
  },
  lbUnmanaged: {
    page: "labels", label: "Unmanaged labels", span: 12, flush: true, reads: "labelSync", controls: ["filter"],
    sub: () => {
      const d = sync();
      return d ? `${fmt(d.unmanaged.length)} names across the org · ${USAGE_LAG}` : "";
    },
    render: unmanagedHtml,
  },
};

export function labelCount(id) {
  if (!sync()) return null;
  if (id === "lbSync") return driftRows().length || null;
  if (id === "lbUnmanaged") return sync().unmanaged.length || null;
  return null;
}
