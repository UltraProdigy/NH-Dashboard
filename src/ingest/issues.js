/**
 * All-time issue ingestion.
 *
 * Same shape and the same reasoning as the PR ingest next door: the questions
 * worth asking about issues — how long until somebody answered, how long until
 * it closed, is the backlog growing — all need history, and history is far too
 * slow to fetch live. Walk it once, store it, update incrementally.
 *
 * What's different from pullRequests.js:
 *   - Only repos with `hasIssuesEnabled` are walked. Most of the org's repos
 *     have the tab switched off — 86 of 340 at the time of writing — and
 *     asking the rest would cost a request each.
 *   - First response is derived at ingest time rather than stored raw. The
 *     interesting number is "when did a human other than the reporter first
 *     say something", and keeping ten comment nodes per issue to recompute it
 *     later would roughly double the store for no gain.
 *   - Records carry a version, and anything below the current one gets
 *     re-walked. The PR store grew a bespoke backfill pass per field added;
 *     one version number does the same job for every future field at once.
 */

import { appendFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { graphql, stats } from "../github/client.js";
import {
  colorsOf,
  responseFor,
  scanEarlyComments,
  toRecord as restRecord,
  walkIssues,
} from "./issuesBulk.js";
import { BOT_PATTERN, ORG } from "../config.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const STORE_DIR =
  process.env.NH_STORE_DIR || path.join(ROOT, "data", "ingest");
export const STORE_FILE = path.join(STORE_DIR, "issues.ndjson");
const STATE_FILE = path.join(STORE_DIR, "issues-state.json");

/**
 * Label name -> colour, per repo.
 *
 * A sidecar rather than a field on every record: the modpack labels issues by
 * mod, so the same forty names repeat across thousands of issues and storing
 * the colour alongside each one would cost megabytes to say the same thing
 * over and over. The colours arrive free with the labels the walk already
 * fetches, so this costs no requests — only the few kilobytes of the map.
 */
const LABELS_FILE = path.join(STORE_DIR, "issue-labels.json");

/**
 * Bump this whenever a field is *added* to the query, and the next run re-walks
 * every record that predates it. Without it a watermarked incremental ingest
 * only ever populates a new field on issues that happen to change afterwards.
 *
 * Removing a field is not a reason to bump. Older records simply carry a value
 * nothing reads any more, which costs a few bytes and breaks nothing — where a
 * bump would order a full re-walk of the entire store to obtain strictly less
 * data than it already holds.
 *
 * **A bump is the expensive option, and it is not always the right one.** The
 * re-walk uses the full query — fifteen labels, ten comments and five assignees
 * per issue, fifty to a page — which is the exact shape GitHub's abuse limit
 * refuses on the org's largest tracker. That is why `--bulk` exists, and a
 * version bump walks straight back into it: bumping this to 3 for the closer
 * fields put the walk into a 60-second penalty every few requests after clearing
 * all 86 repos in one pass each.
 *
 * So when a new field can be fetched *on its own*, fetch it on its own and patch
 * the records in place — see `patchClosers`. Reserve the bump for changes that
 * genuinely need every field re-read.
 */
const REC_VERSION = 3;

/** Matches the PR store — long titles ellipsise in every list that shows one. */
const MAX_TITLE = 160;

/**
 * How many comments are fetched per issue to find the first real response.
 *
 * Ten covers everything except threads that open with a long back-and-forth
 * between the reporter and the bots. Those record `responseUnknown` rather
 * than "never answered", so they drop out of the median instead of dragging
 * it up.
 */
const COMMENT_SAMPLE = 10;

/**
 * How many labels are fetched per issue.
 *
 * This is the single biggest lever on query cost — it multiplies by the 50
 * issues a page returns, so every label here is 50 nodes on the request. At 40
 * the walk tripped GitHub's *secondary* rate limit (a `retry-after`, not the
 * hourly quota) roughly every fifth request and crawled at 60s a throttle.
 *
 * The org's busiest issue trackers put at most three labels on an issue, so 15
 * is five times the observed ceiling and still cheap. `labelsTruncated` on
 * each record is the safety net: if a repo ever exceeds this, the flag says so
 * rather than the count quietly going short.
 */
const LABEL_SAMPLE = 15;

const REPOS = `
  query($org: String!, $cursor: String) {
    organization(login: $org) {
      repositories(first: 100, after: $cursor, orderBy: { field: PUSHED_AT, direction: DESC }) {
        pageInfo { hasNextPage endCursor }
        nodes { name pushedAt isArchived hasIssuesEnabled }
      }
    }
  }
`;

/**
 * Who closed the issue, and what closed it.
 *
 * The store could already say when an issue closed but not by whose hand, which
 * left the org's actual triage work invisible: the people whose job is to sort,
 * answer and close tickets did not appear in any number on the dashboard, while
 * anyone who opened a PR did. `actor` is the person who pressed the button;
 * `closer` is the thing that closed it, which for a fix landing through review
 * is the pull request rather than a person.
 *
 * One timeline node per issue, so this is about 2% on top of a page that
 * already carries fifteen labels and ten comments per issue — nothing like the
 * cost of the reaction aggregates that had to be abandoned. `last: 1` because
 * an issue can be closed and reopened several times and only the close that
 * stuck describes the current state.
 */
const CLOSER_FIELDS = `
  timelineItems(last: 1, itemTypes: [CLOSED_EVENT]) {
    nodes {
      ... on ClosedEvent {
        createdAt
        actor { login }
        closer {
          __typename
          ... on PullRequest { number author { login } repository { name } }
        }
      }
    }
  }
`;

const ISSUE_FIELDS = `
  number
  title
  createdAt
  updatedAt
  closedAt
  state
  stateReason
  author { login }
  labels(first: ${LABEL_SAMPLE}) { totalCount nodes { name color } }
  assignees(first: 5) { totalCount nodes { login } }
  comments(first: ${COMMENT_SAMPLE}) {
    totalCount
    nodes { createdAt author { login } }
  }
  ${CLOSER_FIELDS}
`;

/**
 * How many issues the closer patch takes per page.
 *
 * Fifty, matching the full walk exactly. A hundred with a `states: [CLOSED]`
 * filter looked obviously cheaper — a fifth of the nodes, half the requests —
 * and was refused anyway. Filtering a connection is not free: the server still
 * walks the rows and discards, so a filtered page is *more* work than an
 * unfiltered one of the same size, not less. Matching the shape that demonstrably
 * cleared all 86 repos beats reasoning about which shape ought to be cheaper.
 */
const CLOSER_PAGE = 50;

/**
 * Just the closer, for issues already in the store.
 *
 * Same connection shape as the first walk — unfiltered, fifty a page, ordered by
 * creation — carrying one timeline node instead of fifteen labels, ten comments
 * and five assignees. Open issues come back too and are skipped locally, which
 * costs a node and saves a filter.
 *
 * Newest first, which is the one deliberate difference. The version-driven
 * backfill this replaces walked oldest-first and died partway, so on the repos it
 * touched the *oldest* issues are the ones already patched and the newest are the
 * ones still missing. Walking down from the newest reaches them immediately and
 * stops as soon as the set is empty, where walking up would page through
 * thousands of already-patched issues to reach them. Both directions read the
 * creation index rather than a secondary one, which is the part that matters.
 */
const CLOSERS_BY_CREATED = `
  query($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      issues(
        first: ${CLOSER_PAGE}
        after: $cursor
        orderBy: { field: CREATED_AT, direction: DESC }
      ) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          ${CLOSER_FIELDS}
        }
      }
    }
  }
`;

/**
 * How many rate-limited pages in a row before the patch pass gives up.
 *
 * A secondary limit that keeps firing whatever the spacing is isn't a pace
 * problem, it's a token in a cooldown — and no amount of politeness inside this
 * process fixes that. Grinding through it makes no progress at a minute a page
 * and looks, from outside, exactly like a hang. The store is resumable, so
 * stopping and saying come back later is strictly better than continuing.
 */
const CLOSER_STRIKES = 3;

/**
 * Stop after N consecutive failures, whatever shape they arrive in.
 *
 * Two shapes, and the first version of this only caught one. A throttled page
 * that the client eventually retried into success shows up as a bump in its
 * rate-limit counter; a page that stayed throttled through all five attempts
 * arrives as a thrown 403. Counting only the first meant a token in cooldown
 * spent five minutes per repo failing quietly and then moved on to the next one,
 * thirty-six times — three hours of making no progress, which is precisely what
 * this exists to prevent.
 */
function breaker(n = CLOSER_STRIKES) {
  let strikes = 0;
  return {
    strike: () => ++strikes >= n,
    clear: () => { strikes = 0; },
    tripped: () => strikes >= n,
    count: () => strikes,
  };
}

const COOLDOWN_NOTE =
  "  Stopping here: that is a cooldown on the token, not a pace this run can\n" +
  "  fix. Everything already fetched is saved. Wait a while — tens of minutes,\n" +
  "  not seconds — and run the same command again; it resumes where it stopped.";

/**
 * Incremental walk: newest-updated first, so the first already-seen issue
 * means every remaining issue is also already seen.
 *
 * Ordering by update time needs a secondary index, and each page seeks further
 * into it — cost grows with depth rather than staying flat. That is invisible
 * on a few hundred issues and fatal on tens of thousands, which is why this
 * shape is reserved for runs that will stop after a page or two.
 */
const ISSUES_BY_UPDATED = `
  query($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      issues(
        first: 50
        after: $cursor
        orderBy: { field: UPDATED_AT, direction: DESC }
      ) {
        pageInfo { hasNextPage endCursor }
        nodes { ${ISSUE_FIELDS} }
      }
    }
  }
`;

/**
 * First walk: oldest-created first.
 *
 * A first walk takes every issue in the repo, so it has no use for
 * newest-first ordering — there is nothing to stop early at. Creation order
 * runs with the grain of how the rows are stored instead of against a
 * secondary index, so deep pages cost roughly what shallow ones do. It is also
 * the more stable order to paginate: issues opened while the walk is running
 * are appended past the end rather than shifting the window under the cursor.
 *
 * This is the difference between the org's largest tracker being refused on
 * every attempt and being merely long.
 */
const ISSUES_BY_CREATED = `
  query($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      issues(
        first: 50
        after: $cursor
        orderBy: { field: CREATED_AT, direction: ASC }
      ) {
        pageInfo { hasNextPage endCursor }
        nodes { ${ISSUE_FIELDS} }
      }
    }
  }
`;

const isBot = (login) => !login || BOT_PATTERN.test(login);

/**
 * The first comment from someone who isn't the reporter and isn't a bot.
 *
 * `unknown` when the sample was exhausted without finding one but more
 * comments exist — that's "we didn't look far enough", which must not be
 * counted as "nobody ever replied".
 */
function firstResponse(issue) {
  const nodes = issue.comments?.nodes ?? [];
  const author = issue.author?.login ?? null;

  for (const c of nodes) {
    const who = c.author?.login ?? null;
    if (!who || who === author || isBot(who)) continue;
    return { at: c.createdAt, by: who, unknown: false };
  }

  const truncated = (issue.comments?.totalCount ?? 0) > nodes.length;
  return { at: null, by: null, unknown: truncated };
}

/**
 * The close that stuck, flattened.
 *
 * `closedBy` is the login that pressed the button and `closedVia` says what did
 * the closing — a pull request (with its author, who is usually the person who
 * actually fixed it), a commit, or nothing, which means somebody closed it by
 * hand. An issue closed and reopened repeatedly yields only the last close,
 * which is the one describing the state the record carries.
 */
function closure(issue) {
  const ev = (issue.timelineItems?.nodes ?? []).at(-1);
  if (!ev) return { by: null, via: null };
  const c = ev.closer;
  const via =
    c?.__typename === "PullRequest"
      ? { kind: "pr", repo: c.repository?.name ?? null, number: c.number, author: c.author?.login ?? null }
      : c?.__typename
        ? { kind: c.__typename === "Commit" ? "commit" : c.__typename.toLowerCase() }
        : null;
  return { by: ev.actor?.login ?? null, via };
}

const toRecord = (repo, issue) => {
  const fr = firstResponse(issue);
  const cl = closure(issue);
  return {
    v: REC_VERSION,
    repo,
    number: issue.number,
    title: issue.title ? issue.title.slice(0, MAX_TITLE) : null,
    author: issue.author?.login ?? null,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    state: issue.state,
    // COMPLETED vs NOT_PLANNED is the difference between "we fixed it" and
    // "this was never going to happen", and a close rate that conflates the
    // two flatters the org.
    stateReason: issue.stateReason ?? null,
    labels: (issue.labels?.nodes ?? []).map((l) => l.name),
    labelsTruncated: (issue.labels?.totalCount ?? 0) > (issue.labels?.nodes?.length ?? 0),
    assignees: (issue.assignees?.nodes ?? []).map((a) => a.login),
    comments: issue.comments?.totalCount ?? 0,
    firstResponseAt: fr.at,
    firstResponder: fr.by,
    responseUnknown: fr.unknown,
    closedBy: cl.by,
    closedVia: cl.via,
    // The GraphQL walk always asks, so absent here means "nobody closed it".
    // The REST bulk path can't ask at all and writes false, which has to read
    // as "we don't know" rather than "closed by nobody".
    closerKnown: true,
    // Reactions are deliberately absent. Three aggregate counts per issue is
    // 150 aggregations on a 50-issue page, and on the org's largest tracker
    // that query was refused by GitHub's abuse limit on every single attempt.
    // They fed the 👍/👎 lists and nothing else; "most commented" survives,
    // since the comment count is a plain field on the issue. Reinstating them
    // is a REC_VERSION bump and a re-walk.
  };
};

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    return { repos: {} };
  }
}

async function saveState(state) {
  await mkdir(STORE_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

async function loadLabelMap() {
  try {
    return JSON.parse(await readFile(LABELS_FILE, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Keys are sorted on the way out. The file is committed, and an unsorted
 * object would reshuffle on every run and turn a no-op ingest into a diff.
 */
async function saveLabelMap(map) {
  const sorted = {};
  for (const repo of Object.keys(map).sort()) {
    sorted[repo] = Object.fromEntries(
      Object.entries(map[repo]).sort(([a], [b]) => a.localeCompare(b))
    );
  }
  await mkdir(STORE_DIR, { recursive: true });
  await writeFile(LABELS_FILE, JSON.stringify(sorted, null, 2));
}

/** Read the colour map back. Returns {} if the ingest hasn't written one. */
export async function readLabelColors() {
  return loadLabelMap();
}

async function listRepos() {
  const repos = [];
  let cursor = null;

  while (true) {
    const data = await graphql(REPOS, { org: ORG, cursor });
    const page = data.organization?.repositories;
    if (!page) break;
    repos.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }

  return repos;
}

/**
 * Walk one repo's issues newest-first, yielding a page at a time.
 *
 * A generator rather than a function returning the lot, because a repo is not
 * a safe unit of work. The modpack alone is tens of thousands of issues — with
 * the walk accumulating in memory and writing only on completion, an hour of
 * fetching evaporated if the last page was throttled, and every retry started
 * from the top. Yielding per page lets the caller append and checkpoint as it
 * goes, so the unit of lost work is one page rather than one repo.
 *
 * `startCursor` resumes a repo that was interrupted mid-walk.
 */
async function* walkRepo(repo, seenThrough, startCursor = null) {
  let cursor = startCursor;
  // No watermark means this repo has never been walked to completion, so we
  // want all of it and can use the cheap ordering. A resumed first walk lands
  // here too — `seenThrough` is only set once a repo finishes — so the cursor
  // is always paired with the query that produced it.
  const firstWalk = !seenThrough;
  const query = firstWalk ? ISSUES_BY_CREATED : ISSUES_BY_UPDATED;

  while (true) {
    const data = await graphql(query, { owner: ORG, name: repo, cursor });
    const page = data.repository?.issues;
    if (!page) return;

    const records = [];
    const colors = {};
    let caughtUp = false;

    for (const issue of page.nodes) {
      // Only meaningful on the incremental walk; the first walk is ordered by
      // creation and takes everything.
      if (!firstWalk && issue.updatedAt <= seenThrough) {
        caughtUp = true;
        break;
      }
      for (const l of issue.labels?.nodes ?? []) colors[l.name] = l.color;
      records.push(toRecord(repo, issue));
    }

    cursor = page.pageInfo.endCursor;
    const last = caughtUp || !page.pageInfo.hasNextPage;

    yield { records, colors, cursor, last };
    if (last) return;
  }
}

/**
 * Fill an empty repo from REST, in two passes.
 *
 * Pass one streams every comment in the repo to learn who replied first on
 * each issue; pass two streams the issues themselves and writes complete
 * records. Both are `since`-walks over an index, so a deep page costs what a
 * shallow one does — which is the whole reason this exists. See issuesBulk.js
 * for why the GraphQL walk can't do this job.
 *
 * Both passes checkpoint. The comment map is large enough to be worth keeping
 * on disk rather than re-earning, so it lives in a sidecar next to the store
 * until the load completes, then it's deleted.
 */
export async function bulkLoad(repoName, { onProgress } = {}) {
  const state = await loadState();
  const labelColors = await loadLabelMap();
  await mkdir(STORE_DIR, { recursive: true });

  const prev = state.repos[repoName];
  if (prev?.seenThrough) {
    console.log(`  ${repoName} already has a watermark — use the normal ingest to refresh it.`);
    return { skipped: true };
  }

  const sidecar = path.join(STORE_DIR, `issues-bulk-${repoName}.json`);
  let saved = {};
  try {
    saved = JSON.parse(await readFile(sidecar, "utf8"));
  } catch {
    /* first attempt */
  }

  const bulk = prev?.bulk ?? {};
  const candidates = saved.candidates ?? {};

  const saveSidecar = async (extra) =>
    writeFile(sidecar, JSON.stringify({ candidates, ...extra }));

  const saveState_ = async (patch) => {
    state.repos[repoName] = { ...(state.repos[repoName] ?? {}), bulk: { ...bulk, ...patch } };
    await saveState(state);
  };

  /* ---- pass one: who answered ---- */
  if (!bulk.commentsDone) {
    console.log(`  ${repoName}: scanning comments for first responses`);
    const { map, cursor } = await scanEarlyComments(repoName, {
      since: bulk.commentsSince ?? null,
      into: candidates,
      onProgress: async (p) => {
        bulk.commentsSince = p.cursor;
        await saveSidecar();
        await saveState_({ commentsSince: p.cursor });
        console.log(`      …${p.pages} comment pages, ${p.issues.toLocaleString()} issues answered`);
      },
    });
    Object.assign(candidates, map);
    bulk.commentsSince = cursor ?? bulk.commentsSince;
    bulk.commentsDone = true;
    await saveSidecar();
    await saveState_({ commentsDone: true, commentsSince: bulk.commentsSince });
    console.log(`  ${repoName}: ${Object.keys(candidates).length.toLocaleString()} issues have a reply`);
  } else {
    console.log(`  ${repoName}: reusing ${Object.keys(candidates).length.toLocaleString()} scanned replies`);
  }

  /* ---- pass two: the issues ---- */
  let written = 0;
  let newest = bulk.pendingNewest ?? null;
  let pages = 0;

  for await (const page of walkIssues(repoName, { since: bulk.issuesSince ?? null })) {
    const records = page.issues.map((it) =>
      restRecord(repoName, it, responseFor(candidates[it.number], it.user?.login ?? null), REC_VERSION)
    );

    for (const r of records) if (!newest || r.updatedAt > newest) newest = r.updatedAt;

    if (records.length) {
      await appendFile(STORE_FILE, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
      written += records.length;
    }

    const colors = colorsOf(page.issues);
    if (Object.keys(colors).length)
      labelColors[repoName] = { ...labelColors[repoName], ...colors };

    bulk.issuesSince = page.cursor;
    bulk.pendingNewest = newest;
    await saveState_({ issuesSince: page.cursor, pendingNewest: newest });
    await saveLabelMap(labelColors);

    if (++pages % 10 === 0) {
      console.log(`      …${written.toLocaleString()} issues (${pages} pages)`);
      onProgress?.({ written, pages });
    }
  }

  // Only now is the watermark valid: the walk covered everything, so the
  // newest update it saw is genuinely the newest in the repo.
  state.repos[repoName] = {
    seenThrough: newest ?? new Date().toISOString(),
    at: new Date().toISOString(),
  };
  await saveState(state);
  await saveLabelMap(labelColors);
  await unlink(sidecar).catch(() => {});

  const { before, after } = await compactStore();
  console.log(
    `  done: ${written.toLocaleString()} issues from ${repoName}` +
      (before !== after ? `, compacted ${before} → ${after} lines` : "")
  );

  return { written, pages };
}

/**
 * Fill in who closed each issue, without re-reading everything else about it.
 *
 * The store already holds the title, the labels, the comment count and the first
 * response for all 26,000 issues. The only thing missing on an older record is
 * the closer, and re-fetching the other forty fields to obtain it is what put the
 * heavy backfill into a rate-limit penalty loop. This asks for the one thing it
 * needs and merges it onto the record that's already on disk.
 *
 * Self-limiting and resumable, like every other pass here, but on two axes: the
 * set it works on is "closed records that don't know their closer", so anything
 * already patched is excluded from the next run, *and* the page cursor is saved
 * per page, so an interruption costs one page rather than a repo. That second
 * part is what the version-driven backfill couldn't do — it had no way to say
 * where in a repo it had got to, so a refused request at page 300 of the modpack
 * threw away 299 pages of pacing.
 */
async function patchClosers(state, { limit = Infinity } = {}) {
  clearStoreCache();

  const need = new Map(); // repo -> Map(number -> the record to patch)
  const open = [];        // nothing closed these, so no request is needed
  for (const i of await readStore()) {
    if (i.closerKnown === true) continue;
    if (i.closedAt) {
      if (!need.has(i.repo)) need.set(i.repo, new Map());
      need.get(i.repo).set(i.number, i);
    } else {
      open.push(i);
    }
  }

  // Stamped locally and for free. An open issue has no closer, so the answer is
  // known without asking — and saying so is what keeps these records from
  // looking stale to the version-driven backfill, which would then re-read every
  // field of a seven-year-old open issue to learn something already certain.
  if (open.length) {
    await appendFile(
      STORE_FILE,
      open
        .map((r) =>
          JSON.stringify({ ...r, v: REC_VERSION, closedBy: null, closedVia: null, closerKnown: true })
        )
        .join("\n") + "\n"
    );
    console.log(`  ${open.length.toLocaleString()} open issues need no closer — stamped locally`);
  }

  if (!need.size) {
    clearStoreCache();
    return open.length;
  }

  const total = [...need.values()].reduce((n, m) => n + m.size, 0);
  console.log(
    `  filling in the closer for ${total.toLocaleString()} closed issues across ${need.size} repos`
  );

  let written = open.length;
  let fetched = 0; // records patched over the wire, as opposed to stamped locally
  let repos = 0;
  const bad = breaker();

  for (const [repo, wanted] of need) {
    if (repos >= limit || bad.tripped()) break;
    repos++;

    const st = (state.repos[repo] ??= {});
    let cursor = st.closerCursor ?? null;
    let patched = 0;
    let failed = false;
    // Only a repo that ran out of work or out of pages is finished. Anything
    // else keeps its cursor, or the next run starts this repo from the top.
    let finished = false;

    try {
      while (wanted.size) {
        // The client absorbs a throttle and retries, so a page that cost it a
        // wait is a strike even though it came back with data.
        const waitsBefore = stats.rateLimitWaits;
        const data = await graphql(CLOSERS_BY_CREATED, { owner: ORG, name: repo, cursor });
        if (stats.rateLimitWaits > waitsBefore) {
          if (bad.strike()) break;
        } else bad.clear();

        const page = data.repository?.issues;
        if (!page) break;

        const records = [];
        for (const node of page.nodes) {
          const rec = wanted.get(node.number);
          if (!rec) continue;
          wanted.delete(node.number);
          const cl = closure(node);
          // Spread over the stored record rather than rebuilt from the response:
          // the response deliberately doesn't contain the other fields, and
          // rebuilding would blank every one of them.
          records.push({
            ...rec,
            v: REC_VERSION,
            closedBy: cl.by,
            closedVia: cl.via,
            closerKnown: true,
          });
        }

        if (records.length) {
          await appendFile(
            STORE_FILE,
            records.map((r) => JSON.stringify(r)).join("\n") + "\n"
          );
          written += records.length;
          fetched += records.length;
          patched += records.length;
        }

        cursor = page.pageInfo.endCursor;
        st.closerCursor = cursor;
        await saveState(state);

        if (!page.pageInfo.hasNextPage) {
          finished = true;
          break;
        }
      }
      if (!wanted.size) finished = true;
      if (finished) delete st.closerCursor;
    } catch (err) {
      failed = true;
      // A throw here is five attempts already spent, so it counts the same as a
      // run of throttled pages — otherwise the pass works its way through every
      // remaining repo at five minutes each while achieving nothing.
      bad.strike();
      console.warn(`  ${repo}: ${err.message.split("\n")[0]}`);
    }
    if (finished && !failed) bad.clear();
    // A first repo that fails outright, before a single record has come back over
    // the wire, is a cooldown and not bad luck. Five attempts a repo at a minute
    // each means trying two more to confirm it costs ten minutes to learn
    // something already obvious.
    if (failed && !fetched) while (!bad.tripped()) bad.strike();
    await saveState(state);

    if (patched || failed)
      console.log(
        `  [${repos}/${need.size}] ${repo} — ${patched.toLocaleString()} closers` +
          (finished ? "" : `, ${wanted.size.toLocaleString()} left for next run`)
      );

    if (bad.tripped()) console.warn(COOLDOWN_NOTE);
  }

  clearStoreCache();
  return written;
}

/**
 * Re-walk every repo holding records below REC_VERSION, with the full query.
 *
 * Self-limiting and resumable for the same reason the PR backfills are: the set
 * it works on is "records at the wrong version", so records rewritten before an
 * interruption are already excluded from the next run's set, and once the store
 * is current this costs one local read and zero requests.
 *
 * The expensive path, and the last resort — see the note on REC_VERSION. Prefer
 * a targeted pass like patchClosers for any field that can be fetched alone.
 */
async function backfillStale(labelColors, { limit = Infinity } = {}) {
  clearStoreCache();
  // A record below version that hasn't been closer-patched yet is the *patch
  // pass's* job, not this one's — the closer is the only difference between v2
  // and v3, and re-reading forty fields to obtain it is the mistake this whole
  // arrangement exists to avoid. Without this line a token in cooldown gets the
  // light pass stopped by its breaker and then walks straight into the heavy
  // query on the very same records, which is how the cooldown started.
  const stale = (await readStore()).filter(
    (i) => (i.v ?? 0) < REC_VERSION && i.closerKnown === true
  );
  if (!stale.length) return 0;

  const wanted = new Map(); // repo -> Set of issue numbers still at the old version
  for (const i of stale) {
    if (!wanted.has(i.repo)) wanted.set(i.repo, new Set());
    wanted.get(i.repo).add(i.number);
  }

  console.log(
    `  backfilling ${stale.length} issues across ${wanted.size} repos to v${REC_VERSION}`
  );

  let written = 0;
  let done = 0;
  const bad = breaker();

  for (const [repo, numbers] of wanted) {
    if (done >= limit || bad.tripped()) break;
    const colors = {};
    let cursor = null;
    // Written a page at a time rather than a repo at a time. The store this
    // walks is 26,000 issues deep, so a repo can be an hour of fetching — and
    // when the modpack's walk is refused two thirds of the way through, an
    // accumulate-then-write loop loses all of it and starts over. Per-page
    // appends mean the lost work is one page, and the set this run works on is
    // "records still at the old version", so what already landed is excluded
    // from the next attempt.
    try {
      while (numbers.size) {
        const data = await graphql(ISSUES_BY_CREATED, { owner: ORG, name: repo, cursor });
        const page = data.repository?.issues;
        if (!page) break;

        const records = [];
        for (const issue of page.nodes) {
          if (!numbers.delete(issue.number)) continue;
          for (const l of issue.labels?.nodes ?? []) colors[l.name] = l.color;
          records.push(toRecord(repo, issue));
        }

        if (records.length) {
          await appendFile(
            STORE_FILE,
            records.map((r) => JSON.stringify(r)).join("\n") + "\n"
          );
          written += records.length;
        }
        if (Object.keys(colors).length)
          labelColors[repo] = { ...labelColors[repo], ...colors };
        await saveLabelMap(labelColors);

        if (!page.pageInfo.hasNextPage) break;
        cursor = page.pageInfo.endCursor;
      }
      bad.clear();
    } catch (err) {
      console.warn(`  ${repo}: ${err.message.split("\n")[0]} — resumes next run`);
      // Same reasoning as the closer pass: this walk is the expensive one, and
      // grinding it against a cooldown repo by repo is hours of nothing.
      if (bad.strike()) console.warn(COOLDOWN_NOTE);
    }

    if (++done % 25 === 0)
      console.log(`  ${done}/${wanted.size} repos, ${written} records re-fetched`);
  }

  clearStoreCache();
  return written;
}

export async function ingest({ limit = Infinity } = {}) {
  const state = await loadState();
  const labelColors = await loadLabelMap();
  await mkdir(STORE_DIR, { recursive: true });

  const all = await listRepos();
  // A repo with the issue tab switched off can still hold issues from before
  // it was switched off, but they're unreachable and irrelevant — nobody is
  // triaging a tracker that doesn't exist.
  const repos = all.filter((r) => r.hasIssuesEnabled);
  console.log(`  ${repos.length} of ${all.length} repos in ${ORG} have issues enabled`);

  let processed = 0;
  let written = 0;

  for (const repo of repos) {
    if (processed >= limit) break;

    const prev = state.repos[repo.name];

    // Unlike PRs, issue activity does not imply a push — someone can comment
    // on or close an issue in a repo that hasn't seen a commit in years. So
    // there's no pushedAt shortcut here; every enabled repo costs at least one
    // request per run, and the watermark keeps that to exactly one.
    let repoRecords = 0;
    let failed = false;
    let pages = 0;
    // Resuming a half-walked repo keeps the watermark it started with — the
    // new one isn't valid until the walk reaches already-seen territory — so
    // the high-water mark seen so far rides along in `pendingNewest`.
    let newest = prev?.pendingNewest ?? prev?.seenThrough ?? null;

    try {
      for await (const page of walkRepo(repo.name, prev?.seenThrough, prev?.cursor)) {
        pages++;

        for (const r of page.records)
          if (!newest || r.updatedAt > newest) newest = r.updatedAt;

        if (page.records.length) {
          await appendFile(
            STORE_FILE,
            page.records.map((r) => JSON.stringify(r)).join("\n") + "\n"
          );
          written += page.records.length;
          repoRecords += page.records.length;
        }

        // Merged rather than replaced: an incremental run only sees labels on
        // issues that changed, and dropping the rest would empty the map for
        // every quiet repo.
        if (Object.keys(page.colors).length)
          labelColors[repo.name] = { ...labelColors[repo.name], ...page.colors };

        state.repos[repo.name] = page.last
          ? { seenThrough: newest ?? new Date().toISOString(), at: new Date().toISOString() }
          // Watermark deliberately left where it was. Advancing it mid-walk
          // would mark the unread remainder of the repo as already seen.
          : {
              ...(prev ?? {}),
              cursor: page.cursor,
              pendingNewest: newest,
              at: new Date().toISOString(),
            };

        // Every page, not every repo. This is the whole point of the
        // generator: the unit of work you can lose is one page.
        await saveState(state);
        await saveLabelMap(labelColors);

        if (!page.last && pages % 10 === 0)
          console.log(`      …${repoRecords.toLocaleString()} issues so far (${pages} pages)`);
      }
    } catch (err) {
      failed = true;
      console.warn(`  ${repo.name}: ${err.message.split("\n")[0]}`);
    }

    processed++;

    console.log(
      `  [${processed}/${repos.length}] ${repo.name}` +
        (failed
          ? ` — stopped after ${repoRecords.toLocaleString()} issues, resumes here next run`
          : repoRecords
            ? ` — ${repoRecords.toLocaleString()} issues`
            : " — up to date")
    );
  }

  await saveState(state);
  await saveLabelMap(labelColors);

  // Before the version-driven backfill, deliberately: it patches the closer
  // fields cheaply, which is most of what would otherwise make a record look
  // stale enough to warrant re-reading all of it.
  const patched = await patchClosers(state, { limit });
  const backfilled = await backfillStale(labelColors, { limit });
  await saveLabelMap(labelColors);
  const { before, after } = await compactStore();

  console.log(
    `  done: ${processed} repos, ${written} new/updated issue records` +
      (patched ? `, ${patched} closers filled in` : "") +
      (backfilled ? `, ${backfilled} backfilled` : "") +
      (before !== after ? `, compacted ${before} → ${after} lines` : "")
  );

  return { processed, written, patched, backfilled };
}

/** Rewrite the store deduplicated and sorted — see the PR store's version. */
export async function compactStore() {
  const records = [...(await readStore())];

  let before = 0;
  try {
    const raw = await readFile(STORE_FILE, "utf8");
    before = raw.trim() ? raw.trim().split("\n").length : 0;
  } catch {
    return { before: 0, after: 0 };
  }

  records.sort((a, b) =>
    a.repo === b.repo ? a.number - b.number : a.repo.localeCompare(b.repo)
  );

  const tmp = `${STORE_FILE}.tmp`;
  await writeFile(tmp, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  await rename(tmp, STORE_FILE);

  return { before, after: records.length };
}

let storeCache = null;

export function clearStoreCache() {
  storeCache = null;
}

/**
 * Read the store back, keeping only the newest record per repo#number.
 * Callers must treat the result as read-only — they all share one array.
 */
export async function readStore() {
  if (storeCache) return storeCache;
  const byKey = new Map();

  try {
    const rl = createInterface({
      input: createReadStream(STORE_FILE),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        byKey.set(`${rec.repo}#${rec.number}`, rec);
      } catch {
        /* skip a torn line from an interrupted write */
      }
    }
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }

  storeCache = [...byKey.values()];
  return storeCache;
}
