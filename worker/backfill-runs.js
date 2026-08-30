/**
 * Fill `workflow_runs` with the history the webhook can never deliver.
 *
 *   node --env-file-if-exists=.env worker/backfill-runs.js --out worker/runs.sql
 *   cd worker && npx wrangler d1 execute nh-dashboard --remote --file runs.sql
 *
 * Same reason as `backfill-commits.js`, and more acutely. The webhook captures
 * forward only, and this panel's every figure is computed over "the newest
 * twenty completed runs" — so on capture alone a repo reads as having however
 * many runs have happened to arrive since the Worker went live. A quiet repo
 * would show one run and a pass rate of 100%, which is not a stale answer but a
 * confident wrong one.
 *
 * Cheaper than the commits sweep by a wide margin: one REST request per repo,
 * no pagination, no GraphQL. The whole thing is roughly 260 requests where
 * `backfill-commits.js` is several thousand.
 *
 * SQL to a file rather than a direct write, for the reasons `seed.js` and
 * `backfill-commits.js` give: it needs no Cloudflare credentials, runs anywhere
 * a GitHub token does, and can be applied to a local replica first.
 */

import { createWriteStream } from "node:fs";

import { graphql, rest } from "../src/github/client.js";
import { ORG, STALE_REPO_CUTOFF_DAYS } from "../src/config.js";
import { utcSeconds } from "../src/shared/commit-rules.js";
import { CI_RUN_RETAIN } from "./src/panels/ci-health.js";

const DAY = 86_400_000;
const ROWS_PER_STATEMENT = 200;
const REPOS_PER_SWEEP = 50;

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

const OUT = args.get("out") ?? "worker/runs.sql";

/**
 * How many runs to take per repo.
 *
 * The panel samples twenty. This takes the retention cap instead, which is
 * five times that, because the request costs the same either way and it leaves
 * the sample room to be widened later without another sweep. Above 100 the API
 * paginates, which would make it cost real requests.
 */
const PER_REPO = Math.min(CI_RUN_RETAIN, 100);

function q(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replace(/'/g, "''")}'`;
}

const SWEEP = `
  query($org: String!, $cursor: String) {
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
          isPrivate
          isArchived
          pushedAt
          updatedAt
          defaultBranchRef { name }
        }
      }
    }
  }
`;

const runs = [];
const repoNodes = new Map();

/**
 * Repo rows, written narrowly on purpose.
 *
 * The panel joins `repos` for each repo's default branch, so a store with runs
 * and no repo rows answers nothing — and `seed.sql` never wrote one. Writing
 * them here makes this script self-sufficient rather than silently dependent on
 * `backfill-commits.js` having been run first.
 *
 * **`commits_since` is deliberately not in the update list.** That column is
 * the release panels' record of how far back their own sweep walked, and this
 * sweep walks no commits at all. Including it would write NULL over a real
 * horizon, and the visible effect would be `depUpdates` floors quietly
 * shallowing — the exact bug that card already had once, arriving from a script
 * that has nothing to do with it.
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

/**
 * One run row.
 *
 * `run_started_at` falls back to `created_at` for old runs that predate the
 * field, matching the handler and `runStart` — the column has to hold one kind
 * of value or the index over it means two things.
 *
 * The duration ceiling is **not** applied here. Storing the timestamps and
 * judging them at read time is what lets the ceiling move without a re-sweep,
 * and it keeps this file free of any opinion about what a run means.
 */
function runRow(repo, run) {
  const started = utcSeconds(run.run_started_at ?? run.created_at);
  if (!run.id || !started) return null;
  return [
    q(repo),
    q(run.id),
    q(run.name ?? null),
    q(run.head_branch ?? null),
    q(run.event ?? null),
    q(run.conclusion ?? null),
    q(started),
    q(utcSeconds(run.updated_at)),
    q(run.html_url ?? null),
  ];
}

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

let written = false;

async function write({ partial = false } = {}) {
  if (written) return;
  written = true;

  const repos = [];
  for (const node of repoNodes.values()) {
    const row = repoRow(node);
    if (row) repos.push(row);
  }

  const out = createWriteStream(OUT);
  out.write(`-- Generated by worker/backfill-runs.js on ${new Date().toISOString()}\n`);
  if (partial) {
    out.write("-- PARTIAL: the sweep did not finish. Safe to apply and re-run.\n");
  }
  out.write(`-- ${repos.length} repos, ${runs.length} workflow runs\n\n`);

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
    "workflow_runs",
    ["repo", "run_id", "name", "head_branch", "event", "conclusion",
     "run_started_at", "updated_at", "html_url"],
    runs,
    "repo, run_id",
    ["name", "head_branch", "event", "conclusion", "run_started_at", "updated_at", "html_url"],
  )) {
    out.write(sql);
  }

  await new Promise((resolve) => out.end(resolve));

  console.log(
    `\n  wrote ${repos.length + runs.length} rows to ${OUT}` +
      (partial ? "  (partial)" : "") +
      `\n\n  npx wrangler d1 execute nh-dashboard --remote --file ${OUT.replace(/^worker\//, "")}\n` +
      `  (run from the worker/ directory)\n`,
  );
}

// Every write is an upsert on a natural key, so a partial file applied now and
// a full one applied later converge. Losing an hour of API calls to one Ctrl-C
// is avoidable and was, once.
process.on("SIGINT", async () => {
  console.log("\n\n  interrupted — writing what was gathered\n");
  await write({ partial: true });
  process.exit(130);
});

async function main() {
  const staleCutoff =
    STALE_REPO_CUTOFF_DAYS === null ? null : Date.now() - STALE_REPO_CUTOFF_DAYS * DAY;

  console.log(`\nSweeping ${ORG} for workflow runs\n`);

  // Stage 1 — the repo list and each default branch. Ordered by pushedAt
  // descending, so the first stale repo means the rest are stale too.
  const active = [];
  let cursor = null;
  let stale = false;

  while (!stale) {
    const data = await graphql(SWEEP, { org: ORG, cursor });
    const page = data.organization?.repositories;
    if (!page) break;

    for (const node of page.nodes) {
      if (staleCutoff && new Date(node.pushedAt).getTime() < staleCutoff) {
        stale = true;
        break;
      }
      if (!node.defaultBranchRef) continue; // empty repo
      repoNodes.set(node.name, node);
      active.push({ repo: node.name, branch: node.defaultBranchRef.name });
    }

    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }

  console.log(`  ${active.length} active repos\n`);

  // Stage 2 — one request each. `exclude_pull_requests` is passed to keep the
  // response small and for no other reason: measured against the API it returns
  // the same set of runs either way, and it is the `branch` filter that leaves
  // pull-request runs out.
  let withRuns = 0;
  let failed = 0;

  for (const [i, { repo, branch }] of active.entries()) {
    try {
      const body = await rest(
        `/repos/${ORG}/${repo}/actions/runs` +
          `?branch=${encodeURIComponent(branch)}` +
          `&status=completed&per_page=${PER_REPO}&exclude_pull_requests=true`,
      );

      const list = body.workflow_runs ?? [];
      if (!list.length) continue;

      withRuns++;
      for (const run of list) {
        const row = runRow(repo, run);
        if (row) runs.push(row);
      }
    } catch (err) {
      // A repo with Actions disabled 404s, which is normal and not worth a line
      // of output. Anything else is worth knowing about.
      if (!/\b404\b/.test(err.message)) {
        failed++;
        console.warn(`  ${repo}: ${err.message.split("\n")[0]}`);
      }
    }

    if ((i + 1) % 50 === 0) {
      console.log(`  ${i + 1}/${active.length} repos, ${runs.length} runs so far`);
    }
  }

  console.log(
    `\n  ${withRuns} repos with runs on their default branch` +
      (failed ? `, ${failed} errored` : ""),
  );

  await write();
}

main().catch(async (err) => {
  console.error(`\n  ${err.message}\n`);
  await write({ partial: true });
  process.exit(1);
});
