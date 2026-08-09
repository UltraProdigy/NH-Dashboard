/**
 * Search-API-backed PR panels.
 *
 * All three of these are single org-wide search queries — no per-repo fan-out,
 * so they're cheap enough to run on every build.
 */

import { searchIssues } from "../github/client.js";
import { ORG, TRACKED_LABELS } from "../config.js";

const DAY = 86_400_000;

/** Turn a search result item into the shape the frontend renders. */
function normalize(item) {
  // Search results don't include the repo directly; derive it from the URL.
  // repository_url looks like https://api.github.com/repos/OWNER/NAME
  const repo = item.repository_url?.split("/repos/")[1] ?? "unknown";

  return {
    repo,
    number: item.number,
    title: item.title,
    url: item.html_url,
    author: item.user?.login ?? "ghost",
    authorAvatar: item.user?.avatar_url ?? null,
    draft: Boolean(item.draft),
    labels: (item.labels || []).map((l) => ({ name: l.name, color: l.color })),
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    ageDays: Math.floor((Date.now() - new Date(item.created_at)) / DAY),
    staleDays: Math.floor((Date.now() - new Date(item.updated_at)) / DAY),
  };
}

/**
 * Approved but not yet merged.
 *
 * `review:approved` reflects the PR's *current* review state, so anything
 * that was approved and later got changes requested won't show up here.
 * Drafts are excluded — an approved draft isn't waiting on anyone.
 *
 * `is:open` already implies unmerged: merging closes the PR.
 */
export async function approvedUnmerged() {
  const items = await searchIssues(
    `org:${ORG} is:pr is:open review:approved -is:draft`
  );
  return items.map(normalize).sort((a, b) => b.ageDays - a.ageDays);
}

/**
 * Changes requested, not since approved.
 *
 * Same reasoning as above — `review:changes_requested` is current state, so
 * this is already "has changes requested AND is not approved".
 */
export async function changesRequested() {
  const items = await searchIssues(
    `org:${ORG} is:pr is:open review:changes_requested -is:draft`
  );
  return items.map(normalize).sort((a, b) => b.staleDays - a.staleDays);
}

/**
 * Open PRs grouped by tracked label. One search per label — see
 * TRACKED_LABELS in config.js for why we don't enumerate all of them.
 */
export async function byLabel() {
  const groups = {};

  for (const label of TRACKED_LABELS) {
    const items = await searchIssues(
      `org:${ORG} is:pr is:open label:"${label}"`
    );
    groups[label] = items.map(normalize).sort((a, b) => b.ageDays - a.ageDays);
  }

  return groups;
}
