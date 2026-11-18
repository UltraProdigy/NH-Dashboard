import { GRANS, state } from "./state.js";
import { avatar, bareRepo, bucketLabel, bucketParts, diff, esc, fmt } from "./format.js";

/* ==========================================================================
   Chart primitives — hand-rolled SVG, so the page stays dependency-free
   ========================================================================== */

const NICE = [1, 2, 2.5, 5, 10];
function niceMax(v) {
  if (!v) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  return (NICE.find(n => v <= n * mag) ?? 10) * mag;
}

const groupingByChart = new Map();
const chartGrouping = id => groupingByChart.get(id) ?? "month";
const groupingLabel = id => id[0].toUpperCase() + id.slice(1);

function setChartGrouping(id, grouping) {
  if (!id || !GRANS.some(g => g.id === grouping) || chartGrouping(id) === grouping) return false;
  groupingByChart.set(id, grouping);
  return true;
}

/** The date range stays in the page toolbar. These controls affect one chart. */
function chartControls(id, title, series) {
  return `<div class="chart-toolbar">${legend(series)}
    <fieldset class="chart-grouping" aria-label="Group ${esc(title.toLowerCase())} by">
      <legend>Group by</legend>
      <div class="chart-segments">${GRANS.map(({ id: grouping }) =>
        `<button type="button" data-chart-gran="${esc(id)}" data-gran="${grouping}" aria-pressed="${chartGrouping(id) === grouping}">${groupingLabel(grouping)}</button>`).join("")}</div>
    </fieldset>
  </div>`;
}

/**
 * The SVG scales to any card width. Its axis labels are laid out in CSS pixels
 * so a narrow card never compresses the text to match the plot geometry.
 */
function plotFrame(max, height) {
  const W = 1000;
  const innerH = height - 18;
  const top = niceMax(max);
  const y = v => 8 + (1 - v / top) * innerH;
  const ticks = [1, 0.75, 0.5, 0.25, 0].map(f => top * f);
  const grid = ticks.map(t =>
    `<line x1="0" x2="${W}" y1="${y(t)}" y2="${y(t)}" opacity="${t === 0 ? 1 : .6}"/>`).join("");
  const labels = ticks.map(t => {
    const value = t >= 1000 ? `${Math.round(t / 100) / 10}k` : Math.round(t * 10) / 10;
    return `<span style="top:${y(t) / height * 100}%">${value}</span>`;
  }).join("");
  return { W, height, innerH, top, y, grid, labels };
}

const STRIDES = {
  M: [1, 2, 3, 6, 12, 24],
  W: [1, 2, 4, 8, 13, 26, 52],
  D: [1, 2, 7, 14, 28, 91, 182, 364],
};

function xAxis(buckets, maxLabels, density) {
  const key = buckets[0].b;
  const steps = STRIDES[key.includes("W") ? "W" : key.split("-").length > 2 ? "D" : "M"];
  let stride = steps.find(step => Math.ceil(buckets.length / step) <= maxLabels) ?? steps.at(-1);
  while (Math.ceil(buckets.length / stride) > maxLabels) stride *= 2;

  let lastYear = null;
  const labels = [];
  // Date the right edge even when the width leaves room for only a few ticks.
  for (let i = (buckets.length - 1) % stride; i < buckets.length; i += stride) {
    const { period, year } = bucketParts(buckets[i].b);
    const label = `<span>${esc(period)}</span>${year === lastYear ? "" : `<small>${esc(year)}</small>`}`;
    labels.push(`<span class="chart-tick" style="--at:${(i + 0.5) / buckets.length * 100}%">${label}</span>`);
    lastYear = year;
  }
  return `<div class="chart-xaxis ${density}">${labels.join("")}</div>`;
}

function chartFrame(f, buckets, series, marks, describe, { everyLabel, label }) {
  const slot = f.W / buckets.length;
  const hover = buckets.map((b, i) => `
    <rect class="hoverzone" x="${slot * i}" y="${f.y(f.top)}" width="${slot}" height="${f.innerH}" fill="transparent" data-chart-bucket="${i}">
      <title>${esc(bucketLabel(b.b))}\n${series.map(s => `${esc(s.label)}: ${esc(describe(b[s.key]))}`).join("\n")}</title>
    </rect>`).join("");
  const name = label ?? series.map(s => s.label).join(", ");
  return `<div class="chart-frame" data-chart-label="${esc(name)}">
    <div class="chart-stage">
      <div class="chart-axes" aria-hidden="true">
        <div class="chart-yaxis">${f.labels}</div>
        <svg class="chart" viewBox="0 0 ${f.W} ${f.height}" preserveAspectRatio="none" height="${f.height}">
          <g class="chart-grid">${f.grid}</g>${marks}${hover}
        </svg>
        ${xAxis(buckets, everyLabel ? 12 : 7, "wide")}
        ${xAxis(buckets, 5, "medium")}
        ${xAxis(buckets, 3, "narrow")}
      </div>
    </div>
  </div>`;
}

/** Grouped vertical bars. `series` = [{ key, label, color }]. */
function barChart(buckets, series, { height = 190, everyLabel = false, label } = {}) {
  if (!buckets.length) return `<div class="empty">No data in this range.</div>`;
  const max = Math.max(1, ...buckets.flatMap(b => series.map(s => b[s.key] ?? 0)));
  const f = plotFrame(max, height);
  const slot = f.W / buckets.length;
  const bw = (slot * 0.74) / series.length;

  const bars = buckets.map((b, i) => {
    const x0 = slot * (i + 0.13);
    return series.map((s, j) => {
      const v = b[s.key] ?? 0;
      const h = Math.max(v > 0 ? 1 : 0, f.y(0) - f.y(v));
      return `<rect x="${x0 + bw * j}" y="${f.y(0) - h}" width="${bw}" height="${h}" fill="${s.color}" rx="1"/>`;
    }).join("");
  }).join("");

  return chartFrame(f, buckets, series, bars, v => fmt(v ?? 0), { everyLabel, label });
}

const LINE_DASHES = { dashed: "6 4", dotted: "2 4" };

/** Multi-series line chart. Nulls break the line and single points stay visible. */
function lineChart(buckets, series, { height = 190, fmtV = fmt, everyLabel = false, label } = {}) {
  if (!buckets.length) return `<div class="empty">No data in this range.</div>`;
  const max = Math.max(1, ...buckets.flatMap(b => series.map(s => b[s.key] ?? 0)));
  const f = plotFrame(max, height);
  const slot = f.W / buckets.length;
  const px = i => slot * (i + 0.5);

  const paths = series.map(s => {
    let line = "", isolated = "";
    buckets.forEach((b, i) => {
      const v = b[s.key];
      if (v == null) return;
      const follows = buckets[i - 1]?.[s.key] != null;
      const precedes = buckets[i + 1]?.[s.key] != null;
      const position = `${px(i).toFixed(1)},${f.y(v).toFixed(1)}`;
      if (follows || precedes) line += `${follows ? "L" : "M"}${position}`;
      else isolated += `M${position}h0`;
    });
    return `<g stroke="${s.color}" fill="none">
      <path d="${line}" stroke-width="2" stroke-linejoin="round" stroke-dasharray="${LINE_DASHES[s.line] ?? "none"}" vector-effect="non-scaling-stroke"/>
      <path d="${isolated}" stroke-width="4" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    </g>`;
  }).join("");

  return chartFrame(f, buckets, series, paths, v => v == null ? "—" : fmtV(v), { everyLabel, label });
}

function legend(series) {
  return `<div class="legend">${series.map(s =>
    `<span><i${s.line ? ` class="legend-${s.line}"` : ""} style="--series-color:${s.color};background:${s.color}" aria-hidden="true"></i>${esc(s.label)}</span>`).join("")}</div>`;
}

function bindChartInspection(root) {
  for (const frame of root.querySelectorAll(".chart-frame")) {
    const stage = frame.querySelector(".chart-stage");
    if (stage.hasAttribute("role")) continue;
    const chart = stage.querySelector("svg");
    const zones = [...chart.querySelectorAll("[data-chart-bucket]")];
    const describe = zone => zone.querySelector("title").textContent.split("\n");
    const readout = document.createElement("div");
    readout.className = "chart-readout";
    readout.innerHTML = `
      <div class="chart-value"><strong></strong>${describe(zones[0]).slice(1).map(() => "<span></span>").join("")}</div>
      <div class="chart-step">
        <button type="button" aria-label="Previous bucket" title="Previous bucket"></button>
        <button type="button" aria-label="Next bucket" title="Next bucket"></button>
      </div>
      <div class="chart-announcement" role="status"></div>`;
    frame.append(readout);
    stage.tabIndex = 0;
    stage.setAttribute("role", "slider");
    stage.setAttribute("aria-label", `${frame.dataset.chartLabel} data point. Use arrow keys to inspect.`);
    stage.setAttribute("aria-valuemin", "1");
    stage.setAttribute("aria-valuemax", String(zones.length));
    const [previous, next] = readout.querySelectorAll("button");
    const values = [...readout.querySelector(".chart-value").children];
    const announcement = readout.querySelector(".chart-announcement");
    let selected = -1;
    function inspect(index, announce = false) {
      const pick = Math.max(0, Math.min(zones.length - 1, index));
      if (pick === selected) return;

      zones[selected]?.classList.remove("selected-zone");
      selected = pick;
      const zone = zones[selected];
      zone.classList.add("selected-zone");
      const entries = describe(zone);
      const text = entries.join(", ");
      values.forEach((node, i) => { node.textContent = entries[i]; });
      stage.setAttribute("aria-valuenow", String(selected + 1));
      stage.setAttribute("aria-valuetext", text);
      if (announce) announcement.textContent = text;
      previous.setAttribute("aria-disabled", String(selected === 0));
      next.setAttribute("aria-disabled", String(selected === zones.length - 1));
    }

    const inspectZone = event => {
      const zone = event.target.closest("[data-chart-bucket]");
      if (zone) inspect(Number(zone.dataset.chartBucket));
    };
    chart.addEventListener("pointerover", inspectZone);
    chart.addEventListener("pointerup", inspectZone);
    previous.addEventListener("click", () => inspect(selected - 1, true));
    next.addEventListener("click", () => inspect(selected + 1, true));
    stage.addEventListener("keydown", event => {
      const index = {
        ArrowLeft: selected - 1,
        ArrowDown: selected - 1,
        ArrowRight: selected + 1,
        ArrowUp: selected + 1,
        Home: 0,
        End: zones.length - 1,
      }[event.key];
      if (index == null) return;
      event.preventDefault();
      inspect(index);
    });
    inspect(zones.length - 1);
  }
}

/**
 * Horizontal ranked bars — better than a pie for "top N of many".
 *
 * Every one of these lists ranks by a single metric, so each row is numbered:
 * position in the list is information, and "who is seventh" shouldn't need
 * counting down from the top. `share` adds each row's percentage of the list's
 * total beside its count — on a per-repo breakdown of someone's PRs, "48 in
 * GT5-Unofficial" means something quite different at 12% than at 80%.
 *
 * `note` is a second string in the same cell, for a fact the bar can't carry
 * because it isn't what the bar is measuring: "12 open" ranks the list, and
 * "40 closed" beside it is the difference between a quiet tracker and a
 * well-tended one.
 */
function hbars(rows, { label, value, color = "var(--accent)", href = null, internal = false, fmtV = fmt, rank = true, share = false, icon = null, note = null } = {}) {
  if (!rows.length) return `<div class="empty">Nothing to show.</div>`;
  const max = Math.max(...rows.map(value));
  // Of the list, not of the subject's grand total: these breakdowns are
  // exhaustive (every PR they opened lands in exactly one repo), so the two are
  // the same number — and computing it from the rows can't drift out of step
  // with a window that omitted something.
  const total = share ? rows.reduce((n, r) => n + value(r), 0) : 0;
  // `internal` links stay in the app (a #hash route), so they must not open in
  // a new tab the way the github.com links do.
  const attrs = internal ? " data-drilllink" : ` target="_blank" rel="noopener"`;
  return `<div class="hbars">${rows.map((r, i) => {
    const text = esc(label(r));
    const v = value(r);
    return `<div class="hbar">
      ${rank ? `<span class="rk">${i + 1}</span>` : `<span></span>`}
      ${/* Inside .lab rather than as a fifth grid track, so the name keeps the
            ellipsis it needs when a long login meets a narrow duo box. */""}
      <span class="lab" title="${text}">${icon ? icon(r) : ""}${
        href ? `<a href="${href(r)}"${attrs}>${text}</a>` : text}</span>
      <span class="track"><span class="fill" style="width:${(v / max) * 100}%;background:${color}"></span></span>
      <span class="val">${fmtV(v)}${
        note ? `<span class="sh">${note(r)}</span>` : ""}${
        share && total ? `<span class="sh">${Math.round((v / total) * 100)}%</span>` : ""}</span>
    </div>`;
  }).join("")}</div>`;
}

/**
 * Several titled ranked lists laid across the width of a card.
 *
 * The alternative was stacking them, which on a full-width card meant every row
 * spanning the whole screen with its count stranded at the far edge — see the
 * cap on `.hbars`. Capped and stacked would have read fine and left two thirds
 * of the card empty; two or three columns of capped lists reads fine and uses
 * the space. Blocks with nothing in them drop out rather than leaving a titled
 * hole in the grid.
 */
function barGrid(blocks) {
  const live = blocks.filter(b => b.html);
  if (!live.length) return "";
  return `<div class="bargrid">${live.map(b =>
    `<section><h3>${esc(b.title)}</h3>${b.html}</section>`).join("")}</div>`;
}

/**
 * A ranked list of PRs — "most grossing", and anything else where the row is a
 * pull request rather than a name.
 *
 * No bar. These counts span three orders of magnitude (a 400-comment thread
 * next to a 6-comment one), and a proportional track renders four invisible
 * slivers under one full-width one, which tells you less than the numbers do.
 */
function prList(rows, { unit = "", repo = null, kind = "pull" } = {}) {
  if (!rows.length) return `<div class="empty" style="padding:18px 0">Nothing here.</div>`;
  const org = state.data.org;
  return `<div class="prlist">${rows.map((r, i) => {
    // Rows from a repo's own lists don't carry a repo — the card is already
    // about one. The org-wide board does, and needs it on every row.
    const where = bareRepo(r.repo ?? repo);
    const id = r.repo ? `${where}#${r.number}` : `#${r.number}`;
    // Titles are absent until the ingest backfill has run; fall back to the
    // identifier rather than rendering a blank row.
    const text = esc(r.title || id);
    return `<div class="prrow">
      <span class="rk">${i + 1}</span>
      <span class="ttl" title="${esc(r.title || id)}">
        <a href="https://github.com/${org}/${encodeURIComponent(where)}/${kind}/${r.number}"
           target="_blank" rel="noopener">${text}</a>
        <span class="who">${esc(id)}${
          r.author ? ` · ${avatar(r.author, 14)}${esc(r.author)}` : ""}</span>
      </span>
      <span class="ct">${fmt(r.count)}${unit ? ` ${unit}` : ""}</span>
    </div>`;
  }).join("")}</div>`;
}

/**
 * Three ranked boxes — the shape "most grossing" takes everywhere it appears.
 *
 * Same construction as duo(), one box wider. Kept separate rather than
 * generalising duo() to n boxes: the two have different collapse points and
 * different empty-state wording, and a `boxes(...lists)` that took both would
 * be mostly branches on how many it was handed.
 */
function trio(boxes, { height = "short", stacked = false, repo = null, kind = "pull" } = {}) {
  return `<div class="trio${stacked ? " stacked" : ""}">${boxes.map(b => `
    <section class="duo-box">
      <h3>${esc(b.title)}<span class="n">${fmt(b.rows.length)}</span></h3>
      <div class="scroll ${height}">${prList(b.rows, { unit: b.unit, repo, kind })}</div>
    </section>`).join("")}</div>`;
}

/** The three lists, in the order they read best: argued about, liked, hated. */
const GROSSING_BOXES = [
  { key: "commented", title: "Most commented", unit: "comments" },
  { key: "liked", title: "Most 👍", unit: "" },
  { key: "disliked", title: "Most 👎", unit: "" },
];

const grossingBoxes = (g) =>
  GROSSING_BOXES.map(b => ({ ...b, rows: g?.[b.key] ?? [] }));

/** Shown when a build predates the engagement fields, or nothing drew any. */
const grossingNote = (g) =>
  g && GROSSING_BOXES.some(b => (g[b.key] ?? []).length)
    ? ""
    : `<div class="hint" style="margin-top:12px">No comment or reaction data yet. It arrives with the ingest backfill — run <code>npm run ingest</code>, which re-walks the store once to populate diff sizes, comment counts and reactions, then <code>npm run build</code>.</div>`;

function kpi(k, v, d = "", cls = "") {
  return `<div class="kpi"><div class="k">${esc(k)}</div><div class="v ${cls}">${v}</div><div class="d">${d}</div></div>`;
}

export {
  barChart,
  barGrid,
  bindChartInspection,
  chartControls,
  chartGrouping,
  grossingBoxes,
  grossingNote,
  hbars,
  kpi,
  legend,
  lineChart,
  setChartGrouping,
  trio,
};
