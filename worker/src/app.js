/**
 * The dashboard: its pages and its read API, behind Cloudflare Access.
 *
 * Access is turned on for this whole Worker and only lets GTNewHorizons members
 * through. The Worker still verifies the Access token on every /api/ request
 * itself, so a hostname or preview that Access doesn't cover returns nothing.
 * Static files come straight from web/ without running this code, since they
 * hold no data.
 *
 * Members see every page except Admin Resources. The data only those pages use
 * (ADMIN_PANELS), the manual recompute, the Dream Panel verify and the daily
 * release are refused to anyone who isn't on the admin team, whatever the page
 * shows.
 */

import { verifyAccess } from "./access.js";
import { roleFor } from "./roles.js";
import { recompute } from "./recompute.js";
import { verifyDreamPanel } from "./verify.js";
import { dailyStatus, releaseDaily } from "./daily-release.js";
import {
  handleDashboard,
  handleFacets,
  handlePanel,
  handleSearch,
  handleSubject,
  handleVersion,
  json,
} from "./reads.js";
import { ADMIN_PANELS, isAdmin } from "../../web/js/roles.js";
import { LOG_NAME } from "./event-log.js";

const LOCAL = new Set(["localhost", "127.0.0.1"]);

async function authenticate(request, env, ctx, url, opts) {
  if (env.DEV_ROLE && LOCAL.has(url.hostname)) {
    return { ok: true, identity: { email: "dev@localhost", sub: "dev" }, role: env.DEV_ROLE, groups: [] };
  }
  const auth = await verifyAccess(request, env, opts);
  if (!auth.ok) return auth;
  const { role, groups } = await roleFor(request, env, ctx, auth.identity, opts);
  return { ...auth, role, groups };
}

async function route(request, env, ctx, url, who) {
  const path = url.pathname;
  const admin = isAdmin(who.role);

  if (path === "/api/recompute") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    if (!admin) return json({ error: "admin only" }, 403);
    if (request.headers.get("origin") !== url.origin) return json({ error: "bad origin" }, 403);
    return json(await recompute(env, { force: url.searchParams.get("force") === "1" }));
  }

  if (path === "/api/verify") {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    if (!admin) return json({ error: "admin only" }, 403);
    if (request.headers.get("origin") !== url.origin) return json({ error: "bad origin" }, 403);
    try {
      return json(await verifyDreamPanel(env, { reason: "button" }));
    } catch (err) {
      console.error(JSON.stringify({ at: "verify", error: String(err) }));
      return json({ error: "verify failed", detail: String(err) }, 502);
    }
  }

  if (path === "/api/daily") {
    if (!admin) return json({ error: "admin only" }, 403);
    if (request.method === "GET") return json(await dailyStatus(env));
    if (request.method !== "POST") return json({ error: "GET or POST only" }, 405);
    if (request.headers.get("origin") !== url.origin) return json({ error: "bad origin" }, 403);
    const by = who.identity.email ?? who.identity.sub ?? "unknown";
    const dryRun = Boolean(env.DEV_ROLE && LOCAL.has(url.hostname));
    const { status, body } = await releaseDaily(env, by, { force: url.searchParams.get("force") === "1", dryRun });
    return json(body, status);
  }

  if (request.method !== "GET") return json({ error: "GET only" }, 405);

  if (path === "/api/whoami") {
    return json({
      email: who.identity.email ?? null,
      role: who.role,
      groups: who.groups,
      sessionExpires: who.identity.exp ? new Date(who.identity.exp * 1000).toISOString() : null,
    });
  }
  if (path === "/api/logs") {
    if (!admin) return json({ error: "admin only" }, 403);
    if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") return json({ error: "websocket only" }, 426);
    const devOrigin = env.DEV_ROLE && LOCAL.has(url.hostname);
    if (!devOrigin && request.headers.get("origin") !== url.origin) return json({ error: "bad origin" }, 403);
    if (!env.EVENT_LOG) return json({ error: "event log not bound" }, 503);
    return env.EVENT_LOG.get(env.EVENT_LOG.idFromName(LOG_NAME)).fetch(request);
  }
  if (path === "/api/dashboard") return handleDashboard(env, who.role);
  if (path === "/api/version") return handleVersion(env);
  if (path === "/api/search") return handleSearch(env, url);
  if (path === "/api/search/facets") return handleFacets(env);

  const panel = path.match(/^\/api\/panel\/([a-z][a-z0-9]*)$/i);
  if (panel) {
    if (ADMIN_PANELS.includes(panel[1]) && !admin) return json({ error: "admin only" }, 403);
    return handlePanel(env, panel[1]);
  }

  const person = path.match(/^\/api\/contributor\/(.+)$/);
  if (person) return handleSubject(env, ctx, "contributors", decodeURIComponent(person[1]));

  const repo = path.match(/^\/api\/repo\/(.+)$/);
  if (repo) return handleSubject(env, ctx, "repos", decodeURIComponent(repo[1]));

  return json({ error: "not found" }, 404);
}

export async function handleApp(request, env, ctx, opts) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

  const who = await authenticate(request, env, ctx, url, opts);
  if (!who.ok) {
    console.log(JSON.stringify({ at: "app", path: url.pathname, status: who.status, reason: who.reason }));
    return json({ error: who.status === 401 ? "login required" : "forbidden" }, who.status);
  }
  return route(request, env, ctx, url, who);
}

export default {
  fetch: (request, env, ctx) => handleApp(request, env, ctx),
};
