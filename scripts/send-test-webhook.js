/**
 * Send a signed webhook to a running Worker.
 *
 * Proves the signature path end to end before GitHub is pointed at anything,
 * which matters because a webhook endpoint that keeps failing gets its
 * subscription disabled — and the failures would arrive as silence.
 *
 *   node scripts/send-test-webhook.js
 *   node scripts/send-test-webhook.js --event issues --url https://...
 *   node scripts/send-test-webhook.js --bad          send a wrong signature
 *
 * Reads the secret from worker/.dev.vars so it always matches what the Worker
 * is running with.
 */

import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (!arg.startsWith("--")) continue;
  const [key, inline] = arg.slice(2).split("=");
  const next = process.argv[i + 1];
  if (inline !== undefined) args.set(key, inline);
  else if (next && !next.startsWith("--")) args.set(key, process.argv[++i]);
  else args.set(key, true);
}

const URL_BASE = args.get("url") ?? "http://localhost:8787";
const EVENT = args.get("event") ?? "ping";
const BAD = Boolean(args.get("bad"));

function readSecret() {
  if (process.env.GITHUB_WEBHOOK_SECRET) return process.env.GITHUB_WEBHOOK_SECRET;
  const text = readFileSync("worker/.dev.vars", "utf8");
  const line = text
    .split("\n")
    .find((l) => l.trim().startsWith("GITHUB_WEBHOOK_SECRET="));
  if (!line) throw new Error("GITHUB_WEBHOOK_SECRET not found in worker/.dev.vars");
  return line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
}

const PAYLOADS = {
  ping: {
    zen: "Non-blocking is better than blocking.",
    hook_id: 1,
    repository: { name: "GT5-Unofficial", private: false },
  },
  pull_request: {
    action: "closed",
    number: 4821,
    pull_request: {
      number: 4821,
      title: "Fix crash on world load",
      state: "closed",
      merged: true,
      merged_at: new Date().toISOString(),
      user: { login: "someone" },
      additions: 12,
      deletions: 3,
    },
    repository: { name: "GT5-Unofficial", private: false },
  },
  issues: {
    action: "closed",
    issue: {
      number: 991,
      title: "Recipe conflict in the assembler",
      state: "closed",
      state_reason: "completed",
      user: { login: "someone" },
    },
    sender: { login: "a-maintainer" },
    repository: { name: "GT5-Unofficial", private: false },
  },
};

const payload = PAYLOADS[EVENT];
if (!payload) {
  console.error(`No fixture for "${EVENT}". Have: ${Object.keys(PAYLOADS).join(", ")}`);
  process.exit(1);
}

const body = JSON.stringify(payload);
const secret = BAD ? "definitely-not-the-secret" : readSecret();
const signature = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

const res = await fetch(`${URL_BASE}/webhook`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-github-event": EVENT,
    "x-github-delivery": randomUUID(),
    "x-hub-signature-256": signature,
    "user-agent": "GitHub-Hookshot/test",
  },
  body,
});

const text = await res.text();
console.log(`${EVENT}${BAD ? " (deliberately bad signature)" : ""} -> ${res.status}`);
console.log(text);

const expected = BAD ? 401 : 200;
if (res.status !== expected) {
  console.error(`\nexpected ${expected}`);
  process.exit(1);
}
