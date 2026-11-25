/**
 *   node --experimental-sqlite worker/test/properties.test.js
 *
 * The Custom Properties page: the planner, applying a batch against a stubbed
 * GitHub, the history it writes, and the webhook telling its echoes apart.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { applyProperties, propertiesState } from "../src/properties.js";
import { onCustomProperty, onCustomPropertyValues, propertyAttribution } from "../src/property-history.js";
import { forgetToken } from "../src/github.js";
import { forgetOrgManagerToken } from "../src/org-manager.js";
import { EventLog } from "../src/event-log.js";
import { crossTab, distribution, gaps, importCsv, normDef, parseCsv, planBatch, stateFrom, toCsv } from "../../web/js/properties-calc.js";

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}` + (ok ? "" : `\n          expected ${JSON.stringify(expected)}\n          got      ${JSON.stringify(actual)}`));
}

const raw = new DatabaseSync(":memory:");
raw.exec(readFileSync("worker/schema.sql", "utf8"));
const db = {
  prepare(sql) {
    let params = [];
    const api = {
      bind(...p) { params = p; return api; },
      async all() { return { results: raw.prepare(sql).all(...params) }; },
      async first() { return raw.prepare(sql).get(...params) ?? null; },
      async run() { const r = raw.prepare(sql).run(...params); return { meta: { changes: r.changes } }; },
    };
    return api;
  },
};

const pair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
const PEM = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----\n`;
const env = { DB: db, GITHUB_ORG: "GTNewHorizons", GH_APP_ID: "4745300", GH_APP_PRIVATE_KEY: PEM, ORG_MANAGER_APP_ID: "5299242", ORG_MANAGER_PRIVATE_KEY: PEM };

const defs = () => new Map([
  ["Type", { property_name: "Type", value_type: "single_select", allowed_values: ["Mod", "Library", "Tool"], required: false }],
  ["Tags", { property_name: "Tags", value_type: "multi_select", allowed_values: ["GT", "Magic", "Old"] }],
  ["Owner", { property_name: "Owner", value_type: "string" }],
]);
let gh;
let calls;
let failOn = null;

function reset() {
  gh = {
    repos: ["Alpha", "Beta", "Gamma", "Delta", "Old-Thing"],
    archived: new Set(["Old-Thing"]),
    defs: defs(),
    values: new Map([
      ["Alpha", { Type: "Mod", Tags: ["GT", "Old"] }],
      ["Beta", { Type: "Library", Tags: ["Old"] }],
      ["Gamma", { Type: "Mod" }],
      ["Delta", {}],
      ["Old-Thing", { Type: "Tool" }],
    ]),
  };
  calls = [];
  failOn = null;

}
reset();

const issuer = (auth) => {
  try { return JSON.parse(Buffer.from(auth.replace("Bearer ", "").split(".")[1], "base64url")).iss; } catch { return null; }
};

globalThis.fetch = async (url, init = {}) => {
  const path = String(url).replace("https://api.github.com", "");
  const method = init.method ?? "GET";
  const auth = init.headers?.Authorization ?? "";
  if (path === "/orgs/GTNewHorizons/installation") return Response.json({ id: issuer(auth) === "5299242" ? 2 : 1 });
  const minted = path.match(/^\/app\/installations\/(\d)\/access_tokens$/);
  if (minted) return Response.json({ token: minted[1] === "2" ? "ghs_om" : "ghs_db", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
  const token = auth.replace("Bearer ", "");
  if (method !== "GET") {
    calls.push(`${method} ${path.replace("/orgs/GTNewHorizons/properties/", "")} ${token}`);
    if (failOn && failOn(method, path, init)) return new Response(JSON.stringify({ message: "Validation Failed" }), { status: 422 });
  }
  if (path.startsWith("/orgs/GTNewHorizons/repos")) return Response.json(gh.repos.map((name) => ({ name, archived: gh.archived.has(name), default_branch: "main" })));
  if (path === "/orgs/GTNewHorizons/properties/schema") return Response.json([...gh.defs.values()]);
  if (path.startsWith("/orgs/GTNewHorizons/properties/values") && method === "GET") {
    return Response.json([...gh.values].map(([name, props]) => ({ repository_name: name, properties: Object.entries(props).map(([property_name, value]) => ({ property_name, value })) })));
  }
  if (path === "/orgs/GTNewHorizons/properties/values" && method === "PATCH") {
    const body = JSON.parse(init.body);
    for (const repo of body.repository_names) {
      const v = gh.values.get(repo);
      for (const p of body.properties) { if (p.value == null) delete v[p.property_name]; else v[p.property_name] = p.value; }
    }
    return new Response(null, { status: 204 });
  }
  const schema = path.match(/^\/orgs\/GTNewHorizons\/properties\/schema\/(.+)$/);
  if (schema) {
    const name = decodeURIComponent(schema[1]);
    if (method === "PUT") {
      const body = JSON.parse(init.body);
      gh.defs.set(name, { property_name: name, ...body });
      return Response.json(gh.defs.get(name));
    }
    if (method === "DELETE") {
      gh.defs.delete(name);
      for (const v of gh.values.values()) delete v[name];
      return new Response(null, { status: 204 });
    }
  }
  return new Response(`unstubbed ${method} ${path}`, { status: 599 });
};

const state = () => stateFrom({
  schema: [...gh.defs.values()].map((p) => ({ name: p.property_name, type: p.value_type, allowed: p.allowed_values ?? null, required: p.required, default: p.default_value ?? null })),
  repos: gh.repos.filter((r) => !gh.archived.has(r)).map((name) => ({ name, properties: gh.values.get(name) })),
});
const def = (name) => normDef({ ...gh.defs.get(name) });

async function drain(out) {
  if (!out.stream) return { lines: [], out };
  const text = await new Response(out.stream).text();
  await out.job;
  return { lines: text.trim().split("\n").map((l) => JSON.parse(l)), out };
}
const resultsOf = (lines) => Object.fromEntries((lines.at(-1)?.results ?? []).map((r) => [r.key, r.status]));

console.log("\nplanning");
{
  reset();
  const plan = planBatch([
    { kind: "value", repo: "Delta", prop: "Type", from: null, to: "Tool" },
    { kind: "value", repo: "Gamma", prop: "Type", from: "Mod", to: "Tool" },
  ], state(), { org: "GTNewHorizons" });
  check("repos getting the same values share one write", plan.steps.map((s) => [s.method, s.body.repository_names]), [["PATCH", ["Delta", "Gamma"]]]);

  const many = Array.from({ length: 70 }, (_, i) => `R${i}`);
  const big = { defs: state().defs, values: new Map(many.map((r) => [r, {}])), repos: new Set(many) };
  const bulk = planBatch(many.map((repo) => ({ kind: "value", repo, prop: "Owner", from: null, to: "me" })), big, { org: "GTNewHorizons" });
  check("and are split 30 at a time", bulk.steps.map((s) => s.body.repository_names.length), [30, 30, 10]);

  const stale = planBatch([{ kind: "value", repo: "Gamma", prop: "Type", from: "Library", to: "Tool" }], state(), { org: "GTNewHorizons" });
  check("a value changed on GitHub since loading is a conflict", [stale.steps.length, stale.results.get("value:Gamma:Type").status], [0, "conflict"]);

  const bad = planBatch([{ kind: "value", repo: "Gamma", prop: "Type", from: "Mod", to: "Nope" }], state(), { org: "GTNewHorizons" });
  check("a value that isn't allowed is refused", bad.results.get("value:Gamma:Type").status, "invalid");

  const archived = planBatch([{ kind: "value", repo: "Old-Thing", prop: "Type", from: "Tool", to: "Mod" }], state(), { org: "GTNewHorizons" });
  check("archived repos can't be changed", archived.results.get("value:Old-Thing:Type").status, "conflict");

  const revalue = planBatch([{ kind: "revalue", name: "Tags", sources: ["Old"], target: "Legacy", from: def("Tags") }], state(), { org: "GTNewHorizons" });
  check("renaming a value adds the new one, moves repos, then removes the old one",
    revalue.steps.map((s) => [s.phase, s.method, s.body?.allowed_values ?? s.body?.repository_names]),
    [[1, "PUT", ["GT", "Magic", "Legacy", "Old"]], [3, "PATCH", ["Alpha"]], [3, "PATCH", ["Beta"]], [4, "PUT", ["GT", "Magic", "Legacy"]]]);
  check("multi-select keeps a repo's other values", revalue.steps[1].body.properties, [{ property_name: "Tags", value: ["GT", "Legacy"] }]);
  check("and the last step waits on every move", [...revalue.steps[3].needs].sort(), [0, 1, 2]);

  const merge = planBatch([{ kind: "revalue", name: "Type", sources: ["Library", "Tool"], target: "Mod", from: def("Type") }], state(), { org: "GTNewHorizons" });
  check("merging into an existing value needs no first write", merge.steps.map((s) => s.method), ["PATCH", "PUT"]);

  const rename = planBatch([{ kind: "rename", name: "Type", to: "Kind", from: def("Type") }], state(), { org: "GTNewHorizons" });
  check("a rename creates, copies, then deletes", rename.steps.map((s) => `${s.phase} ${s.method} ${s.path.split("/").pop()}`),
    ["1 PUT Kind", "3 PATCH values", "3 PATCH values", "5 DELETE Type"]);
  check("and the delete waits for the copies", [...rename.steps[3].needs].sort(), [0, 1, 2]);

  const clash = planBatch([
    { kind: "rename", name: "Type", to: "Kind", from: def("Type") },
    { kind: "value", repo: "Delta", prop: "Type", from: null, to: "Mod" },
  ], state(), { org: "GTNewHorizons" });
  check("a value on a property being renamed is refused", clash.results.get("value:Delta:Type").status, "invalid");

  const shrink = planBatch([{ kind: "update", name: "Type", from: def("Type"), to: { ...def("Type"), allowed: ["Mod", "Library"] } }], state(), { org: "GTNewHorizons" });
  check("removing an allowed value is the last write", shrink.steps.map((s) => s.phase), [4]);

  const grow = planBatch([
    { kind: "update", name: "Type", from: def("Type"), to: { ...def("Type"), allowed: ["Mod", "Library", "Tool", "Addon"] } },
    { kind: "value", repo: "Delta", prop: "Type", from: null, to: "Addon" },
  ], state(), { org: "GTNewHorizons" });
  check("a value added in the same batch can be used", grow.steps.map((s) => [s.phase, [...s.needs]]), [[1, []], [3, [0]]]);

  const changed = planBatch([{ kind: "delete", name: "Type", from: { ...def("Type"), description: "old" } }], state(), { org: "GTNewHorizons" });
  check("a definition changed since loading is a conflict", changed.results.get("def:Type").status, "conflict");

  const twice = planBatch([
    { kind: "delete", name: "Owner", from: def("Owner") },
    { kind: "update", name: "Owner", from: def("Owner"), to: { ...def("Owner"), description: "x" } },
  ], state(), { org: "GTNewHorizons" });
  check("one definition change per property", [...twice.results.values()].map((r) => r.status), ["invalid"]);

  const create = planBatch([{ kind: "create", def: { name: "Kind", type: "single_select", allowed: [] } }], state(), { org: "GTNewHorizons" });
  check("a select needs allowed values", create.results.get("def:Kind").status, "invalid");
}

console.log("\nreading");
{
  reset();
  forgetToken();
  const { status, body } = await propertiesState(env);
  check("answers", status, 200);
  check("leaves archived repos out", body.repos.map((r) => r.name), ["Alpha", "Beta", "Delta", "Gamma"]);
  check("keeps the whole definition", body.schema[0], { name: "Type", type: "single_select", allowed: ["Mod", "Library", "Tool"], description: null, required: false, default: null, editableBy: "org_actors", explicit: false });
  check("history is there, and empty", [body.history, body.historyError], [[], null]);
}

console.log("\napplying");
{
  reset();
  forgetToken();
  forgetOrgManagerToken();
  const sent = { changes: [
    { kind: "value", repo: "Delta", prop: "Type", from: null, to: "Tool" },
    { kind: "revalue", name: "Tags", sources: ["Old"], target: "Legacy", from: def("Tags") },
  ] };
  const { lines } = await drain(await applyProperties(env, "ethan@example.com", sent, { pace: 0 }));
  check("streams a start, a line per write and a summary", lines.map((l) => l.type), ["start", "step", "step", "step", "step", "step", "done"]);
  check("every change is done", resultsOf(lines), { "revalue:Tags:Old": "done", "value:Delta:Type": "done" });
  check("as Org-Manager", calls.every((c) => c.endsWith("ghs_om")), true);
  check("GitHub ends up right", [gh.values.get("Delta").Type, gh.values.get("Alpha").Tags, gh.defs.get("Tags").allowed_values], ["Tool", ["GT", "Legacy"], ["GT", "Magic", "Legacy"]]);
  const rows = raw.prepare("SELECT repo, property, before, after, by, source, state FROM property_history ORDER BY id").all().map((r) => ({ ...r }));
  check("history has every change, marked done", rows.map((r) => [r.repo, r.property, r.after && r.repo ? r.after : r.repo ? null : "def", r.state]), [
    ["Alpha", "Tags", '["GT","Legacy"]', "done"],
    ["Beta", "Tags", '["Legacy"]', "done"],
    ["Delta", "Type", '"Tool"', "done"],
    [null, "Tags", "def", "done"],
  ]);
  check("and who did it", [...new Set(rows.map((r) => `${r.by} ${r.source}`))], ["ethan@example.com dashboard"]);
  check("the lock is let go", raw.prepare("SELECT COUNT(*) n FROM meta WHERE key = 'properties_apply'").get().n, 0);

  const echo = { sender: { login: "nh-org-manager[bot]", type: "Bot" }, repository: { name: "Delta" },
    old_property_values: [{ property_name: "Type", value: null }], new_property_values: [{ property_name: "Type", value: "Tool" }] };
  check("Org-Manager's echo is recognised", await onCustomPropertyValues(db, echo), { skipped: "dashboard echo" });
  check("and attributed to whoever applied it", await propertyAttribution(db, "custom_property_values", echo), "ethan@example.com");
  const human = { ...echo, sender: { login: "Dream-Master", type: "User" } };
  check("the same change by a person is their own", await onCustomPropertyValues(db, human), { table: "property_history", repo: "Delta", logged: 1 });
  check("and isn't attributed to the dashboard", await propertyAttribution(db, "custom_property_values", human), null);
  const defEcho = { action: "updated", sender: { type: "Bot", login: "nh-org-manager[bot]" }, definition: { property_name: "Tags", value_type: "multi_select" } };
  check("a definition echo is recognised", await onCustomProperty(db, defEcho), { skipped: "dashboard echo" });
  const made = await onCustomProperty(db, { action: "created", sender: { type: "User", login: "boubou" }, definition: { property_name: "Team", value_type: "string" } });
  check("a property made on GitHub is logged", made, { table: "property_history", property: "Team", action: "created" });
}

console.log("\nfailures");
{
  reset();
  forgetOrgManagerToken();
  failOn = (method, path) => method === "PATCH" && path.endsWith("/values");
  const rename = { changes: [{ kind: "rename", name: "Type", to: "Kind", from: def("Type") }] };
  const { lines } = await drain(await applyProperties(env, "ethan@example.com", rename, { pace: 0 }));
  const steps = lines.filter((l) => l.type === "step").map((l) => l.state);
  check("a failed copy stops the delete", steps, ["done", "failed", "failed", "blocked"]);
  check("so the old property survives", gh.defs.has("Type"), true);
  check("and the rename is reported failed", resultsOf(lines)["def:Type"], "failed");
  const batch = raw.prepare("SELECT batch FROM property_history WHERE source = 'dashboard' ORDER BY id DESC LIMIT 1").get().batch;
  check("history keeps only what happened", raw.prepare("SELECT note FROM property_history WHERE batch = ? ORDER BY id").all(batch).map((r) => r.note), ["renamed from Type"]);

  reset();
  const stale = { changes: [{ kind: "value", repo: "Gamma", prop: "Type", from: "Library", to: "Tool" }] };
  const out = await applyProperties(env, "ethan@example.com", stale, { pace: 0 });
  check("a batch with nothing left to write answers in one piece", [out.status, out.body.results[0].status], [200, "conflict"]);

  raw.prepare("INSERT INTO meta (key, value) VALUES ('properties_apply', ?)").run(JSON.stringify({ run: "x", by: "boubou@example.com", seen: Date.now() }));
  const locked = await applyProperties(env, "ethan@example.com", { changes: [{ kind: "value", repo: "Delta", prop: "Owner", from: null, to: "me" }] });
  check("a second apply while one runs is refused", [locked.status, /boubou/.test(locked.body.error)], [409, true]);
  raw.prepare("DELETE FROM meta WHERE key = 'properties_apply'").run();

  calls = [];
  const dry = await drain(await applyProperties({ ...env, ORG_MANAGER_PRIVATE_KEY: "" }, "dev@localhost", { changes: [{ kind: "value", repo: "Delta", prop: "Owner", from: null, to: "me" }] }, { dryRun: true }));
  check("a dry run writes nothing", [calls.length, resultsOf(dry.lines)["value:Delta:Owner"], dry.lines[0].dry], [0, "done", true]);
}

console.log("\nthe page's views");
{
  reset();
  const s = state();
  const repos = [...s.values].map(([name, properties]) => ({ name, properties }));
  check("distribution counts repos and values", distribution(s.defs.get("Tags"), repos), { set: 2, unset: 2, counts: [["GT", 1], ["Magic", 0], ["Old", 2]], stale: 0 });
  const t = crossTab(s.defs.get("Type"), s.defs.get("Tags"), repos);
  check("cross-tab puts a multi-select repo in each of its values", [t.at("Mod", "GT"), t.at("Mod", "Old"), t.at("Mod", null), t.at(null, null)], [["Alpha"], ["Alpha"], ["Gamma"], ["Delta"]]);
  const g = gaps(s, repos);
  check("gaps finds untagged repos and unused values", [g.untagged, g.unusedValues, g.unusedProps], [["Delta"], [{ prop: "Type", values: ["Tool"] }, { prop: "Tags", values: ["Magic"] }], ["Owner"]]);

  const csv = toCsv([...s.defs.values()], repos);
  check("CSV export joins multi-select values", csv.split("\r\n")[1], "Alpha,Mod,GT; Old,");
  check("CSV parsing handles quotes", parseCsv('repo,Owner\r\nAlpha,"Smith, ""J"""\n'), [["repo", "Owner"], ["Alpha", 'Smith, "J"']]);
  const edited = csv.replace("Alpha,Mod,GT; Old,", "Alpha,library,GT,").replace("Delta,,,", "Delta,Nope,,").concat("Ghost,Mod,,\r\n");
  const imp = importCsv(edited, s);
  check("an import stages only what differs, matching values case-insensitively", imp.changes, [
    { kind: "value", repo: "Alpha", prop: "Type", from: "Mod", to: "Library" },
    { kind: "value", repo: "Alpha", prop: "Tags", from: ["GT", "Old"], to: ["GT"] },
  ]);
  check("and lists what it couldn't use", imp.problems, ["Row 5, Delta: Nope isn't an allowed value of Type", "Row 6: Ghost isn't an active repo"]);
}

console.log("\nthe log socket filter");
{
  const sockets = [];
  const ctx = { storage: { sql: { exec: () => ({ toArray: () => [] }) } }, getWebSockets: () => sockets };
  const log = new EventLog(ctx, {});
  const props = { sent: [], send(m) { this.sent.push(JSON.parse(m).event.event); }, deserializeAttachment: () => ({ only: ["custom_property_values"] }) };
  const all = { sent: [], send(m) { this.sent.push(JSON.parse(m).event.event); } };
  sockets.push(props, all);
  log.record({ box: "repo", event: "label" });
  log.record({ box: "repo", event: "custom_property_values" });
  check("a filtered socket only hears its events", props.sent, ["custom_property_values"]);
  check("the GitHub Logs page still hears everything", all.sent, ["label", "custom_property_values"]);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
