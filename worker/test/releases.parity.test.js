/**
 * The SQL release cards, against rules built by hand.
 *
 *   node --experimental-sqlite worker/test/releases.parity.test.js
 *
 * Written before the panels, which is the rule this repo has learned the hard
 * way — the last port's test caught a hardcoded `truncated: 0`, a TEXT
 * comparison that made every windowed count constant, and a rule the real store
 * could not exercise at all.
 *
 * This one cannot be the usual parity test, and the reason is worth stating.
 * The other ports compare two implementations reading one store. Here the
 * JavaScript reads *GitHub* — a GraphQL sweep and a REST compare — and the SQL
 * reads a store that GitHub's webhooks have only partially filled. Running both
 * would compare a live API against a database mid-backfill and call the
 * difference a bug.
 *
 * So the baseline is synthetic, and deliberately so: the cases that decide
 * these cards are ones the real store contains few of. A release with no
 * commits after it, a repo whose only commits since its tag were direct
 * pushes, a draft that must not count as the latest release, a commit whose
 * timestamp arrives with an offset instead of a Z. Real data would validate a
 * wrong implementation happily on all four.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  commitAuthor,
  headline,
  utcSeconds,
  viaPullRequest,
} from "../../src/shared/commit-rules.js";
import { needsRelease } from "../src/panels/releases.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = path.join(HERE, "..", "schema.sql");

const DAY = 86_400_000;

let pass = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ok    ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const d1 = (db) => ({
  prepare(sql) {
    let params = [];
    const api = {
      bind(...p) { params = p; return api; },
      async all() { return { results: db.prepare(sql).all(...params) }; },
      async first() { return db.prepare(sql).get(...params) ?? null; },
    };
    return api;
  },
});

function blank() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(SCHEMA, "utf8"));
  return db;
}

/** `now` is fixed so day arithmetic in the assertions is not a race. */
const NOW = Date.parse("2026-08-30T12:00:00Z");
const ago = (days) => utcSeconds(NOW - days * DAY);

function addRepo(db, name, extra = {}) {
  db.prepare(
    `INSERT INTO repos (name, full_name, private, archived, default_branch, pushed_at,
                        updated_at, commits_since)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    name,
    `GTNewHorizons/${name}`,
    extra.private ? 1 : 0,
    extra.archived ? 1 : 0,
    extra.defaultBranch ?? "master",
    extra.pushedAt ?? ago(1),
    extra.pushedAt ?? ago(1),
    // How far back the backfill swept this repo. Defaults to the full lookback,
    // which is what a normal repo gets.
    extra.commitsSince === undefined ? ago(365) : extra.commitsSince,
  );
}

function addRelease(db, repo, tag, daysAgo, extra = {}) {
  db.prepare(
    `INSERT INTO releases (repo, tag_name, published_at, created_at, draft, prerelease)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    repo,
    tag,
    extra.draft ? null : ago(daysAgo),
    ago(daysAgo),
    extra.draft ? 1 : 0,
    extra.prerelease ? 1 : 0,
  );
}

let shaCounter = 0;
function addCommit(db, repo, daysAgo, extra = {}) {
  const sha = extra.sha ?? `sha${String(++shaCounter).padStart(37, "0")}`;
  db.prepare(
    `INSERT INTO commits (repo, sha, committed_at, author, message, via_pr)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    repo,
    sha,
    extra.at ?? ago(daysAgo),
    extra.author ?? "someone",
    extra.message ?? "a commit",
    extra.viaPr === undefined ? null : extra.viaPr,
  );
  return sha;
}

function addMergedPr(db, repo, number, sha) {
  db.prepare(
    `INSERT INTO pull_requests (repo, number, created_at, updated_at, state, merge_commit_sha)
     VALUES (?, ?, ?, ?, 'MERGED', ?)`,
  ).run(repo, number, ago(30), ago(30), sha);
}

const byRepo = (rows) => Object.fromEntries(rows.map((r) => [r.repo, r]));

// ---------------------------------------------------------------- timestamps

console.log("\ntimestamp normalisation");

check(
  "an offset timestamp normalises to Z",
  utcSeconds("2026-08-30T12:34:56+02:00") === "2026-08-30T10:34:56Z",
  utcSeconds("2026-08-30T12:34:56+02:00"),
);

check(
  "milliseconds are dropped, not rounded up",
  utcSeconds("2026-08-30T12:34:56.789Z") === "2026-08-30T12:34:56Z",
  utcSeconds("2026-08-30T12:34:56.789Z"),
);

check(
  "every normalised value is the same width",
  new Set(
    ["2026-08-30T12:34:56+02:00", "2026-01-01T00:00:00.5Z", "2014-12-08T20:38:55Z"]
      .map((v) => utcSeconds(v).length),
  ).size === 1,
);

// The property every query in both panels rests on. An unnormalised commit
// would sort below one that shares its date, and MAX(committed_at) would stop
// meaning "newest" without any query looking wrong.
check(
  "lexical order is chronological order after normalising",
  utcSeconds("2026-08-30T12:34:56+02:00") < utcSeconds("2026-08-30T12:34:56Z"),
);

check("an unparseable timestamp is null, not NaN", utcSeconds("not a date") === null);

// ------------------------------------------------------------- the PR reading

console.log("\npull-request association");

check(
  "GraphQL's answer is read from associatedPullRequests",
  viaPullRequest({ associatedPullRequests: { totalCount: 1 } }) === true &&
    viaPullRequest({ associatedPullRequests: { totalCount: 0 } }) === false,
);

// The claim that sent the previous handoff wrong. A push payload has no such
// field, so the absence must read as unknown rather than as "not a PR".
check(
  "a push-shaped commit has no PR field and reads as not-via-PR",
  viaPullRequest({ id: "abc", message: "x", timestamp: "2026-08-30T00:00:00Z" }) === false,
);

check(
  "commitAuthor reads both the GraphQL and the push shape",
  commitAuthor({ author: { user: { login: "alice" } } }) === "alice" &&
    commitAuthor({ author: { username: "bob", name: "Bob R" } }) === "bob" &&
    commitAuthor({ author: { name: "Only Git" } }) === "Only Git",
);

check(
  "headline takes the first line only",
  headline("fix the thing\n\nlonger body here") === "fix the thing",
);

// -------------------------------------------------------------- needsRelease

console.log("\nneedsRelease");

{
  const db = blank();

  // Ahead, and something in the range came from a PR.
  addRepo(db, "Ahead");
  addRelease(db, "Ahead", "v1.0", 30);
  const merged = addCommit(db, "Ahead", 10);
  addMergedPr(db, "Ahead", 7, merged);
  addCommit(db, "Ahead", 5);

  // Ahead, but every commit since the tag was a direct push. Stage 3 of the
  // Node panel drops these: buildscript bumps and workflow edits go straight
  // to the default branch and nobody is waiting on a release for them.
  addRepo(db, "DirectOnly");
  addRelease(db, "DirectOnly", "v2.0", 30);
  addCommit(db, "DirectOnly", 10);

  // The build resolved via_pr itself, so no PR row is needed.
  addRepo(db, "BuildResolved");
  addRelease(db, "BuildResolved", "v3.0", 30);
  addCommit(db, "BuildResolved", 4, { viaPr: 1 });

  // Up to date — the release is newer than every commit.
  addRepo(db, "UpToDate");
  addRelease(db, "UpToDate", "v4.0", 2);
  addCommit(db, "UpToDate", 10, { viaPr: 1 });

  // Never released. The GraphQL sweep drops these for free and so must this.
  addRepo(db, "NeverReleased");
  addCommit(db, "NeverReleased", 3, { viaPr: 1 });

  // A draft must not count as the latest release: the real latest is v5.0,
  // and the commit is newer than that, so this repo is behind.
  addRepo(db, "HasDraft");
  addRelease(db, "HasDraft", "v6.0-draft", 1, { draft: true });
  addRelease(db, "HasDraft", "v5.0", 40);
  addCommit(db, "HasDraft", 20, { viaPr: 1 });

  // A prerelease *is* a release. A repo that just cut an rc is not waiting.
  addRepo(db, "JustCutRc");
  addRelease(db, "JustCutRc", "v7.0-rc1", 1, { prerelease: true });
  addCommit(db, "JustCutRc", 10, { viaPr: 1 });

  addRepo(db, "Archived", { archived: true });
  addRelease(db, "Archived", "v8.0", 30);
  addCommit(db, "Archived", 5, { viaPr: 1 });

  // A private repo is included, matching the build. Withholding it here made
  // the Worker quietly stricter than the page it was replacing — seven repos
  // that the build publishes were missing from the live card, which reads as a
  // broken port rather than as a policy. NH_INGEST_EXCLUDE is the lever, and it
  // is applied in scope.js across every table at once.
  addRepo(db, "PrivateRepo", { private: true });
  addRelease(db, "PrivateRepo", "v10.0", 30);
  addCommit(db, "PrivateRepo", 5, { viaPr: 1 });

  // A stale `pushed_at` must not remove a repo that has commits. In production
  // 27 repos carried a `pushed_at` older than a year while having commits
  // inside the lookback, and the cutoff dropped every one of them — a repo
  // cannot both have been pushed to last week and have a year-old pushed_at,
  // so between the two the commits are the better authority.
  addRepo(db, "StalePushedAt", { pushedAt: ago(500) });
  addRelease(db, "StalePushedAt", "v9.0", 90);
  addCommit(db, "StalePushedAt", 10, { viaPr: 1 });

  // Genuinely dormant: no commits after its release. Dropped by the data
  // rather than by a predicate, which is the point — the commit rows are
  // already the bound the cutoff was trying to be.
  addRepo(db, "TrulyDormant", { pushedAt: ago(500) });
  addRelease(db, "TrulyDormant", "v9.1", 900);
  addCommit(db, "TrulyDormant", 950, { viaPr: 1 });

  const rows = await needsRelease(d1(db), NOW);
  const got = byRepo(rows);

  check("a repo ahead with a merged PR is listed", Boolean(got.Ahead));
  check(
    "commitsAhead counts commits after the release",
    got.Ahead?.commitsAhead === 2,
    String(got.Ahead?.commitsAhead),
  );
  check(
    "daysSinceRelease is measured from the release",
    got.Ahead?.daysSinceRelease === 30,
    String(got.Ahead?.daysSinceRelease),
  );
  check("the tag name is the latest release's", got.Ahead?.tagName === "v1.0");
  check(
    "ahead with no PR in the range is dropped",
    !got.DirectOnly,
    "buildscript-only pushes should not ask for a release",
  );
  check("via_pr from the build satisfies the PR test", Boolean(got.BuildResolved));
  check("a repo up to date is dropped", !got.UpToDate);
  check("a repo with no releases is dropped", !got.NeverReleased);
  check("a draft is not the latest release", Boolean(got.HasDraft));
  check("the draft's tag is not reported", got.HasDraft?.tagName === "v5.0");
  check("a prerelease counts as a release", !got.JustCutRc);
  check("an archived repo is dropped", !got.Archived);
  check(
    "a stale pushed_at does not drop a repo that has commits",
    Boolean(got.StalePushedAt),
    "the commits are a better authority than a copied timestamp",
  );
  check(
    "a repo with no commits after its release is dropped by the data",
    !got.TrulyDormant,
  );
  check(
    "a private repo is included, as the build includes it",
    Boolean(got.PrivateRepo),
    "the exclusion lever is NH_INGEST_EXCLUDE, not a predicate in this panel",
  );

  check(
    "the frontend's fields are all present",
    ["repo", "repoUrl", "tagName", "releaseUrl", "isPrerelease", "commitsAhead",
     "daysSinceRelease", "defaultBranch"].every((k) => k in (got.Ahead ?? {})),
    JSON.stringify(got.Ahead),
  );

  check(
    "repoUrl and releaseUrl are derived, not stored",
    got.Ahead?.repoUrl === "https://github.com/GTNewHorizons/Ahead" &&
      got.Ahead?.releaseUrl === "https://github.com/GTNewHorizons/Ahead/releases/tag/v1.0",
    `${got.Ahead?.repoUrl} / ${got.Ahead?.releaseUrl}`,
  );

  // The Node panel sorts by commitsAhead descending.
  const many = "Many";
  addRepo(db, many);
  addRelease(db, many, "v1", 30);
  for (let i = 0; i < 5; i++) {
    const sha = addCommit(db, many, 10 - i);
    if (i === 0) addMergedPr(db, many, 100 + i, sha);
  }
  const sorted = await needsRelease(d1(db), NOW);
  check(
    "sorted by commitsAhead, most behind first",
    sorted.every((r, i) => i === 0 || sorted[i - 1].commitsAhead >= r.commitsAhead),
    sorted.map((r) => `${r.repo}:${r.commitsAhead}`).join(" "),
  );

  db.close();
}

// ------------------------------------------------------- snapshot lines

console.log("\na snapshot's line");

{
  const db = blank();
  const line = db.prepare(
    `INSERT INTO release_snapshot_tags (snapshot, repo, tag, base_tag, series, since, updated_by, updated_at)
     VALUES ('2.9.x', ?, ?, ?, ?, ?, 'admin', ?)`,
  );

  addRepo(db, "Lined");
  addRelease(db, "Lined", "5.09.54.233", 20);
  addRelease(db, "Lined", "5.09.55.0", 10);
  addRelease(db, "Lined", "5.09.54.234", 2);
  line.run("Lined", "5.09.54.234", "5.09.54.233", "5.09.54.*", ago(15), ago(2));
  const l1 = addCommit(db, "Lined", 5);
  addMergedPr(db, "Lined", 1, l1);
  addCommit(db, "Lined", 3);

  addRepo(db, "Unbumped");
  addRelease(db, "Unbumped", "1.1.71-GTNH", 20);
  line.run("Unbumped", "1.1.71-GTNH", "1.1.71-GTNH", "1.1.*", ago(15), ago(15));
  const u1 = addCommit(db, "Unbumped", 5);
  addMergedPr(db, "Unbumped", 2, u1);

  const got = byRepo(await needsRelease(d1(db), NOW));
  check(
    "a release on the snapshot's line isn't master's latest",
    got.Lined?.tagName === "5.09.55.0" && got.Lined?.commitsAhead === 2,
    JSON.stringify(got.Lined),
  );
  check(
    "the snapshot's base tag still counts",
    got.Unbumped?.tagName === "1.1.71-GTNH" && got.Unbumped?.commitsAhead === 1,
    JSON.stringify(got.Unbumped),
  );

  db.close();
}

{
  const db = blank();
  db.exec("DROP TABLE release_snapshot_tags");
  addRepo(db, "Premigration");
  addRelease(db, "Premigration", "1.0.0", 10);
  const p1 = addCommit(db, "Premigration", 5);
  addMergedPr(db, "Premigration", 3, p1);
  const got = byRepo(await needsRelease(d1(db), NOW));
  check("before the snapshot tables exist, the card still answers", got.Premigration?.tagName === "1.0.0", JSON.stringify(got));
  db.close();
}

// ------------------------------------------------------- the store's horizon

console.log("\nhow far back the store can see");

{
  const db = blank();

  // The release predates the sweep, so the count is only the commits that fell
  // inside the window. Measured against the live build: 20 where the truth was
  // 106, printed as a bare number.
  addRepo(db, "OldRelease", { commitsSince: ago(365) });
  addRelease(db, "OldRelease", "v1.0", 1268);
  const m1 = addCommit(db, "OldRelease", 200);
  addMergedPr(db, "OldRelease", 1, m1);
  addCommit(db, "OldRelease", 100);

  // Same shape, but the deep walk reached the release, so the count is real.
  addRepo(db, "Deepened", { commitsSince: ago(1300) });
  addRelease(db, "Deepened", "v1.0", 1268);
  const m2 = addCommit(db, "Deepened", 900);
  addMergedPr(db, "Deepened", 2, m2);

  const got = byRepo(await needsRelease(d1(db), NOW));

  check(
    "a release older than the horizon is flagged approximate",
    got.OldRelease?.commitsAheadApprox === true,
    JSON.stringify(got.OldRelease),
  );
  check(
    "a repo walked back past its release is not flagged",
    got.Deepened?.commitsAheadApprox === false,
    JSON.stringify(got.Deepened),
  );
  check(
    "the count itself is still reported either way",
    got.OldRelease?.commitsAhead === 2 && got.Deepened?.commitsAhead === 1,
  );

  db.close();
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
