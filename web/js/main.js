import { state } from "./state.js";
import { loadExclusions } from "./dream.js";
import { render } from "./render.js";
import { readHash } from "./router.js";
import { applyTheme } from "./theme.js";
import { collapseBtn } from "./events.js";

if (localStorage.getItem("nh:collapsed") === "1") {
  document.body.classList.add("collapsed");
  collapseBtn.title = "Expand sidebar";
}

const prefersLight =
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-color-scheme: light)").matches;
applyTheme(localStorage.getItem("nh:theme") ?? (prefersLight ? "light" : "dark"));

try {
  // Relative, not absolute: on GitHub Pages this lives under /NH-Dashboard/,
  // so a leading slash would resolve to the wrong origin root.
  const res = await fetch("data/dashboard.json", { cache: "no-store" });
  if (!res.ok) throw new Error("no data yet");
  state.data = await res.json();

  const built = new Date(state.data.generatedAt);
  const mins = Math.round((Date.now() - built) / 60000);
  const ageText = mins < 1 ? "just now" : mins < 90 ? `${mins} min ago` : `${Math.round(mins / 60)} hr ago`;
  const meta = document.getElementById("meta");
  meta.textContent = `${state.data.org} · built ${ageText}`;
  // Flag it visually once the data is older than a couple of cron cycles,
  // which usually means a workflow run failed rather than just ran late.
  if (mins > 90) meta.classList.add("stale");

  // Derive the workflow URL from wherever this is hosted, so a fork or a
  // move into the org doesn't need this hardcoded value updated.
  const m = location.hostname.match(/^([^.]+)\.github\.io$/);
  const repo = m ? `${m[1]}/${location.pathname.split("/").filter(Boolean)[0] ?? ""}` : null;
  document.getElementById("refresh").href = repo
    ? `https://github.com/${repo}/actions/workflows/build.yml`
    : "https://github.com/UltraProdigy/NH-Dashboard/actions/workflows/build.yml";

  state.label = Object.keys(state.data.panels.byLabel?.data ?? {})[0] ?? null;
  loadExclusions();
  readHash();
  render();
} catch (err) {
  document.getElementById("meta").textContent = "no data";
  document.getElementById("view").innerHTML =
    `<div class="error">No data found. Run <code>npm run build</code> first.</div>`;
}
