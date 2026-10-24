const PRE = /-pre$/i;
const MINECRAFT = "1.7.10";
const MINECRAFT_OR_NUMBER = /((?<![\d.])1\.7\.10(?![\d.])|\d+)/;

export const DEFAULT_RULE = { fromEnd: 0, step: 1 };

export const DATED_REPOS = new Set(["GT-New-Horizons-Modpack", "Questbook-Releases"]);

const DATED = /^(.*?)(\d{4}-\d{2}-\d{2})(?:-(\d+))?$/;

export const isDatedTag = (tag) => DATED.test(String(tag ?? ""));

export function predictDatedTag(lastTag, taken, now = Date.now()) {
  const m = DATED.exec(String(lastTag ?? ""));
  if (!m) return null;
  const base = m[1] + new Date(now).toISOString().slice(0, 10);
  if (!taken.has(base)) return base;
  let n = 1;
  for (const t of taken) {
    const same = DATED.exec(t);
    if (same && same[1] + same[2] === base && same[3]) n = Math.max(n, Number(same[3]));
  }
  return `${base}-${String(n + 1).padStart(2, "0")}`;
}

export function parseTag(tag) {
  const raw = String(tag ?? "").trim();
  if (!raw || /\s/.test(raw)) return null;
  const pre = PRE.test(raw);
  const pieces = [""];
  raw.replace(PRE, "").split(MINECRAFT_OR_NUMBER).forEach((tok, i) => {
    if (i % 2 === 1 && tok !== MINECRAFT) pieces.push(tok, "");
    else pieces[pieces.length - 1] += tok;
  });
  const parts = pieces.filter((_, i) => i % 2 === 1);
  if (!parts.length) return null;
  return { pieces, parts, pre };
}

const skeleton = (v) => v.pieces.filter((_, i) => i % 2 === 0).join("#");

const bumped = (part, value) =>
  part.length > 1 && part.startsWith("0") ? String(value).padStart(part.length, "0") : String(value);

function rebuild(v, parts) {
  let n = 0;
  return v.pieces.map((p, i) => (i % 2 === 1 ? parts[n++] : p)).join("");
}

export function predictTag(lastTag, rule = DEFAULT_RULE) {
  const v = parseTag(lastTag);
  if (!v) return null;
  const at = v.parts.length - 1 - (rule.fromEnd ?? 0);
  if (at < 0) return predictTag(lastTag, DEFAULT_RULE);
  const parts = v.parts.map((p, i) => {
    if (i < at) return p;
    if (i === at) return bumped(p, Number(p) + (rule.step ?? 1));
    return bumped(p, 0);
  });
  return rebuild(v, parts);
}

export function learnRule(previousTag, actualTag) {
  const a = parseTag(previousTag);
  const b = parseTag(actualTag);
  if (!a || !b || b.pre || skeleton(a) !== skeleton(b) || a.parts.length !== b.parts.length) return null;
  const at = a.parts.findIndex((p, i) => Number(p) !== Number(b.parts[i]));
  if (at < 0) return null;
  if (Number(b.parts[at]) - Number(a.parts[at]) !== 1) return null;
  if (b.parts.slice(at + 1).some((p) => Number(p) !== 0)) return null;
  return { fromEnd: a.parts.length - 1 - at, step: 1 };
}

export function ruleFrom(corrections) {
  for (const c of corrections) {
    const rule = learnRule(c.previous_tag, c.tag);
    if (rule) return rule;
  }
  return null;
}

export const isDefaultRule = (rule) =>
  !rule || (rule.fromEnd === DEFAULT_RULE.fromEnd && rule.step === DEFAULT_RULE.step);

export const validTagName = (tag) =>
  typeof tag === "string" && /^[0-9A-Za-z][0-9A-Za-z._+-]{0,99}$/.test(tag) && !tag.includes("..") && !tag.endsWith(".");
