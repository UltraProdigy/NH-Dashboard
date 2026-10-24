const PRE = /-pre$/i;

export const DEFAULT_RULE = { fromEnd: 0, step: 1 };

export function parseTag(tag) {
  const raw = String(tag ?? "").trim();
  if (!raw || /\s/.test(raw)) return null;
  const pre = PRE.test(raw);
  const pieces = raw.replace(PRE, "").split(/(\d+)/);
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
