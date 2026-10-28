/**
 * Labels page: how every repo's labels compare with the managed set, and the
 * labels nobody manages.
 *
 * Only `labels` and `repo_labels` are stamped reads. `repos` is read for the
 * list of repos but left out of `reads`, because nearly every delivery stamps
 * it and this would rebuild every tick for a list that rarely changes; the
 * hourly staleness rebuild picks up new and archived repos instead.
 */

import { LABEL_SOURCE } from "../../../src/config.js";
import { normalizeName, planRepository } from "../../../src/shared/label-sync/plan.js";

const PLAN_INPUTS = {
  deleted: [],
  githubDefaults: [],
  replacements: [],
  options: { deleteMissing: false, deleteGithubDefaultLabels: false },
};

const label = (r) => ({
  name: r.name,
  color: (r.color ?? "").replace(/^#/, "").toLowerCase(),
  description: r.description ?? "",
});

function skipReason(repo) {
  if (repo.archived) return "archived";
  if (normalizeName(repo.name) === normalizeName(LABEL_SOURCE.repo)) return "source";
  return null;
}

export async function labelSync(db) {
  const [managedRows, labelRows, repoRows] = await Promise.all([
    db.prepare("SELECT name, color, description FROM labels ORDER BY position, name").all(),
    db.prepare("SELECT repo, name, color, description FROM repo_labels ORDER BY repo, name").all(),
    db.prepare("SELECT name, archived FROM repos ORDER BY name").all(),
  ]);

  const managed = managedRows.results.map(label);
  const managedKeys = new Set(managed.map((l) => normalizeName(l.name)));

  const byRepo = new Map();
  for (const r of labelRows.results) {
    if (!byRepo.has(r.repo)) byRepo.set(r.repo, []);
    byRepo.get(r.repo).push(label(r));
  }

  const names = new Map(repoRows.results.map((r) => [r.name, { name: r.name, archived: !!r.archived }]));
  for (const repo of byRepo.keys()) {
    if (!names.has(repo)) names.set(repo, { name: repo, archived: false });
  }

  const repos = [];
  const inventory = new Map();

  for (const repo of [...names.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const existing = byRepo.get(repo.name) ?? null;
    const custom = (existing ?? []).filter((l) => !managedKeys.has(normalizeName(l.name)));
    const skip = skipReason(repo);
    const planned = existing && managed.length && !skip
      ? planRepository({ existing, labelsForRepo: managed, ...PLAN_INPUTS })
      : null;

    repos.push({
      repo: repo.name,
      read: !!existing,
      skip,
      custom,
      actions: planned?.actions ?? [],
    });

    for (const l of repo.archived ? [] : custom) {
      const key = normalizeName(l.name);
      if (!inventory.has(key)) inventory.set(key, { names: new Map(), variants: new Map(), repos: new Set() });
      const entry = inventory.get(key);
      entry.repos.add(repo.name);
      entry.names.set(l.name, (entry.names.get(l.name) ?? 0) + 1);
      const v = `${l.color}\0${l.description}`;
      if (!entry.variants.has(v)) entry.variants.set(v, { color: l.color, description: l.description, repos: new Set() });
      entry.variants.get(v).repos.add(repo.name);
    }
  }

  const unmanaged = [...inventory.values()]
    .map((e) => ({
      name: [...e.names].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0],
      repos: [...e.repos],
      variants: [...e.variants.values()]
        .map((v) => ({ ...v, repos: [...v.repos] }))
        .sort((a, b) => b.repos.length - a.repos.length),
    }))
    .sort((a, b) => b.repos.length - a.repos.length || a.name.localeCompare(b.name));

  return {
    managed,
    checks: { deleted: false, githubDefaults: false, replacements: false },
    repos,
    unmanaged,
  };
}
