import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "../../env/server";

/**
 * Decides whether a presented sync token matches the configured one. The
 * shared instance reads `PANE_VIEW_SYNC_TOKEN`; the guards below take a
 * verifier so a suite can supply its own configured-token source instead of
 * the process environment.
 */
export interface SyncApiTokenVerifier {
  verify(request: { token: string | null }): boolean;
}

function digestApiToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export function createSyncApiTokenVerifier({
  digest = digestApiToken,
  getConfiguredToken,
}: {
  digest?: (token: string) => Buffer;
  getConfiguredToken: () => string | undefined;
}): SyncApiTokenVerifier {
  let cachedConfiguredToken: string | null = null;
  let cachedConfiguredTokenDigest: Buffer | null = null;

  return {
    verify({ token }: { token: string | null }): boolean {
      const configured = getConfiguredToken();
      if (!configured || !token) return false;

      if (cachedConfiguredToken !== configured || !cachedConfiguredTokenDigest) {
        cachedConfiguredToken = configured;
        cachedConfiguredTokenDigest = digest(configured);
      }

      return timingSafeEqual(digest(token), cachedConfiguredTokenDigest);
    },
  };
}

const sharedSyncApiTokenVerifier = createSyncApiTokenVerifier({
  getConfiguredToken: () => env.PANE_VIEW_SYNC_TOKEN,
});

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

export function verifySyncApiToken(
  { token }: { token: string | null },
  verifier: SyncApiTokenVerifier = sharedSyncApiTokenVerifier,
): boolean {
  return verifier.verify({ token });
}

export function requireSyncApiToken(
  request: Request,
  verifier: SyncApiTokenVerifier = sharedSyncApiTokenVerifier,
): Response | null {
  if (verifySyncApiToken({ token: readBearerToken(request) }, verifier)) {
    return null;
  }

  return new Response("Unauthorized", { status: 401 });
}

export function assertSyncApiTokenFromBody(
  token: string | undefined,
  verifier: SyncApiTokenVerifier = sharedSyncApiTokenVerifier,
): void {
  if (!verifySyncApiToken({ token: token ?? null }, verifier)) {
    throw new Error("Invalid sync token.");
  }
}
