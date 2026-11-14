export const WEBHOOK_EVENTS = [
  ["push", "Pushes", []],
  ["pull_request", "Pull requests", [
    "opened", "merged", "closed", "reopened", "ready_for_review", "converted_to_draft", "synchronize", "edited",
    "labeled", "unlabeled", "assigned", "unassigned", "review_requested", "review_request_removed",
    "auto_merge_enabled", "auto_merge_disabled", "milestoned", "demilestoned", "locked", "unlocked",
  ]],
  ["pull_request_review", "PR reviews", ["submitted", "edited", "dismissed"]],
  ["pull_request_review_comment", "PR diff comments", ["created", "edited", "deleted"]],
  ["pull_request_review_thread", "PR review threads", ["resolved", "unresolved"]],
  ["issues", "Issues", [
    "opened", "closed", "reopened", "edited", "labeled", "unlabeled", "assigned", "unassigned",
    "transferred", "deleted", "pinned", "unpinned", "milestoned", "demilestoned", "locked", "unlocked", "typed", "untyped",
  ]],
  ["issue_comment", "Issue & PR comments", ["created", "edited", "deleted"]],
  ["commit_comment", "Commit comments", ["created"]],
  ["create", "Branch or tag created", []],
  ["delete", "Branch or tag deleted", []],
  ["release", "Releases", ["published", "released", "prereleased", "created", "edited", "deleted", "unpublished"]],
  ["discussion", "Discussions", ["created", "edited", "answered", "unanswered", "closed", "reopened", "deleted", "labeled", "unlabeled", "category_changed", "transferred", "pinned", "unpinned", "locked", "unlocked"]],
  ["discussion_comment", "Discussion comments", ["created", "edited", "deleted"]],
  ["fork", "Forks", []],
  ["watch", "Stars", ["started"]],
  ["public", "Repo made public", []],
  ["member", "Collaborators", ["added", "removed", "edited"]],
  ["repository", "Repositories", ["created", "deleted", "archived", "unarchived", "edited", "renamed", "transferred", "publicized", "privatized"]],
  ["gollum", "Wiki edits", []],
  ["check_run", "Check runs", ["created", "completed", "rerequested", "requested_action"]],
  ["check_suite", "Check suites", ["completed", "requested", "rerequested"]],
  ["status", "Commit statuses", []],
  ["workflow_run", "Workflow runs", ["requested", "in_progress", "completed"]],
  ["workflow_job", "Workflow jobs", ["queued", "waiting", "in_progress", "completed"]],
  ["star", "Stars (with unstars)", ["created", "deleted"]],
  ["label", "Labels", ["created", "edited", "deleted"]],
  ["milestone", "Milestones", ["created", "opened", "closed", "edited", "deleted"]],
  ["deployment", "Deployments", ["created"]],
  ["deployment_status", "Deployment statuses", ["created"]],
  ["registry_package", "Packages", ["published", "updated"]],
  ["package", "Packages (legacy)", ["published", "updated"]],
  ["branch_protection_rule", "Branch protection", ["created", "edited", "deleted"]],
  ["repository_ruleset", "Rulesets", ["created", "edited", "deleted"]],
  ["team_add", "Team added to repo", []],
  ["team", "Teams", ["created", "edited", "deleted", "added_to_repository", "removed_from_repository"]],
  ["membership", "Team membership", ["added", "removed"]],
  ["organization", "Organization", ["member_added", "member_removed", "member_invited", "renamed", "deleted"]],
  ["meta", "Webhook deleted", ["deleted"]],
];

export const EVENT_ORDER = new Map(WEBHOOK_EVENTS.map(([event], i) => [event, i]));

const LABELS = new Map(WEBHOOK_EVENTS.map(([event, label]) => [event, label]));

export const REASONS = {
  "event off": "event off",
  "action off": "action off",
  "event off for repo": "event off for this repo",
  "action off for repo": "action off for this repo",
  "repo excluded": "repo unticked",
  "sender excluded": "sender excluded",
  bot: "bot",
  "not the default branch": "not default branch",
  "rules unavailable": "rules unreadable, sent anyway",
};

export const actionsOf = (event) => WEBHOOK_EVENTS.find(([e]) => e === event)?.[2] ?? [];

export const eventLabel = (event) => LABELS.get(event) ?? event.replace(/_/g, " ");
export const actionLabel = (action) => String(action).replace(/_/g, " ");
