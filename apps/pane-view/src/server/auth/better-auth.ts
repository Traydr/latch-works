import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { memoryAdapter } from "@better-auth/memory-adapter";
import { betterAuth } from "better-auth";
import { hashPassword } from "better-auth/crypto";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { and, eq } from "drizzle-orm";
import { createPaneViewDb, readDatabaseUrl } from "../db/client";
import * as schema from "../db/schema";
import { readSingleUserCredentials, verifySingleUserCredentials } from "./session";

const memoryDb: Record<string, unknown[]> = {
  account: [],
  sessions: [],
  users: [],
  verification: [],
};

export const auth = betterAuth({
  advanced: {
    cookiePrefix: "pane-view",
    database: {
      generateId: "uuid",
    },
  },
  appName: "Pane View",
  baseURL: readBetterAuthUrl(process.env),
  database: createAuthDatabase(process.env),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 1,
    requireEmailVerification: false,
  },
  plugins: [tanstackStartCookies()],
  secret: readBetterAuthSecret(process.env),
  session: {
    modelName: "sessions",
  },
  user: {
    modelName: "users",
  },
});

export function readConfiguredOwner(env: NodeJS.ProcessEnv): {
  email: string;
  name: string;
  password: string;
  username: string;
} | null {
  const credentials = readSingleUserCredentials(env);
  if (!credentials) {
    return null;
  }

  return {
    email: toOwnerEmail(credentials.username),
    name: credentials.username,
    password: credentials.password,
    username: credentials.username,
  };
}

export function verifyConfiguredOwnerCredentials({
  env,
  password,
  username,
}: {
  env: NodeJS.ProcessEnv;
  password: string;
  username: string;
}): ReturnType<typeof readConfiguredOwner> {
  if (!verifySingleUserCredentials({ env, password, username })) {
    return null;
  }

  return readConfiguredOwner(env);
}

export async function ensureConfiguredOwnerCredentialAccount(
  owner: NonNullable<ReturnType<typeof readConfiguredOwner>>,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const databaseUrl = readDatabaseUrl(env);
  if (!databaseUrl) {
    return false;
  }

  const db = createPaneViewDb(databaseUrl);
  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, owner.email))
    .limit(1);

  if (!user) {
    return false;
  }

  const [existingAccount] = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.userId, user.id),
        eq(schema.accounts.providerId, "credential"),
        eq(schema.accounts.accountId, user.id),
      ),
    )
    .limit(1);

  if (existingAccount) {
    return true;
  }

  await db.insert(schema.accounts).values({
    accountId: user.id,
    password: await hashPassword(owner.password),
    providerId: "credential",
    userId: user.id,
  });

  return true;
}

function createAuthDatabase(env: NodeJS.ProcessEnv) {
  const databaseUrl = readDatabaseUrl(env);
  if (!databaseUrl) {
    return memoryAdapter(memoryDb);
  }

  return drizzleAdapter(createPaneViewDb(databaseUrl), {
    provider: "pg",
    schema: {
      ...schema,
      account: schema.accounts,
      session: schema.sessions,
      user: schema.users,
      verification: schema.verifications,
    },
  });
}

function readBetterAuthSecret(env: NodeJS.ProcessEnv): string {
  const secret = env.BETTER_AUTH_SECRET ?? env.SESSION_SECRET;
  if (secret) {
    return secret;
  }

  if (env.NODE_ENV === "production") {
    throw new Error("BETTER_AUTH_SECRET or SESSION_SECRET must be configured in production.");
  }

  return "pane-view-development-better-auth-secret";
}

function readBetterAuthUrl(env: NodeJS.ProcessEnv): string {
  return env.BETTER_AUTH_URL ?? env.APP_ORIGIN ?? "http://localhost:3000";
}

function toOwnerEmail(username: string): string {
  return username.includes("@") ? username.toLowerCase() : `${username}@pane-view.local`;
}
