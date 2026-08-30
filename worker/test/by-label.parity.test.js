/**
 * The SQL "PRs by label" card, against the rules the search version implies.
 *
 *   node --experimental-sqlite worker/test/by-label.parity.test.js
 *
 * Written before the panel. The baseline is synthetic for the same reason the
 * release cards' is: the Node version asks GitHub's search API once per label,
 * so a live comparison measures ingest freshness rather than logic, and the
 * cases that decide this card are ones the seed contains few of.
 *
 * The three that matter, and all three are easy to get wrong:
 *
 *   **Drafts are included.** The query is `org:X is:pr is:open label:"L"` with
 *   no `-is:draft`, unlike the two review cards which both carry it. Copying
 *   their OPEN predicate would silently drop every draft.
 *
 *   **Only managed labels get a column.** The label set comes from
 *   Label-Sync-GTNH, not from whatever labels happen to be in use, so a label
 *   nobody manages is not a missing column — it is correctly absent.
 *
 *   **A label with no open PRs still gets a column**, empty. The Node version
 *   runs a search per managed label and keeps the empty result, and the
 *   frontend reads `Object.keys` as the tracked-label list.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { byLabel } from "../src/panels/by-label.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = path.join(HERE, "..", "schema.sql");

const DAY = 86_400_000;
const NOW = Date.parse("2026-08-30T12:00:00Z");
const ago = (days) =>
  new Date(NOW - days * DAY).toISOString().replace(".000Z", "Z");

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

function addLabel(db, name, colour, position) {
  db.prepare(
    "INSERT INTO labels (name, color, description, position) VALUES (?, ?, NULL, ?)",
  ).run(name, colour, position);
}

let n = 0;
function addPr(db, repo, labels, extra = {}) {
  const number = ++n;
  db.prepare(
    `INSERT INTO pull_requests
       (repo, number, title, author, created_at, updated_at, merged_at, closed_at,
        state, is_draft, labels)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    repo,
    number,
    extra.title ?? `pr ${number}`,
    extra.author ?? "someone",
    ago(extra.ageDays ?? 10),
    ago(extra.staleDays ?? 5),
    extra.mergedAt ?? null,
    extra.closedAt ?? null,
    extra.state ?? "OPEN",
    extra.draft ? 1 : 0,
    JSON.stringify(labels),
  );
  return number;
}

const NEW_FEATURE = "New Feature";
const BUG_FIX = "Bug Fix";
const CHORE = "Chore";

console.log("\nbyLabel");

{
  const db = blank();
  addLabel(db, NEW_FEATURE, "56964a", 0);
  addLabel(db, BUG_FIX, "7ff74f", 1);
  addLabel(db, CHORE, "ffffff", 2);

  addPr(db, "Angelica", [NEW_FEATURE], { ageDays: 30 });
  addPr(db, "GT5-Unofficial", [NEW_FEATURE, BUG_FIX], { ageDays: 10 });
  addPr(db, "Chisel", [BUG_FIX], { ageDays: 5, draft: true });
  addPr(db, "Botania", ["Unmanaged Label"], { ageDays: 3 });
  addPr(db, "Natura", [NEW_FEATURE], { state: "MERGED", mergedAt: ago(1) });
  addPr(db, "Opis", [NEW_FEATURE], { state: "CLOSED", closedAt: ago(1) });

  const got = await byLabel(d1(db), NOW);

  check(
    "every managed label gets a column, in config order",
    JSON.stringify(Object.keys(got)) === JSON.stringify([NEW_FEATURE, BUG_FIX, CHORE]),
    JSON.stringify(Object.keys(got)),
  );
  check(
    "a managed label with no open PRs is present and empty",
    Array.isArray(got[CHORE]) && got[CHORE].length === 0,
  );
  check(
    "a PR appears under each of its labels",
    got[NEW_FEATURE].some((r) => r.repo.endsWith("GT5-Unofficial")) &&
      got[BUG_FIX].some((r) => r.repo.endsWith("GT5-Unofficial")),
  );

  // The difference from the two review cards, and the easiest thing to break
  // by copying their predicate.
  check(
    "a draft is included",
    got[BUG_FIX].some((r) => r.repo.endsWith("Chisel") && r.draft === true),
    JSON.stringify(got[BUG_FIX].map((r) => `${r.repo}:${r.draft}`)),
  );

  check(
    "an unmanaged label gets no column",
    !("Unmanaged Label" in got),
    Object.keys(got).join(", "),
  );
  check(
    "merged and closed pull requests are excluded",
    !got[NEW_FEATURE].some((r) => r.repo.endsWith("Natura") || r.repo.endsWith("Opis")),
    JSON.stringify(got[NEW_FEATURE].map((r) => r.repo)),
  );
  check(
    "oldest first, matching the Node sort",
    got[NEW_FEATURE][0].repo.endsWith("Angelica"),
    JSON.stringify(got[NEW_FEATURE].map((r) => r.ageDays)),
  );

  // The regression the labels table exists to fix: D1 stores names only, so
  // every live chip rendered uncoloured until the palette had somewhere to live.
  const chip = got[NEW_FEATURE][0].labels.find((l) => l.name === NEW_FEATURE);
  check("label chips carry their colour", chip?.color === "56964a", JSON.stringify(chip));

  check(
    "the row shape matches the other PR cards",
    ["repo", "number", "title", "url", "author", "draft", "labels", "createdAt",
     "updatedAt", "ageDays", "staleDays"].every((k) => k in got[NEW_FEATURE][0]),
    JSON.stringify(got[NEW_FEATURE][0]),
  );
  check(
    "repo is org-qualified, as the search version returns it",
    got[NEW_FEATURE][0].repo === "GTNewHorizons/Angelica",
    got[NEW_FEATURE][0].repo,
  );

  db.close();
}

{
  // An empty labels table means backfill-labels.js has not run. The card is
  // then empty rather than wrong, and `trackedLabels` on the frontend is empty
  // too — which is visible, unlike a card quietly missing half its columns.
  const db = blank();
  addPr(db, "Angelica", [NEW_FEATURE]);
  const got = await byLabel(d1(db), NOW);
  check("no managed labels means no columns", Object.keys(got).length === 0);
  db.close();
}

{
  // The cap exists to bound the Node version's cost — one search request per
  // label — and it takes the first N by config order. The SQL version has no
  // such cost, but it has to agree on which labels are tracked or the two
  // disagree about what the card even contains.
  const db = blank();
  for (let i = 0; i < 60; i++) addLabel(db, `label-${i}`, "ffffff", i);
  const got = await byLabel(d1(db), NOW);
  check(
    "the tracked-label cap is respected",
    Object.keys(got).length === 40,
    String(Object.keys(got).length),
  );
  check(
    "and it takes the first by position, not by name",
    Object.keys(got)[0] === "label-0" && Object.keys(got).includes("label-39"),
    Object.keys(got).slice(0, 3).join(", "),
  );
  db.close();
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
