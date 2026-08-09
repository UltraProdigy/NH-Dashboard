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

/** Pull label names out of whatever shape the config uses. */
function extractNames(parsed) {
  const list = Array.isArray(parsed)
    ? parsed
    : parsed?.labels ?? parsed?.managedLabels ?? [];

  return list
    .map((l) => (typeof l === "string" ? l : l?.name))
    .filter((n) => typeof n === "string" && n.trim())
    .map((n) => n.trim());
}

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
