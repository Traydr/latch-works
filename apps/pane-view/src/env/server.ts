import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    DATABASE_URL: z.url(),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    APP_ORIGIN: z.url().optional(),
    BETTER_AUTH_SECRET: z.string().optional(),
    BETTER_AUTH_URL: z.url().optional(),
    SESSION_SECRET: z.string().optional(),
    S3_ENDPOINT: z.url().optional(),
    S3_REGION: z.string().optional(),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    MEDIA_URL_MODE: z.enum(["signed-url"]).optional(),
    PANE_VIEW_USERNAME: z.string().optional(),
    PANE_VIEW_PASSWORD: z.string().optional(),
    PANE_VIEW_SYNC_TOKEN: z.string().optional(),
    RAILWAY_DEPLOYMENT_ID: z.string().optional(),
    RAILWAY_ENVIRONMENT_ID: z.string().optional(),
    RAILWAY_ENVIRONMENT_NAME: z.string().optional(),
    RAILWAY_SERVICE_ID: z.string().optional(),
    RAILWAY_SERVICE_NAME: z.string().optional(),
  },
  clientPrefix: "VITE_",
  client: {},
  runtimeEnv: process.env,
  skipValidation: typeof process !== "undefined" && Boolean(process.env.SKIP_ENV_VALIDATION),
  emptyStringAsUndefined: true,
});
