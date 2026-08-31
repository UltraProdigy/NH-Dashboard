/**
 * Bulk first-load of one repo's issues, over REST.
 *
 * Why a second implementation exists at all: filling an empty store and keeping
 * a full one current are different problems, and the query that is right for
 * one is wrong for the other.
 *
 * The GraphQL walk is built for the steady state. It asks for issues newest-
 * updated first so it can stop at the first one it has already seen, which
 * makes a daily refresh cost a page. On a repo with tens of thousands of
 * issues and nothing in the store, that same query has to sort the entire
 * tracker by update time and then seek further into that ordering on every
 * page — cost that grows with depth. GitHub's abuse detection refuses it, and
 * it is right to: nothing about that access pattern looks like a dashboard.
 *
 * REST suits the bulk case far better:
 *
 *   - 100 items a page instead of 50, halving the number of round trips.
 *   - `since` walks forward through an index rather than paging into an offset,
 *     so the thousandth page costs what the first one did.
 *   - The list endpoints are cheap and heavily cached. They are what every
 *     issue tracker mirror on earth is built on, so they are not mistaken for
 *     scraping.
 *
 * First response comes out better here too. The GraphQL walk samples ten
 * comments per issue and admits `responseUnknown` when that is not enough. The
 * repo-wide comments endpoint streams every comment in the repo in creation
 * order, so one pass yields the true first reply for every issue at once, and
 * `responseUnknown` is never set.
 *
 * Records are written in exactly the shape the GraphQL walk produces. Once the
 * repo has a watermark, the incremental path takes over and this file is never
 * touched again for it.
 */

import { rest } from "../github/client.js";
import { BOT_PATTERN, ORG } from "../config.js";
import { stateReason } from "../shared/issue-rules.js";

const PER_PAGE = 100;

/** Kept in step with the GraphQL walk — records from both must be identical. */
const MAX_TITLE = 160;

const isBot = (login) => !login || BOT_PATTERN.test(login);

/** "open" -> "OPEN", to match what GraphQL returns. */
const upper = (s) => (s ? String(s).toUpperCase() : null);

/**
 * Walk a `since`-supporting list endpoint forward in ascending time.
 *
 * `since` is inclusive, so every page after the first repeats at least the
 * record it resumed from. `seen` drops those. When a whole page is nothing but
 * repeats — which happens when more than PER_PAGE records share one timestamp —
 * the cursor is nudged a second forward, because otherwise the walk asks for
 * the same page forever.
 */
async function* sincePages(path, params, timeField, { since = null } = {}) {
  const seen = new Set();
  let cursor = since;

  while (true) {
    const qs = new URLSearchParams({ ...params, per_page: String(PER_PAGE) });
    if (cursor) qs.set("since", cursor);

    const page = await rest(`${path}?${qs}`);
    if (!Array.isArray(page) || !page.length) return;

    const fresh = page.filter((it) => !seen.has(it.id));
    for (const it of page) seen.add(it.id);

    const last = page[page.length - 1][timeField];

    if (!fresh.length) {
      if (page.length < PER_PAGE) return;
      cursor = new Date(new Date(last).getTime() + 1000).toISOString();
      continue;
    }

    yield { items: fresh, cursor: last };

    if (page.length < PER_PAGE) return;
    cursor = last;
  }
}

/**
 * The first few distinct people to comment on each issue, in creation order.
 *
 * Up to three per issue rather than one, because the reporter replying to
 * their own report twice before anyone else speaks is common and would
 * otherwise be recorded as the response. Who reported an issue isn't in the
 * comment payload, so that comparison happens at merge time — keeping three
 * candidates is what lets this pass run first and stand alone, instead of
 * needing the issue walk to have gone before it.
 *
 * Bots are dropped here, where it's free.
 */
const CANDIDATES = 3;

export async function scanEarlyComments(repo, { since = null, into = {}, onProgress } = {}) {
  const map = into;
  let cursor = since;
  let pages = 0;

  for await (const page of sincePages(
    `/repos/${ORG}/${repo}/issues/comments`,
    { sort: "created", direction: "asc" },
    "created_at",
    { since }
  )) {
    for (const c of page.items) {
      // The tail of issue_url is the issue number. Comments on pull requests
      // are not returned by this endpoint, so there is nothing to filter out.
      const n = Number(c.issue_url?.split("/").pop());
      if (!Number.isFinite(n)) continue;

      const who = c.user?.login ?? null;
      if (isBot(who)) continue;

      const got = (map[n] ??= []);
      if (got.length >= CANDIDATES) continue;
      if (got.some((e) => e.by === who)) continue;
      got.push({ at: c.created_at, by: who });
    }

    cursor = page.cursor;
    pages++;
    if (pages % 20 === 0)
      onProgress?.({ pages, issues: Object.keys(map).length, cursor });
  }

  return { map, cursor, pages };
}

/** First candidate who isn't the person who filed it. */
export function responseFor(candidates, author) {
  return (candidates ?? []).find((c) => c.by !== author) ?? null;
}

/**
 * Every issue in the repo, oldest-updated first.
 *
 * The endpoint returns pull requests alongside issues — anything carrying a
 * `pull_request` key is one, and is dropped. That is the single most important
 * line in this file: without it the store would count every PR in the repo as
 * an issue.
 */
export async function* walkIssues(repo, { since = null } = {}) {
  for await (const page of sincePages(
    `/repos/${ORG}/${repo}/issues`,
    { state: "all", sort: "updated", direction: "asc" },
    "updated_at",
    { since }
  )) {
    const issues = page.items.filter((it) => !it.pull_request);
    yield { issues, cursor: page.cursor };
  }
}

/** REST payload -> the same record the GraphQL walk writes. */
export function toRecord(repo, it, response, version) {
  const fr = response ?? null;
  return {
    v: version,
    repo,
    number: it.number,
    title: it.title ? String(it.title).slice(0, MAX_TITLE) : null,
    author: it.user?.login ?? null,
    createdAt: it.created_at,
    updatedAt: it.updated_at,
    closedAt: it.closed_at,
    state: upper(it.state),
    stateReason: stateReason(it.state_reason),
    labels: (it.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)),
    // REST returns the whole label set on every issue, so unlike the GraphQL
    // walk there is no sample size to overflow.
    labelsTruncated: false,
    assignees: (it.assignees ?? []).map((a) => a.login),
    comments: it.comments ?? 0,
    firstResponseAt: fr?.at ?? null,
    firstResponder: fr?.by ?? null,
    // Never unknown here: the comment pass sees every comment in the repo, so
    // an absent first response means silence rather than an exhausted sample.
    responseUnknown: false,
    // REST returns `closed_by` only when fetching one issue at a time, and the
    // closing pull request not at all, so a bulk load cannot answer this. Said
    // out loud rather than left absent: every count derived from it reports how
    // many issues it couldn't see, instead of quietly reading them as "closed
    // by nobody". A later `npm run ingest` fills them in over GraphQL.
    closedBy: null,
    closedVia: null,
    closerKnown: false,
  };
}

/** Label name -> colour, harvested from the issue payloads for the sidecar. */
export function colorsOf(issues) {
  const colors = {};
  for (const it of issues)
    for (const l of it.labels ?? [])
      if (typeof l === "object" && l.name && l.color) colors[l.name] = l.color;
  return colors;
}
