/**
 * Reads the managed label set from the Label-Sync-GTNH config.
 *
 * That repo is the org's source of truth for labels, and its list changes over
 * time, so hardcoding label names here would drift. We fetch it on every build
 * instead — one extra API request.
 *
 * The config is JSONC (comments and trailing commas allowed), which JSON.parse
 * rejects, so we strip those first.
 */

import { rest } from "./client.js";
import { LABEL_SOURCE, TRACKED_LABELS_FALLBACK } from "../config.js";

/**
 * Strip // and /* *\/ comments and trailing commas from JSONC.
 *
 * Done with a character scanner rather than a regex because label descriptions
 * routinely contain things like "https://..." — a naive regex would treat the
 * // inside that string as the start of a comment and truncate the file.
 */
export function stripJsonc(text) {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }

    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }

    if (inString) {
      out += c;
      if (c === "\\") {
        out += text[++i] ?? "";
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }

    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }

    if (c === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }

    if (c === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }

    out += c;
  }

  // Trailing commas before } or ]
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Pull labels out of whatever shape the config uses.
 *
 * Returns the whole record rather than just the name, because the colour is
 * what D1 is missing: pull requests and issues store label *names* only, so
 * every chip the Worker serves renders uncoloured until something puts the
 * palette in the database. The config already carries `color` and
 * `description` next to each name — dropping them on the way through was the
 * only reason that was ever hard.
 *
 * A config entry may still be a bare string, in which case there is no colour
 * to have and null is the honest answer.
 */
export function extractLabels(parsed) {
  const list = Array.isArray(parsed)
    ? parsed
    : parsed?.labels ?? parsed?.managedLabels ?? [];

  return list
    .map((l) => (typeof l === "string" ? { name: l } : l))
    .filter((l) => typeof l?.name === "string" && l.name.trim())
    .map((l, position) => ({
      name: l.name.trim(),
      // Configs write colours both ways and GitHub's own API omits the hash.
      // Stored without it, because that is what the API returns and what the
      // frontend's `#${color}` already expects.
      color: typeof l.color === "string" ? l.color.trim().replace(/^#/, "") : null,
      description: typeof l.description === "string" ? l.description.trim() : null,
      position,
    }));
}

/** Names only, for callers that do not care about the palette. */
const extractNames = (parsed) => extractLabels(parsed).map((l) => l.name);

/**
 * Fetch the managed label list. Falls back to the static list in config.js if
 * the repo is unreachable or the config is malformed — a label-source outage
 * shouldn't take down the whole build.
 */
export async function fetchManagedLabels() {
  const { owner, repo, path } = LABEL_SOURCE;

  try {
    // Deliberately NOT using the raw accept header: the client parses every
    // response as JSON, and a raw JSONC body (with comments) would blow up
    // there before we ever got a chance to strip them. The default response
    // is JSON metadata carrying the file base64-encoded, which parses fine.
    const res = await rest(`/repos/${owner}/${repo}/contents/${path}`);

    const text =
      typeof res === "string"
        ? res
        : res?.content
          ? Buffer.from(res.content, "base64").toString("utf8")
          : null;

    if (!text) throw new Error("unexpected response shape");

    const names = extractNames(JSON.parse(stripJsonc(text)));
    if (!names.length) throw new Error("config parsed but contained no labels");

    console.log(`  ${names.length} managed labels from ${owner}/${repo}`);
    return names;
  } catch (err) {
    console.warn(
      `  could not read managed labels (${err.message.split("\n")[0]}) — using fallback list`
    );
    return TRACKED_LABELS_FALLBACK;
  }
}

/**
 * The same fetch, keeping the colours.
 *
 * Deliberately *not* falling back to `TRACKED_LABELS_FALLBACK` on failure. That
 * list is three generic names with no colours, which is a reasonable stand-in
 * for "which labels should the build query" and a bad one for "what is the
 * org's label set" — writing it into D1 would replace twenty real labels with
 * three invented ones, and the next reader could not tell that had happened.
 * Failing loudly leaves whatever was last written in place instead.
 */
export async function fetchManagedLabelDetails() {
  const { owner, repo, path } = LABEL_SOURCE;

  const res = await rest(`/repos/${owner}/${repo}/contents/${path}`);
  const text =
    typeof res === "string"
      ? res
      : res?.content
        ? Buffer.from(res.content, "base64").toString("utf8")
        : null;

  if (!text) throw new Error("unexpected response shape");

  const labels = extractLabels(JSON.parse(stripJsonc(text)));
  if (!labels.length) throw new Error("config parsed but contained no labels");

  return labels;
}
