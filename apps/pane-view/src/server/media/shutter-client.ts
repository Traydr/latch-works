import { createSignedGetUrl } from "@latch-works/media-storage";
import { env } from "../../env/server";
import type { MediaThumbnailContext } from "./repository";
import { issueShutterCapability, shutterCapabilityClaimTimes } from "./shutter-capability";
import { validateCapabilityKeyConfig } from "./shutter-capability-config";
import { createPaneViewStorageClient } from "./storage-client";

const SHUTTER_WIDTHS = [320, 640, 750, 828, 960, 1080, 1280, 1668, 1920, 2048, 2560, 3200, 3840];
const SOURCE_LOCATOR_LIFETIME_SECONDS = 24 * 60 * 60 + 5 * 60;
export type ShutterPreviewResult =
  | { status: "pending"; retryAfterMs: number }
  | { status: "ready"; url: string }
  | { action?: string; code?: string; status: "failed" };

function retryAfterMs(response: Response): number {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : 5_000;
}

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

function edgeUrl(path: string): string {
  return new URL(path, env.SHUTTER_EDGE_URL).toString();
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
  const capability = await issueShutterCapability({
    space_id: env.SHUTTER_SPACE_ID,
    source_id: context.sha256,
    purpose: "image_source",
    locator: await sourceLocator(context),
    ...shutterCapabilityClaimTimes(),
  });
  return edgeUrl(
    `/v1/private/${encodeURIComponent(env.SHUTTER_SPACE_ID)}/source/${encodeURIComponent(capability)}?w=${normalizeShutterWidth(width)}&q=75`,
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
  const sourceCapability = await issueShutterCapability({
    space_id: env.SHUTTER_SPACE_ID,
    source_id: context.sha256,
    purpose: "preview_job",
    kind,
    locator: await sourceLocator(context),
    ...shutterCapabilityClaimTimes(),
  });
  const jobPath = `/v1/spaces/${encodeURIComponent(env.SHUTTER_SPACE_ID)}/sources/${encodeURIComponent(context.sha256)}/previews/${kind}`;
  let response: Response;
  try {
    response = await fetch(new URL(jobPath, env.SHUTTER_CONTROL_URL), {
      method: "PUT",
      headers: {
        authorization: `Bearer ${env.SHUTTER_SPACE_API_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sourceCapability }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { status: "pending", retryAfterMs: 5_000 };
  }
  if (!response.ok) {
    return response.status === 408 || response.status === 429 || response.status >= 500
      ? { status: "pending", retryAfterMs: retryAfterMs(response) }
      : { status: "failed" };
  }
  const result = (await response.json()) as {
    failure?: { action?: unknown; code?: unknown };
    status?: unknown;
  };
  if (result.status === "pending" || result.status === "processing") {
    return { status: "pending", retryAfterMs: retryAfterMs(response) };
  }
  if (result.status !== "ready") {
    return {
      action: typeof result.failure?.action === "string" ? result.failure.action : undefined,
      code: typeof result.failure?.code === "string" ? result.failure.code : undefined,
      status: "failed",
    };
  }
  const capability = await issueShutterCapability({
    space_id: env.SHUTTER_SPACE_ID,
    source_id: context.sha256,
    purpose: "master_preview",
    kind,
    ...shutterCapabilityClaimTimes(),
  });
  return {
    status: "ready",
    url: edgeUrl(
      `/v1/private/${encodeURIComponent(env.SHUTTER_SPACE_ID)}/master/${encodeURIComponent(capability)}?w=${normalizeShutterWidth(width)}&q=75`,
    ),
  };
}

export async function purgeShutterSource(sourceId: string): Promise<void> {
  const path = `/v1/spaces/${encodeURIComponent(env.SHUTTER_SPACE_ID)}/sources/${encodeURIComponent(sourceId)}/purge`;
  const response = await fetch(new URL(path, env.SHUTTER_CONTROL_URL), {
    method: "POST",
    headers: { authorization: `Bearer ${env.SHUTTER_SPACE_API_TOKEN}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 204) {
    throw new Error(`Shutter source purge failed with ${response.status}`);
  }
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
