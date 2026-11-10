import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "../../env/server";

/**
 * Decides whether a presented sync token matches the configured one. The
 * shared instance reads `PANE_VIEW_SYNC_TOKEN`; the guards below take a
 * verifier so a suite can supply its own configured token.
 */
export interface SyncApiTokenVerifier {
  verify(token: string | null): boolean;
}

/** Compares fixed-size digests, so neither the length nor the content of the token leaks. */
function digest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export function createSyncApiTokenVerifier(
  getConfiguredToken: () => string | undefined,
): SyncApiTokenVerifier {
  return {
    verify(token) {
      const configured = getConfiguredToken();

      if (!configured || !token) return false;

      return timingSafeEqual(digest(token), digest(configured));
    },
  };
}

const sharedSyncApiTokenVerifier = createSyncApiTokenVerifier(() => env.PANE_VIEW_SYNC_TOKEN);

export function readBearerToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization");

  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.slice("Bearer ".length).trim();

  return token.length > 0 ? token : null;
}

export function requireSyncApiToken(
  request: Request,
  verifier: SyncApiTokenVerifier = sharedSyncApiTokenVerifier,
): Response | null {
  return verifier.verify(readBearerToken(request))
    ? null
    : new Response("Unauthorized", { status: 401 });
}

export function assertSyncApiTokenFromBody(
  token: string | undefined,
  verifier: SyncApiTokenVerifier = sharedSyncApiTokenVerifier,
): void {
  if (!verifier.verify(token ?? null)) {
    throw new Error("Invalid sync token.");
  }
}
