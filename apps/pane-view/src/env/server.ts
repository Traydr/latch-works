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
    // Optional: when SHUTTER_EDGE_URL is unset, variant delivery falls back to signed
    // original URLs (see server/media/variant-provider.ts).
    SHUTTER_EDGE_URL: z.url().or(z.literal("")).default(""),
    SHUTTER_CONTROL_URL: z.url().or(z.literal("")).default(""),
    SHUTTER_SPACE_ID: z.string().default(""),
    // Optional: the Space's S3 resolver for the originals bucket. When set, images and
    // previews are served from v2 Delivery URLs and nothing is presigned per request.
    SHUTTER_RESOLVER_ID: z
      .string()
      .regex(
        /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/u,
        "SHUTTER_RESOLVER_ID must be a Shutter identifier",
      )
      .or(z.literal(""))
      .default(""),
    SHUTTER_SPACE_API_TOKEN: z.string().min(32).or(z.literal("")).default(""),
    SHUTTER_CAPABILITY_KEYS: z.string().default(""),
    SHUTTER_CAPABILITY_KID: z.string().default(""),
  },
  clientPrefix: "VITE_",
  client: {},
  runtimeEnv: process.env,
  skipValidation: Boolean(process.env.SKIP_ENV_VALIDATION),
  emptyStringAsUndefined: true,
});
