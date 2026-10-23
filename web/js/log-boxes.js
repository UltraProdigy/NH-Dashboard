/**
 * The boxes on the GitHub Logs page, in the order they're drawn. Shared with the
 * webhook Worker, which files each delivery under one of these ids, so the two
 * can't disagree about where an event goes.
 */

export const BOXES = [
  { id: "security", label: "Security" },
  { id: "ci", label: "CI & deploys", note: "Only runs on each repo's default branch. PR builds are left out." },
  { id: "pulls", label: "Pull requests" },
  { id: "reviews", label: "Reviews & PR comments" },
  { id: "issues", label: "Issues" },
  { id: "pushes", label: "Pushes & branches" },
  { id: "releases", label: "Releases & packages" },
  { id: "repo", label: "Repo settings" },
  { id: "org", label: "Org & people" },
  { id: "community", label: "Community", note: "Also anything the App receives that has no box of its own." },
];

export const KEEP_PER_BOX = 200;

export const FALLBACK_BOX = "community";

export const DROPPED_EVENTS = new Set(["check_run", "check_suite", "status", "workflow_job", "merge_group"]);

const EVENT_BOX = {
  dependabot_alert: "security",
  code_scanning_alert: "security",
  security_and_analysis: "security",
  deploy_key: "security",
  personal_access_token_request: "security",
  org_block: "security",
  workflow_run: "ci",
  workflow_dispatch: "ci",
  deployment: "ci",
  pull_request: "pulls",
  pull_request_review: "reviews",
  pull_request_review_comment: "reviews",
  pull_request_review_thread: "reviews",
  issues: "issues",
  issue_comment: "issues",
  milestone: "issues",
  sub_issues: "issues",
  issue_dependencies: "issues",
  issue_relates_to: "issues",
  push: "pushes",
  create: "pushes",
  delete: "pushes",
  commit_comment: "pushes",
  release: "releases",
  registry_package: "releases",
  repository: "repo",
  label: "repo",
  branch_protection_rule: "repo",
  branch_protection_configuration: "repo",
  repository_ruleset: "repo",
  public: "repo",
  custom_property_values: "repo",
  organization: "org",
  member: "org",
  membership: "org",
  team: "org",
  team_add: "org",
  custom_property: "org",
  installation: "org",
  installation_repositories: "org",
  installation_target: "org",
  discussion: "community",
  discussion_comment: "community",
  gollum: "community",
  star: "community",
  watch: "community",
  fork: "community",
};

const EVENT_LABEL = {
  dependabot_alert: "Dependabot alerts",
  code_scanning_alert: "Code scanning alerts",
  security_and_analysis: "Security features turned on or off",
  deploy_key: "Deploy keys added or removed",
  personal_access_token_request: "Fine-grained token requests",
  org_block: "Users blocked or unblocked",
  workflow_run: "Workflow runs: queued, running, finished",
  workflow_dispatch: "Workflows run by hand",
  deployment: "Deployments",
  pull_request: "Opened, merged, closed, labeled, assigned, review requests, pushes",
  pull_request_review: "Approvals, change requests and reviews",
  pull_request_review_comment: "Comments on the diff",
  pull_request_review_thread: "Review threads resolved or unresolved",
  issues: "Opened, closed, labeled, assigned, edited",
  milestone: "Milestones",
  sub_issues: "Sub-issues added or removed",
  issue_dependencies: "Blocked-by links",
  issue_relates_to: "Relates-to links",
  push: "Commits pushed, including force-pushes",
  create: "Branches and tags created",
  delete: "Branches and tags deleted",
  commit_comment: "Comments on commits",
  release: "Releases published, edited or deleted",
  registry_package: "GitHub Packages published",
  repository: "Repos created, edited, renamed, archived, deleted, transferred",
  label: "Labels created, edited or deleted",
  branch_protection_rule: "Branch protection rules",
  branch_protection_configuration: "Branch protection switched on or off",
  public: "Repos made public",
  custom_property_values: "Custom property values",
  organization: "Members invited, added or removed; org renamed",
  member: "Repo collaborators added, removed or changed",
  membership: "People added to or removed from teams",
  team: "Teams created, edited or deleted",
  team_add: "Teams given access to a repo",
  custom_property: "Custom property definitions",
  installation: "The App installed, suspended or removed",
  installation_repositories: "Repos added to or removed from the App",
  installation_target: "The org the App is installed on renamed",
  discussion: "Discussions",
  discussion_comment: "Discussion comments",
  gollum: "Wiki pages created or edited",
  star: "Stars",
  watch: "Watchers",
  fork: "Forks",
};

const ROUTED = {
  reviews: [["issue_comment", "Comments on PRs"]],
  issues: [["issue_comment", "Comments on issues"]],
  repo: [["repository_ruleset", "Rulesets on one repo"]],
  org: [["repository_ruleset", "Org-wide rulesets"]],
};
const ROUTED_EVENTS = new Set(Object.values(ROUTED).flat().map(([event]) => event));

export function monitors(boxId) {
  const direct = Object.entries(EVENT_BOX)
    .filter(([event, box]) => box === boxId && !ROUTED_EVENTS.has(event))
    .map(([event]) => [event, EVENT_LABEL[event] ?? event]);
  return [...direct, ...(ROUTED[boxId] ?? [])];
}

export function boxOf(event, payload = {}) {
  if (event === "issue_comment" && payload?.issue?.pull_request) return "reviews";
  if (event === "repository_ruleset" && !payload?.repository) return "org";
  return EVENT_BOX[event] ?? FALLBACK_BOX;
}
