/**
 * The pure label planner against the branches of Label-Sync's syncRepository.
 *
 *   node worker/test/label-plan.test.js
 *
 * The table below is checked on its own. When a Label-Sync checkout is found
 * (LABEL_SYNC_DIR, or ../Label-Sync beside this repo), every case is also run
 * through the real scripts/sync-labels.mjs in dry-run mode with fetch mocked,
 * and its console lines must match the planner's.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { planRepository } from "../../src/shared/label-sync/plan.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");

let pass = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ok    ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const L = (name, color, description = "") => ({ name, color, description });

const BUG = L("Bug", "d73a4a", "Something is broken");
const CHORE = L("Chore", "c5def5", "Housekeeping");
const FIX = L("Bug Fix", "0e8a16", "Fixes a bug");
const DEFAULTS = [
  L("bug", "d73a4a", "Something isn't working"),
  L("enhancement", "a2eeef", "New feature or request"),
  L("question", "d876e3", "Further information is requested"),
];

const CASES = [
  {
    name: "everything in sync",
    existing: [BUG, CHORE],
    labels: [BUG, CHORE],
    expect: [],
    unchanged: ["Bug", "Chore"],
  },
  {
    name: "a missing managed label is created",
    existing: [BUG],
    labels: [BUG, CHORE],
    expect: ["+ Chore"],
    unchanged: ["Bug"],
  },
  {
    name: "a different colour is an update",
    existing: [L("Bug", "ff0000", BUG.description)],
    labels: [BUG],
    expect: ["~ Bug"],
  },
  {
    name: "a different description is an update",
    existing: [L("Bug", BUG.color, "old words")],
    labels: [BUG],
    expect: ["~ Bug"],
  },
  {
    name: "a case-only rename is an update",
    existing: [L("bug", BUG.color, BUG.description)],
    labels: [BUG],
    expect: ["~ Bug"],
  },
  {
    name: "colour case and a missing description are normalised",
    existing: [{ name: "Chore", color: "C5DEF5", description: null }],
    labels: [L("Chore", "c5def5")],
    expect: [],
    unchanged: ["Chore"],
  },
  {
    name: "a replacement with only the old label renames it",
    existing: [L("Fix", "123456", "old")],
    labels: [FIX],
    deleted: [L("Fix", "123456", "old")],
    replacements: "Fix=Bug Fix",
    expect: ["~ Fix -> Bug Fix (replacement rename)"],
    unchanged: ["Bug Fix"],
  },
  {
    name: "a replacement with both labels migrates and deletes the old one",
    existing: [L("Fix", "123456", "old"), L("Bug Fix", "000000", "stale")],
    labels: [FIX],
    deleted: [L("Fix", "123456", "old")],
    replacements: "Fix=Bug Fix",
    expect: [
      "~ Fix -> Bug Fix (replacement migration)",
      "- Fix (replaced label config)",
      "~ Bug Fix",
    ],
  },
  {
    name: "a replacement whose old label is absent does nothing",
    existing: [FIX],
    labels: [FIX],
    deleted: [L("Fix", "123456", "old")],
    replacements: "Fix=Bug Fix",
    expect: [],
    unchanged: ["Bug Fix"],
  },
  {
    name: "a deleted-config label is deleted with no flag set",
    existing: [BUG, L("wontfix", "ffffff", "")],
    labels: [BUG],
    deleted: [L("WontFix", "ffffff", "")],
    expect: ["- wontfix (deleted label config)"],
    unchanged: ["Bug"],
  },
  {
    name: "an exact GitHub default is deleted when the flag is on",
    existing: [CHORE, DEFAULTS[1], L("question", "d876e3", "changed")],
    labels: [CHORE],
    defaults: DEFAULTS,
    options: { deleteGithubDefaultLabels: true },
    expect: ["- enhancement (GitHub default label)"],
    unchanged: ["Chore"],
  },
  {
    name: "GitHub defaults are kept when the flag is off",
    existing: [CHORE, DEFAULTS[1]],
    labels: [CHORE],
    defaults: DEFAULTS,
    expect: [],
    unchanged: ["Chore"],
  },
  {
    name: "a GitHub default name that is managed is updated, not deleted",
    existing: [DEFAULTS[0]],
    labels: [BUG],
    defaults: DEFAULTS,
    options: { deleteGithubDefaultLabels: true },
    expect: ["~ Bug"],
  },
  {
    name: "deleteMissing removes custom labels and spares exact defaults",
    existing: [BUG, L("custom", "abcdef", "mine"), DEFAULTS[2]],
    labels: [BUG],
    defaults: DEFAULTS,
    options: { deleteMissing: true },
    expect: ["- custom (delete missing)"],
    unchanged: ["Bug"],
  },
  {
    name: "everything at once runs in the workflow's order",
    existing: [
      L("Fix", "123456", "old"),
      L("chore", "c5def5", "Housekeeping"),
      L("stale", "eeeeee", ""),
      DEFAULTS[1],
      L("custom", "abcdef", ""),
    ],
    labels: [BUG, CHORE, FIX],
    deleted: [L("Fix", "123456", "old"), L("stale", "eeeeee", "")],
    defaults: DEFAULTS,
    replacements: "Fix=Bug Fix",
    options: { deleteGithubDefaultLabels: true, deleteMissing: true },
    expect: [
      "~ Fix -> Bug Fix (replacement rename)",
      "+ Bug",
      "~ Chore",
      "- stale (deleted label config)",
      "- enhancement (GitHub default label)",
      "- custom (delete missing)",
    ],
    unchanged: ["Bug Fix"],
  },
];

function planLines(c) {
  const { actions, unchanged } = planRepository({
    existing: c.existing,
    labelsForRepo: c.labels,
    deleted: c.deleted ?? [],
    githubDefaults: c.defaults ?? [],
    replacements: c.replacements ?? "",
    options: c.options ?? {},
  });
  const lines = [];
  const reasons = {
    "deleted-config": "deleted label config",
    "github-default": "GitHub default label",
    unmanaged: "delete missing",
  };
  for (const a of actions) {
    if (a.type === "create") lines.push(`+ ${a.after.name}`);
    else if (a.type === "update") lines.push(`~ ${a.after.name}`);
    else if (a.type === "rename") lines.push(`~ ${a.before.name} -> ${a.after.name} (replacement rename)`);
    else if (a.type === "migrate") {
      lines.push(`~ ${a.before.name} -> ${a.after.name} (replacement migration)`);
      lines.push(`- ${a.before.name} (replaced label config)`);
    } else lines.push(`- ${a.name} (${reasons[a.reason]})`);
  }
  return { lines, unchanged: unchanged.map((l) => l.name) };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("planner cases");
const planned = new Map();
for (const c of CASES) {
  const got = planLines(c);
  planned.set(c, got);
  check(c.name, same(got.lines, c.expect), JSON.stringify(got.lines));
  if (c.unchanged) {
    check(`${c.name}: unchanged`, same(got.unchanged, c.unchanged), JSON.stringify(got.unchanged));
  }
}

{
  const { actions } = planRepository({
    existing: [L("Fix", "123456", "old")],
    labelsForRepo: [FIX],
    deleted: [L("Fix", "123456", "old")],
    replacements: "Fix=Bug Fix",
  });
  check("every action carries its reason", actions.every((a) => a.reason === "replacement"));
  const input = [L("x", "000000")];
  planRepository({ existing: input, labelsForRepo: [], options: { deleteMissing: true } });
  check("the input labels are not mutated", input.length === 1 && input[0].name === "x");
}

const labelSync = [process.env.LABEL_SYNC_DIR, path.join(ROOT, "..", "Label-Sync")]
  .filter(Boolean)
  .find((dir) => existsSync(path.join(dir, "scripts", "sync-labels.mjs")));

const MOCK = `
import { readFileSync } from "node:fs";
const fixture = JSON.parse(readFileSync(process.env.PLAN_FIXTURE, "utf8"));
const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const page = Number(u.searchParams.get("page") ?? 1);
  if ((init.method ?? "GET") !== "GET") return new Response("unexpected write", { status: 500 });
  if (u.pathname === "/orgs/Org/repos") {
    return ok(page > 1 ? [] : [{
      name: "repo", full_name: "Org/repo", owner: { login: "Org" },
      archived: false, disabled: false, permissions: { admin: true, push: true },
    }]);
  }
  if (u.pathname === "/repos/Org/repo/labels") return ok(page > 1 ? [] : fixture.existing);
  if (u.pathname === "/repos/Org/repo/issues") return ok([]);
  return new Response("not mocked: " + u.pathname, { status: 404 });
};
`;

function runReal(dir, c) {
  const cwd = mkdtempSync(path.join(tmpdir(), "label-plan-"));
  try {
    mkdirSync(path.join(cwd, "config"));
    const write = (file, value) =>
      writeFileSync(path.join(cwd, "config", file), JSON.stringify(value, null, 2));
    write("properties.jsonc", {
      organization: "Org",
      labelSyncTokenSecretName: "LABEL_SYNC_TOKEN",
      sourceRepository: "Org/Label-Sync",
    });
    write("labels.jsonc", c.labels);
    write("deleted-labels.jsonc", c.deleted ?? []);
    write("github-default-labels.jsonc", c.defaults ?? DEFAULTS);
    write("repository-filter.jsonc", {
      filterMode: "blacklist",
      automaticSync: { enabled: false, deleteMissing: false, deleteGithubDefaultLabels: false, labelReplacements: "" },
      whitelist: [],
      blacklist: [],
      customProperties: { logic: "AND", rules: [] },
    });
    writeFileSync(path.join(cwd, "fixture.json"), JSON.stringify({ existing: c.existing }));
    writeFileSync(path.join(cwd, "mock-fetch.mjs"), MOCK);

    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DRY_RUN: "true",
      LABEL_SYNC_TOKEN: "test",
      ORG_NAME: "Org",
      PLAN_FIXTURE: path.join(cwd, "fixture.json"),
      LABEL_REPLACEMENTS: c.replacements ?? "",
      DELETE_MISSING: String(Boolean(c.options?.deleteMissing)),
      DELETE_GITHUB_DEFAULT_LABELS: String(Boolean(c.options?.deleteGithubDefaultLabels)),
    };
    const out = spawnSync(
      process.execPath,
      ["--import", path.join(cwd, "mock-fetch.mjs"), path.join(dir, "scripts", "sync-labels.mjs")],
      { cwd, env, encoding: "utf8" },
    );
    if (out.status !== 0) return { error: (out.stderr || out.stdout).trim() };

    const lines = [];
    const unchanged = [];
    let inRepo = false;
    for (const raw of out.stdout.split("\n")) {
      if (raw.startsWith("Syncing Org/repo")) inRepo = true;
      else if (raw.startsWith("Summary for")) inRepo = false;
      else if (inRepo && /^ {2}[+~=-] /.test(raw)) {
        const line = raw.slice(2).replace(/ \(replacement migration:[^)]*\)/, " (replacement migration)");
        if (line.startsWith("= ")) unchanged.push(line.slice(2));
        else lines.push(line);
      }
    }
    return { lines, unchanged };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

if (!labelSync) {
  console.log("\nparity with sync-labels.mjs: skipped, no Label-Sync checkout found");
} else {
  console.log(`\nparity with ${path.join(labelSync, "scripts", "sync-labels.mjs")}`);
  for (const c of CASES) {
    const real = runReal(labelSync, c);
    if (real.error) {
      check(`${c.name}: real run`, false, real.error.split("\n").pop());
      continue;
    }
    const mine = planned.get(c);
    check(`${c.name}: matches`, same(real.lines, mine.lines), `real ${JSON.stringify(real.lines)}`);
    check(
      `${c.name}: unchanged matches`,
      same(real.unchanged, mine.unchanged),
      `real ${JSON.stringify(real.unchanged)}`,
    );
  }
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
