/**
 * Permission levels and effective access, shared by the webhook Worker, the app
 * Worker and the Permissions page so the three can't disagree about who can do
 * what. How effective access is worked out is in docs/Calculations.md.
 */

export const LEVELS = ["read", "triage", "write", "maintain", "admin"];

const RANK = new Map(LEVELS.map((level, i) => [level, i + 1]));

export const rank = (level) => RANK.get(level) ?? 0;

const REST_KEYS = [["admin", "admin"], ["maintain", "maintain"], ["push", "write"], ["triage", "triage"], ["pull", "read"]];

export function levelOf(value) {
  if (value == null) return null;
  if (typeof value === "object") {
    const hit = REST_KEYS.find(([key]) => value[key] === true);
    return hit ? hit[1] : null;
  }
  const text = String(value).toLowerCase();
  if (text === "push") return "write";
  if (text === "pull") return "read";
  return RANK.has(text) ? text : null;
}

export const higher = (a, b) => (rank(b) > rank(a) ? b : a);
