/**
 * Check the Dream Panel's instant cards against GitHub, and repair the rows
 * underneath them that are wrong.
 *
 * Everything else here trusts the webhook to have said what happened. This asks
 * GitHub directly, in both directions:
 *
 *   - every PR the two review cards are listing is looked up, so one that was
 *     merged or closed behind a lost delivery comes off;
 *   - GitHub's own `review:approved` and `review:changes_requested` searches are
 *     run, so one the cards should be listing and are not goes on;
 *   - each repo's newest published release is compared with the store, so a
 *     release whose delivery went missing takes the repo off Needs a release.
 *
 * It is cheap because the cards are short: a few dozen PRs and one release per
 * repo, about eight API calls in all. Rows are only written when they differ,
 * and every write keeps the forward-only rule the handlers and the reconcile
 * follow, so a snapshot that is seconds old cannot undo a delivery that landed
 * while it was being taken.
 *
 * What it does not reach: a commit that never arrived. Needs a release can still
 * miss a repo whose `push` was lost; the reconcile is where that belongs.
 */

import { PR_COLUMNS, PR_FIELDS, prValues, reviewsTruncated } from "../../src/shared/pr-fields.js";
import { utcSeconds } from "../../src/shared/commit-rules.js";
import { appReady, graphql, installationToken } from "./github.js";
import { markWritten, refreshInstant } from "./recompute.js";

const FIELDS = `repository { name } ${PR_FIELDS} mergeCommit { oid }`;

const SEARCH = `
  query($q: String!, $cursor: String) {
    search(query: $q, type: ISSUE, first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { ... on PullRequest { ${FIELDS} } }
    }
  }
`;

const RELEASES = `
  query($org: String!, $cursor: String) {
    organization(login: $org) {
      repositories(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          name
          releases(first: 5, orderBy: { field: CREATED_AT, direction: DESC }) {
            nodes { tagName publishedAt createdAt isDraft isPrerelease }
          }
        }
      }
    }
  }
`;

const REVIEW_PANELS = ["approvedUnmerged", "changesRequested"];
const MAX_PAGES = 4;

const bare = (repo) => String(repo).split("/").pop();
const key = (repo, number) => `${bare(repo)}#${number}`;

async function listed(db) {
  const { results } = await db
    .prepare(
      `SELECT name, json FROM panel_cache WHERE name IN (${REVIEW_PANELS.map(() => "?").join(",")})`,
    )
    .bind(...REVIEW_PANELS)
    .all();
  const out = new Map();
  for (const { json } of results) {
    for (const row of JSON.parse(json || "[]")) {
      out.set(key(row.repo, row.number), { repo: bare(row.repo), number: row.number });
    }
  }
  return out;
}

async function search(token, q) {
  const found = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await graphql(token, SEARCH, { q, cursor });
    found.push(...data.search.nodes.filter((n) => n?.number));
    if (!data.search.pageInfo.hasNextPage) break;
    cursor = data.search.pageInfo.endCursor;
  }
  return found;
}

async function lookup(token, org, wanted) {
  if (!wanted.length) return [];
  const parts = wanted.map(
    ({ repo, number }, i) =>
      `p${i}: repository(owner: ${JSON.stringify(org)}, name: ${JSON.stringify(repo)}) {
         pullRequest(number: ${Number(number)}) { ${FIELDS} }
       }`,
  );
  const data = await graphql(token, `query { ${parts.join("\n")} }`);
  return Object.values(data).map((r) => r?.pullRequest).filter(Boolean);
}

// GitHub lists a PR's labels in a different order over GraphQL than in a
// webhook payload, so comparing the JSON as written would rewrite the row on
// every tick.
const sameSet = (json) => JSON.stringify(JSON.parse(json || "[]").sort());

const reviewSet = (rows) =>
  rows
    .map((r) => `${r.author ?? ""}|${r.state}|${r.submitted_at ?? ""}`)
    .sort()
    .join("\n");

const PR_UPSERT = `
  INSERT INTO pull_requests (${PR_COLUMNS.join(", ")}, merge_commit_sha)
  VALUES (${PR_COLUMNS.map(() => "?").join(", ")}, ?)
  ON CONFLICT (repo, number) DO UPDATE SET
    ${PR_COLUMNS.slice(2).map((c) => `${c} = excluded.${c}`).join(",\n    ")},
    merge_commit_sha = COALESCE(excluded.merge_commit_sha, pull_requests.merge_commit_sha)
  WHERE excluded.updated_at >= pull_requests.updated_at`;

async function repairPrs(db, prs) {
  if (!prs.length) return [];
  const keys = JSON.stringify(prs.map((pr) => ({ repo: pr.repository.name, number: pr.number })));
  const { results: rows } = await db
    .prepare(
      `SELECT p.repo, p.number, p.state, p.updated_at, p.is_draft, p.labels
         FROM json_each(?1) j
         JOIN pull_requests p
           ON p.repo = json_extract(j.value, '$.repo')
          AND p.number = json_extract(j.value, '$.number')`,
    )
    .bind(keys)
    .all();
  const { results: reviewRows } = await db
    .prepare(
      `SELECT r.repo, r.pr_number, r.author, r.state, r.submitted_at
         FROM json_each(?1) j
         JOIN reviews r
           ON r.repo = json_extract(j.value, '$.repo')
          AND r.pr_number = json_extract(j.value, '$.number')`,
    )
    .bind(keys)
    .all();

  const stored = new Map(rows.map((r) => [key(r.repo, r.number), r]));
  const storedReviews = new Map();
  for (const r of reviewRows) {
    const k = key(r.repo, r.pr_number);
    if (!storedReviews.has(k)) storedReviews.set(k, []);
    storedReviews.get(k).push(r);
  }

  const fixes = [];
  const statements = [];
  for (const pr of prs) {
    const repo = pr.repository.name;
    const k = key(repo, pr.number);
    const row = stored.get(k);
    if (row && row.updated_at > pr.updatedAt) continue;

    const values = prValues(repo, pr);
    const col = (name) => values[PR_COLUMNS.indexOf(name)];
    const fetchedReviews = (pr.reviews?.nodes ?? []).map((r) => ({
      author: r.author?.login ?? null,
      state: r.state,
      submitted_at: r.submittedAt ?? null,
    }));

    const rowWrong =
      !row ||
      row.state !== pr.state ||
      row.updated_at < pr.updatedAt ||
      Number(row.is_draft ?? 0) !== Number(col("is_draft") ?? 0) ||
      sameSet(row.labels) !== sameSet(col("labels"));
    const reviewsWrong =
      !reviewsTruncated(pr) &&
      reviewSet(storedReviews.get(k) ?? []) !== reviewSet(fetchedReviews);
    if (!rowWrong && !reviewsWrong) continue;

    statements.push(db.prepare(PR_UPSERT).bind(...values, pr.mergeCommit?.oid ?? null));
    if (reviewsWrong) {
      statements.push(
        db.prepare("DELETE FROM reviews WHERE repo = ? AND pr_number = ?").bind(repo, pr.number),
        ...fetchedReviews.map((r) =>
          db
            .prepare(
              "INSERT OR REPLACE INTO reviews (repo, pr_number, author, state, submitted_at) VALUES (?, ?, ?, ?, ?)",
            )
            .bind(repo, pr.number, r.author, r.state, r.submitted_at),
        ),
      );
    }
    fixes.push({
      repo,
      number: pr.number,
      was: row ? row.state : "missing",
      now: pr.state,
      reviews: reviewsWrong,
    });
  }

  if (statements.length) await db.batch(statements);
  return fixes;
}

async function latestReleases(token, org) {
  const latest = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const data = await graphql(token, RELEASES, { org, cursor });
    const repos = data.organization.repositories;
    for (const repo of repos.nodes) {
      const published = (repo.releases?.nodes ?? [])
        .filter((r) => !r.isDraft && r.publishedAt)
        .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
      if (published[0]) latest.push({ repo: repo.name, ...published[0] });
    }
    if (!repos.pageInfo.hasNextPage) break;
    cursor = repos.pageInfo.endCursor;
  }
  return latest;
}

async function repairReleases(db, latest) {
  if (!latest.length) return [];
  const { results } = await db
    .prepare(
      `SELECT r.repo, r.tag_name, r.published_at, r.draft
         FROM json_each(?1) j
         JOIN releases r
           ON r.repo = json_extract(j.value, '$.repo')
          AND r.tag_name = json_extract(j.value, '$.tag')`,
    )
    .bind(JSON.stringify(latest.map((r) => ({ repo: r.repo, tag: r.tagName }))))
    .all();
  const stored = new Map(results.map((r) => [`${r.repo}@${r.tag_name}`, r]));

  const fixes = [];
  const statements = [];
  for (const r of latest) {
    const publishedAt = utcSeconds(r.publishedAt);
    const row = stored.get(`${r.repo}@${r.tagName}`);
    if (row && row.draft === 0 && row.published_at === publishedAt) continue;
    fixes.push({ repo: r.repo, tag: r.tagName, was: row ? (row.draft ? "draft" : "stale") : "missing" });
    statements.push(
      db
        .prepare(
          `INSERT INTO releases (repo, tag_name, published_at, created_at, draft, prerelease)
           VALUES (?, ?, ?, ?, 0, ?)
           ON CONFLICT (repo, tag_name) DO UPDATE SET
             published_at = excluded.published_at,
             created_at = excluded.created_at,
             draft = 0,
             prerelease = excluded.prerelease`,
        )
        .bind(r.repo, r.tagName, publishedAt, utcSeconds(r.createdAt), r.isPrerelease ? 1 : 0),
    );
  }
  if (statements.length) await db.batch(statements);
  return fixes;
}

export async function verifyDreamPanel(env, { reason = "cron" } = {}) {
  if (!appReady(env)) return { skipped: "GH_APP_ID or GH_APP_PRIVATE_KEY not set" };

  const started = Date.now();
  const org = env.GITHUB_ORG ?? "GTNewHorizons";
  const db = env.DB;
  const token = await installationToken(env);

  const onCards = await listed(db);
  const base = `org:${org} is:pr is:open draft:false archived:false`;
  const [approved, changes] = await Promise.all([
    search(token, `${base} review:approved`),
    search(token, `${base} review:changes_requested`),
  ]);

  const fetched = new Map();
  for (const pr of [...approved, ...changes]) fetched.set(key(pr.repository.name, pr.number), pr);
  const unseen = [...onCards.entries()].filter(([k]) => !fetched.has(k)).map(([, v]) => v);
  for (const pr of await lookup(token, org, unseen)) fetched.set(key(pr.repository.name, pr.number), pr);

  const prFixes = await repairPrs(db, [...fetched.values()]);

  const releaseFixes = await repairReleases(db, await latestReleases(token, org));

  const tables = [
    ...(prFixes.length ? ["pull_requests", "reviews"] : []),
    ...(releaseFixes.length ? ["releases"] : []),
  ];
  let rebuilt = {};
  if (tables.length) {
    await markWritten(db, tables);
    rebuilt = await refreshInstant(env, null, `verify:${reason}`);
  }

  await db
    .prepare(
      `INSERT INTO meta (key, value) VALUES ('verified_at', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    )
    .bind(new Date().toISOString())
    .run();

  return {
    checked: { prs: fetched.size, onCards: onCards.size, releases: true },
    fixed: { prs: prFixes, releases: releaseFixes },
    rebuilt: Object.keys(rebuilt),
    ms: Date.now() - started,
  };
}
