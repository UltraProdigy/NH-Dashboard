import { state } from "./state.js";
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

/**
 * Shared scaffold: y grid lines + labels, x labels thinned to ~6 ticks.
 * Returns the plot geometry so each chart type only has to draw its marks.
 */
function plotFrame(buckets, max, { height, padL = 38, padB = 22, padT = 6, everyLabel = false }) {
  const W = 1000, H = height;
  const innerW = W - padL - 6, innerH = H - padB - padT;
  const top = niceMax(max);
  const y = v => padT + innerH - (v / top) * innerH;

  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => top * f);
  const gridSvg = ticks.map(t => `
    <line class="grid-line" x1="${padL}" x2="${W - 6}" y1="${y(t)}" y2="${y(t)}" opacity="${t === 0 ? 1 : .45}"/>
    <text class="axis" x="${padL - 7}" y="${y(t) + 3}" text-anchor="end">${t >= 1000 ? `${Math.round(t / 1000)}k` : Math.round(t * 10) / 10}</text>`).join("");

  // Label roughly six evenly-spaced buckets, anchored on the newest one so the
  // right-hand edge is always dated. When everyLabel is set the labels move
  // out of the SVG entirely — see xAxis() — so nothing is drawn here.
  const every = Math.max(1, Math.ceil(buckets.length / 6));
  const xLabels = everyLabel ? "" : buckets.map((b, i) =>
    (buckets.length - 1 - i) % every === 0
      ? `<text class="axis" x="${padL + (innerW / buckets.length) * (i + 0.5)}" y="${H - 6}" text-anchor="middle">${esc(bucketLabel(b.b))}</text>`
      : ""
  ).join("");

  return { W, H, padL, padT, innerW, innerH, top, y, gridSvg, xLabels };
}

/**
 * Every bucket labelled, as HTML beneath the plot.
 *
 * Inset to match the plot area so label i sits under bar i. The percentages
 * come from the same geometry plotFrame uses, so the two can't drift.
 */
const MAX_LABELS = 12;

/* Strides that read as something — every 6th month is "twice a year", every
   5th is noise. One list per bucket size, since a good stride for months is a
   bad one for weeks. */
const STRIDES = {
  M: [1, 2, 3, 6, 12, 24],
  W: [1, 2, 4, 8, 13, 26, 52],
  D: [1, 2, 7, 14, 28, 91, 182, 364],
};

function labelStride(buckets) {
  const k = buckets[0].b;
  const list = STRIDES[k.includes("W") ? "W" : k.split("-").length > 2 ? "D" : "M"];
  let s = list.find(c => buckets.length / c <= MAX_LABELS);
  if (!s) { s = list.at(-1); while (buckets.length / s > MAX_LABELS) s *= 2; }
  return s;
}

function xAxis(buckets, { padL = 38, W = 1000, padR = 6 } = {}) {
  if (!buckets.length) return "";
  const left = (padL / W) * 100;
  const width = ((W - padR - padL) / W) * 100;
  const stride = labelStride(buckets);
  let lastYear = null;
  const cells = buckets.map((b, i) => {
    // Anchored on the newest bucket so the right-hand edge is always dated,
    // the same way plotFrame's thinned SVG ticks are. Skipped buckets still
    // get an empty cell, or the grid stops lining up with the bars.
    if ((buckets.length - 1 - i) % stride) return `<span></span>`;
    const { period, year } = bucketParts(b.b);
    // Only when it changes: on an all-time axis the year is the same for
    // twelve labels running, and repeating it is what made the row unreadable.
    const yr = year === lastYear ? "" : `<span class="yr">${esc(year)}</span>`;
    lastYear = year;
    return `<span>${esc(period)}${yr}</span>`;
  }).join("");
  return `<div class="xaxis" style="margin-left:${left}%;width:${width}%;grid-template-columns:repeat(${buckets.length},1fr)">${cells}</div>`;
}

/** Grouped vertical bars. `series` = [{ key, label, color }]. */
function barChart(buckets, series, { height = 190, everyLabel = false } = {}) {
  if (!buckets.length) return `<div class="empty">No data in this range.</div>`;
  const max = Math.max(1, ...buckets.flatMap(b => series.map(s => b[s.key] ?? 0)));
  const f = plotFrame(buckets, max, { height, everyLabel });
  const slot = f.innerW / buckets.length;
  const bw = Math.max(1, (slot * 0.74) / series.length);

  const bars = buckets.map((b, i) => {
    const x0 = f.padL + slot * i + slot * 0.13;
    return series.map((s, j) => {
      const v = b[s.key] ?? 0;
      const h = Math.max(v > 0 ? 1 : 0, f.padT + f.innerH - f.y(v));
      return `<rect x="${x0 + bw * j}" y="${f.y(v)}" width="${bw}" height="${h}" fill="${s.color}" rx="1"/>`;
    }).join("");
  }).join("");

  const hover = buckets.map((b, i) => `
    <rect class="hoverzone" x="${f.padL + slot * i}" y="${f.padT}" width="${slot}" height="${f.innerH}" fill="transparent">
      <title>${esc(bucketLabel(b.b))}\n${series.map(s => `${s.label}: ${fmt(b[s.key] ?? 0)}`).join("\n")}</title>
    </rect>`).join("");

  return `<svg class="chart" viewBox="0 0 ${f.W} ${f.H}" preserveAspectRatio="none" height="${height}">
    ${f.gridSvg}${bars}${hover}${f.xLabels}</svg>` + (everyLabel ? xAxis(buckets) : "");
}

/** Multi-series line chart. Nulls break the line rather than dropping to zero. */
function lineChart(buckets, series, { height = 190, fmtV = fmt, everyLabel = false } = {}) {
  if (!buckets.length) return `<div class="empty">No data in this range.</div>`;
  const max = Math.max(1, ...buckets.flatMap(b => series.map(s => b[s.key] ?? 0)));
  const f = plotFrame(buckets, max, { height, everyLabel });
  const slot = f.innerW / buckets.length;
  const px = i => f.padL + slot * (i + 0.5);

  const paths = series.map(s => {
    let d = "", pen = false;
    buckets.forEach((b, i) => {
      const v = b[s.key];
      if (v == null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${px(i).toFixed(1)},${f.y(v).toFixed(1)}`;
      pen = true;
    });
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
  }).join("");

  const hover = buckets.map((b, i) => `
    <rect class="hoverzone" x="${f.padL + slot * i}" y="${f.padT}" width="${slot}" height="${f.innerH}" fill="transparent">
      <title>${esc(bucketLabel(b.b))}\n${series.map(s => `${s.label}: ${b[s.key] == null ? "—" : fmtV(b[s.key])}`).join("\n")}</title>
    </rect>`).join("");

  return `<svg class="chart" viewBox="0 0 ${f.W} ${f.H}" preserveAspectRatio="none" height="${height}">
    ${f.gridSvg}${paths}${hover}${f.xLabels}</svg>` + (everyLabel ? xAxis(buckets) : "");
}

function legend(series) {
  return `<div class="legend">${series.map(s =>
    `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join("")}</div>`;
}

/**
 * Horizontal ranked bars — better than a pie for "top N of many".
 *
 * Every one of these lists ranks by a single metric, so each row is numbered:
 * position in the list is information, and "who is seventh" shouldn't need
 * counting down from the top. `share` adds each row's percentage of the list's
 * total beside its count — on a per-repo breakdown of someone's PRs, "48 in
 * GT5-Unofficial" means something quite different at 12% than at 80%.
 */
function hbars(rows, { label, value, color = "var(--accent)", href = null, internal = false, fmtV = fmt, rank = true, share = false, icon = null } = {}) {
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
    const text = r.title ? esc(r.title) : id;
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

export { barChart, barGrid, grossingBoxes, grossingNote, hbars, kpi, legend, lineChart, trio };
