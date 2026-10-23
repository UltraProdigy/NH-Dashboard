/**
 * Repo settings GitHub sends no webhook for (merge options, features, forking),
 * read on the cron and compared against the last reading so a change still
 * reaches the GitHub Logs page, ten minutes late and without who made it.
 */

import { graphql } from "./github.js";

export const SETTINGS = {
  mergeCommitAllowed: "merge commits",
  squashMergeAllowed: "squash merging",
  rebaseMergeAllowed: "rebase merging",
  autoMergeAllowed: "auto-merge",
  deleteBranchOnMerge: "auto-delete head branches",
  allowUpdateBranch: "suggest updating PR branches",
  webCommitSignoffRequired: "web commit sign-off",
  hasIssuesEnabled: "Issues",
  hasWikiEnabled: "Wiki",
  hasDiscussionsEnabled: "Discussions",
  hasProjectsEnabled: "Projects",
  hasSponsorshipsEnabled: "Sponsorships",
  forkingAllowed: "forking",
  isTemplate: "template repository",
  squashMergeCommitTitle: "squash commit title",
  squashMergeCommitMessage: "squash commit message",
  mergeCommitTitle: "merge commit title",
  mergeCommitMessage: "merge commit message",
};

const CHOICE = {
  PR_TITLE: "PR title",
  COMMIT_OR_PR_TITLE: "commit or PR title",
  PR_BODY: "PR description",
  COMMIT_MESSAGES: "commit messages",
  BLANK: "blank",
  MERGE_MESSAGE: "default merge message",
};

const QUERY = `query($org: String!, $after: String) {
  organization(login: $org) {
    repositories(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { name ${Object.keys(SETTINGS).join(" ")} }
    }
  }
}`;

export async function fetchRepoSettings(token, org, { query = graphql, maxPages = 20 } = {}) {
  const repos = {};
  let after = null;
  for (let page = 0; page < maxPages; page++) {
    const data = await query(token, QUERY, { org, after });
    const list = data.organization.repositories;
    for (const { name, ...settings } of list.nodes) repos[name] = settings;
    if (!list.pageInfo.hasNextPage) return repos;
    after = list.pageInfo.endCursor;
  }
  throw new Error(`more than ${maxPages} pages of repos`);
}

export function settingChanges(before, after) {
  return Object.keys(SETTINGS)
    .filter((key) => key in before && key in after && before[key] !== after[key])
    .map((key) => {
      const value = after[key];
      if (typeof value === "boolean") return `${SETTINGS[key]} ${value ? "on" : "off"}`;
      return `${SETTINGS[key]} → ${CHOICE[value] ?? String(value).toLowerCase().replace(/_/g, " ")}`;
    });
}

export function diffSnapshots(previous, next, { at, org }) {
  const entries = [];
  for (const [name, settings] of Object.entries(next)) {
    if (!previous[name]) continue;
    const changes = settingChanges(previous[name], settings);
    if (!changes.length) continue;
    entries.push({
      id: `settings-${name}-${at}`,
      at,
      box: "repo",
      event: "repo_settings",
      action: null,
      repo: name,
      actor: null,
      via: "10-min check",
      text: `changed settings: ${changes.join(", ")}`,
      url: `https://github.com/${org}/${encodeURIComponent(name)}/settings`,
      tone: null,
    });
  }
  return entries;
}
