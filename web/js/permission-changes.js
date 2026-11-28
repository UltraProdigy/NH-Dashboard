// { kind, team: { id, slug, name }, repo: { id, name }, login, name, parent, from, to },
// with only the fields its kind uses. `to: null` removes.

import { LEVELS } from "./permissions-calc.js";

export const KINDS = [
  "team_member", "team_repo", "collaborator", "visibility", "archived",
  "team_create", "team_rename", "team_parent", "team_delete", "owner",
  "team_description", "team_privacy", "team_notifications",
];

export const TEAM_ROLES = ["member", "maintainer"];

// GitHub's "closed" is what its own pages call visible.
export const PRIVACY_LABEL = { closed: "visible", secret: "secret" };
export const NOTIFY_LABEL = { enabled: "on", disabled: "off" };
export const NOTIFY_API = { enabled: "notifications_enabled", disabled: "notifications_disabled" };
export const MAX_DESCRIPTION = 1024;

export const API_LEVEL = { read: "pull", triage: "triage", write: "push", maintain: "maintain", admin: "admin" };

export const MAX_CHANGES = 1000;

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
export const validLogin = (s) => typeof s === "string" && LOGIN.test(s);
export const validTeamName = (s) => typeof s === "string" && s.trim().length > 0 && s.trim().length <= 100;

const low = (s) => String(s ?? "").toLowerCase();

export function keyOf(c) {
  switch (c?.kind) {
    case "team_member": return `tm:${c.team.id}:${low(c.login)}`;
    case "team_repo": return `tr:${c.team.id}:${c.repo.id}`;
    case "collaborator": return `co:${c.repo.id}:${low(c.login)}`;
    case "visibility": return `vis:${c.repo.id}`;
    case "archived": return `arc:${c.repo.id}`;
    case "team_create": return `tc:${low(c.name).trim()}`;
    case "team_rename": return `tn:${c.team.id}`;
    case "team_parent": return `tp:${c.team.id}`;
    case "team_delete": return `td:${c.team.id}`;
    case "owner": return `ow:${low(c.login)}`;
    case "team_description": return `tds:${c.team.id}`;
    case "team_privacy": return `tpv:${c.team.id}`;
    case "team_notifications": return `tnt:${c.team.id}`;
    default: return null;
  }
}

const REMOVES = new Set(["team_member", "team_repo", "collaborator"]);
const ALWAYS_RISKY = new Set(["visibility", "archived", "team_delete", "owner"]);

export const isRemoval = (c) => REMOVES.has(c.kind) && c.to == null;

export function isInvite(c, isMember) {
  if (c.to == null || !c.login) return false;
  if (c.kind === "team_member") return !isMember(c.login);
  if (c.kind === "collaborator") return c.from == null && !isMember(c.login);
  return false;
}

export const isRisky = (c) => ALWAYS_RISKY.has(c.kind) || c.to === "admin" || isRemoval(c);

export function needsOwner(c, adminTeamId) {
  if (c.kind === "owner") return true;
  if (adminTeamId == null) return false;
  const admin = (id) => id != null && String(id) === String(adminTeamId);
  if (c.team && admin(c.team.id)) return true;
  if (c.kind === "team_parent") return admin(c.from) || admin(c.to);
  if (c.kind === "team_create") return admin(c.parent);
  return false;
}

export function validValue(kind, v) {
  switch (kind) {
    case "team_member": return v == null || TEAM_ROLES.includes(v);
    case "team_repo":
    case "collaborator": return v == null || LEVELS.includes(v);
    case "visibility": return v === "public" || v === "private";
    case "archived": return typeof v === "boolean";
    case "owner": return v === "owner" || v === "member";
    case "team_privacy": return v in PRIVACY_LABEL;
    case "team_notifications": return v in NOTIFY_LABEL;
    case "team_description": return typeof v === "string" && v.length <= MAX_DESCRIPTION;
    default: return true;
  }
}

export function describe(c, { teamName = (id) => `team ${id}`, past = false } = {}) {
  const v = (now, then) => (past ? then : now);
  const team = c.team?.name ?? c.team?.slug ?? "?";
  const repo = c.repo?.name ?? "?";
  switch (c.kind) {
    case "team_member":
      if (c.to == null) return `${v("remove", "removed")} ${c.login} from team ${team}`;
      if (c.from == null) return `${v("add", "added")} ${c.login} to team ${team} as ${c.to}`;
      return `${v("make", "made")} ${c.login} a ${c.to} of team ${team}`;
    case "team_repo":
      if (c.to == null) return `${v("remove", "removed")} team ${team} from ${repo}`;
      if (c.from == null) return `${v("give", "gave")} team ${team} ${c.to} on ${repo}`;
      return `${v("change", "changed")} team ${team} on ${repo}: ${c.from} → ${c.to}`;
    case "collaborator":
      if (c.to == null) return `${v("remove", "removed")} ${c.login}'s direct access to ${repo}`;
      if (c.from == null) return `${v("give", "gave")} ${c.login} direct ${c.to} on ${repo}`;
      return `${v("change", "changed")} ${c.login}'s direct access to ${repo}: ${c.from} → ${c.to}`;
    case "visibility":
      return `${v("make", "made")} ${repo} ${c.to}`;
    case "archived":
      return c.to ? `${v("archive", "archived")} ${repo}` : `${v("unarchive", "unarchived")} ${repo}`;
    case "team_create":
      return `${v("create", "created")} team ${c.name}${c.parent != null ? ` under ${teamName(c.parent)}` : ""}`;
    case "team_rename":
      return `${v("rename", "renamed")} team ${c.from} to ${c.to}`;
    case "team_parent":
      return c.to == null
        ? `${v("move", "moved")} team ${team} to the top level`
        : `${v("move", "moved")} team ${team} under ${teamName(c.to)}`;
    case "team_delete":
      return `${v("delete", "deleted")} team ${team}`;
    case "owner":
      return c.to === "owner" ? `${v("make", "made")} ${c.login} an owner` : `${v("make", "made")} ${c.login} a member instead of an owner`;
    case "team_description":
      return c.to ? `${v("change", "changed")} the description of team ${team}` : `${v("clear", "cleared")} the description of team ${team}`;
    case "team_privacy":
      return `${v("make", "made")} team ${team} ${PRIVACY_LABEL[c.to] ?? c.to}`;
    case "team_notifications":
      return `${v("turn", "turned")} ${NOTIFY_LABEL[c.to] ?? c.to} notifications for team ${team}`;
    default:
      return c.kind;
  }
}

// A change and the webhook it causes share a key, so that line can name the admin instead of Org-Manager.
export function expectKeys(c, { member = true } = {}) {
  switch (c.kind) {
    case "team_member": return [`tm:${c.team.id}:${low(c.login)}`, ...(member ? [] : [`inv:${low(c.login)}`])];
    case "team_repo": return [`tr:${c.team.id}:${c.repo.id}`];
    case "collaborator": return [`co:${c.repo.id}:${low(c.login)}`];
    case "visibility":
    case "archived": return [`repo:${c.repo.id}`];
    case "team_create": return [`tc:${low(c.name).trim()}`];
    case "team_rename":
    case "team_parent":
    case "team_delete":
    case "team_description":
    case "team_privacy":
    case "team_notifications": return [`team:${c.team.id}`];
    case "owner": return [`org:${low(c.login)}`];
    default: return [];
  }
}

export function deliveryKey(event, p) {
  const team = p?.team?.id;
  const repo = p?.repository?.id;
  if (event === "membership" && team != null && p.member?.login) return `tm:${team}:${low(p.member.login)}`;
  if (event === "team_add" && team != null && repo != null) return `tr:${team}:${repo}`;
  if (event === "team" && team != null) {
    if (p.action === "created") return `tc:${low(p.team.name).trim()}`;
    if (repo != null && (p.action !== "edited" || p.changes?.repository)) return `tr:${team}:${repo}`;
    return `team:${team}`;
  }
  if (event === "member" && repo != null && p.member?.login) return `co:${repo}:${low(p.member.login)}`;
  if (event === "repository" && repo != null) return `repo:${repo}`;
  if (event === "organization") {
    if (p.action === "member_invited" && p.invitation?.login) return `inv:${low(p.invitation.login)}`;
    const login = p.membership?.user?.login;
    if (login) return `org:${low(login)}`;
  }
  return null;
}
