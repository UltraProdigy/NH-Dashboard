export const DREAM_EXCL_KINDS = {
  approvedUnmerged: ["repos", "labels"],
  changesRequested: ["repos"],
  needsRelease: ["repos"],
  byLabel: ["repos", "labels"],
  updates: ["repos"],
};

const MAX_NAME = 200;
const MAX_LIST = 1000;

export function normaliseFilters(raw) {
  const out = {};
  for (const [panel, kinds] of Object.entries(DREAM_EXCL_KINDS)) {
    out[panel] = { repos: [], labels: [] };
    for (const kind of kinds) {
      const list = raw?.[panel]?.[kind];
      if (Array.isArray(list)) out[panel][kind] = [...new Set(list.filter((x) => typeof x === "string" && x && x.length <= MAX_NAME))];
    }
  }
  return out;
}

export function checkFilterOp(op) {
  const kinds = DREAM_EXCL_KINDS[op?.panel];
  if (!kinds || !kinds.includes(op.kind)) return "unknown card or filter";
  if (op.clear === true) return null;
  if (typeof op.name !== "string" || !op.name || op.name.length > MAX_NAME) return "bad name";
  if (typeof op.on !== "boolean") return "on must be true or false";
  return null;
}

export function applyFilterOp(filters, op) {
  const next = normaliseFilters(filters);
  const list = next[op.panel][op.kind];
  if (op.clear) next[op.panel][op.kind] = [];
  else if (op.on && !list.includes(op.name) && list.length < MAX_LIST) list.push(op.name);
  else if (!op.on) next[op.panel][op.kind] = list.filter((x) => x !== op.name);
  return next;
}
