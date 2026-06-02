import { and, eq, isNull } from "drizzle-orm";
import { createPaneViewDb, readDatabaseUrl } from "../db/client";
import { sessions, users } from "../db/schema";
import { hashSessionToken, sessionExpiresAt } from "./session";

export interface StoredSession {
  expiresAt: Date;
  token: string;
}

export async function createStoredSession({
  env,
  token,
  username,
}: {
  env: NodeJS.ProcessEnv;
  token: string;
  username: string;
}): Promise<StoredSession> {
  const expiresAt = sessionExpiresAt();
  const databaseUrl = readDatabaseUrl(env);

  if (!databaseUrl) {
    return { expiresAt, token };
  }

  const db = createPaneViewDb(databaseUrl);
  const [user] = await db
    .insert(users)
    .values({
      email: username,
      role: "owner",
    })
    .onConflictDoUpdate({
      set: {
        email: username,
      },
      target: users.email,
    })
    .returning({ id: users.id });

  if (!user) {
    throw new Error("Unable to create owner user.");
  }

  await db.insert(sessions).values({
    expiresAt,
    tokenHash: hashSessionToken(token),
    userId: user.id,
  });

  return { expiresAt, token };
}

export async function revokeStoredSession({
  env,
  token,
}: {
  env: NodeJS.ProcessEnv;
  token: string | null;
}): Promise<void> {
  const databaseUrl = readDatabaseUrl(env);
  if (!databaseUrl || !token) {
    return;
  }

  const db = createPaneViewDb(databaseUrl);
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(eq(sessions.tokenHash, hashSessionToken(token)));
}

export async function isStoredSessionValid({
  env,
  token,
}: {
  env: NodeJS.ProcessEnv;
  token: string | null;
}): Promise<boolean> {
  if (!token) {
    return false;
  }

  const databaseUrl = readDatabaseUrl(env);
  if (!databaseUrl) {
    return true;
  }

  const db = createPaneViewDb(databaseUrl);
  const [session] = await db
    .select({
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .where(and(eq(sessions.tokenHash, hashSessionToken(token)), isNull(sessions.revokedAt)))
    .limit(1);

  if (!session) {
    return false;
  }

  return session.expiresAt.getTime() > Date.now();
}

export async function readStoredSessionUserId({
  env,
  token,
}: {
  env: NodeJS.ProcessEnv;
  token: string | null;
}): Promise<string | null> {
  if (!token) {
    return null;
  }

  const databaseUrl = readDatabaseUrl(env);
  if (!databaseUrl) {
    return null;
  }

  const db = createPaneViewDb(databaseUrl);
  const [session] = await db
    .select({
      expiresAt: sessions.expiresAt,
      userId: sessions.userId,
    })
    .from(sessions)
    .where(and(eq(sessions.tokenHash, hashSessionToken(token)), isNull(sessions.revokedAt)))
    .limit(1);

  if (!session || session.expiresAt.getTime() <= Date.now()) {
    return null;
  }

  return session.userId;
}
