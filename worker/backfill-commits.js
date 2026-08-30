/**
 * Fill `commits` and `releases` with the history the webhook can never deliver.
 *
 *   node --env-file-if-exists=.env worker/backfill-commits.js --out worker/backfill.sql
 *   cd worker && npx wrangler d1 execute nh-dashboard --remote --file backfill.sql
 *
 * The webhook captures forward only. `depUpdates` looks back a year and
 * `needsRelease` needs each repo's *current* latest release, which for nearly
 * every repo already happened — so on webhook capture alone both cards would be
 * wrong for months, and wrong in the quiet direction: a repo whose last release
 * predates the capture window has no row and reads as up to date.
 *
 * SQL to a file rather than a direct write, which is `seed.js`'s shape and for
 * the same reason: it needs no Cloudflare credentials, so it runs anywhere a
 * GitHub token does, and the output can be piped into a local database to test
 * before it touches the real one. The daily workflow has no Cloudflare secret
 * at all — adding one is what it would take to run this automatically, and
 * that decision is deliberately not made here.
 *
 * This also writes the one thing the Worker cannot derive: `via_pr`. GraphQL
 * answers `associatedPullRequests` directly, and a delivered commit can only
 * guess by matching `merge_commit_sha`. Every row this writes overwrites that
 * guess with GitHub's own answer, which is why re-running it is a repair and
 * not just a top-up.
 */

import { createWriteStream } from "node:fs";

import { graphql } from "../src/github/client.js";
import { DEP_UPDATE_LOOKBACK_DAYS, ORG, STALE_REPO_CUTOFF_DAYS } from "../src/config.js";
import { commitAuthor, headline, utcSeconds, viaPullRequest } from "../src/shared/commit-rules.js";

const DAY = 86_400_000;
const ROWS_PER_STATEMENT = 200;

/**
 * Ten repos a request, not fifty.
 *
 * Each node drags a page of commits and their pull-request connections behind
 * it, and a query asking too much at once is timed out by the API rather than
 * rate-limited — which no amount of backing off fixes. `depUpdates` learned
 * this and the number is copied from it deliberately.
 */
const REPOS_PER_SWEEP = 10;
const PAGE = 100;

/**
 * Releases are swept separately, fifty repos at a time.
 *
 * The first version of this file asked for commits and releases in one query,
 * on the reasoning that it was sweeping the same repos either way. GitHub
 * returned 502 on the first request and kept returning it — a GraphQL 502 here
 * means the query timed out server-side, and no amount of the client's
 * exponential backoff fixes a request that is simply too expensive.
 *
 * The two Node panels each proved a shape that works: `depUpdates` reads ten
 * repos of hundred-commit history with their pull-request connections, and
 * `needsRelease` reads fifty repos of releases. Combining them produced
 * something heavier than either, which is the whole lesson — these limits are
 * per-request cost, so two cheap sweeps beat one expensive one even though the
 * repo list is walked twice.
 */
const RELEASE_REPOS_PER_SWEEP = 50;

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (!arg.startsWith("--")) continue;
  const [key, inline] = arg.slice(2).split("=");
  const next = process.argv[i + 1];
  if (inline !== undefined) args.set(key, inline);
  else if (next && !next.startsWith("--")) args.set(key, process.argv[++i]);
  else args.set(key, true);
}

const OUT = args.get("out") ?? "worker/backfill.sql";
const LOOKBACK = Number(args.get("days") ?? DEP_UPDATE_LOOKBACK_DAYS);

function q(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Sweep one — repos and their releases. Cheap, so fifty at a time.
 *
 * This is also where every `repos` row comes from, which matters more than it
 * looks: `seed.sql` never wrote one, so without this sweep both panels join an
 * almost-empty table and say nothing about most of the org.
 */
const RELEASES = `
  query($org: String!, $cursor: String) {
    organization(login: $org) {
      repositories(
        first: ${RELEASE_REPOS_PER_SWEEP}
        after: $cursor
        isArchived: false
        orderBy: { field: PUSHED_AT, direction: DESC }
      ) {
        pageInfo { hasNextPage endCursor }
        nodes {
          name
          nameWithOwner
          pushedAt
          updatedAt
          isPrivate
          isArchived
          defaultBranchRef { name }
          releases(first: 10, orderBy: { field: CREATED_AT, direction: DESC }) {
            nodes { tagName publishedAt createdAt isDraft isPrerelease }
          }
        }
      }
    }
  }
`;

/** Sweep two — commit history. Ten at a time, the shape `depUpdates` proved. */
const SWEEP = `
  query($org: String!, $cursor: String, $since: GitTimestamp!) {
    organization(login: $org) {
      repositories(
        first: ${REPOS_PER_SWEEP}
        after: $cursor
        isArchived: false
        orderBy: { field: PUSHED_AT, direction: DESC }
      ) {
        pageInfo { hasNextPage endCursor }
        nodes {
          name
          pushedAt
          defaultBranchRef {
            name
            target {
              ... on Commit {
                history(first: ${PAGE}, since: $since) {
                  pageInfo { hasNextPage endCursor }
                  nodes {
                    oid
                    committedDate
                    messageHeadline
                    author { user { login } name }
                    associatedPullRequests(first: 1) { totalCount }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * One repo's history from a date of its own choosing.
 *
 * `$cursor` is nullable here where `MORE`'s is not, so the same query serves
 * both the first page of a deep walk and every page after it.
 */
const DEEP = `
  query($org: String!, $repo: String!, $cursor: String, $since: GitTimestamp!) {
    repository(owner: $org, name: $repo) {
      defaultBranchRef {
        target {
          ... on Commit {
            history(first: ${PAGE}, after: $cursor, since: $since) {
              pageInfo { hasNextPage endCursor }
              nodes {
                oid
                committedDate
                messageHeadline
                author { user { login } name }
                associatedPullRequests(first: 1) { totalCount }
              }
            }
          }
        }
      }
    }
  }
`;

const MORE = `
  query($org: String!, $repo: String!, $cursor: String!, $since: GitTimestamp!) {
    repository(owner: $org, name: $repo) {
      defaultBranchRef {
        target {
          ... on Commit {
            history(first: ${PAGE}, after: $cursor, since: $since) {
              pageInfo { hasNextPage endCursor }
              nodes {
                oid
                committedDate
                messageHeadline
                author { user { login } name }
                associatedPullRequests(first: 1) { totalCount }
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * How deep to walk one repo's history.
 *
 * Unbounded would be correct and occasionally enormous — a busy repo can carry
 * thousands of commits inside the lookback, and the panels only ever read the
 * newest direct one and a count since the last release. Twenty pages is two
 * thousand commits, well past both.
 */
const MAX_PAGES = 20;

/**
 * How far a deep walk will go for one repo whose release predates the lookback.
 *
 * These are the repos the card most wants to be right about — a release two
 * years stale is the headline case — and the flat window turned their commit
 * count into "however many the window happened to catch": 20 against a true
 * 106 on TC4Tweaks, 9 against 79 on BugTorch.
 *
 * Fifty pages is five thousand commits, past anything in this org. A repo that
 * exhausts it keeps `commits_since` at the point the walk stopped, so the panel
 * still reports its count as approximate rather than pretending.
 */
const DEEP_MAX_PAGES = 50;

function commitRow(repo, node) {
  const at = utcSeconds(node.committedDate);
  if (!node.oid || !at) return null;
  return [
    q(repo),
    q(node.oid),
    q(at),
    q(commitAuthor(node)),
    q(headline(node.messageHeadline)),
    viaPullRequest(node) ? "1" : "0",
  ];
}

/**
 * The dependency neither panel makes obvious.
 *
 * `seed.sql` loaded pull requests, reviews, issues and traffic, and never wrote
 * a single `repos` row — so that table holds only what a webhook has upserted
 * since the Worker went live. Both release panels join it, which means without
 * this they would answer correctly about the handful of repos that happen to
 * have seen an event, and say nothing at all about the rest. The commits would
 * be there; nothing would join to them.
 */
function repoRow(node, commitsSince) {
  if (!node.name) return null;
  return [
    q(node.name),
    q(node.nameWithOwner ?? `${ORG}/${node.name}`),
    node.isPrivate ? "1" : "0",
    node.isArchived ? "1" : "0",
    q(node.defaultBranchRef?.name ?? null),
    q(utcSeconds(node.pushedAt)),
    q(utcSeconds(node.updatedAt)),
    q(utcSeconds(commitsSince)),
  ];
}

function releaseRow(repo, node) {
  if (!node.tagName) return null;
  return [
    q(repo),
    q(node.tagName),
    q(utcSeconds(node.publishedAt)),
    q(utcSeconds(node.createdAt)),
    node.isDraft ? "1" : "0",
    node.isPrerelease ? "1" : "0",
  ];
}

/**
 * Multi-row INSERTs, chunked.
 *
 * A single statement per row is 50,000 statements and minutes of wrangler; a
 * single statement for everything exceeds what D1 will parse. 200 is what the
 * seed settled on against the same limits.
 *
 * `ON CONFLICT DO UPDATE` rather than `DO NOTHING`, because this file's whole
 * purpose is to replace a delivered row's NULL `via_pr` with the real answer.
 * DO NOTHING would leave every commit the webhook got to first unrepaired.
 */
function* statements(table, columns, rows, conflict, updates) {
  for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
    const chunk = rows.slice(i, i + ROWS_PER_STATEMENT);
    yield `INSERT INTO ${table} (${columns.join(", ")}) VALUES\n` +
      chunk.map((r) => `  (${r.join(", ")})`).join(",\n") +
      `\nON CONFLICT (${conflict}) DO UPDATE SET ` +
      updates.map((c) => `${c} = excluded.${c}`).join(", ") +
      ";\n";
  }
}

/**
 * Collected at module scope so an interrupt can still write them.
 *
 * A full sweep is a long run against a rate-limited API, and losing all of it
 * to one Ctrl-C or a 502 that outlasts the client's five retries means starting
 * over. Everything gathered up to that point is still valid — the writes are
 * upserts keyed on natural keys, so a partial file applied now and a full one
 * applied later converge.
 */
const commits = [];
const releases = [];

/**
 * repo name → how far back its history was swept, as a Date.
 *
 * Starts at the flat lookback for every repo and moves earlier for the few that
 * get a deep walk. Written to `repos.commits_since`, which is what lets both
 * panels tell "nothing happened here" from "we cannot see that far back".
 */
const horizon = new Map();
const repoNodes = new Map();

let written = false;

async function write({ partial = false } = {}) {
  if (written) return;
  written = true;

  const repos = [];
  for (const [name, node] of repoNodes) {
    const row = repoRow(node, horizon.get(name) ?? null);
    if (row) repos.push(row);
  }

  const out = createWriteStream(OUT);
  out.write(`-- Generated by worker/backfill-commits.js on ${new Date().toISOString()}\n`);
  if (partial) {
    out.write("-- PARTIAL: the sweep did not finish. Safe to apply and re-run.\n");
  }
  out.write(
    `-- ${repos.length} repos, ${commits.length} commits, ${releases.length} releases\n\n`,
  );

  // Repos first. Nothing joins without them.
  for (const sql of statements(
    "repos",
    ["name", "full_name", "private", "archived", "default_branch", "pushed_at",
     "updated_at", "commits_since"],
    repos,
    "name",
    ["full_name", "private", "archived", "default_branch", "pushed_at",
     "updated_at", "commits_since"],
  )) {
    out.write(sql);
  }

  for (const sql of statements(
    "commits",
    ["repo", "sha", "committed_at", "author", "message", "via_pr"],
    commits,
    "repo, sha",
    ["committed_at", "author", "message", "via_pr"],
  )) {
    out.write(sql);
  }

  for (const sql of statements(
    "releases",
    ["repo", "tag_name", "published_at", "created_at", "draft", "prerelease"],
    releases,
    "repo, tag_name",
    ["published_at", "created_at", "draft", "prerelease"],
  )) {
    out.write(sql);
  }

  await new Promise((resolve) => out.end(resolve));

  console.log(
    `\n  wrote ${repos.length + commits.length + releases.length} rows to ${OUT}` +
      (partial ? "  (partial)" : "") +
      `\n\n  npx wrangler d1 execute nh-dashboard --remote --file ${OUT.replace(/^worker\//, "")}\n` +
      `  (run from the worker/ directory)\n`,
  );
}

process.on("SIGINT", async () => {
  console.log("\n\n  interrupted — writing what was gathered\n");
  await write({ partial: true });
  process.exit(130);
});

async function main() {
  const since = new Date(Date.now() - LOOKBACK * DAY).toISOString();
  const staleCutoff =
    STALE_REPO_CUTOFF_DAYS === null ? null : Date.now() - STALE_REPO_CUTOFF_DAYS * DAY;

  const pending = [];
  const latestRelease = new Map();

  let cursor = null;
  let scanned = 0;
  let hitStaleCutoff = false;

  console.log(`\nBackfilling ${ORG} — commits since ${since.slice(0, 10)}\n`);

  // Sweep one: repos and releases.
  while (!hitStaleCutoff) {
    const data = await graphql(RELEASES, { org: ORG, cursor });
    const page = data.organization?.repositories;
    if (!page) break;

    for (const node of page.nodes) {
      scanned++;

      // Ordered by pushedAt desc, so the first dormant repo means every repo
      // after it is dormant too. Both panels drop these anyway.
      if (staleCutoff && new Date(node.pushedAt).getTime() < staleCutoff) {
        hitStaleCutoff = true;
        break;
      }

      repoNodes.set(node.name, node);
      horizon.set(node.name, new Date(since));

      for (const release of node.releases?.nodes ?? []) {
        const row = releaseRow(node.name, release);
        if (row) releases.push(row);

        // The newest published, non-draft release decides whether this repo
        // needs a deeper walk than the flat window gives it.
        if (release.isDraft || !release.publishedAt) continue;
        const at = new Date(release.publishedAt);
        const held = latestRelease.get(node.name);
        if (!held || at > held) latestRelease.set(node.name, at);
      }
    }

    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }

  console.log(`  ${repoNodes.size} repos, ${releases.length} releases`);

  // Sweep two: commit history over the same repos, in smaller pages.
  cursor = null;
  hitStaleCutoff = false;
  let walked = 0;

  while (!hitStaleCutoff) {
    const data = await graphql(SWEEP, { org: ORG, cursor, since });
    const page = data.organization?.repositories;
    if (!page) break;

    for (const node of page.nodes) {
      if (staleCutoff && new Date(node.pushedAt).getTime() < staleCutoff) {
        hitStaleCutoff = true;
        break;
      }

      walked++;
      const history = node.defaultBranchRef?.target?.history;
      if (!history) continue;

      for (const commit of history.nodes) {
        const row = commitRow(node.name, commit);
        if (row) commits.push(row);
      }

      if (history.pageInfo.hasNextPage) {
        pending.push({ repo: node.name, cursor: history.pageInfo.endCursor });
      }
    }

    if (page.pageInfo.hasNextPage) cursor = page.pageInfo.endCursor;
    else break;

    if (walked % 50 < REPOS_PER_SWEEP) {
      console.log(`  ${walked} repos walked, ${commits.length} commits so far`);
    }
  }

  console.log(
    `  ${walked} repos walked → ${commits.length} commits` +
      (pending.length ? `, ${pending.length} needing a deeper walk` : ""),
  );

  for (const item of pending) {
    let at = item.cursor;
    for (let page = 1; page < MAX_PAGES; page++) {
      const data = await graphql(MORE, { org: ORG, repo: item.repo, cursor: at, since });
      const history = data.repository?.defaultBranchRef?.target?.history;
      if (!history) break;

      for (const commit of history.nodes) {
        const row = commitRow(item.repo, commit);
        if (row) commits.push(row);
      }

      if (!history.pageInfo.hasNextPage) break;
      at = history.pageInfo.endCursor;
    }
  }

  // Sweep three: repos whose last release predates the flat window.
  //
  // Without this, `commitsAhead` for those repos is not a count of anything —
  // it is the number of commits that happened to fall inside the lookback, and
  // it under-reports exactly the repos furthest behind. Few repos qualify, so
  // the deeper walk is cheap in aggregate even though each one is several
  // pages.
  const deepen = [...latestRelease.entries()]
    .filter(([repo, at]) => repoNodes.has(repo) && at < new Date(since))
    .sort((a, b) => a[1] - b[1]);

  if (deepen.length) {
    console.log(
      `\n  ${deepen.length} repos have a release older than the window — walking back to it`,
    );
  }

  for (const [repo, releasedAt] of deepen) {
    const deepSince = releasedAt.toISOString();
    let at = null;
    let pages = 0;
    let got = 0;
    let exhausted = false;

    for (; pages < DEEP_MAX_PAGES; pages++) {
      const data = await graphql(DEEP, { org: ORG, repo, cursor: at, since: deepSince });
      const history = data.repository?.defaultBranchRef?.target?.history;
      if (!history) break;

      for (const commit of history.nodes) {
        const row = commitRow(repo, commit);
        if (row) {
          commits.push(row);
          got++;
        }
      }

      if (!history.pageInfo.hasNextPage) {
        exhausted = true;
        break;
      }
      at = history.pageInfo.endCursor;
    }

    // Only claim to see back to the release if the walk actually got there.
    // A repo that ran out of pages keeps the flat horizon, so the panel goes on
    // calling its count approximate — which it still is.
    if (exhausted) horizon.set(repo, releasedAt);

    console.log(
      `    ${repo}: +${got} commits back to ${deepSince.slice(0, 10)}` +
        (exhausted ? "" : `  (stopped at ${DEEP_MAX_PAGES} pages — still approximate)`),
    );
  }

  await write();
}

main().catch(async (err) => {
  console.error(`\n  sweep failed: ${err.message}\n`);
  await write({ partial: true });
  process.exit(1);
});
