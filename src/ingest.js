/**
 * Ingestion entry point.
 *
 *   npm run ingest                 full/incremental pass over every repo
 *   npm run ingest -- --limit=50   stop after 50 repos per pass (a first look)
 *   npm run ingest -- --only=prs   pull requests only
 *   npm run ingest -- --only=issues
 *   npm run ingest -- --bulk=NAME  first-load one repo's issues over REST
 *
 * `--bulk` is for a tracker too large for the incremental GraphQL walk to fill
 * from empty — see src/ingest/issuesBulk.js. It only ever runs on a repo with
 * no watermark, so it cannot be used by accident on a repo already ingested.
 *
 * Safe to interrupt with Ctrl-C — state is saved as it goes, and re-running
 * resumes rather than restarting.
 */

import { ORG } from "./config.js";
import { rateLimit, stats } from "./github/client.js";
import { ingest as ingestPRs, STORE_FILE as PR_STORE } from "./ingest/pullRequests.js";
import {
  bulkLoad,
  ingest as ingestIssues,
  STORE_FILE as ISSUE_STORE,
} from "./ingest/issues.js";

const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : Infinity;

const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const only = onlyArg ? onlyArg.split("=")[1] : null;

const bulkArg = process.argv.find((a) => a.startsWith("--bulk="));
const bulkRepo = bulkArg ? bulkArg.split("=")[1] : null;

if (bulkRepo) {
  console.log(`\nBulk-loading issues for ${ORG}/${bulkRepo} over REST`);
  console.log("Two passes: every comment, then every issue. Ctrl-C is safe — both resume.\n");
  const started = Date.now();
  try {
    await bulkLoad(bulkRepo);
  } catch (err) {
    console.error(`  failed: ${err.message}\n`);
    process.exitCode = 1;
  }
  console.log(`\n${((Date.now() - started) / 60000).toFixed(1)} min, ${stats.requests} API requests`);
  const rl0 = await rateLimit();
  if (rl0?.resources?.core) {
    const { remaining, limit: max } = rl0.resources.core;
    console.log(`${remaining}/${max} REST quota remaining\n`);
  }
  process.exit(process.exitCode ?? 0);
}

const PASSES = [
  { id: "prs", label: "PRs and reviews", store: PR_STORE, run: ingestPRs },
  { id: "issues", label: "Issues", store: ISSUE_STORE, run: ingestIssues },
];

const passes = only ? PASSES.filter((p) => p.id === only) : PASSES;

if (!passes.length) {
  console.error(`\nUnknown --only=${only}. Pick one of: ${PASSES.map((p) => p.id).join(", ")}\n`);
  process.exit(1);
}

console.log(`\nIngesting ${passes.map((p) => p.label.toLowerCase()).join(" and ")} for ${ORG}`);
console.log(
  Number.isFinite(limit)
    ? `Limited to ${limit} repos per pass.\n`
    : "First run walks all-time history and will take a while. Ctrl-C is safe — it resumes.\n"
);

const started = Date.now();

// The two stores are independent, so a failure in one leaves the other's work
// intact and the next run picks it up from its own watermark.
for (const pass of passes) {
  console.log(`▸ ${pass.label}`);
  console.log(`  Store: ${pass.store}`);
  try {
    await pass.run({ limit });
  } catch (err) {
    console.error(`  failed: ${err.message}\n`);
    process.exitCode = 1;
  }
  console.log("");
}

const mins = ((Date.now() - started) / 60000).toFixed(1);
console.log(`${mins} min, ${stats.requests} API requests`);

const rl = await rateLimit();
if (rl?.resources?.graphql) {
  const { remaining, limit: max } = rl.resources.graphql;
  console.log(`${remaining}/${max} GraphQL quota remaining\n`);
}
