import { createConcurrencyLimiter } from "./concurrency-limiter";
import type { MediaDeliveryRequest } from "./delivery";
import {
  type MediaThumbnailContext,
  readMediaDeliveryRequest,
  readMediaThumbnailContext,
  readMediaThumbnailContextsByEntryIds,
} from "./repository";
import type { ShutterPreviewResult } from "./shutter-client";
import {
  resolveVariantImageUrl,
  resolveVariantOriginalUrl,
  resolveVariantPreview,
} from "./variant-provider";

/** The width a variant resolves at when the caller names none. */
const DEFAULT_VARIANT_WIDTH = { preview: 960, thumbnail: 320 } as const;

const shutterControlLimiter = createConcurrencyLimiter(6);

/** The archive reads and the three resolutions a delivery makes. */
export interface MediaDeliveryDependencies {
  readDeliveryRequest(request: { mediaId: string }): Promise<MediaDeliveryRequest | null>;
  readThumbnailContext(request: { mediaId: string }): Promise<MediaThumbnailContext | null>;
  readThumbnailContexts(request: {
    mediaIds: string[];
  }): Promise<Map<string, MediaThumbnailContext>>;
  resolveImageUrl(context: MediaThumbnailContext, width: number): Promise<string>;
  resolveOriginalUrl(request: MediaDeliveryRequest): Promise<string>;
  resolvePreview(context: MediaThumbnailContext, width: number): Promise<ShutterPreviewResult>;
}

const defaultMediaDeliveryDependencies: MediaDeliveryDependencies = {
  readDeliveryRequest: readMediaDeliveryRequest,
  readThumbnailContext: readMediaThumbnailContext,
  readThumbnailContexts: readMediaThumbnailContextsByEntryIds,
  resolveImageUrl: resolveVariantImageUrl,
  resolveOriginalUrl: resolveVariantOriginalUrl,
  resolvePreview: resolveVariantPreview,
};

type MediaDeliveryVariant = "thumbnail" | "preview" | "original";

export type MediaDeliveryResolveResult =
  | { pending: true; retryAfterMs: number }
  | { pending: false; url: string };

/** There is nothing to deliver: no such media, no variant for its type, or no Shutter preview. */
export class MediaDeliveryNotFoundError extends Error {
  readonly missing: "media" | "variant" | "preview";

  constructor(missing: "media" | "variant" | "preview", message: string) {
    super(message);
    this.name = "MediaDeliveryNotFoundError";
    this.missing = missing;
  }
}

/** Shutter or the bucket signer failed to produce a URL; the message is the resolver's own. */
export class MediaDeliveryUnavailableError extends Error {
  readonly resolver: "image" | "original" | "preview";

  constructor(resolver: "image" | "original" | "preview", cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "MediaDeliveryUnavailableError";
    this.resolver = resolver;
  }
}

async function resolveWith<Result>(
  resolver: MediaDeliveryUnavailableError["resolver"],
  resolve: () => Promise<Result>,
): Promise<Result> {
  try {
    return await resolve();
  } catch (error) {
    throw new MediaDeliveryUnavailableError(resolver, error);
  }
}

async function resolveVariant(
  context: MediaThumbnailContext,
  variant: "thumbnail" | "preview",
  size: number | undefined,
  dependencies: MediaDeliveryDependencies,
): Promise<MediaDeliveryResolveResult> {
  const width = size ?? DEFAULT_VARIANT_WIDTH[variant];

  if (context.mediaType === "image" || context.mediaType === "gif") {
    return {
      pending: false,
      url: await resolveWith("image", () => dependencies.resolveImageUrl(context, width)),
    };
  }

  if (context.mediaType !== "video" && context.mediaType !== "pdf") {
    throw new MediaDeliveryNotFoundError(
      "variant",
      "Variant unavailable for unsupported media type",
    );
  }

  const preview = await resolveWith("preview", () =>
    shutterControlLimiter.run(() => dependencies.resolvePreview(context, width)),
  );

  if (preview.status === "pending") {
    return { pending: true, retryAfterMs: preview.retryAfterMs };
  }

  if (preview.status === "failed") {
    throw new MediaDeliveryNotFoundError(
      "preview",
      preview.code ? `Shutter preview failed (${preview.code})` : "Shutter preview unavailable",
    );
  }

  return { pending: false, url: preview.url };
}

/**
 * The one delivery dispatch: the server functions and the redirect routes all
 * come through here. Throws MediaDeliveryNotFoundError when there is nothing
 * to deliver and MediaDeliveryUnavailableError when a resolver fails.
 */
export async function resolveMediaDeliveryUrlForVariant(
  {
    mediaId,
    size,
    variant,
  }: {
    mediaId: string;
    size?: number;
    variant: MediaDeliveryVariant;
  },
  dependencies: MediaDeliveryDependencies = defaultMediaDeliveryDependencies,
): Promise<MediaDeliveryResolveResult> {
  if (variant === "original") {
    const media = await dependencies.readDeliveryRequest({ mediaId });

    if (!media) throw new MediaDeliveryNotFoundError("media", "Media not found");

    return {
      pending: false,
      url: await resolveWith("original", () => dependencies.resolveOriginalUrl(media)),
    };
  }

  const context = await dependencies.readThumbnailContext({ mediaId });

  if (!context) throw new MediaDeliveryNotFoundError("media", "Media not found");

  return resolveVariant(context, variant, size, dependencies);
}

interface MediaDeliveryBatchResolveItem {
  mediaId: string;
  size?: number;
  variant: MediaDeliveryVariant;
}

export type MediaDeliveryBatchResult =
  | { mediaId: string; retryAfterMs: number; size?: number; status: "pending"; variant: string }
  | { mediaId: string; size?: number; status: "ready"; url: string; variant: string }
  | { mediaId: string; size?: number; status: "failed"; variant: string };

function batchResolveKey(item: MediaDeliveryBatchResolveItem): string {
  return `${item.variant}:${item.mediaId}:${item.size ?? "default"}`;
}

/** Resolve each distinct item once; repeats of an item are dropped from the results. */
export async function resolveMediaDeliveryUrlsForVariants(
  items: MediaDeliveryBatchResolveItem[],
  dependencies: MediaDeliveryDependencies = defaultMediaDeliveryDependencies,
): Promise<MediaDeliveryBatchResult[]> {
  const seen = new Set<string>();

  const uniqueItems = items.filter((item) => {
    const key = batchResolveKey(item);

    if (seen.has(key)) return false;
    seen.add(key);

    return true;
  });

  const variantIds: string[] = [];

  for (const item of uniqueItems) {
    if (item.variant !== "original") {
      variantIds.push(item.mediaId);
    }
  }

  const contexts = await dependencies.readThumbnailContexts({ mediaIds: variantIds });

  return Promise.all(
    uniqueItems.map(async (item): Promise<MediaDeliveryBatchResult> => {
      try {
        const context = item.variant === "original" ? undefined : contexts.get(item.mediaId);

        if (item.variant !== "original" && !context) {
          return {
            mediaId: item.mediaId,
            size: item.size,
            status: "failed",
            variant: item.variant,
          };
        }

        let result: MediaDeliveryResolveResult;

        if (item.variant === "original") {
          result = await resolveMediaDeliveryUrlForVariant(item, dependencies);
        } else {
          if (!context) throw new Error("Media not found");
          result = await resolveVariant(context, item.variant, item.size, dependencies);
        }

        return result.pending
          ? {
              mediaId: item.mediaId,
              retryAfterMs: result.retryAfterMs,
              size: item.size,
              status: "pending",
              variant: item.variant,
            }
          : {
              mediaId: item.mediaId,
              size: item.size,
              status: "ready",
              url: result.url,
              variant: item.variant,
            };
      } catch {
        return { mediaId: item.mediaId, size: item.size, status: "failed", variant: item.variant };
      }
    }),
  );
}
