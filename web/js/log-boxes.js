/**
 * The boxes on the GitHub Logs page, in the order they're drawn. Shared with the
 * webhook Worker, which files each delivery under one of these ids, so the two
 * can't disagree about where an event goes.
 */

export const BOXES = [
  { id: "ci", label: "CI on default branches" },
  { id: "pulls", label: "Pull requests" },
  { id: "reviews", label: "Reviews" },
  { id: "issues", label: "Issues & comments" },
  { id: "pushes", label: "Pushes & branches" },
  { id: "releases", label: "Releases" },
  { id: "settings", label: "Repository & org settings" },
  { id: "other", label: "Other" },
];

export const KEEP_PER_BOX = 200;

const EVENT_BOX = {
  workflow_run: "ci",
  pull_request: "pulls",
  pull_request_review: "reviews",
  pull_request_review_comment: "reviews",
  pull_request_review_thread: "reviews",
  issues: "issues",
  issue_comment: "issues",
  discussion: "issues",
  discussion_comment: "issues",
  push: "pushes",
  create: "pushes",
  delete: "pushes",
  release: "releases",
  repository: "settings",
  branch_protection_rule: "settings",
  branch_protection_configuration: "settings",
  repository_ruleset: "settings",
  label: "settings",
  member: "settings",
  membership: "settings",
  organization: "settings",
  team: "settings",
  team_add: "settings",
  public: "settings",
  deploy_key: "settings",
  custom_property_values: "settings",
  installation: "settings",
  installation_repositories: "settings",
};

export const boxOf = (event) => EVENT_BOX[event] ?? "other";
