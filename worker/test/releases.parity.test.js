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
 *
 * What *is* asserted against the real seed is the pair in commit-rules.js:
 * `isDirectCommit` and `isDirectCommitSql` must agree row for row, because two
 * readings of one rule are exactly what drifts invisibly.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  commitAuthor,
  headline,
  isDirectCommit,
  isDirectCommitSql,
  utcSeconds,
  viaPullRequest,
} from "../../src/shared/commit-rules.js";
import { depUpdates, needsRelease } from "../src/panels/releases.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(HERE, "..", "seed.sql");
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
    `INSERT INTO repos (name, full_name, private, archived, default_branch, pushed_at, updated_at)
     VALUES (?, ?, 0, ?, ?, ?, ?)`,
  ).run(
    name,
    `GTNewHorizons/${name}`,
    extra.archived ? 1 : 0,
    extra.defaultBranch ?? "master",
    extra.pushedAt ?? ago(1),
    extra.pushedAt ?? ago(1),
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

  // Dormant for longer than STALE_REPO_CUTOFF_DAYS. "Nobody has released this
  // in two years" is not news about a repo nobody has touched in two years.
  addRepo(db, "Dormant", { pushedAt: ago(500) });
  addRelease(db, "Dormant", "v9.0", 900);
  addCommit(db, "Dormant", 600, { viaPr: 1 });

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
  check("a dormant repo is dropped", !got.Dormant);

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

// ---------------------------------------------------------------- depUpdates

console.log("\ndepUpdates");

{
  const db = blank();

  // The newest *direct* commit is the answer, not the newest commit.
  addRepo(db, "MixedHistory");
  const viaPr = addCommit(db, "MixedHistory", 2);
  addMergedPr(db, "MixedHistory", 1, viaPr);
  addCommit(db, "MixedHistory", 40, { message: "bump deps" });
  addCommit(db, "MixedHistory", 200, { message: "older direct" });

  // A bot pushing generated files is not a maintainer bumping a dependency.
  addRepo(db, "BotPushed");
  addCommit(db, "BotPushed", 3, { author: "dependabot[bot]" });
  addCommit(db, "BotPushed", 90, { author: "a-human" });

  // Nothing but pull requests inside the lookback. The Node panel calls this a
  // floor rather than a date, and the card renders it differently.
  addRepo(db, "AllPrs");
  const only = addCommit(db, "AllPrs", 15);
  addMergedPr(db, "AllPrs", 2, only);

  addRepo(db, "Archived2", { archived: true });
  addCommit(db, "Archived2", 5);

  const rows = await depUpdates(d1(db), NOW);
  const got = byRepo(rows);

  check(
    "the newest direct commit wins, not the newest commit",
    got.MixedHistory?.daysSinceDirect === 40,
    String(got.MixedHistory?.daysSinceDirect),
  );
  check("a merged PR's commit is not direct", got.MixedHistory?.approx === false);
  check(
    "the message and author come from that commit",
    got.MixedHistory?.message === "bump deps" && got.MixedHistory?.author === "someone",
  );
  check(
    "a bot's direct push is skipped",
    got.BotPushed?.daysSinceDirect === 90,
    String(got.BotPushed?.daysSinceDirect),
  );
  check("a repo with only PR commits is a floor", got.AllPrs?.approx === true);
  check("a floor row has no commit to link", got.AllPrs?.commitUrl === null);
  check("an archived repo is dropped", !got.Archived2);

  check(
    "sorted oldest first",
    rows.every((r, i) => i === 0 || rows[i - 1].daysSinceDirect >= r.daysSinceDirect),
    rows.map((r) => `${r.repo}:${r.daysSinceDirect}`).join(" "),
  );

  db.close();
}

// --------------------------------------------- the two readings of one rule

console.log("\nisDirectCommit against isDirectCommitSql");

if (!existsSync(SEED)) {
  console.log("  skip  no seed.sql — run node worker/seed.js --out worker/seed.sql");
} else {
  const db = blank();
  db.exec(readFileSync(SEED, "utf8"));

  // The seed predates the commits table, so the authors it can disagree about
  // are PR authors — which is the point: the bot half of this rule is
  // `isBot`'s, and a login is a login whoever wrote it.
  const authors = db
    .prepare("SELECT DISTINCT author FROM pull_requests WHERE author IS NOT NULL")
    .all()
    .map((r) => r.author);

  db.exec("DELETE FROM commits");
  const insert = db.prepare(
    `INSERT INTO commits (repo, sha, committed_at, author, message, via_pr)
     VALUES ('Parity', ?, '2026-01-01T00:00:00Z', ?, 'x', NULL)`,
  );
  authors.forEach((a, i) => insert.run(`p${String(i).padStart(38, "0")}`, a));

  const sqlSaid = new Set(
    db
      .prepare(
        `SELECT c.author FROM commits c
           LEFT JOIN pull_requests p ON p.repo = c.repo AND p.merge_commit_sha = c.sha
          WHERE c.repo = 'Parity' AND ${isDirectCommitSql()}`,
      )
      .all()
      .map((r) => r.author),
  );

  const disagreed = authors.filter(
    (a) => sqlSaid.has(a) !== isDirectCommit({ author: { username: a } }),
  );

  check(
    `both readings agree on all ${authors.length} authors`,
    disagreed.length === 0,
    disagreed.slice(0, 5).join(", "),
  );

  db.close();
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
