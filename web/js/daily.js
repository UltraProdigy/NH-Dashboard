import { state } from "./state.js";
import { API } from "./live.js";
import { esc, safeUrl } from "./format.js";
import { render } from "./render.js";

function ago(iso) {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(minutes)) return "at an unknown time";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function runLine(run) {
  const how = run.event === "schedule" ? "scheduled" : run.actor ? `run by ${run.actor}` : run.event;
  const result = run.status === "completed"
    ? (run.conclusion === "success" ? "succeeded" : run.conclusion ?? "finished")
    : String(run.status).replace(/_/g, " ");
  return `<a href="${safeUrl(run.url)}" target="_blank" rel="noopener">#${esc(run.number)}</a>`
    + ` · ${esc(how)} · ${esc(result)} · started ${ago(run.startedAt)}`;
}

function dialogHtml(s) {
  const notes = [];
  if (!s.ready)
    notes.push(`<p class="daily-warn">Org-Manager isn't set up on this Worker yet, so this can't run.</p>`);
  if (s.running)
    notes.push(`<p class="daily-warn">Build ${runLine(s.running)}. Releasing now starts a second build alongside it.</p>`);
  if (s.error)
    notes.push(`<p class="daily-warn">Couldn't check GitHub for a build already running: ${esc(s.error)}</p>`);

  const log = s.log?.length
    ? `<div class="daily-log"><div class="minlabel">Released from here</div><ul>${s.log.map(e =>
        `<li>${esc(e.by)} · ${ago(e.at)}${e.dryRun ? " · dry run" : ""}</li>`).join("")}</ul></div>`
    : "";

  return `
    <h3>Release a new daily?</h3>
    <p>This runs <b>Daily modpack build</b> on DreamAssemblerXXL (master), which builds and publishes
      a new daily for everyone. GitHub will show it as run by Org-Manager, and your name is kept here.</p>
    ${notes.join("")}
    ${s.latest && !s.running ? `<p class="daily-last">Last build ${runLine(s.latest)}</p>` : ""}
    ${log}
    <div class="daily-actions">
      <a class="daily-link" href="${safeUrl(s.workflowUrl)}" target="_blank" rel="noopener">Open on GitHub</a>
      <button type="button" class="ghost" data-daily="cancel" autofocus>Cancel</button>
      <button type="button" class="daily-go" data-daily="go"${s.ready ? "" : " disabled"}>${
        s.running ? "Release another anyway" : "Release daily"}</button>
    </div>`;
}

function ask(s) {
  const dialog = document.createElement("dialog");
  dialog.className = "daily-dialog";
  dialog.innerHTML = dialogHtml(s);
  dialog.addEventListener("click", e => {
    const pick = e.target.closest("[data-daily]")?.dataset.daily;
    if (pick) dialog.close(pick);
  });
  dialog.addEventListener("close", () => {
    const go = dialog.returnValue === "go";
    dialog.remove();
    if (go) release(Boolean(s.running));
  });
  document.body.appendChild(dialog);
  dialog.showModal();
}

function finish(note, link = null) {
  state.daily = { busy: null, note, link };
  render();
}

export async function openDaily() {
  if (state.daily.busy) return;
  state.daily = { busy: "checking", note: "", link: null };
  render();
  try {
    const res = await fetch(`${API}/api/daily`, { cache: "no-store" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return finish(`Couldn't check the daily: ${body.error ?? res.status}`);
    finish("");
    ask(body);
  } catch {
    finish("Couldn't check the daily: the dashboard couldn't be reached");
  }
}

async function release(force) {
  state.daily = { busy: "releasing", note: "", link: null };
  render();
  try {
    const res = await fetch(`${API}/api/daily${force ? "?force=1" : ""}`, { method: "POST", cache: "no-store" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return finish(`Release failed: ${body.error ?? res.status}`);
    if (body.entry?.dryRun) return finish("Dry run: nothing was sent to GitHub from localhost");
    finish("Daily build started. It shows on GitHub within a few seconds", body.workflowUrl);
  } catch {
    finish("Release failed: the dashboard couldn't be reached");
  }
}
