import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "../../env/server";
import { readBearerToken } from "./api-token";

let cachedConfiguredToken: string | null = null;
let cachedConfiguredTokenDigest: Buffer | null = null;

function digest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export function resetOptimizerTokenDigestCacheForTests(): void {
  cachedConfiguredToken = null;
  cachedConfiguredTokenDigest = null;
}

function getConfiguredTokenDigest(): Buffer | null {
  const configured = env.MEDIA_OPTIMIZER_TOKEN;
  if (!configured) {
    return null;
  }

  if (cachedConfiguredToken === configured && cachedConfiguredTokenDigest) {
    return cachedConfiguredTokenDigest;
  }

  cachedConfiguredToken = configured;
  cachedConfiguredTokenDigest = digest(configured);
  return cachedConfiguredTokenDigest;
}

export function verifyOptimizerToken(token: string | null): boolean {
  const configuredDigest = getConfiguredTokenDigest();
  if (!configuredDigest || !token) {
    return false;
  }

  return timingSafeEqual(digest(token), configuredDigest);
}

/** Returns a 401/503 response when the optimizer token is missing or invalid, else null. */
export function requireOptimizerToken(request: Request): Response | null {
  if (!env.MEDIA_OPTIMIZER_TOKEN) {
    return new Response("Optimizer token not configured", { status: 503 });
  }

  if (verifyOptimizerToken(readBearerToken(request))) {
    return null;
  }

  return new Response("Unauthorized", { status: 401 });
}
