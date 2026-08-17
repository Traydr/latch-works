import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.url(),
    BETTER_AUTH_SECRET: z.string(),
    BETTER_AUTH_URL: z.url(),
    S3_ENDPOINT: z.url(),
    S3_REGION: z.string(),
    S3_BUCKET: z.string(),
    S3_ACCESS_KEY_ID: z.string(),
    S3_SECRET_ACCESS_KEY: z.string(),
    PANE_VIEW_USERNAME: z.string(),
    PANE_VIEW_PASSWORD: z.string(),
    PANE_VIEW_SYNC_TOKEN: z.string(),
    PANE_VIEW_TRUST_PROXY_HEADERS: z.coerce.boolean().default(false),
    SHUTTER_EDGE_URL: z.url(),
    SHUTTER_CONTROL_URL: z.url(),
    SHUTTER_SPACE_ID: z.string().min(1),
    SHUTTER_SPACE_API_TOKEN: z.string().min(32),
    SHUTTER_CAPABILITY_KEYS: z.string().min(1),
    SHUTTER_CAPABILITY_KID: z.string().min(1),
  },
  clientPrefix: "VITE_",
  client: {},
  runtimeEnv: process.env,
  skipValidation: Boolean(process.env.SKIP_ENV_VALIDATION),
  emptyStringAsUndefined: true,
});
