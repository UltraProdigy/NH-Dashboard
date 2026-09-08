/**
 * Load every repo's own label palette into D1.
 *
 *   node --env-file-if-exists=.env worker/backfill-repo-labels.js
 *   cd worker && npx wrangler d1 execute nh-dashboard --remote --file repo-labels.sql
 *
 * Separate from backfill-labels.js, which loads the twenty managed labels out
 * of the Label-Sync-GTNH config. That table answers "which labels does the org
 * manage", which `byLabel` reads as its definitive column list. This one answers
 * "what colour is this chip", for the 292 names actually in use — and widening
 * the first to hold the second would change what that panel means.
 *
 * Why it exists: issues and pull requests store label *names*, so a chip has no
 * colour of its own. Until this ran, the only names with one were the managed
 * twenty, and a search result showed three tinted chips beside three plain ones
 * for no reason a reader could see.
 *
 * Keyed on (repo, name), because the same name is a different colour in
 * different repos and every row that needs a colour knows which repo it is
 * from. No winner has to be picked.
 *
 * Cost: one GraphQL query per repo, ~300 of them against a 5,000/hour budget,
 * writing ~4,500 rows against a 100,000/day ceiling. It is a small job that
 * needs re-running rarely — the `label` webhook keeps the table current once
 * this has seeded it, so this is for the seed and for repos added since.
 */

import { createWriteStream } from "node:fs";

import { graphql, stats } from "../src/github/client.js";
import { ORG, isIngestExcluded } from "../src/config.js";

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

const OUT = args.get("out") ?? "worker/repo-labels.sql";

/** `--repos=A,B` narrows the walk. The exclusion still applies to the names. */
const ONLY = args.get("repos")
  ? new Set(String(args.get("repos")).split(",").map((s) => s.trim()).filter(Boolean))
  : null;

function q(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

const REPOS = `
  query($org: String!, $cursor: String) {
    organization(login: $org) {
      repositories(first: 100, after: $cursor, orderBy: { field: PUSHED_AT, direction: DESC }) {
        pageInfo { hasNextPage endCursor }
        nodes { name }
      }
    }
  }
`;

const LABELS = `
  query($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      labels(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { name color description }
      }
    }
  }
`;

async function listRepos() {
  if (ONLY) return [...ONLY].filter((name) => !isIngestExcluded(name));

  const repos = [];
  let cursor = null;
  for (;;) {
    const data = await graphql(REPOS, { org: ORG, cursor });
    const page = data.organization.repositories;
    for (const node of page.nodes ?? []) {
      if (!node?.name || isIngestExcluded(node.name)) continue;
      repos.push(node.name);
    }
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return repos;
}

/** One repo's labels. Paginated, though almost no repo here has more than 100. */
async function labelsOf(name) {
  const out = [];
  let cursor = null;
  for (;;) {
    const data = await graphql(LABELS, { owner: ORG, name, cursor });
    const page = data.repository?.labels;
    if (!page) return out;
    for (const l of page.nodes ?? []) {
      if (l?.name) out.push({ name: l.name, color: l.color ?? null, description: l.description ?? null });
    }
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return out;
}

async function main() {
  console.log(`\nReading label palettes for ${ORG}\n`);

  const repos = await listRepos();
  console.log(`  ${repos.length} repos\n`);

  const rows = [];
  const seen = [];
  for (const name of repos) {
    let labels;
    try {
      labels = await labelsOf(name);
    } catch (err) {
      // One repo failing must not cost the rest their palette. The row simply
      // isn't written and its chips keep rendering plain, which is what they
      // did before this script existed.
      console.warn(`  ${name}: ${err.message}`);
      continue;
    }
    seen.push(name);
    for (const l of labels) rows.push({ repo: name, ...l });
    if (labels.length) console.log(`  ${name.padEnd(38)} ${labels.length}`);
  }

  const distinct = new Set(rows.map((r) => r.name)).size;
  const coloured = rows.filter((r) => r.color).length;
  console.log(
    `\n  ${rows.length} rows over ${seen.length} repos — ` +
      `${distinct} distinct names, ${coloured} with a colour`,
  );
  console.log(`  ${stats.requests} API requests\n`);

  if (!rows.length) throw new Error("no labels read; refusing to write an empty file");

  const out = createWriteStream(OUT);
  out.write(`-- Generated by worker/backfill-repo-labels.js on ${new Date().toISOString()}\n`);
  out.write(`-- ${rows.length} labels over ${seen.length} repos in ${ORG}\n\n`);

  // Only the repos actually read are cleared, so a repo whose query failed above
  // keeps whatever palette it already had rather than losing it to a partial
  // run. wrangler applies the file atomically, so no reader sees the gap.
  out.write(
    `DELETE FROM repo_labels WHERE repo IN (${seen.map(q).join(", ")});\n\n`,
  );

  // Chunked because SQLite caps the rows in one VALUES list, and 4,500 in a
  // single statement is well past it.
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    out.write(
      "INSERT INTO repo_labels (repo, name, color, description) VALUES\n" +
        chunk
          .map((r) => `  (${q(r.repo)}, ${q(r.name)}, ${q(r.color)}, ${q(r.description)})`)
          .join(",\n") +
        "\nON CONFLICT (repo, name) DO UPDATE SET" +
        " color = excluded.color," +
        " description = excluded.description;\n\n",
    );
  }

  await new Promise((resolve) => out.end(resolve));

  console.log(
    `  wrote ${OUT}\n\n` +
      `  npx wrangler d1 execute nh-dashboard --remote --file ${OUT.replace(/^worker\//, "")}\n` +
      `  (run from the worker/ directory)\n`,
  );
}

main().catch((err) => {
  // No partial file, for the same reason backfill-labels.js writes none: a
  // half-swept palette applied over a complete one would leave repos with no
  // colours and nothing to say which.
  console.error(`\n  failed: ${err.message}\n  D1 keeps whatever it already had.\n`);
  process.exit(1);
});
