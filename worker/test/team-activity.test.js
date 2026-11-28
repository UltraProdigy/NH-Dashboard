/**
 *   node --experimental-sqlite worker/test/team-activity.test.js
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { lastActive } from "../src/team-activity.js";

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  ok ? (pass++, console.log("  ok    " + n))
     : (fail++, console.log("  FAIL  " + n + (d ? " — " + d : "")));
};

const shim = (raw) => ({
  prepare(sql, bound = []) {
    return {
      bind: (...args) => shim(raw).prepare(sql, args),
      async all() { return { results: raw.prepare(sql).all(...bound) }; },
    };
  },
});

function fresh({ withoutMigration = false } = {}) {
  const raw = new DatabaseSync(":memory:");
  let schema = readFileSync("worker/schema.sql", "utf8");
  if (withoutMigration) schema = schema.replace(/CREATE INDEX IF NOT EXISTS idx_(issues_responder|issues_closed_by|commits_author)[^;]*;\n/g, "");
  raw.exec(schema);
  const pr = raw.prepare("INSERT INTO pull_requests (repo, number, author, created_at, updated_at, state) VALUES (?, ?, ?, ?, ?, 'OPEN')");
  pr.run("GT5-Unofficial", 1, "alice", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z");
  pr.run("GT5-Unofficial", 2, "alice", "2025-06-01T00:00:00Z", "2025-06-01T00:00:00Z");
  raw.prepare("INSERT INTO reviews (repo, pr_number, author, state, submitted_at) VALUES (?, ?, ?, ?, ?)").run("Angelica", 9, "alice", "APPROVED", "2026-02-01T00:00:00Z");
  const issue = raw.prepare(`INSERT INTO issues (repo, number, author, created_at, updated_at, state, first_responder, first_response_at, closed_by, closed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  issue.run("NewHorizons", 5, "carol", "2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z", "CLOSED", "bob", "2026-03-01T00:00:00Z", "dave", "2026-04-01T00:00:00Z");
  raw.prepare("INSERT INTO commits (repo, sha, committed_at, author) VALUES (?, ?, ?, ?)").run("Secret-Thing", "abc123", "2026-05-01T00:00:00Z", "erin");
  return shim(raw);
}

{
  const got = await lastActive(fresh(), ["alice", "bob", "carol", "dave", "erin", "ghost"], { exclude: "Secret-*" });
  const p = got.people;
  check("the newest act wins, from any source", p.alice?.kind === "review" && p.alice.at === "2026-02-01T00:00:00Z" && p.alice.repo === "Angelica" && p.alice.ref === 9);
  check("every source a person shows up in is kept", p.alice.each.pr === "2025-06-01T00:00:00Z" && p.alice.each.review === "2026-02-01T00:00:00Z");
  check("first replies, closes and filed issues count", p.bob?.kind === "replied" && p.dave?.kind === "closed" && p.carol?.kind === "filed");
  check("a commit counts, and an excluded repo's name isn't given out", p.erin?.kind === "pushed" && p.erin.at === "2026-05-01T00:00:00Z" && p.erin.repo === null && p.erin.excluded);
  check("someone with nothing recorded isn't in the answer", !("ghost" in p));
  check("nothing is missing once migration 014 has run", got.missing.length === 0);
}

{
  const got = await lastActive(fresh({ withoutMigration: true }), ["alice", "bob", "erin"]);
  check("without migration 014 the unindexed sources are left out and named",
    got.missing.join() === "replied,closed,pushed" && got.people.alice?.kind === "review" && !("bob" in got.people) && !("erin" in got.people), JSON.stringify(got));
  check("no logins, no query", JSON.stringify(await lastActive(null, [])) === JSON.stringify({ people: {}, missing: [] }));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
