import { originalObjectKeySegments, SHA256_PATTERN } from "@latch-works/sync-protocol";
import {
  createShutterClient,
  type PreviewJobResult,
  type ShutterClient,
  ShutterClientError,
} from "@shutter/client";
import { normalizeWidth } from "@shutter/protocol";
import { DELIVERY_URL_LIFETIME_SECONDS } from "@/features/delivery/delivery-contract";
import type { ShutterConfig } from "./shutter-config";
import { createSignedGetUrl } from "./storage-client";

const SHUTTER_QUALITY = 75;

/** A locator outlives the capability sealing it, so Shutter can still fetch near expiry. */
const SOURCE_LOCATOR_LIFETIME_SECONDS = DELIVERY_URL_LIFETIME_SECONDS + 5 * 60;

/** Shutter's retry hint when Control gives none (or the network failed). */
const DEFAULT_RETRY_AFTER_SECONDS = 5;

export type EnabledShutter = Extract<ShutterConfig, { mode: "on" }>;

/** An original as Shutter names it: by its object key (v2) or its SHA-256 (v1). */
export interface ShutterSource {
  objectKey: string;
  sha256: string;
}

/** What the purge queue keeps for a source: its v1 Source ID and, when known, its object key. */
export interface ShutterPurgeSource {
  objectKey: string | null;
  sha256: string;
}

export type ShutterPreviewResult =
  | { status: "pending"; retryAfterMs: number }
  | { status: "ready"; url: string }
  | { action?: string; code?: string; status: "failed" };

/**
 * A signed URL for the original, which Shutter fetches the source from on the
 * v1 path; the bucket by default. `fetch` overrides the Control calls.
 */
export interface ShutterClientDependencies {
  createSourceLocator(request: { expiresInSeconds: number; key: string }): Promise<string>;
  fetch?: typeof globalThis.fetch | undefined;
}

const defaultDependencies: ShutterClientDependencies = {
  createSourceLocator: (request) => createSignedGetUrl(request),
};

interface ResolverSource {
  resolverId: string;
  reference: readonly string[];
}

/**
 * The resolver source for an object, when v2 is on and the key follows the
 * originals layout. Anything else takes the v1 path, so one legacy row can
 * neither break its own tile nor a maintenance batch.
 */
function resolverSource(shutter: EnabledShutter, objectKey: string): ResolverSource | undefined {
  if (shutter.resolverId === null) return undefined;
  const reference = originalObjectKeySegments(objectKey);

  return reference === undefined ? undefined : { resolverId: shutter.resolverId, reference };
}

function sourceLocator(
  source: ShutterSource,
  dependencies: ShutterClientDependencies,
): Promise<string> {
  return dependencies.createSourceLocator({
    expiresInSeconds: SOURCE_LOCATOR_LIFETIME_SECONDS,
    key: source.objectKey,
  });
}

function shutterClient(
  shutter: EnabledShutter,
  dependencies: ShutterClientDependencies,
): ShutterClient {
  return createShutterClient({
    spaceId: shutter.spaceId,
    controlBaseUrl: shutter.controlUrl,
    edgeBaseUrl: shutter.edgeUrl,
    spaceApiToken: shutter.spaceApiToken,
    capabilityKey: shutter.capabilityKey,
    capabilityLifetimeSeconds: DELIVERY_URL_LIFETIME_SECONDS,
    fetch: dependencies.fetch,
  });
}

function assertSourceId(sha256: string): void {
  if (!SHA256_PATTERN.test(sha256)) {
    throw new Error("Shutter source ID must be a SHA-256 hex digest");
  }
}

export async function resolveShutterImageUrl(
  source: ShutterSource,
  width: number,
  shutter: EnabledShutter,
  dependencies: ShutterClientDependencies = defaultDependencies,
): Promise<string> {
  const client = shutterClient(shutter, dependencies);
  const parameters = { width: normalizeWidth(width), quality: SHUTTER_QUALITY };
  const resolver = resolverSource(shutter, source.objectKey);

  if (resolver !== undefined) return client.v2PrivateDeliveryUrl(resolver, parameters);

  assertSourceId(source.sha256);

  return client.privateSourceUrl(
    { sourceId: source.sha256, locator: await sourceLocator(source, dependencies) },
    parameters,
  );
}

/**
 * The original's own bytes through Shutter, so playback, the PDF viewer, and
 * downloads share the edge cache with the renditions. The token's purpose is
 * `source_delivery`, which the Edge accepts for no other operation.
 */
export async function resolveShutterOriginalUrl(
  source: ShutterSource,
  shutter: EnabledShutter,
  dependencies: ShutterClientDependencies = defaultDependencies,
): Promise<string> {
  const client = shutterClient(shutter, dependencies);
  const resolver = resolverSource(shutter, source.objectKey);

  if (resolver !== undefined) return client.v2PrivateDeliveryUrl(resolver);

  assertSourceId(source.sha256);

  return client.privateDeliveryUrl({
    sourceId: source.sha256,
    locator: await sourceLocator(source, dependencies),
  });
}

/** Maps a Preview Job submission outcome onto the retry, ready, and failed states. */
async function previewResult(
  submit: () => Promise<PreviewJobResult>,
  readyUrl: () => Promise<string>,
): Promise<ShutterPreviewResult> {
  let job: PreviewJobResult;

  try {
    job = await submit();
  } catch (error) {
    if (error instanceof ShutterClientError && error.status !== undefined) {
      return error.status === 408 || error.status === 429 || error.status >= 500
        ? {
            status: "pending",
            retryAfterMs: (error.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS) * 1_000,
          }
        : { status: "failed" };
    }

    if (error instanceof ShutterClientError) throw error;

    // Network-level failures are retryable, matching Control 5xx handling.
    return { status: "pending", retryAfterMs: DEFAULT_RETRY_AFTER_SECONDS * 1_000 };
  }

  if (job.status === "pending" || job.status === "processing") {
    return { status: "pending", retryAfterMs: job.retryAfterSeconds * 1_000 };
  }

  if (job.status === "failed") {
    return { action: job.failure.action, code: job.failure.code, status: "failed" };
  }

  return { status: "ready", url: await readyUrl() };
}

export async function resolveShutterPreview(
  source: ShutterSource,
  kind: "pdf" | "video",
  width: number,
  shutter: EnabledShutter,
  dependencies: ShutterClientDependencies = defaultDependencies,
): Promise<ShutterPreviewResult> {
  const client = shutterClient(shutter, dependencies);
  const parameters = { width: normalizeWidth(width), quality: SHUTTER_QUALITY };
  const resolver = resolverSource(shutter, source.objectKey);

  if (resolver !== undefined) {
    return previewResult(
      () => client.submitV2PreviewJob({ ...resolver, kind }),
      () => client.v2PrivateDeliveryUrl(resolver, { ...parameters, preview: kind }),
    );
  }

  assertSourceId(source.sha256);

  return previewResult(
    async () =>
      client.submitPreviewJob({
        sourceId: source.sha256,
        kind,
        locator: await sourceLocator(source, dependencies),
      }),
    () => client.privateMasterUrl({ sourceId: source.sha256, kind }, parameters),
  );
}

/**
 * Purges every Source ID the object may have been served under. What Shutter
 * cached is a matter of history, not of the current setting, so with v2 on
 * and the key known both the resolver source and the SHA-256 are purged; each
 * purge is idempotent. Otherwise the SHA-256 alone.
 */
export async function purgeShutterSource(
  source: ShutterPurgeSource,
  shutter: EnabledShutter,
  dependencies: ShutterClientDependencies = defaultDependencies,
): Promise<void> {
  const client = shutterClient(shutter, dependencies);

  const resolver =
    source.objectKey === null ? undefined : resolverSource(shutter, source.objectKey);

  if (resolver !== undefined) await client.purgeV2Source(resolver);
  await client.purgeSource(source.sha256);
}
