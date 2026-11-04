import { API } from "./live.js";

const STALE_MS = 5 * 60_000;

let list = null;
let error = null;
let loading = null;
let readAt = 0;
let triedAt = 0;
const listeners = new Set();

export const repoList = () => list;
export const repoListError = () => error;
export const repoListLoading = () => Boolean(loading);
export const repoListStale = () => !list || Date.now() - readAt > STALE_MS;
export const repoListDue = () => !loading && Date.now() - triedAt > STALE_MS;

export function onRepoList(fn) {
  listeners.add(fn);
}

export function loadRepoList() {
  if (loading) return loading;
  triedAt = Date.now();
  loading = (async () => {
    await null;
    try {
      const res = await fetch(`${API}/api/releases/repos`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(res.status === 403 ? "Only the admin team can read the org's repos and custom properties." : `The repos couldn't be read: ${body.error ?? res.status}`);
      list = body;
      readAt = Date.now();
      error = null;
    } catch (err) {
      error = err instanceof TypeError ? "The dashboard couldn't be reached." : err.message;
    } finally {
      loading = null;
    }
    for (const fn of listeners) fn();
    return list;
  })();
  return loading;
}
