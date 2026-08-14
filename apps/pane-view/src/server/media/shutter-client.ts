import { createSignedGetUrl } from "@latch-works/media-storage";
import {
  createShutterClient,
  type PreviewJobResult,
  type ShutterClient,
  ShutterClientError,
} from "@shutter/client";
import { env } from "../../env/server";
import type { MediaThumbnailContext } from "./repository";
import { shutterCapabilityKeyConfig } from "./shutter-capability";
import { validateCapabilityKeyConfig } from "./shutter-capability-config";
import { createPaneViewStorageClient } from "./storage-client";

const SHUTTER_WIDTHS = [320, 640, 750, 828, 960, 1080, 1280, 1668, 1920, 2048, 2560, 3200, 3840];
const SOURCE_LOCATOR_LIFETIME_SECONDS = 24 * 60 * 60 + 5 * 60;
const CAPABILITY_LIFETIME_SECONDS = 24 * 60 * 60;
export type ShutterPreviewResult =
  | { status: "pending"; retryAfterMs: number }
  | { status: "ready"; url: string }
  | { action?: string; code?: string; status: "failed" };

export function normalizeShutterWidth(width: number): number {
  if (width <= 24) return 24;
  return SHUTTER_WIDTHS.find((candidate) => candidate >= width) ?? 3840;
}

export function getShutterCapabilityKeyStatus() {
  return validateCapabilityKeyConfig({
    capabilityKeys: env.SHUTTER_CAPABILITY_KEYS,
    capabilityKid: env.SHUTTER_CAPABILITY_KID,
    spaceId: env.SHUTTER_SPACE_ID,
  });
}

async function sourceLocator(context: MediaThumbnailContext): Promise<string> {
  return createSignedGetUrl({
    expiresInSeconds: SOURCE_LOCATOR_LIFETIME_SECONDS,
    key: context.originalObjectKey,
    storage: createPaneViewStorageClient(),
  });
}

/**
 * Built per call rather than memoized: the environment is mutable in tests and
 * the Capability Key registry must stay evaluated lazily (see
 * `ensureStartupCapabilityStatus`).
 */
function shutterClient(options: { capability: boolean }): ShutterClient {
  return createShutterClient({
    spaceId: env.SHUTTER_SPACE_ID,
    controlBaseUrl: env.SHUTTER_CONTROL_URL,
    edgeBaseUrl: env.SHUTTER_EDGE_URL,
    spaceApiToken: env.SHUTTER_SPACE_API_TOKEN || undefined,
    capabilityKey: options.capability ? shutterCapabilityKeyConfig() : undefined,
    capabilityLifetimeSeconds: CAPABILITY_LIFETIME_SECONDS,
  });
}

function assertSourceId(sha256: string): void {
  if (!/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new Error("Shutter source ID must be a SHA-256 hex digest");
  }
}

export async function resolveShutterImageUrl(
  context: MediaThumbnailContext,
  width: number,
): Promise<string> {
  ensureStartupCapabilityStatus();
  assertSourceId(context.sha256);
  return shutterClient({ capability: true }).privateSourceUrl(
    { sourceId: context.sha256, locator: await sourceLocator(context) },
    { width: normalizeShutterWidth(width), quality: 75 },
  );
}

export async function resolveShutterPreview(
  context: MediaThumbnailContext,
  width: number,
): Promise<ShutterPreviewResult> {
  ensureStartupCapabilityStatus();
  if (context.mediaType !== "video" && context.mediaType !== "pdf") return { status: "failed" };
  if (!env.SHUTTER_SPACE_API_TOKEN) throw new Error("Shutter Space API is not configured");
  assertSourceId(context.sha256);
  const kind = context.mediaType;
  const client = shutterClient({ capability: true });

  let job: PreviewJobResult;
  try {
    job = await client.submitPreviewJob({
      sourceId: context.sha256,
      kind,
      locator: await sourceLocator(context),
    });
  } catch (error) {
    if (error instanceof ShutterClientError && error.status !== undefined) {
      return error.status === 408 || error.status === 429 || error.status >= 500
        ? { status: "pending", retryAfterMs: (error.retryAfterSeconds ?? 5) * 1_000 }
        : { status: "failed" };
    }
    if (error instanceof ShutterClientError) throw error;
    // Network-level failures are retryable, matching Control 5xx handling.
    return { status: "pending", retryAfterMs: 5_000 };
  }

  if (job.status === "pending" || job.status === "processing") {
    return { status: "pending", retryAfterMs: job.retryAfterSeconds * 1_000 };
  }
  if (job.status === "failed") {
    return { action: job.failure.action, code: job.failure.code, status: "failed" };
  }
  return {
    status: "ready",
    url: await client.privateMasterUrl(
      { sourceId: context.sha256, kind },
      { width: normalizeShutterWidth(width), quality: 75 },
    ),
  };
}

export async function purgeShutterSource(sourceId: string): Promise<void> {
  await shutterClient({ capability: false }).purgeSource(sourceId);
}

let startupCapabilityStatusChecked = false;

/**
 * Reports misconfigured capability keys once, on first use rather than at
 * import. Evaluating this at module load is what previously forced test hooks
 * into this file, so the check is deliberately lazy.
 *
 * The tradeoff is that a bad key is no longer surfaced at boot — it surfaces on
 * the first media request instead. `/api/health` calls
 * `getShutterCapabilityKeyStatus()` directly, so deploy-time checks should read
 * health rather than rely on startup logs.
 */
function ensureStartupCapabilityStatus(): void {
  if (startupCapabilityStatusChecked) return;
  startupCapabilityStatusChecked = true;
  const status = getShutterCapabilityKeyStatus();
  if (!status.ok) {
    console.error(`[pane-view] Shutter capability keys misconfigured: ${status.error}`);
  }
}
