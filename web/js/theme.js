/* ---- theme ---------------------------------------------------------------
   Nothing to do with GitHub — this is the dashboard's own setting, defaulting
   to whatever the OS asks for and remembered once you override it. */
const SUN = `<circle cx="8" cy="8" r="3.2"/><path d="M8 0a.7.7 0 0 1 .7.7v1.4a.7.7 0 0 1-1.4 0V.7A.7.7 0 0 1 8 0Zm0 13.2a.7.7 0 0 1 .7.7v1.4a.7.7 0 0 1-1.4 0v-1.4a.7.7 0 0 1 .7-.7ZM16 8a.7.7 0 0 1-.7.7h-1.4a.7.7 0 0 1 0-1.4h1.4A.7.7 0 0 1 16 8ZM2.8 8a.7.7 0 0 1-.7.7H.7a.7.7 0 0 1 0-1.4h1.4a.7.7 0 0 1 .7.7Zm10.85-5.65a.7.7 0 0 1 0 1L12.66 4.3a.7.7 0 1 1-1-1l1-1a.7.7 0 0 1 1 0ZM4.34 11.66a.7.7 0 0 1 0 1l-1 1a.7.7 0 1 1-1-1l1-1a.7.7 0 0 1 1 0Zm9.31 2a.7.7 0 0 1-1 0l-1-1a.7.7 0 1 1 1-1l1 1a.7.7 0 0 1 0 1ZM4.34 4.34a.7.7 0 0 1-1 0l-1-1a.7.7 0 0 1 1-1l1 1a.7.7 0 0 1 0 1Z"/>`;
const MOON = `<path d="M9.9 1.3a6.7 6.7 0 1 0 4.9 8.2 5.5 5.5 0 0 1-4.9-8.2Z"/>`;

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  document.getElementById("themeIcon").innerHTML = t === "dark" ? SUN : MOON;
  document.getElementById("themeLabel").textContent = t === "dark" ? "Light mode" : "Dark mode";
  document.getElementById("theme").title = t === "dark" ? "Switch to light mode" : "Switch to dark mode";
}

document.getElementById("theme").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem("nh:theme", next);
  applyTheme(next);
});

export { applyTheme };
