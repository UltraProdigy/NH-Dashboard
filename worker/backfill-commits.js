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
          nameWithOwner
          pushedAt
          updatedAt
          isPrivate
          isArchived
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
          releases(first: 10, orderBy: { field: CREATED_AT, direction: DESC }) {
            nodes { tagName publishedAt createdAt isDraft isPrerelease }
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
function repoRow(node) {
  if (!node.name) return null;
  return [
    q(node.name),
    q(node.nameWithOwner ?? `${ORG}/${node.name}`),
    node.isPrivate ? "1" : "0",
    node.isArchived ? "1" : "0",
    q(node.defaultBranchRef?.name ?? null),
    q(utcSeconds(node.pushedAt)),
    q(utcSeconds(node.updatedAt)),
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

async function main() {
  const since = new Date(Date.now() - LOOKBACK * DAY).toISOString();
  const staleCutoff =
    STALE_REPO_CUTOFF_DAYS === null ? null : Date.now() - STALE_REPO_CUTOFF_DAYS * DAY;

  const commits = [];
  const releases = [];
  const repos = [];
  const pending = [];

  let cursor = null;
  let scanned = 0;
  let hitStaleCutoff = false;

  console.log(`\nBackfilling ${ORG} — commits since ${since.slice(0, 10)}\n`);

  while (!hitStaleCutoff) {
    const data = await graphql(SWEEP, { org: ORG, cursor, since });
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

      const repo = repoRow(node);
      if (repo) repos.push(repo);

      for (const release of node.releases?.nodes ?? []) {
        const row = releaseRow(node.name, release);
        if (row) releases.push(row);
      }

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

    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }

  console.log(
    `  swept ${scanned} repos → ${repos.length} repo rows, ${commits.length} commits, ` +
      `${releases.length} releases` +
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

  const out = createWriteStream(OUT);
  out.write(`-- Generated by worker/backfill-commits.js on ${new Date().toISOString()}\n`);
  out.write(
    `-- ${repos.length} repos, ${commits.length} commits, ${releases.length} releases\n\n`,
  );

  // Repos first. Nothing joins without them.
  for (const sql of statements(
    "repos",
    ["name", "full_name", "private", "archived", "default_branch", "pushed_at", "updated_at"],
    repos,
    "name",
    ["full_name", "private", "archived", "default_branch", "pushed_at", "updated_at"],
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
    `\n  wrote ${repos.length + commits.length + releases.length} rows to ${OUT}\n\n` +
      `  cd worker && npx wrangler d1 execute nh-dashboard --remote --file ${OUT.replace(/^worker\//, "")}\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
