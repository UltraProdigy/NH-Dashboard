import { state } from "./state.js";
import { loadExclusions, loadLabels } from "./dream.js";
import { render, renderMeta } from "./render.js";
import { PAGES, restrictToMembers } from "./pages.js";
import { isAdmin } from "./roles.js";
import { readRoute } from "./router.js";
import { applyTheme } from "./theme.js";
import { collapseBtn } from "./events.js";
import { API, primeLive, setRole, startPolling } from "./live.js";

if (localStorage.getItem("nh:collapsed") === "1") {
  document.body.classList.add("collapsed");
  collapseBtn.title = "Expand sidebar";
}

const prefersLight =
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-color-scheme: light)").matches;
applyTheme(localStorage.getItem("nh:theme") ?? (prefersLight ? "light" : "dark"));

document.addEventListener("error", (e) => {
  if (e.target instanceof HTMLImageElement && e.target.parentElement?.classList.contains("pfp"))
    e.target.remove();
}, true);

async function getJson(path) {
  const res = await fetch(`${API}/api/${path}`, { cache: "no-store" });
  if (!res.ok) throw Object.assign(new Error(`${path} → ${res.status}`), { status: res.status });
  return res.json();
}

try {
  const who = await getJson("whoami");
  state.role = who.role;
  if (!isAdmin(who.role)) {
    restrictToMembers();
    setRole(who.role);
    if (!PAGES.some((p) => p.id === state.page))
      state.page = (PAGES.find((p) => p.modules.length) ?? PAGES[0]).id;
  }

  state.data = await getJson("dashboard");
  await primeLive();

  loadExclusions();
  loadLabels();
  readRoute();
  render();

  startPolling(render, renderMeta);
} catch (err) {
  document.getElementById("meta").textContent = "no data";
  const message = err.status === 401 || err.status === 403
    ? "You're not signed in, or this GitHub account isn't in GTNewHorizons. Reload the page to sign in again."
    : "The dashboard couldn't load its data. Try reloading in a minute.";
  document.getElementById("view").innerHTML = `<div class="error">${message}</div>`;
}
