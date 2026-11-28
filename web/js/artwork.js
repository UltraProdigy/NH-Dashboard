import { esc } from "./format.js";
import { href } from "./paths.js";

const art = {
  mountain: ["Mountain", "iLex"],
  workshop: ["Mid MV Chaotic Base", "Mayk"],
  steam: ["Steam Engineering", "Li Muli"],
  rockets: ["Rocket Museum", "Audacter"],
  base: ["GoodVibes™ Stargate Base", "Salsa, MimiKe and duck"],
  newage: ["Light of the New Age", "Semetix, Bl1nkle, Tbone, lui993 and P_A_JN"],
  orbit: ["GTNH main menu eclipse", "GTNH Modpack"],
};

const landing = ["newage", "workshop", "steam", "base"];
const pages = {
  overview: ["newage", "", "landing"],
  issues: ["steam", "Track issue volume, response times, and the open queue."],
  analytics: ["rockets", "Pull request activity, review flow, and CI across the organization."],
  people: ["mountain", "See who opens and reviews PRs, who just joined, and who has gone quiet."],
  repos: ["base", "Compare repository activity and find quiet projects or aging pull requests."],
  find: ["rockets", "Search issues and pull requests by title or number.", "wide"],
  contributor: ["workshop", "", "wide"],
  repo: ["steam", "", "wide"],
  dream: ["workshop", "Review pull request queues, releases, and build updates.", "wide"],
  releases: ["steam", "Choose repositories and review a release or tag plan.", "wide"],
  labels: ["workshop", "Inspect managed labels, repository drift, and custom labels.", "wide"],
  ci: ["steam", "Workflow health across sampled default branches.", "wide"],
  rulesets: ["base", "Branch protections and required checks.", "wide"],
  logs: ["rockets", "Browse GitHub activity by delivery category.", "wide"],
  permissions: ["base", "Inspect how people and teams get repository access.", "wide"],
  teams: ["mountain", "Run the org's teams and see who has stepped away.", "wide"],
  webhook: ["newage", "Manage which GitHub deliveries reach Discord.", "wide"],
};

const analyticsSubjects = {
  analytics: "Pull requests",
  issues: "Issues",
  people: "Contributors",
  repos: "Repositories",
};

const landscape = typeof matchMedia === "function" ? matchMedia("(min-width: 851px)") : null;
const reduceMotion = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;

let activePage = null;
let currentScene = 0;
let rotation;

function photo(key) {
  const [title] = art[key];
  return `<picture class="shot-${key}"><source media="(min-width: 851px)" srcset="${href(`assets/scenes/${key}.jpg`)}">
    <img alt="${esc(title)}" decoding="async"></picture>`;
}

function photoCredit(key, slot) {
  const [title, author] = art[key];
  return `<div class="photo-credit"><button type="button" class="photo-info" aria-label="Image information: ${esc(title)}"
    aria-expanded="false" aria-controls="photo-${slot}">
    <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
      <circle cx="10" cy="10" r="7.5"/><path d="M10 9.2v4.4m0-7h.01" stroke-linecap="round"/>
    </svg></button>
    <div id="photo-${slot}" class="photo-about" hidden><strong>${esc(title)}</strong><span>By ${esc(author)}</span></div>
  </div>`;
}

function setCredit(credit, open) {
  const button = credit.querySelector(".photo-info");
  button.setAttribute("aria-expanded", String(open));
  credit.querySelector(".photo-about").hidden = !open;
}

function paintHero(key) {
  document.getElementById("heroScene").innerHTML = photo(key);
  document.getElementById("heroCredit").innerHTML = photoCredit(key, "hero");
}

function renderArtwork(page) {
  if (page.id === activePage || !document.getElementById("hero")) return;
  activePage = page.id;
  clearInterval(rotation);
  const [key, description, layout = "split"] = pages[page.id] ?? pages.overview;
  const hero = document.getElementById("hero");
  hero.dataset.layout = layout;
  const logo = document.getElementById("landingMark");
  logo.hidden = layout !== "landing";
  if (!logo.hidden) logo.src = href("assets/logo.png");
  const context = document.getElementById("heroContext");
  const subject = analyticsSubjects[page.id];
  context.hidden = !subject;
  context.innerHTML = subject
    ? `<a data-pagelink href="${href("org-overview")}">Org Overview</a> <span aria-hidden="true">/</span> ${subject}`
    : "";
  const caption = document.getElementById("pageDescription");
  caption.textContent = description;
  caption.hidden = !description;
  currentScene = 0;
  paintHero(key);

  const gallery = document.getElementById("showcase");
  gallery.hidden = !["overview", "issues", "analytics", "people", "repos"].includes(page.id);
  gallery.innerHTML = gallery.hidden ? "" : [page.id === "overview" ? "mountain" : "steam", "orbit"].map((scene, i) =>
    `<figure class="showcase-photo">${photo(scene)}${photoCredit(scene, `gallery-${i}`)}</figure>`).join("");

  if (layout === "landing" && landscape) {
    rotation = setInterval(() => {
      if (document.hidden || !landscape?.matches || reduceMotion?.matches ||
          hero.querySelector('.photo-info[aria-expanded="true"]')) return;
      currentScene = (currentScene + 1) % landing.length;
      paintHero(landing[currentScene]);
    }, 14_000);
    rotation.unref?.();
  }
}

function bindPhotoCredits() {
  document.addEventListener("pointerover", (event) => {
    const credit = event.target.closest(".photo-credit");
    if (credit && event.pointerType === "mouse" && !credit.contains(event.relatedTarget)) setCredit(credit, true);
  });
  document.addEventListener("pointerout", (event) => {
    const credit = event.target.closest(".photo-credit");
    if (credit && event.pointerType === "mouse" && !credit.contains(event.relatedTarget) &&
        !credit.contains(document.activeElement) && !credit.hasAttribute("data-pinned")) setCredit(credit, false);
  });
  document.addEventListener("focusin", (event) => {
    if (event.target.matches(".photo-info:focus-visible")) setCredit(event.target.closest(".photo-credit"), true);
  });
  document.addEventListener("focusout", (event) => {
    const credit = event.target.closest(".photo-credit");
    if (credit && !credit.hasAttribute("data-pinned") && !credit.matches(":hover")) setCredit(credit, false);
  });
  const dismiss = (credit) => {
    credit.removeAttribute("data-pinned");
    setCredit(credit, false);
  };
  document.addEventListener("click", (event) => {
    const button = event.target.closest(".photo-info");
    const selected = button?.closest(".photo-credit");
    if (selected) setCredit(selected, selected.toggleAttribute("data-pinned"));
    for (const button of document.querySelectorAll('.photo-info[aria-expanded="true"]')) {
      const credit = button.closest(".photo-credit");
      if (!credit.contains(event.target)) dismiss(credit);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    for (const button of document.querySelectorAll('.photo-info[aria-expanded="true"]')) dismiss(button.closest(".photo-credit"));
  });
}

export { bindPhotoCredits, renderArtwork };
