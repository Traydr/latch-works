import { scryptSync, timingSafeEqual } from "node:crypto";
import { env } from "../../env/server";

export interface SingleUserCredentials {
  password: string;
  username: string;
}

export function readSingleUserCredentials(): SingleUserCredentials {
  const username = env.PANE_VIEW_USERNAME;
  const password = env.PANE_VIEW_PASSWORD;

  return { username, password };
}

export function verifySingleUserCredentials({
  password,
  username,
}: {
  password: string;
  username: string;
}): boolean {
  const configured = readSingleUserCredentials();
  return safeCompare(username, configured.username) && safeCompare(password, configured.password);
}

function safeCompare(candidate: string, expected: string): boolean {
  const candidateHash = scryptSync(candidate, "pane-view-login", 32);
  const expectedHash = scryptSync(expected, "pane-view-login", 32);
  return timingSafeEqual(candidateHash, expectedHash);
}
