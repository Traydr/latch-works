import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * The e2e suite runs against the local compose stack (docs/localhost) but on
 * its own database and bucket, so a run never touches the developer's synced
 * archive. Connection details come from the repo-root `.env` when present,
 * falling back to the compose defaults.
 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const E2E_ROOT = path.join(REPO_ROOT, "e2e");
export const FIXTURE_ARCHIVE_DIR = path.join(E2E_ROOT, ".fixtures", "archive");
export const AUTH_STATE_PATH = path.join(E2E_ROOT, ".auth", "pane-view.json");

const PANE_VIEW_PORT = 3100;
export const PANE_VIEW_URL = `http://127.0.0.1:${PANE_VIEW_PORT}`;
export const E2E_DATABASE_NAME = "latch_works_e2e";
export const E2E_BUCKET = "latch-works-e2e";

const DotEnvSchema = z.object({
  DATABASE_URL: z.url().default("postgres://user:password@localhost:5432/latch_works"),
  S3_ACCESS_KEY_ID: z.string().default("rustfsadmin"),
  S3_ENDPOINT: z.url().default("http://127.0.0.1:9000"),
  S3_REGION: z.string().default("auto"),
  S3_SECRET_ACCESS_KEY: z.string().default("rustfsadmin"),
});

export interface PaneViewCredentials {
  password: string;
  syncToken: string;
  username: string;
}

export const PANE_VIEW_CREDENTIALS: PaneViewCredentials = {
  password: "e2e-password-with-length",
  syncToken: "e2e-sync-token-0123456789abcdef",
  username: "e2e",
};

export interface E2eEnvironment {
  /** Connection to the maintenance database, used to create/drop the e2e one. */
  adminDatabaseUrl: string;
  /** The e2e database Pane View runs against. */
  databaseUrl: string;
  s3: {
    accessKeyId: string;
    endpoint: string;
    region: string;
    secretAccessKey: string;
  };
}

function parseDotEnv(contents: string) {
  const entries: [string, string][] = [];
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    entries.push([trimmed.slice(0, separator), trimmed.slice(separator + 1).replace(/^"|"$/g, "")]);
  }
  return Object.fromEntries(entries);
}

export async function loadE2eEnvironment(): Promise<E2eEnvironment> {
  const dotEnv = await readFile(path.join(REPO_ROOT, ".env"), "utf8")
    .then(parseDotEnv)
    // No repo-root .env: the compose defaults apply.
    .catch(() => parseDotEnv(""));
  const values = DotEnvSchema.parse({ ...dotEnv, ...process.env });
  const base = new URL(values.DATABASE_URL);
  const adminUrl = new URL(base);
  adminUrl.pathname = "/postgres";
  const e2eUrl = new URL(base);
  e2eUrl.pathname = `/${E2E_DATABASE_NAME}`;
  return {
    adminDatabaseUrl: adminUrl.toString(),
    databaseUrl: e2eUrl.toString(),
    s3: {
      accessKeyId: values.S3_ACCESS_KEY_ID,
      endpoint: values.S3_ENDPOINT,
      region: values.S3_REGION,
      secretAccessKey: values.S3_SECRET_ACCESS_KEY,
    },
  };
}

/** The process environment Pane View (build, migrate, serve) runs with. */
export function paneViewProcessEnv(environment: E2eEnvironment): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BETTER_AUTH_SECRET: "e2e-better-auth-secret-at-least-32-characters-long",
    BETTER_AUTH_URL: PANE_VIEW_URL,
    DATABASE_URL: environment.databaseUrl,
    NODE_ENV: "production",
    PANE_VIEW_PASSWORD: PANE_VIEW_CREDENTIALS.password,
    PANE_VIEW_SYNC_TOKEN: PANE_VIEW_CREDENTIALS.syncToken,
    PANE_VIEW_TRUST_PROXY_HEADERS: "false",
    PANE_VIEW_USERNAME: PANE_VIEW_CREDENTIALS.username,
    PORT: String(PANE_VIEW_PORT),
    S3_ACCESS_KEY_ID: environment.s3.accessKeyId,
    S3_BUCKET: E2E_BUCKET,
    S3_ENDPOINT: environment.s3.endpoint,
    S3_REGION: environment.s3.region,
    S3_SECRET_ACCESS_KEY: environment.s3.secretAccessKey,
    SHUTTER_CAPABILITY_KEYS: "",
    SHUTTER_CAPABILITY_KID: "",
    SHUTTER_CONTROL_URL: "",
    SHUTTER_EDGE_URL: "",
    SHUTTER_SPACE_API_TOKEN: "",
    SHUTTER_SPACE_ID: "",
  };
}
