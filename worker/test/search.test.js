/**
 * The search endpoint's contract, against a real seed.
 *
 *   node --experimental-sqlite worker/test/search.test.js
 *
 * Not a parity test, and cannot be one: there is no Node panel to reconcile
 * against, because search is the first read here with no build-time twin. So
 * these assert the properties that would otherwise only be noticed by someone
 * getting a wrong answer and not knowing it was wrong.
 *
 * The two that matter most:
 *
 *   An excluded repo must never appear. Every other panel is aggregate — a
 *   leaked row shows up as a number being slightly too large, which nobody can
 *   see. A search returns the row itself, with its title, on a public endpoint.
 *   This is the worst place in the Worker for `scopedDb` to have been forgotten
 *   and the only place the failure would be legible, so it is asserted here
 *   rather than trusted to the wrapper.
 *
 *   The order must be total. `LIMIT 51` over a tie is whichever rows D1 felt
 *   like that day, and the symptom is a result that moves between two identical
 *   searches — read as data changing rather than as a missing tiebreak.
 *
 * Skips if worker/seed.sql is absent, which it is in CI.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { tmpdir } from "node:os";

import { facets, parseSearch, search } from "../src/search.js";
import { scopedDb } from "../src/scope.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(HERE, "..", "seed.sql");
const SCHEMA = path.join(HERE, "..", "schema.sql");

let pass = 0;
let fail = 0;

function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ok    ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function d1(db) {
  return {
    prepare(sql) {
      let params = [];
      const api = {
        bind(...p) {
          params = p;
          return api;
        },
        async all() {
          return { results: db.prepare(sql).all(...params) };
        },
        async first() {
          return db.prepare(sql).get(...params) ?? null;
        },
        async run() {
          return db.prepare(sql).run(...params);
        },
      };
      return api;
    },
  };
}

function load() {
  const file = path.join(tmpdir(), `nh-search-${process.pid}.db`);
  try {
    unlinkSync(file);
  } catch {}
  const db = new DatabaseSync(file);
  db.exec(readFileSync(SCHEMA, "utf8"));
  db.exec("BEGIN");
  db.exec(readFileSync(SEED, "utf8"));
  db.exec("COMMIT");
  return { db, file };
}

/** A search from a query string, which is the shape the route actually gets. */
const run = (handle, qs) =>
  search(handle, parseSearch(new URLSearchParams(qs)));

async function main() {
  if (!existsSync(SEED)) {
    console.log("\nskipped: needs worker/seed.sql, which is not committed\n");
    return;
  }

  console.log("\nsearch\n");
  const { db, file } = load();
  const open = scopedDb(d1(db), {});

  console.log("reading the query string");
  check("defaults to both kinds", parseSearch(new URLSearchParams("q=x")).kinds.length === 2);
  check("defaults to updated", parseSearch(new URLSearchParams("q=x")).sort === "updated");
  check(
    "an unknown sort falls back rather than reaching SQL",
    parseSearch(new URLSearchParams("q=x&sort=; DROP TABLE issues")).sort === "updated",
  );
  check("#4821 is read as a number", parseSearch(new URLSearchParams("q=%234821")).number === 4821);
  check("4821 is read as a number", parseSearch(new URLSearchParams("q=4821")).number === 4821);
  check(
    "a number search carries no text predicate",
    parseSearch(new URLSearchParams("q=4821")).q === "",
  );
  check(
    "list filters are bounded",
    parseSearch(new URLSearchParams(`repo=${Array.from({ length: 60 }, (_, i) => `r${i}`).join(",")}`))
      .repos.length === 20,
  );

  console.log("\nnothing asked, still answered");
  // The empty form is the page's opening state, so it has to be a real answer
  // rather than a refusal — picking `state=open` and nothing else is equally
  // "no question" and always returned a list, and one of the two behaving
  // differently is the inconsistency this asserts against.
  const blank = await run(open, "");
  check("an empty query returns the most recent page", blank.rows.length === 50, `${blank.rows.length}`);
  check("and is bounded like any other search", blank.truncated === true);
  check(
    "newest first",
    blank.rows.every((r, i) => i === 0 || blank.rows[i - 1].staleDays <= r.staleDays),
  );

  console.log("\nmatching titles");
  // Taken from the store rather than hardcoded, so the test survives a reseed.
  const sample = db
    .prepare("SELECT repo, number, title FROM issues WHERE length(title) > 20 ORDER BY number LIMIT 1")
    .get();
  const fragment = sample.title.slice(4, 14);
  const hit = await run(open, `q=${encodeURIComponent(fragment)}&type=issue`);
  check(
    `a mid-title fragment matches (${JSON.stringify(fragment)})`,
    hit.rows.some((r) => r.repo === sample.repo && r.number === sample.number),
    `${hit.rows.length} rows`,
  );
  const shouted = await run(open, `q=${encodeURIComponent(fragment.toUpperCase())}&type=issue`);
  check(
    "matching is case-insensitive",
    shouted.rows.length === hit.rows.length,
    `${shouted.rows.length} vs ${hit.rows.length}`,
  );

  console.log("\nvalues that look like SQL are values");
  for (const nasty of ["100%", "a_b", "'; DROP TABLE issues; --", 'say "hi"']) {
    const res = await run(open, `q=${encodeURIComponent(nasty)}`);
    check(`${JSON.stringify(nasty)} is matched literally`, Array.isArray(res.rows));
  }
  check(
    "the tables are still there",
    db.prepare("SELECT COUNT(*) n FROM issues").get().n > 0,
  );
  // `%` is a LIKE wildcard and would match every row if the predicate were
  // LIKE rather than instr — the one assertion that would catch a rewrite back.
  const wild = await run(open, "q=%25%25%25&type=issue");
  check("a wildcard string is not a wildcard", wild.rows.length === 0, `${wild.rows.length} rows`);

  console.log("\nkinds");
  const issuesOnly = await run(open, "q=fix&type=issue");
  check("type=issue returns only issues", issuesOnly.rows.every((r) => r.kind === "issue"));
  const prsOnly = await run(open, "q=fix&type=pr");
  check("type=pr returns only pull requests", prsOnly.rows.every((r) => r.kind === "pr"));
  const both = await run(open, "q=fix&type=both");
  check("type=both returns some of each",
        both.rows.some((r) => r.kind === "pr") && both.rows.some((r) => r.kind === "issue"));

  console.log("\nstates");
  const merged = await run(open, "state=merged");
  check("merged returns only merged rows", merged.rows.every((r) => r.state === "MERGED"));
  check("and no issues, which cannot be merged", merged.rows.every((r) => r.kind === "pr"));
  const closed = await run(open, "state=closed&type=pr");
  check(
    "closed does not quietly include merged",
    closed.rows.every((r) => r.state === "CLOSED"),
    closed.rows.map((r) => r.state).join(","),
  );
  const openRows = await run(open, "state=open");
  check("open returns only open rows", openRows.rows.every((r) => r.state === "OPEN"));

  console.log("\nfilters");
  const repo = db.prepare("SELECT repo, COUNT(*) n FROM issues GROUP BY repo ORDER BY n DESC LIMIT 1").get();
  const byRepo = await run(open, `repo=${encodeURIComponent(repo.repo)}&type=issue`);
  check(`repo filter holds (${repo.repo})`, byRepo.rows.every((r) => r.repo === repo.repo));

  const author = db
    .prepare("SELECT author, COUNT(*) n FROM issues WHERE author IS NOT NULL GROUP BY author ORDER BY n DESC LIMIT 1")
    .get();
  const byAuthor = await run(open, `author=${encodeURIComponent(author.author.toUpperCase())}&type=issue`);
  check(
    `author filter is case-insensitive (${author.author})`,
    byAuthor.rows.length > 0 &&
      byAuthor.rows.every((r) => r.author.toLowerCase() === author.author.toLowerCase()),
    `${byAuthor.rows.length} rows`,
  );

  const label = db
    .prepare(`SELECT value AS name, COUNT(*) n FROM issues, json_each(labels)
               GROUP BY value ORDER BY n DESC LIMIT 1`)
    .get();
  const byLabel = await run(open, `label=${encodeURIComponent(label.name)}&type=issue`);
  check(
    `label filter holds (${label.name})`,
    byLabel.rows.length > 0 && byLabel.rows.every((r) => r.labels.includes(label.name)),
    `${byLabel.rows.length} rows`,
  );

  console.log("\nnumbers are looked up, not scanned");
  const numbered = await run(open, `q=${sample.number}&type=issue`);
  check(
    `#${sample.number} finds the issue itself`,
    numbered.rows.some((r) => r.repo === sample.repo && r.number === sample.number),
  );
  check("and every row carries that number", numbered.rows.every((r) => r.number === sample.number));

  console.log("\nthe page, and what is past it");
  const broad = await run(open, "state=open");
  check("a broad search is cut to a page", broad.rows.length === 50, `${broad.rows.length}`);
  check("and says there is more", broad.truncated === true);
  const narrow = await run(open, `repo=${encodeURIComponent(repo.repo)}&q=zzzqqq`);
  check("a search with nothing behind it is not truncated", narrow.truncated === false);

  console.log("\norder");
  const a = await run(open, "state=open&sort=comments");
  const b = await run(open, "state=open&sort=comments");
  check(
    "the same search twice is the same order",
    a.rows.map((r) => `${r.repo}#${r.number}`).join() ===
      b.rows.map((r) => `${r.repo}#${r.number}`).join(),
  );
  check(
    "sorted by the key it was asked for",
    a.rows.every((r, i) => i === 0 || a.rows[i - 1].comments >= r.comments),
  );
  const oldest = await run(open, "state=open&sort=oldest");
  check(
    "oldest really is ascending",
    oldest.rows.every((r, i) => i === 0 || oldest.rows[i - 1].ageDays >= r.ageDays),
  );

  console.log("\nexcluded repos");
  const secret = db
    .prepare("SELECT repo, COUNT(*) n FROM issues GROUP BY repo ORDER BY n DESC LIMIT 1")
    .get().repo;
  const scoped = scopedDb(d1(db), { NH_INGEST_EXCLUDE: secret });
  const leak = await run(scoped, `repo=${encodeURIComponent(secret)}`);
  check(`asking for an excluded repo by name returns nothing (${secret})`,
        leak.rows.length === 0, `${leak.rows.length} rows`);
  const wide = await run(scoped, "state=open");
  check("and it is absent from an open-ended search", wide.rows.every((r) => r.repo !== secret));
  // The label predicate reads `json_each(labels)`, which the scope rewrite must
  // not touch and must not be defeated by — a row's labels are reachable only
  // through the row, so scoping the row is enough. Asserted because the FROM in
  // that subquery is the one place the rewrite could plausibly have fired.
  const labelled = await run(scoped, `label=${encodeURIComponent(label.name)}`);
  check("nor from a label search", labelled.rows.every((r) => r.repo !== secret));

  console.log("\nfacets");
  const f = await facets(open);
  check("repos come back", f.repos.length > 0, `${f.repos.length}`);
  check("authors come back", f.authors.length > 0, `${f.authors.length}`);
  check("labels come back", f.labels.length > 0, `${f.labels.length}`);

  // The bug this endpoint exists for. The page used to build these lists from
  // `labelsByRepo`, an issue-analytics aggregate covering 21 repos and no pull
  // request labels at all — so a label on a repo with no issue labels could not
  // be picked. Asserted against the store rather than against a number, since
  // the seed moves.
  const allLabels = new Set(
    db.prepare(`SELECT DISTINCT value AS v FROM issues, json_each(labels)
                 UNION SELECT DISTINCT value FROM pull_requests, json_each(labels)`)
      .all().map((r) => r.v),
  );
  check("every label in the store is offered", f.labels.length === allLabels.size,
        `${f.labels.length} of ${allLabels.size}`);
  const prOnlyLabel = db.prepare(
    `SELECT DISTINCT value AS v FROM pull_requests, json_each(labels)
      WHERE value NOT IN (SELECT DISTINCT value FROM issues, json_each(labels)) LIMIT 1`).get();
  if (prOnlyLabel)
    check(`a label only pull requests carry is offered (${prOnlyLabel.v})`,
          f.labels.some((l) => l.name === prOnlyLabel.v));

  // A label carried by nine repos is one row, not nine. DISTINCT does it, and
  // this is the assertion that says so out loud.
  const dupes = f.labels.map((l) => l.name).filter((n, i, a) => a.indexOf(n) !== i);
  check("no label is offered twice", dupes.length === 0, dupes.slice(0, 5).join(", "));
  check("no repo is offered twice",
        new Set(f.repos.map((r) => r.name)).size === f.repos.length);
  check("no author is offered twice",
        new Set(f.authors.map((a) => a.name)).size === f.authors.length);

  check("busiest first", f.labels.every((l, i) => i === 0 || f.labels[i - 1].n >= l.n));

  // Repos with pull requests and no tracker were missing from the old list.
  const prOnly = db.prepare(`SELECT DISTINCT repo FROM pull_requests
                              WHERE repo NOT IN (SELECT DISTINCT repo FROM issues) LIMIT 1`).get();
  if (prOnly)
    check(`a repo with no issues is offered (${prOnly.repo})`,
          f.repos.some((r) => r.name === prOnly.repo));

  const scopedFacets = await facets(scoped);
  check("an excluded repo is not offered", !scopedFacets.repos.some((r) => r.name === secret));

  console.log("\nlabel colours");
  // Sent beside the rows because the colour belongs to the name, and a page of
  // fifty rows repeats thirty names three times over.
  const coloured = await run(open, `label=${encodeURIComponent(label.name)}`);
  check("a colour map comes back", coloured.labelColors && typeof coloured.labelColors === "object");
  const managed = db.prepare("SELECT name, color FROM labels WHERE color IS NOT NULL").all();
  const namesOnPage = new Set(coloured.rows.flatMap((r) => r.labels));
  check(
    "it only carries names that are on this page",
    Object.keys(coloured.labelColors).every((n) => namesOnPage.has(n)),
    Object.keys(coloured.labelColors).join(", "),
  );
  check(
    "and only names the managed set actually has",
    Object.keys(coloured.labelColors).every((n) => managed.some((m) => m.name === n)),
  );
  // The gap is the point of the assertion: the table holds the managed
  // pull-request set, so an issue label it has never heard of must be absent
  // rather than guessed at — the chip then draws the border it draws
  // everywhere else instead of a wrong colour.
  const anyManaged = await run(open, `q=${encodeURIComponent(managed[0]?.name ?? "zzz")}`);
  check("an unknown label is absent rather than invented",
        Object.keys(anyManaged.labelColors ?? {}).every((n) => managed.some((m) => m.name === n)));

  console.log("\nrow shape");
  const one = (await run(open, "state=open")).rows[0];
  check("carries a GitHub url", /^https:\/\/github\.com\/[^/]+\/[^/]+\/(issues|pull)\/\d+$/.test(one.url));
  check("labels come back as an array", Array.isArray(one.labels));
  check("ages are numbers", Number.isFinite(one.ageDays) && Number.isFinite(one.staleDays));

  db.close();
  try {
    unlinkSync(file);
  } catch {}

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
