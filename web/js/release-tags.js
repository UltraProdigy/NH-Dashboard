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

export const BUMPS = ["predicted", "patch", "minor", "major", "super"];
const POSITIONS = ["patch", "minor", "major", "super"];
const MARKER = /^[-_.]?(?:rc|alpha|beta|pre|a|b)[-_.]?\d+/i;
const MINECRAFT_ANYWHERE = /(?<![\d.])1\.7\.10(?![\d.])/g;

export function versionCore(tag) {
  const raw = String(tag ?? "").trim().replace(PRE, "");
  const minecraft = [...raw.matchAll(MINECRAFT_ANYWHERE)].map((m) => m.index);
  for (const m of raw.matchAll(/\d+(?:\.\d+)*/g)) {
    if (minecraft.includes(m.index)) continue;
    const before = raw.slice(0, m.index);
    if (/[A-Za-z]$/.test(before) && !/(?:^|[-_/])[vV]$/.test(before)) continue;
    return { raw, start: m.index, end: m.index + m[0].length, parts: m[0].split(".") };
  }
  return null;
}

export function bumpTag(lastTag, bump) {
  const want = POSITIONS.indexOf(bump);
  const core = versionCore(lastTag);
  if (want < 0 || !core) return null;
  const fromEnd = Math.min(want, core.parts.length - 1);
  const at = core.parts.length - 1 - fromEnd;
  const parts = core.parts.map((p, i) => (i < at ? p : i === at ? bumped(p, Number(p) + 1) : bumped(p, 0)));
  let rest = core.raw.slice(core.end);
  const marker = MARKER.exec(rest)?.[0] ?? null;
  if (marker) rest = rest.slice(marker.length);
  return {
    tag: core.raw.slice(0, core.start) + parts.join(".") + rest,
    used: POSITIONS[fromEnd],
    fellBack: fromEnd < want,
    numbers: core.parts.length,
    dropped: marker,
  };
}

export const withPre = (tag) => (PRE.test(tag) ? tag : `${tag}-pre`);

const TOKENS = /\{(next|last|date|repo)\}/g;

export const patternTokens = (pattern) => new Set([...String(pattern ?? "").matchAll(TOKENS)].map((m) => m[1]));

export function fillPattern(pattern, values) {
  return String(pattern).replace(TOKENS, (_, k) => values[k] ?? "");
}

function nextTag(row, bump, now) {
  if (row.dated) return { tag: predictDatedTag(row.lastTag, new Set(row.taken ?? []), now), notes: [] };
  if (!row.lastTag) return { tag: null, notes: [] };
  if (bump === "predicted" || !POSITIONS.includes(bump)) {
    return { tag: predictTag(row.lastTag, row.learned ?? undefined), step: (t) => predictTag(t, row.learned ?? undefined), notes: [] };
  }
  const out = bumpTag(row.lastTag, bump);
  if (!out) return { tag: predictTag(row.lastTag), step: (t) => predictTag(t), notes: ["No version number found to bump, so the last number was used"] };
  const notes = [];
  if (out.fellBack) notes.push(`Only ${out.numbers === 1 ? "one number" : `${out.numbers} numbers`}, so this is a ${out.used} bump`);
  if (out.dropped) notes.push(`Dropped ${out.dropped} from the old tag`);
  return { tag: out.tag, step: (t) => bumpTag(t, out.used)?.tag ?? null, notes };
}

export function planTag(row, { bump = "predicted", pattern = "", pre = false, now = Date.now() } = {}) {
  const taken = new Set(row.taken ?? []);
  const finish = (t) => (t && pre ? withPre(t) : t);
  const next = nextTag(row, row.dated ? "predicted" : bump, now);
  const notes = [...next.notes];
  const skipped = [];
  let base = next.tag;
  while (base && next.step && taken.has(finish(base)) && skipped.length < 20) {
    skipped.push(finish(base));
    base = next.step(base);
  }
  if (skipped.length) notes.push(`Skipped ${skipped.join(", ")}: already tagged`);

  if (String(pattern ?? "").trim()) {
    const uses = patternTokens(pattern);
    if ((uses.has("next") && !base) || (uses.has("last") && !row.lastTag)) {
      return { tag: "", notes, skipped, invalid: "No earlier tag for the pattern to use. Type the tag in" };
    }
    const date = new Date(now).toISOString().slice(0, 10);
    const tag = finish(fillPattern(pattern.trim(), { next: base, last: row.lastTag, date, repo: row.repo }));
    return { tag, notes, skipped, invalid: tagProblem(tag, taken) };
  }

  if (!base) {
    const why = row.dated ? "No earlier dated tag to copy. Type the tag in" : "No earlier version tag to count up from. Type the tag in";
    return { tag: "", notes, skipped, invalid: why };
  }
  const tag = finish(base);
  return { tag, notes, skipped, invalid: tagProblem(tag, taken) };
}

export function tagProblem(tag, taken = new Set()) {
  if (!tag) return "Needs a tag";
  if (!validTagName(tag)) return "Not a valid tag name";
  if (taken.has(tag)) return "Already tagged in this repo";
  return null;
}

export function globToRegex(glob) {
  const body = String(glob).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`);
}

export const globPrefix = (glob) => String(glob).split(/[*?]/)[0];
