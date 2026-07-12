import { createSignedGetUrl } from "@latch-works/media-storage";
import { env } from "../../env/server";
import type { MediaThumbnailContext } from "./repository";
import {
  decodeCapabilityKeyMaterial,
  parseCapabilityKeyRegistry,
  readCapabilityKeyMaterial,
  validateCapabilityKeyConfig,
} from "./shutter-capability-config";
import { createPaneViewStorageClient } from "./storage-client";

const SHUTTER_WIDTHS = [320, 640, 750, 828, 960, 1080, 1280, 1668, 1920, 2048, 2560, 3200, 3840];
const CAPABILITY_LIFETIME_SECONDS = 23 * 60 * 60;
const SOURCE_LOCATOR_LIFETIME_SECONDS = 24 * 60 * 60;
type CapabilityPurpose = "image_source" | "master_preview" | "preview_job";
type PreviewKind = "video" | "pdf";
type CommonClaims = {
  space_id: string;
  source_id: string;
  purpose: CapabilityPurpose;
  iat: number;
  exp: number;
};
export type CapabilityClaims =
  | (CommonClaims & { purpose: "image_source"; locator: string })
  | (CommonClaims & { purpose: "master_preview"; kind: PreviewKind })
  | (CommonClaims & { purpose: "preview_job"; kind: PreviewKind; locator: string });
export type ShutterPreviewResult =
  | { status: "pending"; retryAfterMs: number }
  | { status: "ready"; url: string }
  | { status: "failed" };

function retryAfterMs(response: Response): number {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : 5_000;
}

export function normalizeShutterWidth(width: number): number {
  if (width <= 24) return 24;
  return SHUTTER_WIDTHS.find((candidate) => candidate >= width) ?? 3840;
}

function frameStrings(values: readonly string[]): Uint8Array<ArrayBuffer> {
  const encoded = values.map((value) => new TextEncoder().encode(value));
  const output = new Uint8Array(encoded.reduce((sum, value) => sum + value.byteLength + 4, 0));
  const view = new DataView(output.buffer);
  let offset = 0;
  for (const value of encoded) {
    view.setUint32(offset, value.byteLength, false);
    offset += 4;
    output.set(value, offset);
    offset += value.byteLength;
  }
  return output;
}

function capabilityKey(): { kid: string; key: Uint8Array<ArrayBuffer> } {
  const status = validateCapabilityKeyConfig({
    capabilityKeys: env.SHUTTER_CAPABILITY_KEYS,
    capabilityKid: env.SHUTTER_CAPABILITY_KID,
    spaceId: env.SHUTTER_SPACE_ID,
  });
  if (!status.ok) {
    throw new Error(status.error);
  }

  const registry = parseCapabilityKeyRegistry(env.SHUTTER_CAPABILITY_KEYS);
  const encoded = readCapabilityKeyMaterial(registry, status.spaceId, status.kid);
  if (!encoded) {
    throw new Error(`Shutter capability key ID "${status.kid}" is not active for space "${status.spaceId}"`);
  }

  return { kid: status.kid, key: decodeCapabilityKeyMaterial(encoded) };
}

export function getShutterCapabilityKeyStatus() {
  return validateCapabilityKeyConfig({
    capabilityKeys: env.SHUTTER_CAPABILITY_KEYS,
    capabilityKid: env.SHUTTER_CAPABILITY_KID,
    spaceId: env.SHUTTER_SPACE_ID,
  });
}

function canonicalClaims(claims: CapabilityClaims): string {
  const common = {
    space_id: claims.space_id,
    source_id: claims.source_id,
    purpose: claims.purpose,
    iat: claims.iat,
    exp: claims.exp,
  };
  if (claims.purpose === "image_source")
    return JSON.stringify({ ...common, locator: claims.locator });
  if (claims.purpose === "master_preview") return JSON.stringify({ ...common, kind: claims.kind });
  return JSON.stringify({ ...common, kind: claims.kind, locator: claims.locator });
}

async function issueCapability(
  claims: CapabilityClaims,
  ivOverride?: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const { kid, key } = capabilityKey();
  const iv = ivOverride ?? crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, [
    "encrypt",
  ]);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: frameStrings(["v1", claims.space_id, kid, claims.purpose]),
      tagLength: 128,
    },
    cryptoKey,
    new TextEncoder().encode(canonicalClaims(claims)),
  );
  return `v1.${kid}.${Buffer.from(iv).toString("base64url")}.${Buffer.from(ciphertext).toString("base64url")}`;
}

export const shutterClientTestHooks = {
  issueCapability,
};

function claimTimes(): { iat: number; exp: number } {
  const iat = Math.floor(Date.now() / 1000);
  return { iat, exp: iat + CAPABILITY_LIFETIME_SECONDS };
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
  assertSourceId(context.sha256);
  const capability = await issueCapability({
    space_id: env.SHUTTER_SPACE_ID,
    source_id: context.sha256,
    purpose: "image_source",
    locator: await sourceLocator(context),
    ...claimTimes(),
  });
  return edgeUrl(
    `/v1/private/${encodeURIComponent(env.SHUTTER_SPACE_ID)}/source/${encodeURIComponent(capability)}?w=${normalizeShutterWidth(width)}&q=75`,
  );
}

export async function resolveShutterPreview(
  context: MediaThumbnailContext,
  width: number,
): Promise<ShutterPreviewResult> {
  if (context.mediaType !== "video" && context.mediaType !== "pdf") return { status: "failed" };
  if (!env.SHUTTER_SPACE_API_TOKEN) throw new Error("Shutter Space API is not configured");
  assertSourceId(context.sha256);
  const kind = context.mediaType;
  const sourceCapability = await issueCapability({
    space_id: env.SHUTTER_SPACE_ID,
    source_id: context.sha256,
    purpose: "preview_job",
    kind,
    locator: await sourceLocator(context),
    ...claimTimes(),
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
  const result = (await response.json()) as { status?: unknown };
  if (result.status === "pending" || result.status === "processing") {
    return { status: "pending", retryAfterMs: retryAfterMs(response) };
  }
  if (result.status !== "ready") return { status: "failed" };
  const capability = await issueCapability({
    space_id: env.SHUTTER_SPACE_ID,
    source_id: context.sha256,
    purpose: "master_preview",
    kind,
    ...claimTimes(),
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

const startupCapabilityStatus = getShutterCapabilityKeyStatus();
if (!startupCapabilityStatus.ok) {
  console.error(`[pane-view] Shutter capability keys misconfigured: ${startupCapabilityStatus.error}`);
}
