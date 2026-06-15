import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "../../env/server";

let cachedConfiguredToken: string | null = null;
let cachedConfiguredTokenDigest: Buffer | null = null;

function digestApiToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export function resetSyncApiTokenDigestCacheForTests(): void {
  cachedConfiguredToken = null;
  cachedConfiguredTokenDigest = null;
}

export function getSyncApiTokenDigestCacheForTests(): {
  configuredToken: string | null;
  configuredTokenDigest: Buffer | null;
} {
  return {
    configuredToken: cachedConfiguredToken,
    configuredTokenDigest: cachedConfiguredTokenDigest,
  };
}

function getConfiguredTokenDigest(): Buffer | null {
  const configured = env.PANE_VIEW_SYNC_TOKEN;
  if (!configured) {
    return null;
  }

  if (cachedConfiguredToken === configured && cachedConfiguredTokenDigest) {
    return cachedConfiguredTokenDigest;
  }

  cachedConfiguredToken = configured;
  cachedConfiguredTokenDigest = digestApiToken(configured);
  return cachedConfiguredTokenDigest;
}

export function readBearerToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

export function hashApiToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function verifySyncApiToken({ token }: { token: string | null }): boolean {
  const configuredDigest = getConfiguredTokenDigest();
  if (!configuredDigest || !token) {
    return false;
  }

  const tokenDigest = digestApiToken(token);
  return timingSafeEqual(tokenDigest, configuredDigest);
}

export function requireSyncApiToken(request: Request): Response | null {
  if (verifySyncApiToken({ token: readBearerToken(request) })) {
    return null;
  }

  return new Response("Unauthorized", { status: 401 });
}

export function assertSyncApiTokenFromBody(token: string | undefined): void {
  if (!verifySyncApiToken({ token: token ?? null })) {
    throw new Error("Invalid sync token.");
  }
}
