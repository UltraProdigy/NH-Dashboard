/**
 * The boxes on the GitHub Logs page, in the order they're drawn. Shared with the
 * webhook Worker, which files each delivery under one of these ids, so the two
 * can't disagree about where an event goes.
 */

export const BOXES = [
  { id: "security", label: "Security" },
  { id: "ci", label: "CI & deploys" },
  { id: "pulls", label: "Pull requests" },
  { id: "reviews", label: "Reviews & PR comments" },
  { id: "issues", label: "Issues" },
  { id: "pushes", label: "Pushes & branches" },
  { id: "releases", label: "Releases & packages" },
  { id: "repo", label: "Repo settings" },
  { id: "org", label: "Org & people" },
  { id: "community", label: "Community" },
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

export function boxOf(event, payload = {}) {
  if (event === "issue_comment" && payload?.issue?.pull_request) return "reviews";
  if (event === "repository_ruleset" && !payload?.repository) return "org";
  return EVENT_BOX[event] ?? FALLBACK_BOX;
}
