import { decider, EMPTY_RULES, normalizeHook, normalizeRules } from "./relay-rules.js";

export const KEEP_DELIVERIES = 500;

export class DiscordRelay {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS rules (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, updated_at TEXT, updated_by TEXT)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS deliveries (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, entry TEXT NOT NULL)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS idx_deliveries_id ON deliveries (id)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS hook (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)");
    this.loaded = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const sent = request.method === "GET" ? null : await request.json().catch(() => null);
    if (url.pathname === "/decide" && request.method === "POST") return Response.json(this.decide(sent));
    if (url.pathname === "/outcome" && request.method === "POST") {
      this.outcome(sent);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/state" && request.method === "GET") return Response.json(this.state());
    if (url.pathname === "/hook" && request.method === "PUT") return Response.json(this.saveHook(sent));
    if (url.pathname === "/rules" && request.method === "PUT") {
      const { status, body } = this.save(sent);
      return Response.json(body, { status });
    }
    return new Response("not found", { status: 404 });
  }

  current() {
    if (this.loaded) return this.loaded;
    const row = this.sql.exec("SELECT json, updated_at, updated_by FROM rules WHERE id = 1").toArray()[0];
    let rules = EMPTY_RULES;
    try {
      if (row) rules = normalizeRules(JSON.parse(row.json));
    } catch {}
    this.loaded = { rules, updatedAt: row?.updated_at ?? null, updatedBy: row?.updated_by ?? null, decide: decider(rules) };
    return this.loaded;
  }

  hook() {
    const row = this.sql.exec("SELECT json FROM hook WHERE id = 1").toArray()[0];
    try {
      return row ? normalizeHook(JSON.parse(row.json)) : null;
    } catch {
      return null;
    }
  }

  saveHook(sent) {
    const before = this.hook() ?? {};
    const next = normalizeHook({ ...before, ...(sent ?? {}) });
    this.sql.exec(
      "INSERT INTO hook (id, json) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json",
      JSON.stringify(next),
    );
    return next;
  }

  decide(sent) {
    if (sent?.hookId && String(sent.hookId) !== this.hook()?.id) this.saveHook({ id: sent.hookId });
    const facts = sent?.facts;
    if (!facts || typeof facts.event !== "string") return { send: true, reason: null, logged: false };
    const { send, reason } = this.current().decide(facts);
    const id = String(sent.id || `${facts.event}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const entry = {
      id,
      at: sent.at ?? new Date().toISOString(),
      ...facts,
      text: sent.text ?? null,
      url: sent.url ?? null,
      send,
      reason,
      discord: send ? "pending" : null,
    };
    this.sql.exec("INSERT INTO deliveries (id, entry) VALUES (?, ?)", id, JSON.stringify(entry));
    this.sql.exec(
      "DELETE FROM deliveries WHERE seq <= (SELECT seq FROM deliveries ORDER BY seq DESC LIMIT 1 OFFSET ?)",
      KEEP_DELIVERIES,
    );
    return { send, reason, logged: true, id };
  }

  outcome(sent) {
    if (!sent?.id) return;
    const row = this.sql.exec("SELECT seq, entry FROM deliveries WHERE id = ? ORDER BY seq DESC LIMIT 1", String(sent.id)).toArray()[0];
    if (!row) return;
    const entry = JSON.parse(row.entry);
    entry.discord = sent.discord ?? null;
    if (sent.detail) entry.detail = String(sent.detail).slice(0, 200);
    this.sql.exec("UPDATE deliveries SET entry = ? WHERE seq = ?", JSON.stringify(entry), row.seq);
  }

  state() {
    const { rules, updatedAt, updatedBy } = this.current();
    const deliveries = this.sql.exec("SELECT entry FROM deliveries ORDER BY seq DESC").toArray().map((row) => JSON.parse(row.entry));
    return { rules, updatedAt, updatedBy, keep: KEEP_DELIVERIES, hook: this.hook(), deliveries };
  }

  save(sent) {
    if (!sent?.rules || typeof sent.rules !== "object") return { status: 400, body: { error: "no rules sent" } };
    const now = this.current();
    if ((sent.base ?? null) !== now.updatedAt) {
      return { status: 409, body: { error: "the rules were changed by someone else", ...this.state() } };
    }
    const rules = normalizeRules(sent.rules);
    const at = sent.at ?? new Date().toISOString();
    this.sql.exec(
      "INSERT INTO rules (id, json, updated_at, updated_by) VALUES (1, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
      JSON.stringify(rules), at, sent.by ?? null,
    );
    this.loaded = null;
    return { status: 200, body: this.state() };
  }
}
