/**
 * Issue analytics, aggregated from the ingested issue store.
 *
 * Pure local computation, like the PR analytics panel — no API calls. The
 * store already holds every issue in the org with its labels and its first
 * response, so every window costs the same and "all time" is free.
 *
 * The panel answers four questions, in the order an admin actually asks them:
 * what needs triaging right now, is the backlog growing, which labels are
 * carrying it, and who is doing the answering.
 */

import { readStore } from "../ingest/issues.js";
import { BOT_PATTERN, ISSUE_LABEL_REPO, ISSUE_STALE_DAYS, ORG } from "../config.js";
import { WINDOWS } from "./contributors.js";
import { BACKLOG_BUCKETS, DAY_SERIES_DAYS } from "./analytics.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;

const isBot = (login) => !login || BOT_PATTERN.test(login);

/**
 * Close reasons that mean "this was never fixed".
 *
 * GitHub has grown the list over time — DUPLICATE arrived after NOT_PLANNED —
 * and anything not in here counts as completed, so a reason added later fails
 * towards the flattering side. Worth re-checking against the live data
 * occasionally rather than trusting this to stay exhaustive.
 */
const UNRESOLVED = new Set(["NOT_PLANNED", "DUPLICATE"]);

/**
 * Labels on the modpack follow a "Prefix: Value" convention — `Mod: GT`,
 * `Status: Stale`, `Type: Recipe` — and the prefixes are different questions,
 * not one long list. `Status:` is a triage pipeline, `Mod:` is 174 components
 * with a long tail, `Type:` is a taxonomy. Flattening them into one ranked
 * chart buries the nine labels that describe where work is stuck under a
 * hundred that describe what it's about.
 */
const LABEL_PREFIX = /^([A-Za-z0-9][A-Za-z0-9 ]*):\s*(.+)$/;

function splitLabel(name) {
  const m = LABEL_PREFIX.exec(name);
  return m ? { group: m[1], short: m[2] } : { group: "Other", short: name };
}

/**
 * Groups in the order they answer an admin's questions: where is it stuck,
 * how bad is it, what kind of thing is it, which component, everything else.
 * Anything unlisted sorts after these, alphabetically.
 */
const GROUP_ORDER = ["Status", "Bug", "Type", "Platform", "Mod", "Other"];
const groupRank = (g) => {
  const i = GROUP_ORDER.indexOf(g);
  return i === -1 ? GROUP_ORDER.length : i;
};

/**
 * Only labels with at least this many issues get a monthly series. The long
 * tail of `Mod:` labels carrying three issues each would triple the payload to
 * draw a chart that is two dots and a gap.
 */
const SERIES_MIN = 20;

/** How far back per-label monthly series reach. */
const SERIES_MONTHS = 60;

function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const median = (arr) => round1(pct(arr.sort((a, b) => a - b), 50));

function weekKey(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - dow + 3);
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round((t - firstThu) / (7 * DAY));
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

const monthKey = (d) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

const dayKey = (d) => d.toISOString().slice(0, 10);

function blankBucket(key, start) {
  return {
    b: key,
    t: start,
    opened: 0,
    closed: 0,
    unresolved: 0,
    _reporters: new Set(),
    newReporters: 0,
    _closeHours: [],
    _responseHours: [],
  };
}

function finishBucket(b) {
  const close = b._closeHours.sort((x, y) => x - y);
  const resp = b._responseHours.sort((x, y) => x - y);
  return {
    b: b.b,
    t: b.t,
    opened: b.opened,
    closed: b.closed,
    unresolved: b.unresolved,
    // What the backlog actually did that period. The only number on the chart
    // that can go negative, and the one that answers "are we keeping up".
    net: b.opened - b.closed,
    reporters: b._reporters.size,
    newReporters: b.newReporters,
    closeMedianH: round1(pct(close, 50)),
    closeP90H: round1(pct(close, 90)),
    responseMedianH: round1(pct(resp, 50)),
    closeN: close.length,
    responseN: resp.length,
  };
}

/**
 * An issue nobody outside the reporter ever replied to.
 *
 * `responseUnknown` records exhausted the ingest's comment sample without
 * finding a human reply, which is a different thing from silence — those are
 * excluded from both sides rather than counted as unanswered.
 */
const isUnanswered = (i) => !i.firstResponseAt && !i.responseUnknown;

export async function issues() {
  const all = await readStore();

  if (!all.length) {
    throw new Error(
      "No ingested issue data. Run `npm run ingest` first — the all-time " +
        "backfill takes a while, but later runs are incremental."
    );
  }

  const now = Date.now();

  const weeks = new Map();
  const months = new Map();
  const days = new Map();
  const dayCutoff = now - DAY_SERIES_DAYS * DAY;
  const firstSeen = new Map(); // login -> earliest createdAt
  const repoStats = new Map();
  const labelStats = new Map();

  for (const i of all) {
    if (isBot(i.author) || !i.createdAt) continue;
    const prev = firstSeen.get(i.author);
    if (!prev || i.createdAt < prev) firstSeen.set(i.author, i.createdAt);
  }

  const totals = {
    issues: 0,
    open: 0,
    closed: 0,
    completed: 0,
    notPlanned: 0,
    duplicate: 0,
    unknownReason: 0,
    responseUnknown: 0,
  };
  const openIssues = [];
  const discussed = [];

  const periods = [];
  for (const w of WINDOWS) {
    periods.push({
      key: w.id,
      from: w.days == null ? -Infinity : now - w.days * DAY,
      to: Infinity,
    });
    if (w.days != null) {
      periods.push({
        key: `prev:${w.id}`,
        from: now - 2 * w.days * DAY,
        to: now - w.days * DAY,
      });
    }
  }

  const blankPeriod = () => ({
    opened: 0,
    closed: 0,
    completed: 0,
    notPlanned: 0,
    duplicate: 0,
    labeled: 0,
    answered: 0,
    unanswered: 0,
    comments: 0,
    reporters: new Map(),
    responders: new Map(),
    repos: new Map(),
    labels: new Map(),
    newReporters: 0,
    closeHours: [],
    responseHours: [],
  });

  const win = Object.fromEntries(periods.map((p) => [p.key, blankPeriod()]));

  const inPeriod = (p, ts) => {
    if (!ts) return false;
    const t = new Date(ts).getTime();
    return t >= p.from && t < p.to;
  };

  const bucketFor = (map, key, start) => {
    if (!map.has(key)) map.set(key, blankBucket(key, start));
    return map.get(key);
  };

  const repoFor = (name) => {
    if (!repoStats.has(name)) {
      repoStats.set(name, {
        repo: name,
        total: 0,
        open: 0,
        closed: 0,
        unanswered: 0,
        unlabeled: 0,
        last: null,
        _closeHours: [],
        _responseHours: [],
      });
    }
    return repoStats.get(name);
  };

  // Keyed by repo *and* name: "which labels are busy" is a question about one
  // tracker, and the org-wide sum of a per-repo taxonomy means nothing.
  const labelFor = (repo, name) => {
    const key = `${repo}\u0000${name}`;
    if (!labelStats.has(key)) {
      const { group, short } = splitLabel(name);
      labelStats.set(key, {
        repo,
        name,
        group,
        short,
        total: 0,
        open: 0,
        closed: 0,
        unanswered: 0,
        _closeHours: [],
        _responseHours: [],
      });
    }
    return labelStats.get(key);
  };

  /** Monthly opened/closed per label, focus repo only — see SERIES_MIN. */
  const labelSeries = new Map();
  const seriesCutoff = new Date(now - SERIES_MONTHS * 30.4 * DAY)
    .toISOString()
    .slice(0, 7);

  const bumpSeries = (name, month, i) => {
    if (month < seriesCutoff) return;
    let byMonth = labelSeries.get(name);
    if (!byMonth) labelSeries.set(name, (byMonth = new Map()));
    const cell = byMonth.get(month) ?? [0, 0];
    cell[i]++;
    byMonth.set(month, cell);
  };

  for (const i of all) {
    if (!i.createdAt) continue;
    const bot = isBot(i.author);
    const open = i.state === "OPEN";
    const created = new Date(i.createdAt);
    const labels = i.labels ?? [];

    totals.issues++;
    if (open) totals.open++;
    else {
      totals.closed++;
      // A close reason has been recorded on every closed issue GitHub has
      // handed back so far, including ones closed years before the feature
      // existed — it appears to have backfilled COMPLETED onto them. The null
      // branch stays anyway, counting as completed, and `unknownReason` says
      // how many landed there so the assumption is visible if it ever fires.
      if (i.stateReason === "NOT_PLANNED") totals.notPlanned++;
      else if (i.stateReason === "DUPLICATE") totals.duplicate++;
      else {
        totals.completed++;
        if (i.stateReason !== "COMPLETED") totals.unknownReason++;
      }
    }
    if (i.responseUnknown) totals.responseUnknown++;

    const closeHours = i.closedAt ? (new Date(i.closedAt) - created) / HOUR : null;
    const responseHours = i.firstResponseAt
      ? (new Date(i.firstResponseAt) - created) / HOUR
      : null;

    const isFirstEver = !bot && firstSeen.get(i.author) === i.createdAt;

    const r = repoFor(i.repo);
    r.total++;
    if (open) r.open++;
    else r.closed++;
    if (open && isUnanswered(i)) r.unanswered++;
    if (open && !labels.length) r.unlabeled++;
    if (!r.last || i.updatedAt > r.last) r.last = i.updatedAt;
    if (closeHours != null) r._closeHours.push(closeHours);
    if (responseHours != null) r._responseHours.push(responseHours);

    const focus = i.repo === ISSUE_LABEL_REPO;
    const openedMonth = monthKey(created);
    const closedMonth = i.closedAt ? monthKey(new Date(i.closedAt)) : null;

    for (const name of labels) {
      const l = labelFor(i.repo, name);
      l.total++;
      if (open) {
        l.open++;
        if (isUnanswered(i)) l.unanswered++;
      } else l.closed++;
      if (closeHours != null) l._closeHours.push(closeHours);
      if (responseHours != null) l._responseHours.push(responseHours);

      if (focus) {
        bumpSeries(name, openedMonth, 0);
        if (closedMonth) bumpSeries(name, closedMonth, 1);
      }
    }

    // ---- time series ----
    const openedIn = [
      [weeks, weekKey(created)],
      [months, monthKey(created)],
    ];
    if (created.getTime() >= dayCutoff) openedIn.push([days, dayKey(created)]);

    for (const [map, key] of openedIn) {
      const b = bucketFor(map, key, i.createdAt);
      if (i.createdAt < b.t) b.t = i.createdAt;
      b.opened++;
      if (!bot) b._reporters.add(i.author);
      if (isFirstEver) b.newReporters++;
      if (closeHours != null) b._closeHours.push(closeHours);
      if (responseHours != null) b._responseHours.push(responseHours);
    }

    if (i.closedAt) {
      const closed = new Date(i.closedAt);
      const closedIn = [
        [weeks, weekKey(closed)],
        [months, monthKey(closed)],
      ];
      if (closed.getTime() >= dayCutoff) closedIn.push([days, dayKey(closed)]);

      for (const [map, key] of closedIn) {
        const b = bucketFor(map, key, i.closedAt);
        if (i.closedAt < b.t) b.t = i.closedAt;
        b.closed++;
        if (UNRESOLVED.has(i.stateReason)) b.unresolved++;
      }
    }

    // ---- open backlog ----
    if (open) {
      openIssues.push({
        repo: i.repo,
        number: i.number,
        title: i.title ?? "",
        author: i.author,
        url: `https://github.com/${ORG}/${i.repo}/issues/${i.number}`,
        labels,
        assigned: (i.assignees ?? []).length > 0,
        comments: i.comments ?? 0,
        ageDays: Math.floor((now - created) / DAY),
        staleDays: i.updatedAt
          ? Math.floor((now - new Date(i.updatedAt)) / DAY)
          : null,
        answered: !isUnanswered(i),
        responseDays: responseHours == null ? null : Math.round(responseHours / 24),
      });
    }

    if ((i.comments ?? 0) > 0) {
      discussed.push({
        repo: i.repo,
        number: i.number,
        title: i.title ?? "",
        author: bot ? null : i.author,
        comments: i.comments,
        open,
        ageDays: Math.floor((now - created) / DAY),
      });
    }

    // ---- per-period rollups ----
    for (const p of periods) {
      const acc = win[p.key];

      if (inPeriod(p, i.createdAt)) {
        acc.opened++;
        acc.comments += i.comments ?? 0;
        if (labels.length) acc.labeled++;
        if (isUnanswered(i)) acc.unanswered++;
        else if (i.firstResponseAt) acc.answered++;
        if (!bot) {
          acc.reporters.set(i.author, (acc.reporters.get(i.author) ?? 0) + 1);
          if (isFirstEver) acc.newReporters++;
        }
        const rr = acc.repos.get(i.repo) ?? { repo: i.repo, opened: 0, closed: 0 };
        rr.opened++;
        if (i.closedAt) rr.closed++;
        acc.repos.set(i.repo, rr);
        for (const name of labels) {
          const ll = acc.labels.get(name) ?? { name, opened: 0 };
          ll.opened++;
          acc.labels.set(name, ll);
        }
        if (responseHours != null) acc.responseHours.push(responseHours);
      }

      // Closes are counted against the period they happened in, not the one
      // the issue was opened in — otherwise clearing a five-year-old backlog
      // shows up as nothing at all.
      if (inPeriod(p, i.closedAt)) {
        acc.closed++;
        if (i.stateReason === "NOT_PLANNED") acc.notPlanned++;
        else if (i.stateReason === "DUPLICATE") acc.duplicate++;
        else acc.completed++;
        if (closeHours != null) acc.closeHours.push(closeHours);
      }

      // First responders are credited when they replied, for the same reason.
      if (i.firstResponder && !isBot(i.firstResponder) && inPeriod(p, i.firstResponseAt)) {
        acc.responders.set(
          i.firstResponder,
          (acc.responders.get(i.firstResponder) ?? 0) + 1
        );
      }
    }
  }

  const topN = (map, key, n = 8) =>
    [...map.entries()]
      .map(([k, v]) => (typeof v === "number" ? { [key]: k, count: v } : v))
      .sort((a, b) => (b.count ?? b.opened) - (a.count ?? a.opened))
      .slice(0, n);

  function summarize(a) {
    const close = a.closeHours.sort((x, y) => x - y);
    const resp = a.responseHours.sort((x, y) => x - y);
    const decided = a.answered + a.unanswered;

    return {
      opened: a.opened,
      closed: a.closed,
      completed: a.completed,
      notPlanned: a.notPlanned,
      duplicate: a.duplicate,
      // Not planned and duplicate together — the closes that resolved nothing.
      unresolved: a.notPlanned + a.duplicate,
      // Positive means the backlog grew. Deliberately opened-minus-closed
      // rather than a ratio: "12 more than we closed" is a number you can act
      // on, "1.04" is not.
      net: a.opened - a.closed,
      // Of everything closed in this period, what fraction was actually
      // resolved rather than declined or abandoned.
      completedShare: a.closed ? a.completed / a.closed : null,
      medianCloseHours: round1(pct(close, 50)),
      p90CloseHours: round1(pct(close, 90)),
      medianFirstResponseHours: round1(pct(resp, 50)),
      p90FirstResponseHours: round1(pct(resp, 90)),
      // Both shares are over issues *opened* in the period, so they describe
      // the same set the counts above do.
      labeledShare: a.opened ? a.labeled / a.opened : null,
      unlabeled: a.opened - a.labeled,
      answeredShare: decided ? a.answered / decided : null,
      neverAnswered: a.unanswered,
      reporters: a.reporters.size,
      newReporters: a.newReporters,
      responders: a.responders.size,
      responses: [...a.responders.values()].reduce((n, v) => n + v, 0),
      activeRepos: a.repos.size,
      comments: a.comments,
      closedN: close.length,
      respondedN: resp.length,
    };
  }

  const byWindow = Object.fromEntries(
    WINDOWS.map((w) => {
      const a = win[w.id];
      return [
        w.id,
        {
          ...summarize(a),
          topRepos: topN(a.repos, "repo"),
          topReporters: topN(a.reporters, "login"),
          topResponders: topN(a.responders, "login"),
          topLabels: topN(a.labels, "name", 12),
          prev: w.days == null ? null : summarize(win[`prev:${w.id}`]),
          prevLabel: w.days == null ? null : `previous ${w.label.toLowerCase()}`,
        },
      ];
    })
  );

  /** Bucket a list of open issues by one of its day counts. */
  const bucketize = (list, field) => {
    const counts = BACKLOG_BUCKETS.map((b) => ({ label: b.label, count: 0 }));
    for (const it of list) {
      const v = it[field];
      if (v == null) continue;
      const i = BACKLOG_BUCKETS.findIndex((b) => v < b.max);
      counts[i === -1 ? BACKLOG_BUCKETS.length - 1 : i].count++;
    }
    return counts;
  };

  const unanswered = openIssues.filter((i) => !i.answered);

  const triage = {
    open: openIssues.length,
    unlabeled: openIssues.filter((i) => !i.labels.length).length,
    unanswered: unanswered.length,
    unassigned: openIssues.filter((i) => !i.assigned).length,
    stale: openIssues.filter((i) => (i.staleDays ?? 0) >= ISSUE_STALE_DAYS).length,
    staleDays: ISSUE_STALE_DAYS,
    ageBuckets: bucketize(openIssues, "ageDays"),
    staleBuckets: bucketize(openIssues, "staleDays"),
    oldest: [...openIssues].sort((a, b) => b.ageDays - a.ageDays).slice(0, 40),
    quietest: [...openIssues]
      .sort((a, b) => (b.staleDays ?? 0) - (a.staleDays ?? 0))
      .slice(0, 40),
    // The list that most deserves somebody's afternoon: open, old, and nobody
    // has said a word to the person who filed it.
    ignored: unanswered.sort((a, b) => b.ageDays - a.ageDays).slice(0, 40),
  };

  const labelRows = [...labelStats.values()]
    .map((l) => ({
      repo: l.repo,
      name: l.name,
      group: l.group,
      short: l.short,
      total: l.total,
      open: l.open,
      closed: l.closed,
      unanswered: l.unanswered,
      medianCloseHours: median(l._closeHours),
      medianFirstResponseHours: median(l._responseHours),
    }))
    .sort(
      (a, b) =>
        groupRank(a.group) - groupRank(b.group) ||
        a.group.localeCompare(b.group) ||
        b.open - a.open ||
        b.total - a.total
    );

  const labelsByRepo = {};
  for (const l of labelRows) (labelsByRepo[l.repo] ??= []).push(l);

  // Sparse and capped: only months something happened, only labels above
  // SERIES_MIN, only the focus repo. Everything else is a table row.
  const bigEnough = new Set(
    labelRows.filter((l) => l.repo === ISSUE_LABEL_REPO && l.total >= SERIES_MIN).map((l) => l.name)
  );
  const labelSeriesOut = {};
  for (const [name, byMonth] of labelSeries) {
    if (!bigEnough.has(name)) continue;
    labelSeriesOut[name] = Object.fromEntries([...byMonth.entries()].sort());
  }

  const repos = [...repoStats.values()]
    .map((r) => ({
      repo: r.repo,
      total: r.total,
      open: r.open,
      closed: r.closed,
      unanswered: r.unanswered,
      unlabeled: r.unlabeled,
      last: r.last,
      medianCloseHours: median(r._closeHours),
      medianFirstResponseHours: median(r._responseHours),
    }))
    .sort((a, b) => b.open - a.open || b.total - a.total);

  const series = (map) =>
    [...map.values()].map(finishBucket).sort((a, b) => a.b.localeCompare(b.b));

  return {
    windows: WINDOWS,
    totals: {
      ...totals,
      reporters: firstSeen.size,
      repos: repoStats.size,
      labels: labelStats.size,
      firstIssue: [...firstSeen.values()].sort()[0] ?? null,
    },
    series: {
      day: series(days),
      week: series(weeks),
      month: series(months),
      dayFrom: new Date(dayCutoff).toISOString().slice(0, 10),
    },
    byWindow,
    triage,
    labelFocus: labelsByRepo[ISSUE_LABEL_REPO] ? ISSUE_LABEL_REPO : Object.keys(labelsByRepo)[0] ?? null,
    labelsByRepo,
    labelSeries: labelSeriesOut,
    labelSeriesMin: SERIES_MIN,
    labelGroupOrder: GROUP_ORDER,
    repos,
    // Comment count is the only engagement signal in the store — reactions
    // were dropped from the ingest query when GitHub's abuse limit refused it
    // on the org's largest tracker. Ties break on issue number so the list is
    // stable across builds rather than reordering with whatever the store
    // happened to yield first.
    mostDiscussed: discussed
      .sort((a, b) => b.comments - a.comments || b.number - a.number)
      .slice(0, 25),
  };
}
