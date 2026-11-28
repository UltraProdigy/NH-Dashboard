/**
 * When each person last did something on GTNH that the store records.
 *
 * Read from D1 directly rather than through `scopedDb`: work in an excluded repo
 * still counts, so nobody is called inactive for it. Those repos' names are left
 * out of the answer instead.
 */

import { compileRules, matchesAny, parseRepoList } from "../../src/shared/repo-rules.js";

const SOURCES = [
  { key: "pr", what: "opened a pull request", sql: "SELECT json_array(created_at, repo, number) FROM pull_requests WHERE author = people.login ORDER BY created_at DESC LIMIT 1" },
  { key: "review", what: "reviewed a pull request", sql: "SELECT json_array(submitted_at, repo, pr_number) FROM reviews WHERE author = people.login AND submitted_at IS NOT NULL ORDER BY submitted_at DESC LIMIT 1" },
  { key: "filed", what: "filed an issue", sql: "SELECT json_array(created_at, repo, number) FROM issues WHERE author = people.login ORDER BY created_at DESC LIMIT 1" },
  { key: "replied", what: "replied to an issue", index: "idx_issues_responder",
    sql: "SELECT json_array(first_response_at, repo, number) FROM issues WHERE first_responder = people.login AND first_response_at IS NOT NULL ORDER BY first_response_at DESC LIMIT 1" },
  { key: "closed", what: "closed an issue", index: "idx_issues_closed_by",
    sql: "SELECT json_array(closed_at, repo, number) FROM issues WHERE closed_by = people.login AND closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 1" },
  { key: "pushed", what: "pushed a commit", index: "idx_commits_author",
    sql: "SELECT json_array(committed_at, repo, sha) FROM commits WHERE author = people.login ORDER BY committed_at DESC LIMIT 1" },
];

export const ACTIVITY_SOURCES = Object.fromEntries(SOURCES.map((s) => [s.key, s.what]));

const MAX_PEOPLE = 2000;

async function presentIndexes(db) {
  const wanted = SOURCES.map((s) => s.index).filter(Boolean);
  const { results } = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (${wanted.map(() => "?").join(", ")})`)
    .bind(...wanted)
    .all();
  return new Set(results.map((r) => r.name));
}

const parse = (v) => {
  try { return v ? JSON.parse(v) : null; } catch { return null; }
};

/**
 * `{ login: { at, kind, repo, ref } }` for each login with anything recorded, plus
 * `missing`, the sources left out because migration 014 hasn't run.
 */
export async function lastActive(db, logins, { exclude = "" } = {}) {
  const people = [...new Set((logins ?? []).filter((l) => typeof l === "string" && l))].slice(0, MAX_PEOPLE);
  if (!people.length) return { people: {}, missing: [] };
  const indexes = await presentIndexes(db);
  const used = SOURCES.filter((s) => !s.index || indexes.has(s.index));
  const { results } = await db
    .prepare(`WITH people(login) AS (SELECT value FROM json_each(?1))
      SELECT login, ${used.map((s) => `(${s.sql}) AS ${s.key}`).join(", ")} FROM people`)
    .bind(JSON.stringify(people))
    .all();
  const rules = compileRules(parseRepoList(exclude));
  const out = {};
  for (const row of results) {
    let best = null;
    const each = {};
    for (const s of used) {
      const hit = parse(row[s.key]);
      if (!hit?.[0]) continue;
      each[s.key] = hit[0];
      if (!best || hit[0] > best.at) best = { at: hit[0], kind: s.key, repo: hit[1], ref: hit[2] ?? null };
    }
    if (!best) continue;
    if (rules.length && matchesAny(rules, best.repo)) Object.assign(best, { repo: null, ref: null, excluded: true });
    out[row.login] = { ...best, each };
  }
  return { people: out, missing: SOURCES.filter((s) => !used.includes(s)).map((s) => s.key) };
}
