import { state } from "../state.js";
import { avatar, esc, fmt } from "../format.js";
import { legend, lineChart } from "../charts.js";
import { windowPhrase } from "../data.js";
import {
  MAX_OPPONENTS,
  lineup,
  metricGroups,
  opponents,
  overlay,
  readingsFor,
  vsPopHtml,
} from "../versus-data.js";

/**
 * Which cell in a row leads.
 *
 * Returns a Set of column indexes rather than one, so a tie highlights both
 * rather than silently picking whoever was added first. Nulls never lead: a
 * subject with no data for a metric hasn't won it.
 */
function leaders(row, readings) {
  if (!row.dir) return new Set();
  const vals = readings.map((r) => {
    const v = row.get(r);
    return typeof v === "number" ? v : null;
  });
  const real = vals.filter((v) => v != null);
  if (real.length < 2) return new Set();
  const best = row.dir === "low" ? Math.min(...real) : Math.max(...real);
  // A row where everybody scores zero has no leader, only a shared blank.
  if (best === 0 && row.dir === "high") return new Set();
  const out = new Set();
  vals.forEach((v, i) => { if (v === best) out.add(i); });
  return out;
}

/* Only the contributor page — the repo side compares repos, which have no
   face of their own beyond the org's. */
const face = (id) => (state.page === "contributor" ? avatar(id, 16) : "");

const chips = (entries) => `<div class="vs-chips">${
  entries.map((e) => `<span class="vs-chip"${e.pinned ? ' data-pinned="1"' : ""}>
      <i style="background:${e.color}"></i>${face(e.id)}${esc(e.id)}${
        e.pinned
          ? `<span class="vs-you">this page</span>`
          : `<button class="vs-x" data-vsdel="${esc(e.id)}" title="Remove">×</button>`}
    </span>`).join("")
  }${
    entries.length <= MAX_OPPONENTS
      ? `<span class="combo vs-add" id="vsCombo">
           <input type="search" id="vsInput" role="combobox" autocomplete="off"
                  aria-expanded="${state.vs.open}" aria-controls="vsPop"
                  placeholder="Add ${state.page === "contributor" ? "a contributor" : "a repo"}…"
                  value="${esc(state.vs.open ? state.vs.q : "")}">
           <div class="combo-pop" id="vsPop" role="listbox"${state.vs.open ? "" : " hidden"}>${
             state.vs.open ? vsPopHtml() : ""}</div>
         </span>`
      : `<span class="hint" style="align-self:center">Five is the limit — remove one to add another.</span>`
  }${
    opponents().length
      ? `<button class="ghost" data-vsclear="1" style="margin-left:auto">Clear</button>`
      : ""
  }</div>`;

function table(entries, readings) {
  const head = `<thead><tr><th style="cursor:default">Metric</th>${
    entries.map((e) => `<th style="cursor:default" class="num">
      <span class="vs-head"><i style="background:${e.color}"></i>${face(e.id)}${esc(e.id)}</span></th>`).join("")
  }</tr></thead>`;

  const body = metricGroups().map((g) => {
    const rows = g.rows.map((row) => {
      const lead = leaders(row, readings);
      return `<tr><td>${esc(row.label)}</td>${
        readings.map((r, i) =>
          `<td class="num${lead.has(i) ? " lead" : ""}">${row.fmt(row.get(r))}</td>`).join("")
      }</tr>`;
    }).join("");
    return `<tr class="vs-group"><td colspan="${entries.length + 1}">${esc(g.title)}</td></tr>${rows}`;
  }).join("");

  // The sticky first column only sticks to a scrollport, and the card is not
  // one — it clips. This is that scrollport, and the reason the row labels
  // stay put while you read across a five-way comparison.
  return `<div class="tscroll"><table class="vs">${head}<tbody>${body}</tbody></table></div>`;
}

/** One ranked-bar block per headline metric — the table's shape, read sideways. */
function bars(entries, readings, picks) {
  return picks.map(({ title, get, fmtV }) => {
    const rows = entries.map((e, i) => ({
      label: e.id, value: get(readings[i]) ?? 0, color: e.color,
    })).filter((r) => r.value);
    if (!rows.length) return "";
    rows.sort((a, b) => b.value - a.value);
    return `<h3 style="font-size:13px;margin:22px 0 8px">${esc(title)}</h3>` +
      // Coloured per row rather than per list: the colour is the subject's
      // identity everywhere else on this card, and a chart that recoloured them
      // would be its own separate thing to learn.
      `<div class="hbars">${rows.map((r, i) => `
        <div class="hbar">
          <span class="rk">${i + 1}</span>
          <span class="lab" title="${esc(r.label)}">${esc(r.label)}</span>
          <span class="track"><span class="fill" style="width:${
            (r.value / rows[0].value) * 100}%;background:${r.color}"></span></span>
          <span class="val">${(fmtV ?? fmt)(r.value)}</span>
        </div>`).join("")}</div>`;
  }).join("");
}

const HEADLINES = {
  contributor: [
    { title: "PRs opened", get: (r) => r.w.opened },
    { title: "Approvals given", get: (r) => r.w.approvals },
    { title: "Triage acts", get: (r) => r.iw.triage },
    { title: "Issues filed", get: (r) => r.iw.filed },
  ],
  repo: [
    { title: "PRs opened", get: (r) => r.w.opened },
    { title: "Contributors", get: (r) => r.w.people },
    { title: "Issues opened", get: (r) => r.iw.opened },
    { title: "Open issues right now", get: (r) => r.ibacklog.total },
  ],
};

function render(expanded) {
  const entries = lineup();
  const readings = entries.map(readingsFor);
  const only = entries.length < 2;

  const prompt = only
    ? `<div class="hint" style="padding:14px 0">Add ${
        state.page === "contributor" ? "a contributor" : "a repo"
      } to compare against ${esc(state.subject)}. Up to four, side by side, on whichever period the toolbar is set to.</div>`
    : "";

  if (!expanded)
    return chips(entries) + prompt +
      (only ? "" : table(entries, readings));

  const prs = overlay(entries, { field: "opened" });
  const iss = overlay(entries, { issues: true, field: state.page === "contributor" ? "filed" : "opened" });

  const charts = only ? "" : `
    <h3 style="font-size:13px;margin:26px 0 8px">PRs opened, by month</h3>
    ${prs.buckets.length
      ? legend(prs.series) + lineChart(prs.buckets, prs.series, { height: 260 })
      : `<div class="empty">No pull request history in this period.</div>`}
    <h3 style="font-size:13px;margin:26px 0 8px">${
      state.page === "contributor" ? "Issues filed, by month" : "Issues opened, by month"}</h3>
    ${iss.buckets.length
      ? legend(iss.series) + lineChart(iss.buckets, iss.series, { height: 260 })
      : `<div class="empty">No issue history in this period.</div>`}`;

  return chips(entries) + prompt +
    (only ? "" : table(entries, readings) +
      bars(entries, readings, HEADLINES[state.page] ?? []) +
      charts +
      `<div class="hint" style="margin-top:16px">The highlighted cell is the one leading that row, and on the volume rows that is all it means — whoever opened more pull requests is not thereby better at anything. Latency rows highlight the lowest, share rows the highest. Everything here follows the period control, so two people who were busy in different years will both look quiet on a one-month view.</div>`);
}

export const versusModules = {
  cVersus: {
    page: "contributor", label: "Head to head", span: 12, twin: "rVersus",
    controls: ["window"],
    sub: () => `${windowPhrase()}`,
    render,
  },

  rVersus: {
    page: "repo", label: "Head to head", span: 12, twin: "cVersus",
    controls: ["window"],
    sub: () => `${windowPhrase()}`,
    render,
  },
};
