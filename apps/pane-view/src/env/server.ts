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
    MEDIA_DELIVERY_SECRET: z.string().min(32),
    MEDIA_DELIVERY_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
    PANE_VIEW_USERNAME: z.string(),
    PANE_VIEW_PASSWORD: z.string(),
    PANE_VIEW_SYNC_TOKEN: z.string(),
    PANE_VIEW_TRUST_PROXY_HEADERS: z.coerce.boolean().default(false),
    // Derivative generation mode. When unset, falls back to "triggered" if a
    // MEDIA_OPTIMIZER_URL is configured, otherwise "inline" (see
    // resolveDerivativeProcessingMode).
    DERIVATIVE_PROCESSING_MODE: z.enum(["inline", "triggered"]).optional(),
    // Shared bearer secret protecting the internal optimizer claim/complete/fail
    // routes, and used by Pane View to authenticate optimizer wake requests.
    MEDIA_OPTIMIZER_TOKEN: z.string().min(16).optional(),
    // Base URL of the media-optimizer service used to wake it on demand.
    MEDIA_OPTIMIZER_URL: z.url().optional(),
    // Bunny CDN hostname for image delivery (e.g. img.example.com).
    BUNNY_CDN_HOST: z.string().min(1).optional(),
    // Image delivery: "bunny" (edge resize from Originals) or "inline" (local sharp).
    IMAGE_DELIVERY_MODE: z.enum(["bunny", "inline", "shutter"]).optional(),
    VIDEO_PREVIEW_PROVIDER: z.enum(["legacy", "shutter"]).default("legacy"),
    PDF_PREVIEW_PROVIDER: z.enum(["legacy", "shutter"]).default("legacy"),
    SHUTTER_EDGE_URL: z.url().default("https://shutter-edge.traydr.dev"),
    SHUTTER_CONTROL_URL: z.url().default("https://shutter-control.traydr.dev"),
    SHUTTER_SPACE_ID: z.string().min(1).default("pane-view"),
    SHUTTER_SPACE_API_TOKEN: z.string().min(32).optional(),
    SHUTTER_CAPABILITY_KEYS: z.string().optional(),
    SHUTTER_CAPABILITY_KID: z.string().min(1).optional(),
  },
  clientPrefix: "VITE_",
  client: {
    VITE_BUNNY_CDN_HOST: z.string().min(1).optional(),
    VITE_IMAGE_DELIVERY_MODE: z.enum(["bunny", "inline", "shutter"]).optional(),
  },
  runtimeEnv: process.env,
  skipValidation: typeof process !== "undefined" && Boolean(process.env.SKIP_ENV_VALIDATION),
  emptyStringAsUndefined: true,
});

export type DerivativeProcessingMode = "inline" | "triggered";

/**
 * Resolves the effective derivative processing mode. Explicit
 * `DERIVATIVE_PROCESSING_MODE` always wins; otherwise production defers to the
 * optimizer when `MEDIA_OPTIMIZER_URL` is configured, and local/dev stays inline.
 */
export function resolveDerivativeProcessingMode(): DerivativeProcessingMode {
  if (env.DERIVATIVE_PROCESSING_MODE) {
    return env.DERIVATIVE_PROCESSING_MODE;
  }

  return env.MEDIA_OPTIMIZER_URL ? "triggered" : "inline";
}
