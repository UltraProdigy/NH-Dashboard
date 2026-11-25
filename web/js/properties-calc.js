export const TYPES = ["single_select", "multi_select", "string", "true_false", "url"];
export const TYPE_LABEL = { string: "Text", single_select: "Single select", multi_select: "Multi select", true_false: "True / false", url: "URL" };
export const EDITORS = { org_actors: "Org admins only", org_and_repo_actors: "Org and repo admins" };
export const NAME = /^[A-Za-z0-9_$#-]{1,75}$/;
export const MAX_ALLOWED = 200;
export const PATCH_REPOS = 30;
export const MAX_WRITES = 150;
export const MULTI_SEP = ";";

const isSelect = (type) => type === "single_select" || type === "multi_select";

export function normValue(v) {
  if (v == null || v === "") return null;
  if (Array.isArray(v)) {
    const list = [...new Set(v.map(String).filter((x) => x !== ""))];
    return list.length ? list : null;
  }
  return String(v);
}

const valueKey = (v) => {
  const n = normValue(v);
  return Array.isArray(n) ? JSON.stringify([...n].sort()) : JSON.stringify(n);
};

export const sameValue = (a, b) => valueKey(a) === valueKey(b);
export const listOf = (v) => [].concat(normValue(v) ?? []);
export const storedValue = (v) => (normValue(v) == null ? null : valueKey(v));
export const showValue = (v) => (normValue(v) == null ? "" : listOf(v).join(", "));

export function normDef(p) {
  const type = p.type ?? p.value_type;
  const allowed = p.allowed ?? p.allowed_values ?? null;
  return {
    name: p.name ?? p.property_name,
    type,
    required: Boolean(p.required),
    default: normValue(p.default !== undefined ? p.default : p.default_value),
    description: p.description || null,
    allowed: isSelect(type) ? [...(allowed ?? [])].map(String) : null,
    editableBy: (p.editableBy ?? p.values_editable_by) === "org_and_repo_actors" ? "org_and_repo_actors" : "org_actors",
    explicit: Boolean(p.explicit ?? p.require_explicit_values),
  };
}

export const githubDef = (d) => ({
  value_type: d.type,
  required: d.required,
  default_value: d.default,
  description: d.description,
  allowed_values: d.allowed,
  values_editable_by: d.editableBy,
  require_explicit_values: d.explicit,
});

export function sameDef(a, b) {
  if (!a || !b) return false;
  const x = normDef(a);
  const y = normDef(b);
  return x.type === y.type && x.required === y.required && sameValue(x.default, y.default)
    && x.description === y.description && JSON.stringify(x.allowed) === JSON.stringify(y.allowed)
    && x.editableBy === y.editableBy && x.explicit === y.explicit;
}

export function valueError(def, v) {
  const n = normValue(v);
  if (n == null) return def.required ? `${def.name} is required, so it can't be cleared` : null;
  if (def.type === "multi_select") {
    if (!Array.isArray(n) && typeof n !== "string") return "not a list";
    const bad = listOf(n).filter((x) => !def.allowed.includes(x));
    return bad.length ? `${bad.join(", ")} ${bad.length === 1 ? "isn't an allowed value" : "aren't allowed values"} of ${def.name}` : null;
  }
  if (Array.isArray(n)) return `${def.name} takes one value`;
  if (def.type === "single_select") return def.allowed.includes(n) ? null : `${n} isn't an allowed value of ${def.name}`;
  if (def.type === "true_false") return n === "true" || n === "false" ? null : `${def.name} is true or false`;
  if (def.type === "url") return /^https?:\/\/\S+$/i.test(n) ? null : `${def.name} needs a URL starting with https://`;
  return /[\u0000-\u001f]/.test(n) ? "has a control character" : null;
}

export function defErrors(d) {
  const out = [];
  if (!NAME.test(d.name ?? "")) out.push("Names are up to 75 letters, digits, _, -, $ or #");
  if (!TYPES.includes(d.type)) out.push("Pick a type");
  if (isSelect(d.type)) {
    if (!d.allowed?.length) out.push("A select needs at least one allowed value");
    if ((d.allowed?.length ?? 0) > MAX_ALLOWED) out.push(`At most ${MAX_ALLOWED} allowed values`);
    if (new Set(d.allowed ?? []).size !== (d.allowed?.length ?? 0)) out.push("An allowed value is listed twice");
    if ((d.allowed ?? []).some((v) => !v.trim())) out.push("An allowed value is blank");
  }
  if (d.required && d.default == null) out.push("A required property needs a default");
  if (d.default != null) {
    const err = valueError({ ...d, required: false }, d.default);
    if (err) out.push(`Default: ${err}`);
  }
  return out;
}

export const keyOf = (c) =>
  c.kind === "value" ? `value:${c.repo}:${c.prop}`
    : c.kind === "revalue" ? `revalue:${c.name}:${[...c.sources].sort().join("|")}`
      : `def:${c.kind === "create" ? c.def.name : c.name}`;

export function describe(c) {
  const v = (x) => (normValue(x) == null ? "unset" : showValue(x));
  switch (c.kind) {
    case "value": return `${c.repo}: ${c.prop} ${v(c.from)} → ${v(c.to)}`;
    case "create": return `Create ${c.def.name} (${TYPE_LABEL[c.def.type] ?? c.def.type})`;
    case "update": return `Edit ${c.name}: ${defDiff(c.from, c.to).join("; ") || "no change"}`;
    case "delete": return `Delete ${c.name}`;
    case "rename": return `Rename ${c.name} → ${c.to}`;
    case "revalue": return `${c.name}: ${c.sources.join(", ")} → ${c.target}`;
    default: return "Unknown change";
  }
}

export function defDiff(a, b) {
  const x = normDef(a);
  const y = normDef(b);
  const out = [];
  if (x.description !== y.description) out.push(y.description ? `description "${y.description}"` : "no description");
  if (x.required !== y.required) out.push(y.required ? "required" : "not required");
  if (!sameValue(x.default, y.default)) out.push(y.default == null ? "no default" : `default ${showValue(y.default)}`);
  if (x.editableBy !== y.editableBy) out.push(`editable by ${EDITORS[y.editableBy].toLowerCase()}`);
  if (x.explicit !== y.explicit) out.push(y.explicit ? "values must be set explicitly" : "values needn't be set explicitly");
  if (JSON.stringify(x.allowed) !== JSON.stringify(y.allowed)) {
    const added = (y.allowed ?? []).filter((v) => !(x.allowed ?? []).includes(v));
    const removed = (x.allowed ?? []).filter((v) => !(y.allowed ?? []).includes(v));
    if (added.length) out.push(`adds ${added.join(", ")}`);
    if (removed.length) out.push(`removes ${removed.join(", ")}`);
    if (!added.length && !removed.length) out.push("reorders values");
  }
  return out;
}

export function moveValue(def, v, sources, target) {
  const list = listOf(v);
  if (!list.some((x) => sources.includes(x))) return null;
  if (def.type !== "multi_select") return target;
  const next = [...new Set(list.map((x) => (sources.includes(x) ? target : x)))];
  return def.allowed ? next.sort((a, b) => def.allowed.indexOf(a) - def.allowed.indexOf(b)) : next;
}

function insertAt(allowed, value, before) {
  if (allowed.includes(value)) return allowed;
  const at = before.map((b) => allowed.indexOf(b)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  const out = [...allowed];
  out.splice(at ?? out.length, 0, value);
  return out;
}

/**
 * Turns staged changes into GitHub writes, against the state GitHub has right now.
 * Each step lists the steps it depends on, so a failure never removes a value
 * or a property whose repos weren't moved off it first.
 */
export function planBatch(changes, state, { org }) {
  const results = new Map();
  const steps = [];
  const stepsOf = new Map();
  const reject = (c, status, error) => results.set(keyOf(c), { status, error });
  const own = (key, id) => {
    if (!stepsOf.has(key)) stepsOf.set(key, new Set());
    stepsOf.get(key).add(id);
  };
  const add = (step) => {
    const s = { id: steps.length, needs: new Set(), keys: new Set(), rows: [], ...step };
    steps.push(s);
    for (const k of s.keys) own(k, s.id);
    return s;
  };
  const schemaPath = (name) => `/orgs/${org}/properties/schema/${encodeURIComponent(name)}`;

  const defOps = [];
  const valOps = [];
  const seen = new Set();
  for (const c of changes ?? []) {
    if (!c || typeof c !== "object" || !["value", "create", "update", "delete", "rename", "revalue"].includes(c.kind)) continue;
    const k = keyOf(c);
    if (seen.has(k)) { reject(c, "invalid", "Staged twice"); continue; }
    seen.add(k);
    (c.kind === "value" ? valOps : defOps).push(c);
  }

  const claims = new Map();
  const claim = (name, kind) => {
    const had = claims.get(name);
    if (had && !(had === "revalue" && kind === "revalue")) return false;
    claims.set(name, kind);
    return true;
  };

  const created = new Map();
  const updated = new Map();
  const removed = new Map();
  const revalues = new Map();
  const renames = [];
  const blocked = new Set();

  for (const c of defOps) {
    const name = c.kind === "create" ? c.def?.name : c.name;
    const cur = state.defs.get(name);
    const fail = (status, error) => {
      reject(c, status, error);
      if (c.kind === "create") blocked.add(name);
      if (c.kind === "rename") blocked.add(c.to);
    };
    if (c.kind === "create") {
      const def = normDef(c.def ?? {});
      if (cur) { fail("conflict", `${def.name} already exists on GitHub`); continue; }
      const errs = defErrors(def);
      if (errs.length) { fail("invalid", errs.join("; ")); continue; }
      if (!claim(def.name, "create")) { fail("invalid", `${def.name} has another change in this batch`); continue; }
      created.set(def.name, def);
      continue;
    }
    if (!cur) { fail("conflict", `${name} no longer exists on GitHub`); continue; }
    if (!sameDef(cur, c.from)) { fail("conflict", `${name} was changed on GitHub after you loaded it`); continue; }
    if (c.kind === "update") {
      const to = normDef({ ...c.to, name });
      if (to.type !== cur.type) { fail("invalid", "A property's type can't be changed"); continue; }
      const errs = defErrors(to);
      if (errs.length) { fail("invalid", errs.join("; ")); continue; }
      if (!claim(name, "update")) { fail("invalid", `${name} has another change in this batch`); continue; }
      updated.set(name, to);
    } else if (c.kind === "delete") {
      if (!claim(name, "delete")) { fail("invalid", `${name} has another change in this batch`); continue; }
      removed.set(name, c);
    } else if (c.kind === "rename") {
      if (!NAME.test(c.to ?? "")) { fail("invalid", "Names are up to 75 letters, digits, _, -, $ or #"); continue; }
      if (state.defs.has(c.to)) { fail("conflict", `${c.to} already exists on GitHub`); continue; }
      if (!claim(name, "rename") || !claim(c.to, "create")) { fail("invalid", `${name} or ${c.to} has another change in this batch`); continue; }
      renames.push(c);
      removed.set(name, c);
      created.set(c.to, normDef({ ...cur, name: c.to }));
    } else if (c.kind === "revalue") {
      const sources = [...new Set((c.sources ?? []).map(String))].filter(Boolean);
      const target = String(c.target ?? "").trim();
      if (!isSelect(cur.type)) { fail("invalid", "Only select properties have values to rename"); continue; }
      if (!sources.length || !target || sources.includes(target)) { fail("invalid", "Pick the values to move and a different value to move them to"); continue; }
      if (target.length > 75 || /[\u0000-\u001f]/.test(target)) { fail("invalid", "That value is too long or has a control character"); continue; }
      if (!claim(name, "revalue")) { fail("invalid", `${name} has another change in this batch`); continue; }
      if (!revalues.has(name)) revalues.set(name, []);
      revalues.get(name).push({ ...c, sources, target });
    }
  }

  const finalDef = (name) => created.get(name) ?? updated.get(name) ?? state.defs.get(name);
  const firstPut = new Map();
  const lastPut = new Map();
  const defRow = (name, before, after, note) => ({ repo: null, property: name, before: before ? JSON.stringify(githubDef(before)) : null, after: after ? JSON.stringify(githubDef(after)) : null, note });

  for (const [name, def] of created) {
    const rename = renames.find((r) => r.to === name);
    const s = add({
      phase: 1, method: "PUT", path: schemaPath(name), body: githubDef(def), label: rename ? `Create ${name} for the rename` : `Create ${name}`,
      keys: new Set([rename ? keyOf(rename) : `def:${name}`]),
    });
    s.rows.push(defRow(name, null, def, rename ? `renamed from ${rename.name}` : "created"));
    firstPut.set(name, s.id);
  }

  const revaluedDefs = new Map();
  for (const [name, list] of revalues) {
    const cur = state.defs.get(name);
    let wide = [...cur.allowed];
    for (const r of list) wide = insertAt(wide, r.target, r.sources);
    const targets = new Set(list.map((r) => r.target));
    const drop = new Set(list.flatMap((r) => r.sources).filter((v) => !targets.has(v)));
    const map = (v) => list.reduce((acc, r) => (acc != null && r.sources.includes(acc) ? r.target : acc), v);
    const wideDef = { ...cur, allowed: wide };
    const end = { ...cur, allowed: wide.filter((v) => !drop.has(v)), default: cur.default == null ? null : cur.type === "multi_select" ? [...new Set(listOf(cur.default).map(map))] : map(cur.default) };
    revaluedDefs.set(name, { list, wideDef, end, map });
    const keys = new Set(list.map(keyOf));
    if (JSON.stringify(wide) !== JSON.stringify(cur.allowed)) {
      const s = add({ phase: 1, method: "PUT", path: schemaPath(name), body: githubDef(wideDef), label: `Add ${[...targets].filter((t) => !cur.allowed.includes(t)).join(", ")} to ${name}`, keys });
      firstPut.set(name, s.id);
    }
  }

  for (const [name, to] of updated) {
    const cur = state.defs.get(name);
    const extra = (cur.allowed ?? []).filter((v) => !(to.allowed ?? []).includes(v));
    const key = `def:${name}`;
    if (extra.length) {
      const wide = { ...to, allowed: [...to.allowed, ...extra] };
      if (!sameDef({ ...wide, name }, cur)) {
        const s = add({ phase: 1, method: "PUT", path: schemaPath(name), body: githubDef(wide), label: `Update ${name}, keeping values still in use`, keys: new Set([key]) });
        firstPut.set(name, s.id);
      }
      lastPut.set(name, { name, def: to, key, row: defRow(name, cur, to, "edited") });
    } else {
      const s = add({ phase: 1, method: "PUT", path: schemaPath(name), body: githubDef(to), label: `Update ${name}`, keys: new Set([key]) });
      s.rows.push(defRow(name, cur, to, "edited"));
      firstPut.set(name, s.id);
    }
  }

  const entries = new Map();
  const put = (repo, prop, value, key, note) => {
    if (!entries.has(repo)) entries.set(repo, new Map());
    const m = entries.get(repo);
    const had = m.get(prop);
    m.set(prop, { value, keys: new Set([...(had?.keys ?? []), key]), note: note ?? had?.note ?? null });
  };

  for (const [name, rv] of revaluedDefs) {
    for (const [repo, props] of state.values) {
      const before = props[name];
      const hit = rv.list.filter((r) => listOf(before).some((x) => r.sources.includes(x)));
      if (!hit.length) continue;
      let next = before;
      for (const r of rv.list) next = moveValue(rv.wideDef, next, r.sources, r.target) ?? next;
      if (sameValue(next, before)) continue;
      const note = `renamed ${hit.map((r) => `${r.sources.join(", ")} → ${r.target}`).join("; ")}`;
      for (const r of hit) put(repo, name, normValue(next), keyOf(r), note);
    }
  }

  for (const r of renames) {
    for (const [repo, props] of state.values) {
      if (normValue(props[r.name]) != null) put(repo, r.to, normValue(props[r.name]), keyOf(r), `copied from ${r.name}`);
    }
  }

  for (const c of valOps) {
    if (!state.repos.has(c.repo)) { reject(c, "conflict", `${c.repo} isn't an active repo any more`); continue; }
    if (blocked.has(c.prop)) { reject(c, "blocked", `${c.prop} couldn't be created`); continue; }
    if (removed.has(c.prop)) { reject(c, "invalid", `${c.prop} is being ${removed.get(c.prop).kind === "rename" ? "renamed" : "deleted"} in this batch`); continue; }
    const def = finalDef(c.prop);
    if (!def) { reject(c, "conflict", `${c.prop} no longer exists on GitHub`); continue; }
    const now = created.has(c.prop) && !state.defs.has(c.prop) ? null : state.values.get(c.repo)?.[c.prop];
    if (!sameValue(now, c.from)) { reject(c, "conflict", `Changed on GitHub after you loaded it (now ${showValue(now) || "unset"})`); continue; }
    const target = revaluedDefs.get(c.prop)?.end ?? def;
    const err = valueError(target, c.to);
    if (err) { reject(c, "invalid", err); continue; }
    if (sameValue(now, c.to)) { results.set(keyOf(c), { status: "done", error: null, unchanged: true }); continue; }
    put(c.repo, c.prop, normValue(c.to), keyOf(c), null);
  }

  const groups = new Map();
  for (const [repo, m] of entries) {
    const sig = JSON.stringify([...m].sort(([a], [b]) => a.localeCompare(b)).map(([p, e]) => [p, e.value]));
    if (!groups.has(sig)) groups.set(sig, { props: m, repos: [] });
    groups.get(sig).repos.push(repo);
  }
  for (const { props, repos } of groups.values()) {
    for (let i = 0; i < repos.length; i += PATCH_REPOS) {
      const chunk = repos.slice(i, i + PATCH_REPOS);
      const names = [...props.keys()].sort();
      const s = add({
        phase: 3, method: "PATCH", path: `/orgs/${org}/properties/values`,
        body: { repository_names: chunk, properties: names.map((p) => ({ property_name: p, value: props.get(p).value })) },
        label: `Set ${names.join(", ")} on ${chunk.length === 1 ? chunk[0] : `${chunk.length} repos`}`,
        keys: new Set(),
        props: names,
      });
      for (const repo of chunk) {
        const m = entries.get(repo);
        for (const p of names) {
          const e = m.get(p);
          for (const k of e.keys) { s.keys.add(k); own(k, s.id); }
          s.rows.push({ repo, property: p, before: storedValue(state.values.get(repo)?.[p]), after: storedValue(e.value), note: e.note });
        }
      }
      for (const p of names) if (firstPut.has(p)) s.needs.add(firstPut.get(p));
    }
  }

  const patchesFor = (prop) => steps.filter((s) => s.method === "PATCH" && s.props.includes(prop)).map((s) => s.id);

  for (const [name, rv] of revaluedDefs) {
    const cur = state.defs.get(name);
    if (sameDef(rv.end, rv.wideDef) && firstPut.has(name)) {
      steps[firstPut.get(name)].rows.push(defRow(name, cur, rv.end, `renamed values ${rv.list.map((r) => `${r.sources.join(", ")} → ${r.target}`).join("; ")}`));
      continue;
    }
    const s = add({
      phase: 4, method: "PUT", path: schemaPath(name), body: githubDef(rv.end),
      label: `Remove ${rv.list.flatMap((r) => r.sources).join(", ")} from ${name}`, keys: new Set(rv.list.map(keyOf)),
    });
    s.rows.push(defRow(name, cur, rv.end, `renamed values ${rv.list.map((r) => `${r.sources.join(", ")} → ${r.target}`).join("; ")}`));
    if (firstPut.has(name)) s.needs.add(firstPut.get(name));
    for (const id of patchesFor(name)) s.needs.add(id);
  }

  for (const { name, def, key, row } of lastPut.values()) {
    const s = add({ phase: 4, method: "PUT", path: schemaPath(name), body: githubDef(def), label: `Finish updating ${name}`, keys: new Set([key]) });
    s.rows.push(row);
    if (firstPut.has(name)) s.needs.add(firstPut.get(name));
    for (const id of patchesFor(name)) s.needs.add(id);
  }

  for (const [name, c] of removed) {
    const cur = state.defs.get(name);
    const rename = c.kind === "rename";
    const s = add({ phase: 5, method: "DELETE", path: schemaPath(name), body: null, label: rename ? `Delete ${name}, now ${c.to}` : `Delete ${name}`, keys: new Set([keyOf(c)]) });
    s.rows.push(defRow(name, cur, null, rename ? `renamed to ${c.to}` : "deleted"));
    if (rename) {
      s.needs.add(firstPut.get(c.to));
      for (const id of patchesFor(c.to)) s.needs.add(id);
    }
  }

  const accepted = [...defOps, ...valOps].filter((c) => !results.has(keyOf(c)));
  for (const c of accepted) if (!stepsOf.has(keyOf(c))) results.set(keyOf(c), { status: "done", error: null, unchanged: true });

  return { steps, stepsOf, results, writes: steps.length, accepted: accepted.length };
}

export function outcome(plan, done) {
  const out = new Map(plan.results);
  for (const [key, ids] of plan.stepsOf) {
    if (out.has(key)) continue;
    const states = [...ids].map((id) => done.get(id) ?? { state: "pending" });
    const failed = states.find((s) => s.state === "failed");
    const ok = states.filter((s) => s.state === "done").length;
    if (ok === states.length) out.set(key, { status: "done", error: null });
    else if (failed) out.set(key, { status: "failed", error: ok ? `Partly applied: ${failed.error}` : failed.error });
    else if (states.some((s) => s.state === "blocked")) out.set(key, { status: "blocked", error: ok ? "Partly applied; an earlier step failed" : "Skipped because an earlier step failed" });
    else out.set(key, { status: "cancelled", error: "Didn't run" });
  }
  return out;
}

/* ---- the page's own views ---- */

export function stateFrom(list) {
  const defs = new Map((list?.schema ?? []).map((p) => [p.name, normDef(p)]));
  const values = new Map((list?.repos ?? []).map((r) => [r.name, r.properties ?? {}]));
  return { defs, values, repos: new Set(values.keys()) };
}

export function distribution(def, repos) {
  const counts = new Map((def.allowed ?? (def.type === "true_false" ? ["true", "false"] : [])).map((v) => [v, 0]));
  let set = 0;
  let stale = 0;
  for (const r of repos) {
    const vals = listOf(r.properties?.[def.name]);
    if (!vals.length) continue;
    set++;
    for (const v of vals) {
      counts.set(v, (counts.get(v) ?? 0) + 1);
      if (def.allowed && !def.allowed.includes(v)) stale++;
    }
  }
  return { set, unset: repos.length - set, counts: [...counts], stale };
}

export function crossTab(rowDef, colDef, repos) {
  const keys = (def) => [...(def.allowed ?? (def.type === "true_false" ? ["true", "false"] : [])), null];
  const rows = keys(rowDef);
  const cols = keys(colDef);
  const extra = (def, v) => v != null && !rows.includes(v) && def === rowDef;
  const cells = new Map();
  const bucket = (def, r) => {
    const vals = listOf(r.properties?.[def.name]);
    return vals.length ? vals : [null];
  };
  for (const r of repos) {
    for (const a of bucket(rowDef, r)) {
      if (extra(rowDef, a)) rows.splice(rows.length - 1, 0, a);
      for (const b of bucket(colDef, r)) {
        if (b != null && !cols.includes(b)) cols.splice(cols.length - 1, 0, b);
        const k = JSON.stringify([a, b]);
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(r.name);
      }
    }
  }
  const at = (a, b) => cells.get(JSON.stringify([a, b])) ?? [];
  return { rows, cols, at };
}

export function gaps(state, repos) {
  const defs = [...state.defs.values()];
  const required = [];
  const stale = [];
  const unusedValues = [];
  const unusedProps = [];
  const untagged = repos.filter((r) => !defs.some((d) => listOf(r.properties?.[d.name]).length)).map((r) => r.name);
  const unsetBy = [];
  for (const d of defs) {
    const dist = distribution(d, repos);
    if (!dist.set) unusedProps.push(d.name);
    const unset = repos.filter((r) => !listOf(r.properties?.[d.name]).length).map((r) => r.name);
    if (d.required && unset.length) required.push({ prop: d.name, repos: unset });
    else if (unset.length) unsetBy.push({ prop: d.name, repos: unset });
    if (d.allowed) {
      const unused = dist.counts.filter(([v, n]) => !n && d.allowed.includes(v)).map(([v]) => v);
      if (unused.length && dist.set) unusedValues.push({ prop: d.name, values: unused });
      const off = repos.filter((r) => listOf(r.properties?.[d.name]).some((v) => !d.allowed.includes(v)))
        .map((r) => ({ repo: r.name, values: listOf(r.properties?.[d.name]).filter((v) => !d.allowed.includes(v)) }));
      if (off.length) stale.push({ prop: d.name, repos: off });
    }
  }
  return { required, untagged, unsetBy, stale, unusedProps, unusedValues };
}

/* ---- CSV ---- */

const cell = (s) => (/[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function toCsv(defs, repos) {
  const head = ["repo", ...defs.map((d) => d.name)];
  const lines = [head.map(cell).join(",")];
  for (const r of repos) {
    lines.push([r.name, ...defs.map((d) => listOf(r.properties?.[d.name]).join(`${MULTI_SEP} `))].map(cell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const src = String(text ?? "").replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export function importCsv(text, state) {
  const rows = parseCsv(text);
  const problems = [];
  if (!rows.length) return { changes: [], problems: ["The file is empty"], columns: [] };
  const head = rows[0].map((h) => h.trim());
  const repoCol = head.findIndex((h) => h.toLowerCase() === "repo");
  if (repoCol < 0) return { changes: [], problems: ["The first row needs a repo column"], columns: [] };
  const columns = [];
  head.forEach((h, i) => {
    if (i === repoCol || !h) return;
    const def = state.defs.get(h) ?? [...state.defs.values()].find((d) => d.name.toLowerCase() === h.toLowerCase());
    if (def) columns.push({ i, def });
    else problems.push(`Column ${h} isn't a property, so it was skipped`);
  });
  const changes = [];
  const lower = new Map([...state.repos].map((r) => [r.toLowerCase(), r]));
  const seen = new Set();
  for (const [n, r] of rows.slice(1).entries()) {
    const raw = (r[repoCol] ?? "").trim().replace(/^.*\//, "");
    const repo = lower.get(raw.toLowerCase());
    if (!repo) { problems.push(`Row ${n + 2}: ${raw || "(no repo)"} isn't an active repo`); continue; }
    if (seen.has(repo)) { problems.push(`Row ${n + 2}: ${repo} is listed twice; only the first row was used`); continue; }
    seen.add(repo);
    for (const { i, def } of columns) {
      const text = (r[i] ?? "").trim();
      let to = text === "" ? null : def.type === "multi_select" ? text.split(MULTI_SEP).map((s) => s.trim()).filter(Boolean) : text;
      if (to != null && def.type === "true_false") to = String(to).toLowerCase();
      if (to != null && def.allowed && def.type === "single_select") to = def.allowed.find((v) => v.toLowerCase() === String(to).toLowerCase()) ?? to;
      if (Array.isArray(to) && def.allowed) to = to.map((x) => def.allowed.find((v) => v.toLowerCase() === x.toLowerCase()) ?? x);
      const from = state.values.get(repo)?.[def.name] ?? null;
      if (sameValue(from, to)) continue;
      const err = valueError(def, to);
      if (err) { problems.push(`Row ${n + 2}, ${repo}: ${err}`); continue; }
      changes.push({ kind: "value", repo, prop: def.name, from: normValue(from), to: normValue(to) });
    }
  }
  return { changes, problems, columns: columns.map((c) => c.def.name) };
}
