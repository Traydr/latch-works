import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

Object.assign(process.env, loadEnv("test", process.cwd(), ""));

/**
 * Placeholders that let `@/env/server` validate inside a test worker. Server
 * modules take their database, storage, and configuration through explicit
 * seams, so a suite passes its own pglite handle or fake and nothing here is
 * ever dialled; these values only keep the module graph importable. A real
 * `.env.test` still wins, because Vite loads it into `process.env` above and
 * these are only applied where the variable is unset.
 */
const testEnvDefaults = {
  BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-32-chars",
  BETTER_AUTH_URL: "http://127.0.0.1:3000",
  DATABASE_URL: "postgres://test:test@127.0.0.1:5432/pane_view_test",
  PANE_VIEW_PASSWORD: "test-password",
  PANE_VIEW_SYNC_TOKEN: "test-sync-token",
  PANE_VIEW_USERNAME: "test-user",
  S3_ACCESS_KEY_ID: "test-access-key",
  S3_BUCKET: "test-bucket",
  S3_ENDPOINT: "http://127.0.0.1:9000",
  S3_REGION: "us-east-1",
  S3_SECRET_ACCESS_KEY: "test-secret-key",
  SHUTTER_CAPABILITY_KEYS: `{"pane-view":{"key-id":"${"0".repeat(64)}"}}`,
  SHUTTER_CAPABILITY_KID: "key-id",
  SHUTTER_CONTROL_URL: "https://control.shutter.test",
  SHUTTER_EDGE_URL: "https://edge.shutter.test",
  SHUTTER_SPACE_API_TOKEN: "test-shutter-space-api-token-at-least-32",
  SHUTTER_SPACE_ID: "pane-view",
} satisfies Record<string, string>;

const testEnv: Record<string, string> = {};
for (const [key, value] of Object.entries(testEnvDefaults)) {
  if (process.env[key] === undefined) testEnv[key] = value;
}

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    env: testEnv,
    environment: "node",
  },
});
