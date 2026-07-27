import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "../../env/server";

function digestApiToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export function createSyncApiTokenVerifier({
  digest = digestApiToken,
  getConfiguredToken,
}: {
  digest?: (token: string) => Buffer;
  getConfiguredToken: () => string | undefined;
}) {
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

export function verifySyncApiToken({ token }: { token: string | null }): boolean {
  return sharedSyncApiTokenVerifier.verify({ token });
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
