import { GRANS, isDrill, state } from "./state.js";
import { esc } from "./format.js";

/* ==========================================================================
   Data accessors
   ========================================================================== */

const panel = id => state.data?.panels?.[id];
const A = () => panel("analytics")?.ok ? panel("analytics").data : null;
const W = () => A()?.byWindow?.[state.window] ?? null;

/**
 * The issue store's equivalents of A() and W().
 *
 * Two stores, two panels, two accessors — the issue page needs the same
 * window-scoped rollups and the same bucketed series the PR page does, and the
 * helpers below take whichever one they're handed rather than each page
 * growing its own copy of the slicing logic.
 */
const I = () => panel("issues")?.ok ? panel("issues").data : null;
const IW = () => I()?.byWindow?.[state.window] ?? null;

/**
 * The by-contributor issue table for the selected period.
 *
 * Shipped as positional rows against `personFields` — thirty metric names per
 * person per window would have been most of a megabyte of key names in a file
 * every page loads. Expanded on first use and memoized per window onto the
 * panel data, which is the same deal the drilldown's packed rows get.
 */
function issuePeople() {
  const d = I();
  if (!d?.people) return [];
  const cache = (d._people ??= {});
  if (cache[state.window]) return cache[state.window];
  const fields = d.personFields ?? [];
  return (cache[state.window] = (d.people[state.window] ?? []).map((row) => {
    const out = { login: row[0] };
    fields.forEach((f, i) => { out[f] = row[i + 1]; });
    return out;
  }));
}

/* ---- Label mix ----------------------------------------------------------
   The card used to show one repo's labels, chosen from a dropdown and seeded
   with whatever `ISSUE_LABEL_REPO` said. That made the modpack's 235 labels the
   whole of what the page knew about labelling, and the twenty-one other
   trackers invisible unless you already suspected they were there. It opens on
   all of them now, and the chips narrow it. */

/** Every repo the issues panel has label counts for, busiest first. */
const labelRepoList = () => {
  const d = I();
  if (!d?.labelsByRepo) return [];
  return Object.keys(d.labelsByRepo).sort(
    (a, b) => d.labelsByRepo[b].length - d.labelsByRepo[a].length || a.localeCompare(b)
  );
};

/** The repos currently in view. An empty selection is all of them. */
const labelReposInView = () => {
  const all = labelRepoList();
  const picked = state.issueLabelRepos.filter((r) => all.includes(r));
  return picked.length ? picked : all;
};

/**
 * One row per label, summed over the repos in view.
 *
 * Counts add: an org-wide "Bug: Minor" open count is every repo's added up, and
 * the sum is a real number. The medians don't, and there is no arithmetic that
 * makes them — a median of medians is not a median of anything. So they survive
 * only when there's exactly one repo in view, and the table drops those two
 * columns otherwise rather than printing a plausible fiction. `repos` takes
 * their place, since "this label is used in nine trackers" is the fact the
 * combined view can honestly offer.
 */
function labelRows() {
  const d = I();
  if (!d?.labelsByRepo) return [];
  const repos = labelReposInView();
  if (repos.length === 1)
    return (d.labelsByRepo[repos[0]] ?? []).map((l) => ({ ...l, repos: 1 }));

  const by = new Map();
  for (const repo of repos) {
    for (const l of d.labelsByRepo[repo] ?? []) {
      const cur = by.get(l.name);
      if (!cur) {
        by.set(l.name, {
          ...l, repos: 1,
          medianFirstResponseHours: null, medianCloseHours: null,
        });
        continue;
      }
      cur.repos++;
      cur.open += l.open;
      cur.closed += l.closed;
      cur.total += l.total;
      cur.unanswered += l.unanswered;
    }
  }
  return [...by.values()].sort((a, b) => b.open - a.open || b.total - a.total);
}

/**
 * Modules that keep a period of their own, independent of their page's.
 *
 * New Faces is the only one. "Who's new" and "who's busiest" want different
 * spans by nature — six months of first-timers is a long list of people who
 * stopped being new some time ago — and the alternative, rewriting the page's
 * period whenever you open that tab, silently changes what Leaderboard was
 * showing behind your back.
 *
 * It carries its own period control in its card header — see cardWindow — so
 * the toolbar's never claims to govern it. Its caption still names the period
 * it's on, because on the grid it is showing a different span from the three
 * cards beside it.
 */
const OWN_WINDOW = { newcomers: "newFacesWindow" };

/**
 * Which slot of state holds the period for a given module: its own if it has
 * one, otherwise the page's — and the drilldowns keep theirs separate from the
 * org pages, so looking at a person doesn't reset what Analytics was showing.
 */
const windowKey = (mod = state.tab) =>
  OWN_WINDOW[mod] ?? (isDrill(state.page) ? "drillWindow" : "window");

const activeWindow = (mod) => state[windowKey(mod)];

/**
 * The window list for whichever page is showing.
 *
 * Order matters: a drilldown must read its own file's list, because
 * dashboard.json and drilldown.json are built separately and can disagree
 * about which windows exist. When they do — say a rebuild adds 2y and 5y —
 * offering the analytics list on a drilldown would hide options the drilldown
 * data actually has, and offering the drilldown list on Analytics would offer
 * ones it doesn't.
 */
const windowList = () =>
  (isDrill(state.page) ? state.drill?.windows : null)
  ?? A()?.windows ?? state.drill?.windows
  ?? I()?.windows ?? panel("contributors")?.data?.windows ?? [];

const windowLabel = (mod) => {
  const id = activeWindow(mod);
  return windowList().find(w => w.id === id)?.label ?? id;
};

/** "last 3 months" or "all time" — "last all time" reads like a typo. */
const windowPhrase = (mod) => {
  const l = windowLabel(mod).toLowerCase();
  return l === "all time" ? "all time" : `last ${l}`;
};

/** How many days the selected period covers; null for all time. */
const windowDays = (mod) =>
  windowList().find(w => w.id === activeWindow(mod))?.days ?? null;

/**
 * Time series for the selected granularity, trimmed to the selected period.
 *
 * One control drives both now, so this reads the same window the KPI tiles do
 * rather than a second lookback of its own.
 */
function seriesSlice(src = A()) {
  const a = src;
  if (!a) return [];
  const all = a.series[state.gran] ?? [];
  const days = windowDays();
  if (days == null) return all;
  const per = GRANS.find(g => g.id === state.gran)?.bucketDays ?? 30.4;
  return all.slice(-Math.ceil(days / per));
}

/**
 * Set when the period reaches further back than the daily buckets go.
 *
 * The build only emits two years of days (see DAY_SERIES_DAYS) — an all-time
 * daily series is 4,300 buckets of unreadable chart in a file that's committed
 * on every build. Saying so is better than silently drawing a two-year chart
 * under a control that says "5 years".
 */
function dayLimitNote(src = A()) {
  if (state.gran !== "day") return "";
  const from = src?.series?.dayFrom;
  if (!from) return "";
  const days = windowDays();
  if (days != null && Date.now() - days * 86400000 >= new Date(from).getTime())
    return "";
  return `<div class="hint" style="margin-top:10px">Daily buckets only go back to ${esc(from)} — the chart is showing everything there is, which is less than the selected period. Switch to weekly for the full span.</div>`;
}

/**
 * Delta against the equal-length period immediately before the selected
 * window — a 3-month view compares to the 3 months before it, not to last
 * month. The comparison period is precomputed in the analytics panel.
 *
 *   invert: lower is better (latency, unapproved merges)
 *   pp:     the metric is already a share, so report points, not % of a %
 */
function delta(key, { invert = false, pp = false, fallback = "", w = W() } = {}) {
  const prev = w?.prev?.[key];
  const cur = w?.[key];
  if (cur == null || prev == null || (!pp && !prev)) return fallback;

  const diff = pp ? cur - prev : (cur - prev) / prev;
  const flat = Math.abs(diff) < (pp ? 0.005 : 0.02);
  const good = invert ? diff < 0 : diff > 0;
  const cls = flat ? "flat" : good ? "up" : "down";
  const arrow = flat ? "•" : diff > 0 ? "▲" : "▼";
  const n = Math.abs(Math.round(diff * 100));
  const size = pp ? `${n} pt${n === 1 ? "" : "s"}` : `${n}%`;

  return `<span class="${cls}">${arrow} ${size}</span> vs. ${esc(w.prevLabel ?? "previous period")}`;
}

export {
  A,
  I,
  IW,
  W,
  activeWindow,
  dayLimitNote,
  delta,
  issuePeople,
  labelRepoList,
  labelReposInView,
  labelRows,
  panel,
  seriesSlice,
  windowDays,
  windowKey,
  windowLabel,
  windowList,
  windowPhrase,
};
