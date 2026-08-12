import { isDrill, state } from "./state.js";
import { PAGES } from "./pages.js";
import { closeCombo, render } from "./render.js";
import { MODULES } from "./modules/index.js";

/* ==========================================================================
   Routing — hash keeps deep links shareable and survives a reload
   ========================================================================== */

/**
 * Two shapes, because drilldown pages carry a subject:
 *
 *   #people/newcomers
 *   #contributor/Dream-Master/cActivity
 *
 * Logins and repo names can't contain a slash, so splitting on it is safe;
 * they're still percent-encoded, since they can contain plenty else.
 */
/**
 * `_` is the placeholder for "a tab is selected but no subject is". It only
 * shows up when you flip modes with a tab open, and it exists so the subject
 * always sits in the same slot — without it, `#repo/rActivity` would be
 * indistinguishable from a repo that happens to be named rActivity.
 */
const NO_SUBJECT = "_";

/**
 * Where you last were on each page, so the sidebar and the mode toggle put you
 * back rather than resetting to Overview with nothing selected.
 *
 * In memory only. The hash stays the source of truth, so a reload or a shared
 * link still lands exactly where the URL says — this only fills in the blanks
 * when a navigation doesn't specify them.
 */
const lastPlace = Object.create(null);

const remember = () => {
  lastPlace[state.page] = { module: state.module, subject: state.subject };
};

function readHash() {
  const parts = location.hash.replace(/^#/, "").split("/");
  const page = parts[0];
  if (PAGES.some(p => p.id === page)) state.page = page;

  const drill = isDrill(state.page);
  state.subject =
    drill && parts[1] && parts[1] !== NO_SUBJECT ? decodeURIComponent(parts[1]) : null;

  const mod = parts[drill ? 2 : 1];
  state.module = mod && MODULES[mod]?.page === state.page ? mod : null;
  remember();
}

/**
 * `subject` left off means "decide for me": keep it when staying on the same
 * drilldown page (switching tabs), drop it otherwise — a login is not a repo
 * name, so carrying one across a mode switch would only ever 404.
 */
function go(page, mod = null, subject) {
  const drill = isDrill(page);
  if (subject === undefined)
    subject = drill && page === state.page ? state.subject : null;

  state.page = page;
  state.module = mod;
  state.subject = drill ? subject : null;
  state.sort = null;
  state.filter = "";
  closeCombo();
  remember();

  if (drill) {
    const seg = [page];
    if (subject) seg.push(encodeURIComponent(subject));
    else if (mod) seg.push(NO_SUBJECT);
    if (mod) seg.push(mod);
    location.hash = seg.join("/");
  } else {
    location.hash = mod ? `${page}/${mod}` : page;
  }
  render();
}

/** Jump into a drilldown from anywhere, including the other drilldown page. */
function drillTo(page, id) {
  go(page, null, id);
}

/** Sidebar and mode-toggle navigation: resume rather than reset. */
function goPage(page, fallbackModule = null) {
  const last = lastPlace[page];
  go(page, last?.module ?? fallbackModule, last?.subject ?? null);
}

export { drillTo, go, goPage, readHash };
