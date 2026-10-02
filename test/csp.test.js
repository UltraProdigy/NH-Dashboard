/**
 * The Content Security Policy is a meta tag, so nothing but this test notices
 * when it stops matching the page. A 404.html edit that misses the hash breaks
 * every deep link on Pages, and an inline handler or a moved API is blocked
 * silently in the browser.
 *
 *   node test/csp.test.js
 */

import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  ok ? (pass++, console.log("  ok    " + n))
     : (fail++, console.log("  FAIL  " + n + (d ? " — " + d : "")));
};

const web = new URL("../web/", import.meta.url);
const read = (p) => readFile(new URL(p, web), "utf8");
const policyOf = (html) =>
  html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)?.[1] ?? "";
const directive = (policy, name) =>
  policy.split(";").map((d) => d.trim().split(/\s+/)).find(([k]) => k === name)?.slice(1) ?? [];

const index = await read("index.html");
const policy = policyOf(index);
check("index.html has a policy", policy !== "");
check("scripts only from the site itself", directive(policy, "script-src").join(" ") === "'self'");
check("index.html has no inline script", !/<script(?![^>]*\bsrc=)[^>]*>/.test(index));
check("index.html has no inline handlers", !/\son[a-z]+=/i.test(index));

const api = (await read("js/live.js")).match(/const DEFAULT_API = "([^"]+)"/)?.[1];
check("connect-src allows the Worker", directive(policy, "connect-src").includes(api), api);

const notFound = await read("404.html");
const script = notFound.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
const hash = `'sha256-${createHash("sha256").update(script).digest("base64")}'`;
check("404.html's hash matches its script", directive(policyOf(notFound), "script-src").includes(hash),
  `expected ${hash}`);

const files = (await readdir(new URL("js/", web), { recursive: true })).filter((f) => f.endsWith(".js"));
const handlers = [];
for (const f of files) {
  const src = await read(path.join("js", f));
  for (const m of src.matchAll(/<[a-z][^>`]*\son[a-z]+=["'$]/gi)) handlers.push(`${f}: ${m[0].slice(0, 60)}`);
}
check("no inline handlers in rendered markup", !handlers.length, handlers.join("; "));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
