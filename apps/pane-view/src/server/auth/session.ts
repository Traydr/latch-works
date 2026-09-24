import { createHash, timingSafeEqual } from "node:crypto";
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
  // Both comparisons always run, so a wrong username costs as much as a wrong password.
  const usernameMatches = safeCompare(username, configured.username);
  const passwordMatches = safeCompare(password, configured.password);

  return usernameMatches && passwordMatches;
}

/** Compares fixed-size digests, so neither the length nor the content of `expected` leaks. */
function safeCompare(candidate: string, expected: string): boolean {
  const candidateDigest = createHash("sha256").update(candidate).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();

  return timingSafeEqual(candidateDigest, expectedDigest);
}
