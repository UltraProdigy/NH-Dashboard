import {
  isExactGithubDefault,
  normalizeColor,
  normalizeDescription,
  normalizeLabel,
  normalizeName,
  parseReplacements,
} from "./labels.js";

export * from "./labels.js";

const snapshot = (label) => ({
  name: label.name,
  color: normalizeColor(label.color),
  description: normalizeDescription(label.description),
});

/**
 * Reproduces `syncRepository` in Label-Sync's scripts/sync-labels.mjs without
 * making any calls. Order matters: each step sees the working set the steps
 * before it left, the same way the workflow does.
 */
export function planRepository({
  existing = [],
  labelsForRepo = [],
  deleted = [],
  githubDefaults = [],
  replacements = [],
  options = {},
} = {}) {
  const deleteMissing = Boolean(options.deleteMissing);
  const deleteGithubDefaultLabels = Boolean(options.deleteGithubDefaultLabels);

  const desired = labelsForRepo.map(normalizeLabel);
  const defaults = githubDefaults.map(normalizeLabel);
  const working = existing.map((l) => ({ ...l }));
  const byKey = new Map(working.map((l) => [normalizeName(l.name), l]));
  const desiredByKey = new Map(desired.map((l) => [normalizeName(l.name), l]));
  const deletedKeys = new Set(deleted.map((l) => normalizeName(l.name)));

  const put = (key, label) => {
    byKey.set(key, label);
    const i = working.findIndex((l) => normalizeName(l.name) === key);
    if (i === -1) working.push(label);
    else working[i] = label;
  };
  const drop = (key) => {
    byKey.delete(key);
    const i = working.findIndex((l) => normalizeName(l.name) === key);
    if (i !== -1) working.splice(i, 1);
  };

  const actions = [];
  const unchanged = [];

  for (const r of parseReplacements(replacements)) {
    const old = byKey.get(r.oldKey);
    const next = desiredByKey.get(r.newKey);
    if (!old || !next) continue;
    const type = byKey.has(r.newKey) ? "migrate" : "rename";
    actions.push({ type, reason: "replacement", name: old.name, before: snapshot(old), after: next });
    drop(r.oldKey);
    if (type === "rename") put(r.newKey, next);
  }

  for (const want of desired) {
    const have = byKey.get(normalizeName(want.name));
    if (!have) {
      actions.push({ type: "create", reason: "managed", name: want.name, before: null, after: want });
      continue;
    }
    const before = snapshot(have);
    if (before.color === want.color && before.description === want.description && have.name === want.name) {
      unchanged.push(want);
      continue;
    }
    actions.push({ type: "update", reason: "managed", name: have.name, before, after: want });
  }

  const remove = (label, reason) => {
    actions.push({ type: "delete", reason, name: label.name, before: snapshot(label), after: null });
    drop(normalizeName(label.name));
  };

  for (const label of [...working]) {
    if (deletedKeys.has(normalizeName(label.name))) remove(label, "deleted-config");
  }

  const kept = (label) => {
    const key = normalizeName(label.name);
    return desiredByKey.has(key) || deletedKeys.has(key);
  };

  if (deleteGithubDefaultLabels) {
    for (const label of [...working]) {
      if (!kept(label) && isExactGithubDefault(label, defaults)) remove(label, "github-default");
    }
  }

  if (deleteMissing) {
    for (const label of [...working]) {
      if (!kept(label) && !isExactGithubDefault(label, defaults)) remove(label, "unmanaged");
    }
  }

  return { actions, unchanged };
}
