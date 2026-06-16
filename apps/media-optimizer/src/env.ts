import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    MEDIA_OPTIMIZER_TOKEN: z.string().min(16),
    MEDIA_OPTIMIZER_PORT: z.coerce.number().int().positive().optional(),
    PORT: z.coerce.number().int().positive().optional(),
    // Base URL of the Pane View instance that owns the derivative queue/DB.
    PANE_VIEW_INTERNAL_URL: z.url(),
    // How many jobs a single /process invocation will attempt before returning.
    OPTIMIZER_BATCH_LIMIT: z.coerce.number().int().positive().default(250),
    // How many jobs to lease per claim round (keeps dangling leases small on timeout).
    OPTIMIZER_CLAIM_CHUNK: z.coerce.number().int().positive().default(5),
    // Wall-clock budget for a single /process invocation.
    OPTIMIZER_MAX_RUNTIME_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(5 * 60_000),
    S3_ENDPOINT: z.url(),
    S3_REGION: z.string(),
    S3_BUCKET: z.string(),
    S3_ACCESS_KEY_ID: z.string(),
    S3_SECRET_ACCESS_KEY: z.string(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
  skipValidation: typeof process !== "undefined" && Boolean(process.env.SKIP_ENV_VALIDATION),
});

export function resolveMediaOptimizerPort(): number {
  return env.MEDIA_OPTIMIZER_PORT ?? env.PORT ?? 3200;
}
