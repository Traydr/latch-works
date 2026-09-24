import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { env } from "../../env/server";
import { db } from "../db";
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

export interface ConfiguredOwner {
  email: string;
  name: string;
  password: string;
  username: string;
}

export function readConfiguredOwner(): ConfiguredOwner {
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
}): ConfiguredOwner | null {
  if (!verifySingleUserCredentials({ password, username })) {
    return null;
  }

  return readConfiguredOwner();
}

export async function ensureConfiguredOwnerCredentialAccount(
  owner: ReturnType<typeof readConfiguredOwner>,
): Promise<boolean> {
  const context = await auth.$context;

  const existingOwner = await context.internalAdapter.findUserByEmail(owner.email, {
    includeAccounts: true,
  });

  // Hashed only when the stored credential has to change: it is a deliberate scrypt.
  const hashPassword = () => context.password.hash(owner.password);

  if (!existingOwner) {
    const createdOwner = await context.internalAdapter.createUser(
      {
        email: owner.email,
        emailVerified: true,
        name: owner.name,
      },
      { method: "email-password" },
    );

    await context.internalAdapter.linkAccount({
      accountId: createdOwner.id,
      password: await hashPassword(),
      providerId: "credential",
      userId: createdOwner.id,
    });

    return true;
  }

  const credentialAccount = existingOwner.accounts.find(
    (account) => account.providerId === "credential",
  );

  if (!credentialAccount) {
    await context.internalAdapter.linkAccount({
      accountId: existingOwner.user.id,
      password: await hashPassword(),
      providerId: "credential",
      userId: existingOwner.user.id,
    });

    return true;
  }

  const passwordUnchanged = credentialAccount.password
    ? await context.password.verify({ hash: credentialAccount.password, password: owner.password })
    : false;

  if (passwordUnchanged) {
    return true;
  }

  // PANE_VIEW_PASSWORD was rotated: sign out every session opened with the old one.
  await context.internalAdapter.deleteUserSessions(existingOwner.user.id);
  await context.internalAdapter.updatePassword(existingOwner.user.id, await hashPassword());

  return true;
}

let ownerReconciliation: Promise<boolean> | null = null;

/**
 * Brings the stored owner account in line with the configured credentials once
 * per process. Session checks await it too, so a rotated PANE_VIEW_PASSWORD
 * signs out old sessions on the first request after the restart that applied
 * it, not at the next sign-in. Concurrent callers share one run, so two
 * sign-ins cannot both revoke sessions and delete each other's new one.
 */
export function reconcileConfiguredOwner(): Promise<boolean> {
  if (!ownerReconciliation) {
    const reconciliation = ensureConfiguredOwnerCredentialAccount(readConfiguredOwner());
    ownerReconciliation = reconciliation;

    // A failed run (the database was down) is retried by the next caller.
    reconciliation.catch(() => {
      if (ownerReconciliation === reconciliation) ownerReconciliation = null;
    });
  }

  return ownerReconciliation;
}

function createAuthDatabase() {
  return drizzleAdapter(db, {
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

/** Lowercased because Better Auth stores and looks up emails lowercased. */
function toOwnerEmail(username: string): string {
  const email = username.includes("@") ? username : `${username}@pane-view.local`;

  return email.toLowerCase();
}
