/* ==========================================================================
   Where the app is mounted
   ========================================================================== */

/**
 * The path the dashboard is served from, with a trailing slash.
 *
 * Derived from this module's own URL rather than configured, because the mount
 * point differs by host: `/` under `npm run serve`, `/NH-Dashboard/` on GitHub
 * Pages, and something else again on a fork or behind a custom domain. A module
 * always knows where it was loaded from, which makes it the one fact nothing
 * has to be told.
 *
 * Its own file rather than router.js's because format.js builds the drilldown
 * links and router.js reaches render.js, which reaches format.js — a cycle
 * nobody needs for one string.
 */
const BASE = new URL("../", import.meta.url).pathname;

/** A route — "repo/GT5-Unofficial" — as a URL this document can link to. */
const href = (route) => BASE + route;

/** The route a URL from this app points at, or null if it points outside it. */
const routeOf = (url) => (url.startsWith(BASE) ? url.slice(BASE.length) : null);

export { BASE, href, routeOf };
