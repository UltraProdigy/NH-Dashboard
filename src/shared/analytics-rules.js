/**
 * The definitions the analytics panel is built out of, in both languages.
 *
 * Same reasoning as `contributor-rules.js`: the panel now exists twice, once
 * walking the ingest store in JavaScript and once as SQL inside a Worker, and
 * anything both copies decide for themselves is free to drift. A percentile
 * picked one row apart, or a week that starts on a different day at a year
 * boundary, produces two plausible dashboards that disagree — and nothing in
 * either says which is wrong.
 *
 * So each rule appears here once, and where SQLite cannot borrow the JavaScript
 * the SQL fragment is generated from the same constants. The parity test then
 * runs both over the real seed and asserts they agree, which is the only thing
 * that makes "generated from the same constants" mean anything.
 *
 * Dependency-free, because a Worker bundles it.
 */

const DAY = 86_400_000;

/**
 * How stale an open PR has to be before it lands in each backlog bucket.
 *
 * Shared with the per-repo drilldown, which buckets identically — two copies of
 * this list would drift and then the org total would stop equalling the sum of
 * the repos.
 */
export const BACKLOG_BUCKETS = [
  { label: "< 1 week", max: 7 },
  { label: "1–4 weeks", max: 30 },
  { label: "1–3 months", max: 90 },
  { label: "3–12 months", max: 365 },
  { label: "> 1 year", max: Infinity },
];

/**
 * How far back the daily series reaches.
 *
 * The org's history starts in 2014, so an all-time daily series would be ~4,300
 * buckets — roughly 800 KB in a file that's committed on every build, for a
 * chart nobody can read at that width. Two years is 730 buckets (~135 KB) and
 * covers every case where a day-by-day view answers something a weekly one
 * doesn't. The frontend reads `series.dayFrom` and says so when the selected
 * period reaches further back than the data does, rather than quietly plotting
 * a shorter span than the control claims.
 */
export const DAY_SERIES_DAYS = 730;

/** Ten rather than the drilldown's five — see `grossing.js`. */
export const GROSSING_ORG_N = 10;

/**
 * The org the dashboard describes, used to build pull-request links.
 *
 * `config.js` still owns the override from the environment; this is only the
 * fallback, kept here because a Worker cannot import `config.js` — that module
 * resolves tokens and shells out to git.
 */
export const DEFAULT_ORG = "GTNewHorizons";

/** Weekday × hour of PR creation covers this much history. */
export const HEATMAP_DAYS = 365;

// ------------------------------------------------------------------ statistics

/**
 * Linear-interpolation-free percentile. Good enough for a dashboard.
 *
 * The index is what the SQL side has to reproduce, so it is worth stating
 * plainly: zero-based `floor(p/100 * len)`, clamped to the last element. A
 * `ROW_NUMBER()` is one-based, so the matching rank is that index plus one.
 */
export function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

export const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

/**
 * The one-based rank `pct` would pick, given a column holding the row count.
 *
 * `CAST(x AS INTEGER)` truncates toward zero, which is `floor` for the
 * non-negative values this ever sees, and the fraction is emitted as the same
 * IEEE-754 double JavaScript computes, so the two rounds agree bit for bit.
 */
export const pctRankSql = (countCol, p) =>
  `(1 + MIN(${countCol} - 1, CAST(${countCol} * ${p / 100} AS INTEGER)))`;

// ----------------------------------------------------------------- bucket keys

/** ISO-ish week key: 2026-W32. Weeks start Monday, matching GitHub's charts. */
export function weekKey(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (t.getUTCDay() + 6) % 7; // Mon = 0
  t.setUTCDate(t.getUTCDate() - dow + 3); // nearest Thursday defines the year
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round((t - firstThu) / (7 * DAY));
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export const monthKey = (d) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

/** 2026-08-10. Sorts lexically, same as the week and month keys. */
export const dayKey = (d) => d.toISOString().slice(0, 10);

/**
 * The Thursday whose year owns the ISO week — the whole basis of `weekKey`.
 *
 * `strftime('%Y-%W')` looks like the same thing and is not: it counts weeks from
 * the first Sunday of the calendar year, so the last days of December and the
 * first of January land in the wrong year's week roughly one year in two.
 */
const thursdaySql = (col) =>
  `date(${col}, '-' || ((CAST(strftime('%w', ${col}) AS INTEGER) + 6) % 7) || ' days', '+3 days')`;

/**
 * `weekKey` as SQL. Verbose because the Thursday has to be recomputed at each
 * mention — SQLite has no `let` — but it is the same three steps: find the
 * Thursday, take its year, count weeks from that year's 4 January.
 *
 * Jan 4 is always in ISO week 1, and the gap from it to any Thursday in the same
 * year is a whole number of days, so the division can never land on a half and
 * the two languages' rounding rules never have to agree about one.
 */
export function weekKeySql(col) {
  const thu = thursdaySql(col);
  const year = `strftime('%Y', ${thu})`;
  const week = `(1 + CAST(ROUND((julianday(${thu}) - julianday(${year} || '-01-04')) / 7.0) AS INTEGER))`;
  return `(${year} || '-W' || printf('%02d', ${week}))`;
}

export const monthKeySql = (col) => `substr(${col}, 1, 7)`;
export const dayKeySql = (col) => `substr(${col}, 1, 10)`;

// -------------------------------------------------------------------- duration

/**
 * Elapsed hours between two timestamp columns.
 *
 * Whole seconds rather than `julianday` differences, which are REAL days and
 * carry a rounding error large enough to reorder two nearly-equal rows — and
 * the order is what a percentile reads. Every timestamp the panels touch comes
 * from GitHub at second resolution, so this is exact rather than merely close;
 * the parity test asserts that no column carries a fraction.
 */
export const hoursSql = (from, to) =>
  `((CAST(strftime('%s', ${to}) AS INTEGER) - CAST(strftime('%s', ${from}) AS INTEGER)) / 3600.0)`;

/**
 * A millisecond period bound as the ISO string the SQL compares against.
 *
 * Every timestamp these panels store is a fixed-width `YYYY-MM-DDTHH:MM:SSZ`
 * from GitHub, so lexical order over that column *is* chronological order and a
 * window can be a plain string comparison. That matters because the alternative
 * parses a date per row per comparison: thirteen periods over 29,000 rows
 * measured 43ms against 7ms for the string compare, in a panel that does this
 * in a dozen queries.
 *
 * The bound has to be ceiled to a whole second first, and both ends ceil the
 * same way. Stored times are whole seconds, so for an integer `t` seconds:
 *
 *   t × 1000 >= bound   ⟺   t >= ceil(bound / 1000)
 *   t × 1000 <  bound   ⟺   t <  ceil(bound / 1000)
 *
 * The second one is the surprise — it holds whether or not the bound falls
 * exactly on a second — and it is why `>=` and `<` can share one value. Ceiling
 * is not a rounding convenience: comparing raw ISO strings against a bound
 * carrying milliseconds gets the boundary second backwards, because `Z` sorts
 * after `.` and so `…:19Z` reads as later than `…:19.825Z`.
 */
export const isoBound = (ms) =>
  new Date(Math.ceil(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");

// --------------------------------------------------------------------- sorting

/**
 * Count descending, key ascending.
 *
 * The tiebreak is the same fix the leaderboard needed. A top-8 sorted on count
 * alone leaves ties in whatever order the store yielded, so a list reshuffles
 * between builds because somebody unrelated opened a pull request — and once
 * the panel exists in two languages, "whatever order the store yielded" is not
 * a thing the other one can reproduce at all.
 *
 * Compared with `<` rather than `localeCompare` so two runtimes in two locales
 * cannot disagree about the answer.
 */
export function byCountThenKey(keyOf, countOf) {
  return (a, b) => {
    const diff = countOf(b) - countOf(a);
    if (diff !== 0) return diff;
    const ka = keyOf(a);
    const kb = keyOf(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  };
}
