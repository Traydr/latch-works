import { createHash, scryptSync, timingSafeEqual } from "node:crypto";
import { env } from "../../env/server";

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

export function verifySyncApiToken({
  token,
}: {
  token: string | null;
}): boolean {
  const configured = env.PANE_VIEW_SYNC_TOKEN;
  if (!configured || !token) {
    return false;
  }

  const tokenHash = scryptSync(token, "pane-view-sync-token", 32);
  const configuredHash = scryptSync(configured, "pane-view-sync-token", 32);
  return timingSafeEqual(tokenHash, configuredHash);
}

export function requireSyncApiToken(request: Request): Response | null {
  if (verifySyncApiToken({ token: readBearerToken(request) })) {
    return null;
  }

  return new Response("Unauthorized", { status: 401 });
}
