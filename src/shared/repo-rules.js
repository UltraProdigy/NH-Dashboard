/**
 * Which repos are excluded, in both languages.
 *
 * The list is a wildcard pattern set, ordered, last match wins, and a leading
 * `!` un-excludes — so `Foo-*,!Foo-Public` excludes the family and spares one
 * member. That is three behaviours a second implementation can get wrong
 * quietly, and the Worker needs one because it reads D1 directly and never goes
 * through `readStore`.
 *
 * So the matcher and its SQL twin are generated from the same patterns here,
 * and `test/exclusion.test.js` runs both over the same names and asserts they
 * agree. The failure mode being guarded against is not an error — it is a repo
 * appearing on a public page — so agreement has to be asserted rather than
 * assumed.
 *
 * Dependency-free, because a Worker bundles it.
 */

/** `a, b ,c` -> `["a","b","c"]`. Empty and whitespace entries are dropped. */
export const parseRepoList = (raw) =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function compileRules(patterns) {
  return patterns.map((raw) => {
    const negated = raw.startsWith("!");
    const pattern = negated ? raw.slice(1) : raw;
    const re = new RegExp(
      `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`,
      "i",
    );
    return { negated, re };
  });
}

/** Last matching rule decides. A negated rule un-excludes. */
export function matchesAny(rules, repoName) {
  let excluded = false;
  for (const rule of rules) {
    if (rule.re.test(repoName)) excluded = !rule.negated;
  }
  return excluded;
}

/**
 * One pattern as a SQL LIKE literal.
 *
 * `*` and `?` become `%` and `_`; a `%` or `_` that was already in the name is
 * escaped, because otherwise a repo literally called `report_v2` would match
 * `reportXv2` and exclude a repo nobody asked to exclude. `\` is the escape
 * character, declared per-comparison with ESCAPE.
 *
 * Single quotes are doubled. The patterns come from an operator's environment
 * rather than from user input, but this string is concatenated into SQL and a
 * repo name with an apostrophe would otherwise produce a syntax error at best.
 */
const likePattern = (pattern) =>
  pattern
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_")
    .replace(/\*/g, "%")
    .replace(/\?/g, "_")
    .replace(/'/g, "''");

/**
 * `matchesAny` as SQL: 1 when the column names an excluded repo.
 *
 * Last-match-wins becomes first-match-wins over the reversed list, which is the
 * same rule read from the other end and is what a CASE can express. With no
 * patterns it collapses to `0` — nothing is excluded — rather than to an empty
 * string that would leave the surrounding SQL malformed.
 *
 * LIKE is case-insensitive over ASCII in SQLite, which is what the matcher's
 * `i` flag buys on the JavaScript side.
 */
export function excludedRepoSql(column, patterns) {
  if (!patterns.length) return "0";

  const arms = [...patterns].reverse().map((raw) => {
    const negated = raw.startsWith("!");
    const body = negated ? raw.slice(1) : raw;
    return `WHEN ${column} LIKE '${likePattern(body)}' ESCAPE '\\' THEN ${negated ? 0 : 1}`;
  });

  return `(CASE ${arms.join(" ")} ELSE 0 END)`;
}

/** The negation, which is what a query's WHERE clause actually wants. */
export const includedRepoSql = (column, patterns) =>
  patterns.length ? `${excludedRepoSql(column, patterns)} = 0` : "1";
