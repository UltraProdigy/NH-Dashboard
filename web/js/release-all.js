import { state } from "./state.js";
import { API } from "./live.js";
import { esc, safeUrl } from "./format.js";
import { render } from "./render.js";
import { panelRows } from "./dream.js";

const TAG = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,99}$/;
const validTag = t => TAG.test(t) && !t.includes("..") && !t.endsWith(".");

const POSITION = ["last number", "second-to-last number", "third-to-last number"];
const learnedText = rule =>
  `Learned from an earlier correction: bumps the ${POSITION[rule.fromEnd] ?? `number ${rule.fromEnd + 1} from the end`}`;

function finish(note) {
  state.releaseAll = { busy: null, note };
  render();
}

async function post(path, payload) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
}

function rowHtml(r, i) {
  const repoUrl = `https://github.com/GTNewHorizons/${encodeURIComponent(r.repo)}`;
  const usable = !r.problem && r.sha;
  const on = usable && Boolean(r.predicted);
  const notes = [r.problem, ...(r.notes ?? [])].filter(Boolean);
  return `
    <tr data-row="${i}" class="${on ? "" : "ra-off"}">
      <td><input type="checkbox" data-include aria-label="Release ${esc(r.repo)}"${on ? " checked" : ""}${usable ? "" : " disabled"}></td>
      <td><a href="${safeUrl(repoUrl)}" target="_blank" rel="noopener">${esc(r.repo)}</a>${
        r.lastTag ? `<div class="ra-last">last ${esc(r.lastTag)}</div>` : ""}${
        notes.length ? `<div class="ra-note">${notes.map(esc).join("<br>")}</div>` : ""}</td>
      <td class="repo">${r.lastTag ? esc(r.lastTag) : "—"}${r.lastWasPre ? ' <span class="label">pre</span>' : ""}</td>
      <td>
        <input type="text" class="ra-tag" data-tag value="${esc(r.predicted ?? "")}" spellcheck="false"
          autocomplete="off" aria-label="New tag for ${esc(r.repo)}"${usable ? "" : " disabled"}>${
        r.learned ? ` <span class="label ra-learned" title="${esc(learnedText(r.learned))}">learned</span>` : ""}
        <label class="ra-wrong" hidden><input type="checkbox" data-wrong> prediction was wrong</label>
      </td>
      <td class="repo">${r.sha ? `<a href="${safeUrl(`${repoUrl}/commit/${r.sha}`)}" target="_blank" rel="noopener">${esc(r.sha.slice(0, 7))}</a>` : "—"}</td>
    </tr>`;
}

function statsLine(s) {
  if (!s?.total) return "";
  return `<p class="daily-last">Predictions kept as-is on past releases: ${s.matched} of ${s.total}, ${s.wrong} marked wrong.</p>`;
}

function dialogHtml(p) {
  const notes = [];
  if (!p.ready) notes.push(`<p class="daily-warn">Org-Manager isn't set up on this Worker yet, so this can't run.</p>`);
  if (p.storeError) notes.push(`<p class="daily-warn">${esc(p.storeError)}</p>`);
  const log = p.log?.length
    ? `<div class="daily-log"><div class="minlabel">Released from here</div><ul>${p.log.map(e =>
        `<li>${esc(e.by)} · ${esc(new Date(e.at).toLocaleString())} · ${e.created} released${
          e.failed ? `, ${e.failed} failed` : ""}${e.dryRun ? " · dry run" : ""}</li>`).join("")}</ul></div>`
    : "";

  return `
    <h3>Release all?</h3>
    <p>Each ticked repo gets a new release, with GitHub's generated notes, tagged on its
      default branch at the commit shown. The releases are made by Org-Manager, and your
      name is kept here.</p>
    <p class="daily-last">If a predicted tag is wrong, type the right one and tick
      <b>prediction was wrong</b> so it's learned. Leave it unticked for an intentional bump.</p>
    ${notes.join("")}
    ${statsLine(p.stats)}
    <div class="ra-scroll">
      <table class="ra-table">
        <thead><tr><th></th><th>Repo</th><th>Last tag</th><th>New tag</th><th>Commit</th></tr></thead>
        <tbody>${p.repos.map(rowHtml).join("")}</tbody>
      </table>
    </div>
    ${log}
    <div class="daily-actions">
      <span class="ra-count minlabel" data-count></span>
      <button type="button" class="ghost" data-ra="cancel" autofocus>Cancel</button>
      <button type="button" class="daily-go" data-ra="go" disabled>Release</button>
    </div>`;
}

function readRows(dialog, p) {
  return [...dialog.querySelectorAll("tr[data-row]")].map(tr => {
    const r = p.repos[Number(tr.dataset.row)];
    const tag = tr.querySelector("[data-tag]").value.trim();
    return {
      tr,
      r,
      tag,
      include: tr.querySelector("[data-include]").checked,
      changed: Boolean(r.predicted) && Boolean(tag) && tag !== r.predicted,
      wrong: tr.querySelector("[data-wrong]").checked,
    };
  });
}

function refresh(dialog, p) {
  const rows = readRows(dialog, p);
  let bad = 0;
  for (const row of rows) {
    const invalid = row.include && !validTag(row.tag);
    if (invalid) bad++;
    row.tr.classList.toggle("ra-off", !row.include);
    row.tr.querySelector("[data-tag]").classList.toggle("ra-invalid", invalid);
    row.tr.querySelector(".ra-wrong").hidden = !row.changed;
  }
  const picked = rows.filter(r => r.include);
  const dupes = picked.length !== new Set(picked.map(r => r.r.repo)).size;
  const go = dialog.querySelector('[data-ra="go"]');
  go.disabled = !p.ready || !picked.length || bad > 0 || dupes;
  go.textContent = picked.length === 1 ? "Release 1 repo" : `Release ${picked.length} repos`;
  dialog.querySelector("[data-count]").textContent = bad
    ? `${bad} ticked ${bad === 1 ? "repo needs" : "repos need"} a valid tag`
    : `${picked.length} of ${rows.length} ticked`;
}

function ask(p) {
  const dialog = document.createElement("dialog");
  dialog.className = "daily-dialog release-dialog";
  dialog.innerHTML = dialogHtml(p);
  dialog.addEventListener("click", e => {
    const pick = e.target.closest("[data-ra]")?.dataset.ra;
    if (pick) dialog.close(pick);
  });
  dialog.addEventListener("input", () => refresh(dialog, p));
  dialog.addEventListener("change", () => refresh(dialog, p));
  dialog.addEventListener("keydown", e => {
    if (e.key === "Enter" && e.target.matches("[data-tag]")) e.preventDefault();
  });
  dialog.addEventListener("close", () => {
    const items = dialog.returnValue === "go"
      ? readRows(dialog, p).filter(r => r.include).map(r => ({
          repo: r.r.repo,
          tag: r.tag,
          sha: r.r.sha,
          previous: r.r.lastTag,
          predicted: r.r.predicted,
          wrong: r.changed && r.wrong,
        }))
      : null;
    dialog.remove();
    if (items?.length) release(items);
  });
  document.body.appendChild(dialog);
  refresh(dialog, p);
  dialog.showModal();
}

function showResults(results) {
  const failed = results.filter(r => !r.ok);
  const dialog = document.createElement("dialog");
  dialog.className = "daily-dialog";
  dialog.innerHTML = `
    <h3>${results.length - failed.length} released, ${failed.length} failed</h3>
    <ul class="ra-results">${failed.map(r =>
      `<li><b>${esc(r.repo)}</b> ${esc(r.tag)}: ${esc(r.error ?? "failed")}</li>`).join("")}</ul>
    <div class="daily-actions"><span class="ra-count"></span>
      <button type="button" class="ghost" autofocus>Close</button></div>`;
  dialog.addEventListener("click", e => { if (e.target.closest("button")) dialog.close(); });
  dialog.addEventListener("close", () => dialog.remove());
  document.body.appendChild(dialog);
  dialog.showModal();
}

export async function openReleaseAll() {
  if (state.releaseAll.busy) return;
  const repos = panelRows("needsRelease").map(r => r.repo);
  if (!repos.length) return finish("Nothing on Needs a release to release");
  state.releaseAll = { busy: "checking", note: "" };
  render();
  try {
    const { ok, status, body } = await post("/api/release-all/preview", { repos });
    if (!ok) return finish(`Couldn't prepare Release All: ${body.error ?? status}`);
    finish("");
    ask(body);
  } catch {
    finish("Couldn't prepare Release All: the dashboard couldn't be reached");
  }
}

async function release(items) {
  state.releaseAll = { busy: "releasing", note: "" };
  render();
  try {
    const { ok, status, body } = await post("/api/release-all", { items });
    if (!body.results) return finish(`Release All failed: ${body.error ?? status}`);
    const made = body.results.filter(r => r.ok).length;
    if (body.entry?.dryRun) return finish(`Dry run: ${made} releases checked, nothing was sent to GitHub from localhost`);
    finish(`Released ${made} ${made === 1 ? "repo" : "repos"}. Workflow builds follow over the next few minutes`);
    if (!ok || made < body.results.length) showResults(body.results);
  } catch {
    finish("Release All failed: the dashboard couldn't be reached");
  }
}
