import { mintInstallationToken, signJwt } from "./github.js";

let cachedToken = null;

export const orgManagerReady = (env) =>
  Boolean(env.ORG_MANAGER_APP_ID && env.ORG_MANAGER_PRIVATE_KEY);

export async function orgManagerToken(env, now = Date.now()) {
  if (cachedToken && cachedToken.expiresAt - now > 5 * 60_000) return cachedToken.token;
  const jwt = await signJwt(env.ORG_MANAGER_APP_ID, env.ORG_MANAGER_PRIVATE_KEY, now);
  cachedToken = await mintInstallationToken(jwt, env.GITHUB_ORG ?? "GTNewHorizons");
  return cachedToken.token;
}

export function forgetOrgManagerToken() {
  cachedToken = null;
}
