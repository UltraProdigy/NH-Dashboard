export const normalizeName = (name) => String(name ?? "").trim().toLowerCase();

export const normalizeColor = (color) => String(color ?? "").replace(/^#/, "").toLowerCase();

export const normalizeDescription = (description) => description ?? "";

export const normalizeLabel = (label) => ({
  name: String(label.name ?? "").trim(),
  color: normalizeColor(label.color),
  description: normalizeDescription(label.description),
});

export function labelsExactlyMatch(left, right) {
  const a = normalizeLabel(left);
  const b = normalizeLabel(right);
  return a.name === b.name && a.color === b.color && a.description === b.description;
}

export const isExactGithubDefault = (label, githubDefaults) =>
  githubDefaults.some((d) => labelsExactlyMatch(label, d));

export function parseReplacements(value) {
  const entries = Array.isArray(value)
    ? value
    : String(value ?? "").split(",");
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    let oldName;
    let newName;
    if (entry && typeof entry === "object") {
      oldName = String(entry.oldName ?? "").trim();
      newName = String(entry.newName ?? "").trim();
    } else {
      const text = String(entry ?? "").trim();
      const at = text.indexOf("=");
      if (at <= 0 || text.indexOf("=", at + 1) !== -1) continue;
      oldName = text.slice(0, at).trim();
      newName = text.slice(at + 1).trim();
    }
    const oldKey = normalizeName(oldName);
    const newKey = normalizeName(newName);
    if (!oldKey || !newKey || oldKey === newKey || seen.has(oldKey)) continue;
    seen.add(oldKey);
    out.push({ oldName, newName, oldKey, newKey });
  }
  return out;
}
