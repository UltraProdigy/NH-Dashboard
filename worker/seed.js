/**
 * Load D1 from the existing NDJSON store.
 *
 * No re-crawl: the 55k records already gathered carry forward as-is. Writes are
 * batched into multi-row INSERTs and emitted as SQL, so the same output can be
 * piped into a local database for testing or into `wrangler d1 execute` against
 * the real one.
 *
 *   node worker/seed.js --out worker/seed.sql
 *   node worker/seed.js --out worker/seed.sql --only=issues
 *
 * The full seed is ~96,654 rows against a 100,000/day free-tier write ceiling,
 * so it fits in one pass with very little headroom. --only exists to split it
 * across two days if that ceiling is ever hit mid-load.
 */

import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Store paths resolve against the repo, not the working directory.
 *
 * They used to be bare relative strings, and each reader returns quietly when
 * its file is absent — which is right when a store genuinely has not been
 * built, and silent in exactly the wrong way when the file is there and the
 * process simply started somewhere else. Run from `worker/`, the whole thing
 * found nothing, wrote a valid SQL file containing no rows, and exited 0.
 * `wrangler d1 execute --file` would then apply it and report success.
 *
 * That is the same failure shape as the workflow run that deployed nothing:
 * the thing that went wrong announced itself as the thing going right. The
 * `--out` path stays relative to the working directory, because that one is
 * the caller's to choose and a wrong guess there is visible immediately.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const store = (rel) => join(ROOT, rel);

const ROWS_PER_STATEMENT = 200;

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

const OUT = args.get("out") ?? "worker/seed.sql";
const ONLY = args.get("only") ? String(args.get("only")).split(",") : null;

function q(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function json(value) {
  return q(JSON.stringify(value ?? []));
}

async function* records(path) {
  const rl = createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      /* truncated final line from an interrupted write */
    }
  }
}

class Writer {
  constructor(stream) {
    this.stream = stream;
    this.pending = [];
    this.table = null;
    this.columns = null;
    this.verb = null;
    this.counts = new Map();
  }

  begin(table, columns, verb = "INSERT OR REPLACE") {
    this.flush();
    this.table = table;
    this.columns = columns;
    this.verb = verb;
  }

  push(values) {
    this.pending.push(`(${values.join(",")})`);
    this.counts.set(this.table, (this.counts.get(this.table) ?? 0) + 1);
    if (this.pending.length >= ROWS_PER_STATEMENT) this.flush();
  }

  flush() {
    if (!this.pending.length) return;
    this.stream.write(
      `${this.verb} INTO ${this.table} (${this.columns.join(",")}) VALUES\n` +
        this.pending.join(",\n") +
        ";\n",
    );
    this.pending = [];
  }
}

const PR_COLUMNS = [
  "repo", "number", "title", "author", "created_at", "updated_at", "merged_at",
  "closed_at", "state", "is_draft", "additions", "deletions", "changed_files",
  "commits", "comments", "reactions", "thumbs_up", "thumbs_down",
  "review_count", "reviews_truncated", "labels", "assignees", "review_requests",
];

const REVIEW_COLUMNS = ["repo", "pr_number", "author", "state", "submitted_at"];

const ISSUE_COLUMNS = [
  "repo", "number", "v", "title", "author", "created_at", "updated_at",
  "closed_at", "state", "state_reason", "labels", "labels_truncated",
  "assignees", "comments", "first_response_at", "first_responder",
  "response_unknown", "closed_by", "closer_known", "closed_via_kind",
  "closed_via_repo", "closed_via_number", "closed_via_author", "reactions",
  "thumbs_up", "thumbs_down",
];

const TRAFFIC_COLUMNS = [
  "repo", "date", "views", "view_uniques", "clones", "clone_uniques",
];

async function seedPullRequests(w) {
  const path = store("data/ingest/prs.ndjson");
  if (!existsSync(path)) return;

  w.begin("pull_requests", PR_COLUMNS);
  const reviews = [];

  for await (const r of records(path)) {
    w.push([
      q(r.repo), q(r.number), q(r.title ?? null), q(r.author),
      q(r.createdAt), q(r.updatedAt), q(r.mergedAt ?? null), q(r.closedAt ?? null),
      q(r.state), q(r.isDraft ?? null), q(r.additions ?? null),
      q(r.deletions ?? null), q(r.changedFiles ?? null), q(r.commits ?? null),
      q(r.comments ?? null), q(r.reactions ?? null), q(r.thumbsUp ?? null),
      q(r.thumbsDown ?? null), q(r.reviewCount ?? null),
      q(r.reviewsTruncated ?? false), json(r.labels), json(r.assignees),
      json(r.reviewRequests),
    ]);

    for (const rv of r.reviews ?? []) {
      reviews.push([
        q(r.repo), q(r.number), q(rv.author), q(rv.state),
        q(rv.submittedAt ?? null),
      ]);
    }
  }

  w.begin("reviews", REVIEW_COLUMNS);
  for (const row of reviews) w.push(row);
}

async function seedIssues(w) {
  const path = store("data/ingest/issues.ndjson");
  if (!existsSync(path)) return;

  w.begin("issues", ISSUE_COLUMNS);
  for await (const r of records(path)) {
    const via = r.closedVia ?? {};
    w.push([
      q(r.repo), q(r.number), q(r.v ?? 3), q(r.title ?? null), q(r.author),
      q(r.createdAt), q(r.updatedAt), q(r.closedAt ?? null), q(r.state),
      q(r.stateReason ?? null), json(r.labels), q(r.labelsTruncated ?? false),
      json(r.assignees), q(r.comments ?? null), q(r.firstResponseAt ?? null),
      q(r.firstResponder ?? null), q(r.responseUnknown ?? false),
      q(r.closedBy ?? null), q(r.closerKnown ?? false), q(via.kind ?? null),
      q(via.repo ?? null), q(via.number ?? null), q(via.author ?? null),
      q(r.reactions ?? null), q(r.thumbsUp ?? null), q(r.thumbsDown ?? null),
    ]);
  }
}

async function seedTraffic(w) {
  const path = store("data/ingest/traffic.ndjson");
  if (!existsSync(path)) return;

  w.begin("traffic_daily", TRAFFIC_COLUMNS);
  for await (const r of records(path)) {
    w.push([
      q(r.repo), q(r.date), q(r.views), q(r.viewUniques), q(r.clones),
      q(r.cloneUniques),
    ]);
  }
}

async function seedState(w) {
  const path = store("data/ingest/state.json");
  if (!existsSync(path)) return;

  const { readFileSync } = await import("node:fs");
  const state = JSON.parse(readFileSync(path, "utf8"));

  w.begin("ingest_state", ["repo", "seen_through", "at"]);
  for (const [repo, s] of Object.entries(state.repos ?? {})) {
    w.push([q(repo), q(s.seenThrough ?? null), q(s.at ?? null)]);
  }
}

// No BEGIN TRANSACTION and no PRAGMA. D1's remote engine rejects both — it
// wraps statements itself and exposes transactions only through the JS API.
// Nothing is lost: every statement is INSERT OR REPLACE, so a load that dies
// halfway can simply be run again.
const stream = createWriteStream(OUT);

const writer = new Writer(stream);
const wanted = (name) => !ONLY || ONLY.includes(name);

if (wanted("prs")) await seedPullRequests(writer);
if (wanted("issues")) await seedIssues(writer);
if (wanted("traffic")) await seedTraffic(writer);
if (wanted("state")) await seedState(writer);

writer.flush();
await new Promise((resolve) => stream.end(resolve));

let total = 0;
for (const [table, n] of writer.counts) {
  console.log(`  ${table.padEnd(16)} ${String(n).padStart(7)}`);
  total += n;
}
console.log(`  ${"".padEnd(16)} ${String(total).padStart(7)}  -> ${OUT}`);
if (total > 100000) {
  console.log(
    `\n  over the 100,000/day free write ceiling — split with --only, ` +
      `or run one month of Workers Paid`,
  );
}
