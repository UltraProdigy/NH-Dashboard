/**
 * Everything under /api/private/.
 *
 * The Access check happens once, here, before any route is looked up, so a
 * handler added to ROUTES cannot forget it. These responses never carry an
 * access-control-allow-origin header: the private pages are served from the
 * Worker's own origin, and a wildcard here would let any site read an admin's
 * data through their browser.
 */

import { verifyAccess } from "./access.js";

const PREFIX = "/api/private/";

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
};

const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: HEADERS });

const ROUTES = {
  whoami: async ({ identity }) => ({
    email: identity.email,
    sessionExpires: new Date(identity.exp * 1000).toISOString(),
  }),
};

export const isPrivatePath = (pathname) =>
  pathname === PREFIX.slice(0, -1) || pathname.startsWith(PREFIX);

export async function handlePrivate(request, env, url, opts) {
  const auth = await verifyAccess(request, env, opts);
  if (!auth.ok) {
    console.log(JSON.stringify({ at: "private", path: url.pathname, status: auth.status, reason: auth.reason }));
    return reply({ error: auth.status === 401 ? "login required" : "forbidden" }, auth.status);
  }

  if (request.method !== "GET") return reply({ error: "GET only" }, 405);

  const name = url.pathname.slice(PREFIX.length);
  const route = Object.hasOwn(ROUTES, name) ? ROUTES[name] : null;
  if (!route) return reply({ error: "not found" }, 404);

  try {
    return reply(await route({ env, identity: auth.identity, url }));
  } catch (err) {
    console.log(JSON.stringify({ at: "private", path: url.pathname, error: String(err) }));
    return reply({ error: "failed" }, 500);
  }
}
