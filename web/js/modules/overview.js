import { state } from "../state.js";
import { contribLink, dur, esc, fmt, pctFmt, safeUrl } from "../format.js";
import { kpi } from "../charts.js";
import { A, I, IW, W, delta, panel, windowDays, windowLabel, windowPhrase } from "../data.js";
import { ciDur, netClass, signed } from "../module-helpers.js";
import { goneQuiet, newFaces, rankedBy } from "../contributor-data.js";
import { quietRepos, repoOrg, repoOrgWindow } from "../repo-activity-data.js";
import { href } from "../paths.js";
import { pageSlug } from "../pages.js";
import { isAdmin } from "../roles.js";

/**
 * Every figure here is already rendered on the page each card links to, read
 * from the same panel the same way. If a tile ever needs arithmetic of its own,
 * it belongs on that page instead — two pages disagreeing about one number is
 * the failure this one is most exposed to, since it is the page most people see.
 */

const missing = (name) => {
  const p = panel(name);
  if (!p) return `<div class="empty">Loading…</div>`;
  if (!p.ok) return `<div class="error">${esc(p.error)}</div>`;
  return `<div class="empty">Nothing to show.</div>`;
};

const handoff = (label, page, tab = "") =>
  `<a class="expand" href="${href(pageSlug(page) + (tab ? `/${tab}` : ""))}" data-pagelink>${esc(label)} →</a>`;

const versus = (w) =>
  w?.prevLabel ? `${windowPhrase()} vs. ${w.prevLabel}` : windowLabel().toLowerCase();

/* ---- the quick-links bar ------------------------------------------------
   Page chrome rather than a module: it reads no panel, so as a card it could
   claim no freshness tier honestly, and the freshness suite would be right to
   refuse it. */

const MEMBER_LINKS = [
  ["Organization", (o) => `https://github.com/${o}`],
  ["Repositories", (o) => `https://github.com/orgs/${o}/repositories`],
  ["Open PRs", (o) => `https://github.com/pulls?q=is:open+is:pr+org:${o}`],
  ["Awaiting my review", (o) => `https://github.com/pulls?q=is:open+is:pr+org:${o}+review-requested:@me`],
  ["Open issues", (o) => `https://github.com/issues?q=is:open+is:issue+org:${o}`],
  ["Modpack tracker", (o) => `https://github.com/${o}/GT-New-Horizons-Modpack/issues`],
  ["People", (o) => `https://github.com/orgs/${o}/people`],
  ["Teams", (o) => `https://github.com/orgs/${o}/teams`],
];

// A member gets a 404 from every one of these, so they are left out rather
// than drawn dead.
const ADMIN_LINKS = [
  ["Org settings", (o) => `https://github.com/organizations/${o}/settings/profile`],
  ["Installed apps", (o) => `https://github.com/organizations/${o}/settings/installations`],
  ["Rulesets", (o) => `https://github.com/organizations/${o}/settings/rules`],
  ["Audit log", (o) => `https://github.com/organizations/${o}/settings/audit-log`],
];

const chips = (links, org) => links.map(([label, url]) =>
  `<a class="ghost" href="${safeUrl(url(org))}" target="_blank" rel="noopener">${esc(label)}&nbsp;↗</a>`).join("");

function overviewLead() {
  const org = encodeURIComponent(state.data?.org ?? "GTNewHorizons");
  return `<nav class="ov-links" aria-label="GitHub links">
    <div class="ov-row">${chips(MEMBER_LINKS, org)}</div>
    ${isAdmin(state.role)
      ? `<div class="ov-row"><span class="minlabel">admin</span>${chips(ADMIN_LINKS, org)}</div>`
      : ""}
  </nav>`;
}

export const overviewModules = {
  /* ---------------- Org Overview ---------------- */

  gPRs: {
    page: "overview", label: "Pull requests", span: 6, flush: true, tab: false,
    reads: "analytics", controls: ["window"],
    controlsHtml: () => handoff("PR Analytics", "analytics"),
    sub: () => versus(W()),
    render() {
      const a = A(), w = W();
      if (!a || !w) return missing("analytics");
      return `<div class="kpis">
        ${kpi("PRs opened", fmt(w.opened), delta("opened", { fallback: `across ${fmt(w.activeRepos)} repos` }))}
        ${kpi("Merge rate", pctFmt(w.mergeRate), delta("mergeRate", { pp: true, fallback: `${fmt(w.closed)} closed unmerged` }))}
        ${kpi("Median time to merge", dur(w.medianMergeHours), delta("medianMergeHours", { invert: true, fallback: `p90 ${dur(w.p90MergeHours)}` }))}
        ${kpi("Open backlog", fmt(a.backlog.total), `${fmt(a.backlog.unreviewed)} never reviewed`, a.backlog.unreviewed > a.backlog.total / 2 ? "down" : "")}
      </div>`;
    },
  },

  gIssues: {
    page: "overview", label: "Issues", span: 6, flush: true, tab: false,
    reads: "issues", controls: ["window"],
    controlsHtml: () => handoff("Issue Analytics", "issues"),
    sub: () => versus(IW()),
    render() {
      const d = I(), w = IW();
      if (!d || !w) return missing("issues");
      const t = d.triage;
      // No delta on Backlog moved, for the reason Pulse gives: a percentage
      // change of a signed quantity comes out backwards.
      return `<div class="kpis">
        ${kpi("Issues opened", fmt(w.opened), delta("opened", { w, fallback: `across ${fmt(w.activeRepos)} repos` }))}
        ${kpi("Backlog moved", signed(w.net), "opened minus closed", netClass(w.net))}
        ${kpi("Median first response", dur(w.medianFirstResponseHours), delta("medianFirstResponseHours", { w, invert: true, fallback: `${fmt(w.responses)} replies` }))}
        ${kpi("Open now", fmt(t.open), `${fmt(t.unanswered)} never answered`, t.open && t.unanswered > t.open / 2 ? "down" : "")}
      </div>`;
    },
  },

  gRepos: {
    page: "overview", label: "Repos", span: 4, flush: true, tab: false,
    reads: "repos", controls: ["window"],
    controlsHtml: () => handoff("Repo Activity", "repos"),
    sub: () => windowPhrase(),
    render() {
      const org = repoOrg(), w = repoOrgWindow();
      if (!panel("repos")?.ok || !org || !w) return missing("repos");
      const quiet = quietRepos(org);
      return `<div class="kpis">
        ${kpi("Repos", fmt(org.repos), "with any PR or issue")}
        ${kpi("Active in this period", fmt(w.activeRepos), `${pctFmt(org.repos ? w.activeRepos / org.repos : null)} of them`)}
        ${kpi("Quiet 3 months or more", fmt(quiet), "dormant or silent", quiet > org.repos / 3 ? "down" : "")}
        ${kpi("Stale open PRs", fmt(org.staleOpenPRs), `of ${fmt(org.openPRs)} open, over 6 months`,
              org.staleOpenPRs > org.openPRs / 4 ? "down" : "")}
      </div>`;
    },
  },

  /**
   * No active-contributor count. The PR card's would sit two columns away,
   * counted differently, and a reader would try to reconcile the two and fail.
   *
   * New faces reads the page's period here, not New Faces' own — so this and
   * Contributor Activity can show different counts, and the tile says which
   * period it means.
   */
  gPeople: {
    page: "overview", label: "People", span: 4, flush: true, tab: false,
    reads: "contributors", controls: ["window"],
    controlsHtml: () => handoff("Contributor Activity", "people"),
    sub: () => windowPhrase(),
    render() {
      const p = panel("contributors");
      if (!p?.ok) return missing("contributors");
      const days = windowDays();
      const top = rankedBy("prs")[0];
      return `<div class="kpis">
        ${kpi("Known contributors", fmt(p.data.rows?.length ?? 0), "all time")}
        ${kpi("New faces", fmt(newFaces(days).length), days == null ? "first PR ever" : `first PR in the ${windowPhrase()}`)}
        ${kpi("Gone quiet", fmt(goneQuiet().length), "regulars, silent 6 months")}
        ${top
          ? kpi("Top author", contribLink(top.login, { pfp: false }), `${fmt(top.count)} PRs opened`)
          : kpi("Top author", "—", "no PRs this period")}
      </div>`;
    },
  },

  /**
   * CI Health is locked, so this hands off to Actions load, which carries the
   * same roll-up and all four caveats.
   */
  gCI: {
    page: "overview", label: "CI", span: 4, flush: true, tab: false,
    reads: "ciHealth",
    controlsHtml: () => handoff("Actions load", "analytics", "actions-load"),
    sub: () => "default branches, estimated",
    render() {
      const p = panel("ciHealth");
      const o = p?.ok ? p.data.org : null;
      if (!o) return missing("ciHealth");
      const rateCls = o.passRate == null ? "" : o.passRate > 0.9 ? "up" : o.passRate > 0.7 ? "flat" : "down";
      return `<div class="kpis">
        ${kpi("Pass rate", pctFmt(o.passRate), `${fmt(o.failures)} failed of ${fmt(o.decisive)}`, rateCls)}
        ${kpi("Runs per month", `~${fmt(o.runsPerMonth)}`, "projected")}
        ${kpi("Hours per month", `~${fmt(o.hoursPerMonth)}`, "wall-clock")}
        ${kpi("Average run", ciDur(o.meanRunMinutes), `over ${fmt(o.sampledRuns)} sampled runs`)}
      </div>
      <div class="hint" style="padding:10px 14px 12px">Projected from sampled default-branch runs, and wall-clock rather than billable — a floor, not an invoice.</div>`;
    },
  },
};

export { overviewLead };
