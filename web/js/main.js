import { state } from "./state.js";
import { loadExclusions, loadLabels } from "./dream.js";
import { render } from "./render.js";
import { BASE, href } from "./paths.js";
import { readRoute } from "./router.js";
import { applyTheme } from "./theme.js";
import { collapseBtn } from "./events.js";
import { primeLive, startPolling } from "./live.js";

if (localStorage.getItem("nh:collapsed") === "1") {
  document.body.classList.add("collapsed");
  collapseBtn.title = "Expand sidebar";
}

const prefersLight =
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-color-scheme: light)").matches;
applyTheme(localStorage.getItem("nh:theme") ?? (prefersLight ? "light" : "dark"));

try {
  // Resolved against the app's mount point rather than the document URL: on
  // GitHub Pages this lives under /NH-Dashboard/, and once the router has
  // pushed a route the document URL is no longer the directory the data is in.
  const res = await fetch(href("data/dashboard.json"), { cache: "no-store" });
  if (!res.ok) throw new Error("no data yet");
  state.data = await res.json();

  // Before the first render, so the page paints live numbers rather than
  // painting built ones and rewriting them a moment later.
  await primeLive();

  // Derive the workflow URL from wherever this is hosted, so a fork or a
  // move into the org doesn't need this hardcoded value updated.
  // BASE rather than location.pathname: routes are real paths now, so the
  // first segment of the address bar is as likely to be a page as the repo.
  const m = location.hostname.match(/^([^.]+)\.github\.io$/);
  const repo = m ? `${m[1]}/${BASE.split("/").filter(Boolean)[0] ?? ""}` : null;
  document.getElementById("refresh").href = repo
    ? `https://github.com/${repo}/actions/workflows/build.yml`
    : "https://github.com/UltraProdigy/NH-Dashboard/actions/workflows/build.yml";

  loadExclusions();
  loadLabels();
  readRoute();
  render();

  // Re-render on the Worker's word that something changed. Re-reading the route
  // first would fight the user for the scroll position and the open tab; render
  // alone repaints the current view with the new numbers in it, and the
  // freshness line with it — a panel that was unreachable at load and came back
  // on a later poll has to move out of the red count.
  startPolling(render);
} catch (err) {
  document.getElementById("meta").textContent = "no data";
  document.getElementById("view").innerHTML =
    `<div class="error">No data found. Run <code>npm run build</code> first.</div>`;
}
