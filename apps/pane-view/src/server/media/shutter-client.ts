import { createSignedGetUrl } from "@latch-works/media-storage";
import {
  createShutterClient,
  type PreviewJobResult,
  type ShutterClient,
  ShutterClientError,
} from "@shutter/client";
import { env } from "../../env/server";
import type { MediaThumbnailContext } from "./repository";
import { type CapabilityEnvironment, shutterCapabilityKeyConfig } from "./shutter-capability";
import { validateCapabilityKeyConfig } from "./shutter-capability-config";
import { createPaneViewStorageClient } from "./storage-client";

const SHUTTER_WIDTHS = [320, 640, 750, 828, 960, 1080, 1280, 1668, 1920, 2048, 2560, 3200, 3840];
const SHUTTER_QUALITY = 75;
const SOURCE_LOCATOR_LIFETIME_SECONDS = 24 * 60 * 60 + 5 * 60;
const CAPABILITY_LIFETIME_SECONDS = 24 * 60 * 60;
/** Originals live under this prefix; the resolver's key template names the rest. */
const ORIGINALS_KEY_PREFIX = "originals/sha256/";
/** Two shard labels and `{sha256}.{extension}` (see originalObjectKey in media-storage). */
const ORIGINALS_KEY_SEGMENTS = 3;

export type ShutterPreviewResult =
  | { status: "pending"; retryAfterMs: number }
  | { status: "ready"; url: string }
  | { action?: string; code?: string; status: "failed" };

/** The Shutter configuration this client reads; the process environment by default. */
export type ShutterEnvironment = CapabilityEnvironment &
  Pick<
    typeof env,
    "SHUTTER_CONTROL_URL" | "SHUTTER_EDGE_URL" | "SHUTTER_RESOLVER_ID" | "SHUTTER_SPACE_API_TOKEN"
  >;

/** What the purge queue keeps for a source: its v1 Source ID and, when known, its object key. */
export interface ShutterPurgeSource {
  objectKey: string | null;
  sha256: string;
}

/**
 * What the Shutter client needs from outside its own module: the Shutter
 * configuration and a signed URL for the original object, which Shutter
 * fetches the source from on the v1 path. The default instance reads the
 * real environment and the real bucket.
 */
export interface ShutterClientDependencies {
  createSourceLocator(request: { expiresInSeconds: number; key: string }): Promise<string>;
  environment: ShutterEnvironment;
  /** Fetch override for the Control calls; the global fetch by default. */
  fetch?: typeof globalThis.fetch | undefined;
}

export const shutterClientDependencies: ShutterClientDependencies = {
  createSourceLocator: (request) =>
    createSignedGetUrl({ ...request, storage: createPaneViewStorageClient() }),
  environment: env,
};

export function normalizeShutterWidth(width: number): number {
  if (width <= 24) return 24;
  return SHUTTER_WIDTHS.find((candidate) => candidate >= width) ?? 3840;
}

export function getShutterCapabilityKeyStatus(environment: ShutterEnvironment = env) {
  return validateCapabilityKeyConfig({
    capabilityKeys: environment.SHUTTER_CAPABILITY_KEYS,
    capabilityKid: environment.SHUTTER_CAPABILITY_KID,
    spaceId: environment.SHUTTER_SPACE_ID,
  });
}

/**
 * v2 is opt-in per deployment: with a resolver ID, Shutter reads the
 * originals bucket itself through the resolver configured on the Space and
 * every URL names the object by its key. Without one, the v1 path presigns a
 * locator here and seals it into a Source Capability.
 */
export function isShutterResolverConfigured(environment: ShutterEnvironment = env): boolean {
  return environment.SHUTTER_RESOLVER_ID !== "";
}

/**
 * The reference a v2 Delivery URL carries: the object key's segments after
 * the originals prefix, or nothing for a key outside that layout. The
 * resolver's key template in Shutter's admin is
 * `originals/sha256/{shard_a}/{shard_b}/{object}`, so the two stay in step
 * only as long as originalObjectKey keeps that layout.
 */
function shutterSourceReference(objectKey: string): readonly string[] | undefined {
  if (!objectKey.startsWith(ORIGINALS_KEY_PREFIX)) return undefined;
  const segments = objectKey.slice(ORIGINALS_KEY_PREFIX.length).split("/");
  if (segments.length !== ORIGINALS_KEY_SEGMENTS || segments.some((part) => part === "")) {
    return undefined;
  }
  return segments;
}

interface ResolverSource {
  resolverId: string;
  reference: readonly string[];
}

/**
 * The resolver source for an object, when v2 is on and the key follows the
 * originals layout. Anything else takes the v1 path, so one legacy row can
 * neither break its own tile nor a maintenance batch.
 */
function resolverSource(
  environment: ShutterEnvironment,
  objectKey: string,
): ResolverSource | undefined {
  if (!isShutterResolverConfigured(environment)) return undefined;
  const reference = shutterSourceReference(objectKey);
  return reference === undefined
    ? undefined
    : { resolverId: environment.SHUTTER_RESOLVER_ID, reference };
}

async function sourceLocator(
  context: MediaThumbnailContext,
  dependencies: ShutterClientDependencies,
): Promise<string> {
  return dependencies.createSourceLocator({
    expiresInSeconds: SOURCE_LOCATOR_LIFETIME_SECONDS,
    key: context.originalObjectKey,
  });
}

/**
 * Built per call rather than memoized: the environment is mutable in tests and
 * the Capability Key registry must stay evaluated lazily (see
 * `ensureStartupCapabilityStatus`).
 */
function shutterClient(options: {
  capability: boolean;
  dependencies: ShutterClientDependencies;
}): ShutterClient {
  const { environment } = options.dependencies;
  return createShutterClient({
    spaceId: environment.SHUTTER_SPACE_ID,
    controlBaseUrl: environment.SHUTTER_CONTROL_URL,
    edgeBaseUrl: environment.SHUTTER_EDGE_URL,
    spaceApiToken: environment.SHUTTER_SPACE_API_TOKEN || undefined,
    capabilityKey: options.capability ? shutterCapabilityKeyConfig(environment) : undefined,
    capabilityLifetimeSeconds: CAPABILITY_LIFETIME_SECONDS,
    fetch: options.dependencies.fetch,
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
  dependencies: ShutterClientDependencies = shutterClientDependencies,
): Promise<string> {
  const { environment } = dependencies;
  ensureStartupCapabilityStatus(environment);
  const parameters = { width: normalizeShutterWidth(width), quality: SHUTTER_QUALITY };
  const source = resolverSource(environment, context.originalObjectKey);
  if (source !== undefined) {
    return shutterClient({ capability: true, dependencies }).v2PrivateDeliveryUrl(
      source,
      parameters,
    );
  }
  assertSourceId(context.sha256);
  const client = shutterClient({ capability: true, dependencies });
  return client.privateSourceUrl(
    { sourceId: context.sha256, locator: await sourceLocator(context, dependencies) },
    parameters,
  );
}

/** Maps a Preview Job submission outcome onto the redirect's retry, ready, and failed states. */
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
  return { status: "ready", url: await readyUrl() };
}

export async function resolveShutterPreview(
  context: MediaThumbnailContext,
  width: number,
  dependencies: ShutterClientDependencies = shutterClientDependencies,
): Promise<ShutterPreviewResult> {
  const { environment } = dependencies;
  ensureStartupCapabilityStatus(environment);
  if (context.mediaType !== "video" && context.mediaType !== "pdf") return { status: "failed" };
  if (!environment.SHUTTER_SPACE_API_TOKEN) {
    throw new Error("Shutter Space API is not configured");
  }
  const kind = context.mediaType;
  const parameters = { width: normalizeShutterWidth(width), quality: SHUTTER_QUALITY };
  const source = resolverSource(environment, context.originalObjectKey);

  if (source !== undefined) {
    const client = shutterClient({ capability: true, dependencies });
    return previewResult(
      () => client.submitV2PreviewJob({ ...source, kind }),
      () => client.v2PrivateDeliveryUrl(source, { ...parameters, preview: kind }),
    );
  }

  assertSourceId(context.sha256);
  const client = shutterClient({ capability: true, dependencies });
  return previewResult(
    async () =>
      client.submitPreviewJob({
        sourceId: context.sha256,
        kind,
        locator: await sourceLocator(context, dependencies),
      }),
    () => client.privateMasterUrl({ sourceId: context.sha256, kind }, parameters),
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
  dependencies: ShutterClientDependencies = shutterClientDependencies,
): Promise<void> {
  const client = shutterClient({ capability: false, dependencies });
  const resolver =
    source.objectKey === null
      ? undefined
      : resolverSource(dependencies.environment, source.objectKey);
  if (resolver !== undefined) await client.purgeV2Source(resolver);
  await client.purgeSource(source.sha256);
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
function ensureStartupCapabilityStatus(environment: ShutterEnvironment): void {
  if (startupCapabilityStatusChecked) return;
  startupCapabilityStatusChecked = true;
  const status = getShutterCapabilityKeyStatus(environment);
  if (!status.ok) {
    console.error(`[pane-view] Shutter capability keys misconfigured: ${status.error}`);
  }
}
