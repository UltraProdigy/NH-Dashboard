/**
 * Minimal static server for local dev — serves web/ plus data/.
 * No dependencies. When this moves to GitHub Pages, this file becomes unused;
 * Pages serves the same files directly.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 4000;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let pathname = decodeURIComponent(url.pathname);

  if (pathname === "/") pathname = "/index.html";

  // data/ is served from the repo root; everything else from web/.
  const rel = pathname.startsWith("/data/")
    ? pathname.slice(1)
    : path.join("web", pathname);

  // Contain the resolved path inside the repo.
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(path.resolve(ROOT))) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    // Routes are real paths — /analytics/actions, /repo/GT5-Unofficial — and
    // nothing on disk answers to those. Redirected to the root rather than
    // served the app here, which is what web/404.html does on GitHub Pages and
    // for the same reason: index.html pulls its styles and scripts in
    // relatively, so it has to be loaded from the one place those resolve.
    if (!path.extname(pathname)) {
      res.writeHead(302, {
        location: "/?route=" + encodeURIComponent(pathname.replace(/^\/+/, "")),
      });
      res.end();
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end(
      pathname === "/data/dashboard.json"
        ? "No data yet — run: npm run build"
        : "Not found"
    );
  }
}).listen(PORT, () => {
  console.log(`\n  Dashboard: http://localhost:${PORT}\n`);
});
