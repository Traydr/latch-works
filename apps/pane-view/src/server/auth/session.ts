import { scryptSync, timingSafeEqual } from "node:crypto";

export interface SingleUserCredentials {
  password: string;
  username: string;
}

export function readSingleUserCredentials(env: NodeJS.ProcessEnv): SingleUserCredentials | null {
  const username = env.PANE_VIEW_USERNAME;
  const password = env.PANE_VIEW_PASSWORD;

  if (!username || !password) {
    return null;
  }

  return { username, password };
}

export function verifySingleUserCredentials({
  env,
  password,
  username,
}: {
  env: NodeJS.ProcessEnv;
  password: string;
  username: string;
}): boolean {
  const configured = readSingleUserCredentials(env);
  if (!configured) {
    return false;
  }

  return safeCompare(username, configured.username) && safeCompare(password, configured.password);
}

function safeCompare(candidate: string, expected: string): boolean {
  const candidateHash = scryptSync(candidate, "pane-view-login", 32);
  const expectedHash = scryptSync(expected, "pane-view-login", 32);
  return timingSafeEqual(candidateHash, expectedHash);
}
