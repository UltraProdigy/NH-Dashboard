/**
 * Ingestion entry point.
 *
 *   npm run ingest              full/incremental pass over every repo
 *   npm run ingest -- --limit=50   stop after 50 repos (useful for a first look)
 *
 * Safe to interrupt with Ctrl-C — state is saved as it goes, and re-running
 * resumes rather than restarting.
 */

import { ORG } from "./config.js";
import { rateLimit, stats } from "./github/client.js";
import { ingest, STORE_FILE } from "./ingest/pullRequests.js";

const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : Infinity;

console.log(`\nIngesting PRs and reviews for ${ORG}`);
console.log(`Store: ${STORE_FILE}`);
console.log(
  Number.isFinite(limit)
    ? `Limited to ${limit} repos.\n`
    : "First run walks all-time history and will take a while. Ctrl-C is safe — it resumes.\n"
);

const started = Date.now();

try {
  await ingest({ limit });
} catch (err) {
  console.error(`\nIngest failed: ${err.message}\n`);
  process.exitCode = 1;
}

const mins = ((Date.now() - started) / 60000).toFixed(1);
console.log(`\n${mins} min, ${stats.requests} API requests`);

const rl = await rateLimit();
if (rl?.resources?.graphql) {
  const { remaining, limit: max } = rl.resources.graphql;
  console.log(`${remaining}/${max} GraphQL quota remaining\n`);
}
