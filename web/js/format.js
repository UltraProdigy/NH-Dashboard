/* ==========================================================================
   Formatting helpers
   ========================================================================== */

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));

/**
 * A GitHub avatar, by login.
 *
 * Costs nothing to have: `github.com/<login>.png` is a public unauthenticated
 * redirect to the avatar CDN, so the browser fetches it directly and neither
 * the ingest nor `drilldown.json` has to carry a URL that would only go stale.
 * Requested at 2× the rendered box so it stays sharp on a retina display.
 *
 * Deleted and renamed accounts 404. The <img> takes itself out when that
 * happens and `data-ini` shows through, so a missing face degrades to an
 * initial rather than a broken-image glyph.
 */
function avatar(id, size = 16, cls = "") {
  const s = String(id ?? "");
  return `<span class="pfp${cls ? ` ${cls}` : ""}" style="--pfp:${size}px" data-ini="${esc((s[0] ?? "?").toUpperCase())}"><img src="https://github.com/${encodeURIComponent(s)}.png?size=${size * 2}" alt="" loading="lazy" decoding="async" onerror="this.remove()"></span>`;
}

/**
 * A contributor's name, linking to their drilldown rather than to GitHub.
 *
 * The drilldown carries more of what you're after when you click a name in
 * this dashboard, and it has a "View on GitHub" button of its own, so nothing
 * is lost. A real anchor rather than a button, so middle-click and
 * open-in-new-tab keep working; the view's click handler intercepts plain
 * clicks to reset sort/filter and leaves modified clicks to the browser.
 *
 * Declared up here with the other formatters because module-scope consts like
 * `byLogin` reference it at initialization time.
 */
const contribHref = (r) => `#contributor/${encodeURIComponent(r.login)}`;
const contribLink = (login, { pfp = true } = {}) =>
  `<a class="namelink" href="${contribHref({ login })}" data-drilllink>${
    pfp ? avatar(login, 16) : ""}<span>${esc(login)}</span></a>`;

/**
 * The same face-plus-name, without the link.
 *
 * Author and reporter columns come from the search-backed panels, which see
 * people the ingest store has never heard of — bots, and anyone whose only
 * activity is outside the window that was walked. Linking those lands you on a
 * drilldown that can only say it has nothing, so they get the avatar and stay
 * plain text. The class is shared with contribLink so the two line up wherever
 * both appear in one table.
 */
const contribName = (login, fallback = "—") =>
  login
    ? `<span class="namelink">${avatar(login, 16)}<span>${esc(login)}</span></span>`
    : fallback;

/**
 * Repo names arrive in two shapes: the search-backed panels carry the full
 * `GTNewHorizons/Angelica`, the release sweep and the ingest store carry a bare
 * `Angelica`. The drilldown is keyed bare, so every link has to strip the org
 * before routing — and the exclusion filter compares bare for the same reason.
 */
const bareRepo = (r) => String(r ?? "").split("/").pop();

/**
 * A repo name, linking to its drilldown rather than to GitHub — the same trade
 * contributor names make. The drilldown answers more of what you were asking
 * when you clicked the name here, and it carries a "View on GitHub" button of
 * its own, so the repo page is one more click rather than gone.
 *
 * The single exception is Dream Panel's "Needs a release": that card exists to
 * send you somewhere to press a button, and the button is on github.com. Those
 * rows keep their direct links, which is why this isn't wired into
 * COLUMNS.release.
 */
const repoHref = (repo) => `#repo/${encodeURIComponent(bareRepo(repo))}`;
const repoLink = (repo, cls = "repo") =>
  `<a class="${cls}" href="${repoHref(repo)}" data-drilllink>${esc(repo)}</a>`;

const fmt = n => (n == null ? "—" : Number(n).toLocaleString());
const pctFmt = x => (x == null ? "—" : `${Math.round(x * 100)}%`);

/** Big line counts are noise at full precision — 41,207 reads as "41k". */
const kfmt = n =>
  n == null ? "—"
    : Math.abs(n) < 10_000 ? Number(n).toLocaleString()
    : Math.abs(n) < 1_000_000 ? `${Math.round(n / 1000).toLocaleString()}k`
    : `${(n / 1_000_000).toFixed(1)}M`;

/** A PR's diff, as +added / −removed. Null when the ingest hasn't backfilled. */
const diff = (add, del) =>
  add == null && del == null
    ? `<span class="diff">—</span>`
    : `<span class="diff"><span class="add">+${kfmt(add ?? 0)}</span><span class="del">−${kfmt(del ?? 0)}</span></span>`;

const linesOf = (r) => (r.additions == null ? null : r.additions + (r.deletions ?? 0));

/** Hours read badly past a day or two, so switch units rather than print 412h. */
function dur(hours) {
  if (hours == null) return "—";
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)}h`;
  const d = hours / 24;
  return d < 60 ? `${d < 10 ? d.toFixed(1) : Math.round(d)}d` : `${Math.round(d / 30)}mo`;
}

/** Bare text — for places that do their own styling, like the search popup. */
function agoText(days) {
  if (days == null) return "—";
  return days === 0 ? "today" : days === 1 ? "1 day ago" : days < 60 ? `${days} days ago`
    : days < 730 ? `${Math.floor(days / 30)} mo ago` : `${Math.floor(days / 365)} yr ago`;
}

function age(days) {
  if (days == null) return "—";
  const cls = days > 180 ? "age-ancient" : days > 60 ? "age-old" : "";
  return `<span class="${cls} num">${agoText(days)}</span>`;
}

const daysSince = iso => (iso ? Math.floor((Date.now() - new Date(iso)) / 86400000) : null);

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

/**
 * Bucket keys are 2026-08 / 2026-W32 / 2026-08-10; none reads well on an axis
 * as-is. Split into the period and its year so an axis can stack them on two
 * lines and a tooltip can join them back into one.
 */
function bucketParts(b) {
  if (b.includes("W")) {
    const [y, w] = b.split("-W");
    return { period: `w${Number(w)}`, year: y };
  }
  const [y, m, d] = b.split("-");
  return {
    period: d ? `${MONTHS[Number(m) - 1]} ${Number(d)}` : MONTHS[Number(m) - 1],
    year: y,
  };
}

function bucketLabel(b) {
  const { period, year } = bucketParts(b);
  return `${period} '${year.slice(2)}`;
}

export {
  MONTHS,
  age,
  agoText,
  avatar,
  bareRepo,
  bucketLabel,
  bucketParts,
  contribHref,
  contribLink,
  contribName,
  daysSince,
  diff,
  dur,
  esc,
  fmt,
  kfmt,
  linesOf,
  pctFmt,
  repoHref,
  repoLink,
};
