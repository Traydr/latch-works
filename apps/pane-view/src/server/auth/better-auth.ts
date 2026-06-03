import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { env } from "../../env/server";
import { createPaneViewDb } from "../db/client";
import * as schema from "../db/schema";
import { readSingleUserCredentials, verifySingleUserCredentials } from "./session";

export const auth = betterAuth({
  advanced: {
    cookiePrefix: "pane-view",
    database: {
      generateId: "uuid",
    },
  },
  appName: "Pane View",
  baseURL: env.BETTER_AUTH_URL,
  database: createAuthDatabase(),
  emailAndPassword: {
    disableSignUp: true,
    enabled: true,
    minPasswordLength: 1,
    requireEmailVerification: false,
  },
  plugins: [tanstackStartCookies()],
  secret: env.BETTER_AUTH_SECRET,
  session: {
    modelName: "sessions",
  },
  user: {
    modelName: "users",
  },
});

export function readConfiguredOwner(): {
  email: string;
  name: string;
  password: string;
  username: string;
} {
  const credentials = readSingleUserCredentials();

  return {
    email: toOwnerEmail(credentials.username),
    name: credentials.username,
    password: credentials.password,
    username: credentials.username,
  };
}

export function verifyConfiguredOwnerCredentials({
  password,
  username,
}: {
  password: string;
  username: string;
}): ReturnType<typeof readConfiguredOwner> | null {
  if (!verifySingleUserCredentials({ password, username })) {
    return null;
  }

  return readConfiguredOwner();
}

export async function ensureConfiguredOwnerCredentialAccount(
  owner: ReturnType<typeof readConfiguredOwner>,
): Promise<boolean> {
  const context = await auth.$context;
  const passwordHash = await context.password.hash(owner.password);
  const existingOwner = await context.internalAdapter.findUserByEmail(owner.email, {
    includeAccounts: true,
  });

  if (!existingOwner) {
    const createdOwner = await context.internalAdapter.createUser({
      email: owner.email,
      emailVerified: true,
      name: owner.name,
    });

    await context.internalAdapter.linkAccount({
      accountId: createdOwner.id,
      password: passwordHash,
      providerId: "credential",
      userId: createdOwner.id,
    });

    return true;
  }

  const hasCredentialAccount = existingOwner.accounts.some(
    (account) => account.providerId === "credential",
  );

  if (!hasCredentialAccount) {
    await context.internalAdapter.linkAccount({
      accountId: existingOwner.user.id,
      password: passwordHash,
      providerId: "credential",
      userId: existingOwner.user.id,
    });

    return true;
  }

  await context.internalAdapter.updatePassword(existingOwner.user.id, passwordHash);

  return true;
}

function createAuthDatabase() {
  return drizzleAdapter(createPaneViewDb(env.DATABASE_URL), {
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

function toOwnerEmail(username: string): string {
  return username.includes("@") ? username.toLowerCase() : `${username}@pane-view.local`;
}
