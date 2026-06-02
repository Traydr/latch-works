import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const sessionDurationMs = 1000 * 60 * 60 * 24 * 14;

export const sessionCookieName = "__Host-pane_view_session";

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

export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function sessionExpiresAt(now = new Date()): Date {
  return new Date(now.getTime() + sessionDurationMs);
}

export function buildSessionCookie(token: string, expiresAt = sessionExpiresAt()): string {
  return serializeCookie(sessionCookieName, token, {
    expires: expiresAt,
    httpOnly: true,
    path: "/",
    sameSite: "Lax",
    secure: process.env.NODE_ENV === "production",
  });
}

export function buildExpiredSessionCookie(): string {
  return serializeCookie(sessionCookieName, "", {
    expires: new Date(0),
    httpOnly: true,
    path: "/",
    sameSite: "Lax",
    secure: process.env.NODE_ENV === "production",
  });
}

export function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) {
    return null;
  }

  const cookies = cookieHeader.split(";").map((part) => part.trim());
  for (const cookie of cookies) {
    const separatorIndex = cookie.indexOf("=");
    if (separatorIndex < 0) {
      continue;
    }

    const cookieName = cookie.slice(0, separatorIndex);
    if (cookieName === name) {
      return decodeURIComponent(cookie.slice(separatorIndex + 1));
    }
  }

  return null;
}

function safeCompare(candidate: string, expected: string): boolean {
  const candidateHash = scryptSync(candidate, "pane-view-login", 32);
  const expectedHash = scryptSync(expected, "pane-view-login", 32);
  return timingSafeEqual(candidateHash, expectedHash);
}

function serializeCookie(
  name: string,
  value: string,
  options: {
    expires: Date;
    httpOnly: boolean;
    path: string;
    sameSite: "Lax" | "Strict";
    secure: boolean;
  },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Expires=${options.expires.toUTCString()}`,
    `Path=${options.path}`,
    `SameSite=${options.sameSite}`,
  ];

  if (options.httpOnly) {
    parts.push("HttpOnly");
  }

  if (options.secure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}
