import { createSignedGetUrl } from "@latch-works/media-storage";
import { createConcurrencyLimiter } from "./concurrency-limiter";
import { type MediaDeliveryRequest, planSignedOriginalDelivery } from "./delivery";
import {
  type MediaThumbnailContext,
  readMediaDeliveryRequest,
  readMediaThumbnailContext,
  readMediaThumbnailContextsByEntryIds,
} from "./repository";
import {
  resolveShutterImageUrl,
  resolveShutterPreview,
  type ShutterPreviewResult,
} from "./shutter-client";
import { createPaneViewStorageClient } from "./storage-client";

const THUMBNAIL_WIDTH = 320;
const PREVIEW_WIDTH = 960;
const shutterControlLimiter = createConcurrencyLimiter(6);

/** The archive reads, the signed original, and the Shutter reads a delivery makes. */
export interface MediaDeliveryDependencies {
  createSignedOriginalUrl(request: { expiresInSeconds: number; key: string }): Promise<string>;
  readDeliveryRequest(request: { mediaId: string }): Promise<MediaDeliveryRequest | null>;
  readThumbnailContext(request: { mediaId: string }): Promise<MediaThumbnailContext | null>;
  readThumbnailContexts(request: {
    mediaIds: string[];
  }): Promise<Map<string, MediaThumbnailContext>>;
  resolveImageUrl(context: MediaThumbnailContext, width: number): Promise<string>;
  resolvePreview(context: MediaThumbnailContext, width: number): Promise<ShutterPreviewResult>;
}

const defaultMediaDeliveryDependencies: MediaDeliveryDependencies = {
  createSignedOriginalUrl: (request) =>
    createSignedGetUrl({ ...request, storage: createPaneViewStorageClient() }),
  readDeliveryRequest: readMediaDeliveryRequest,
  readThumbnailContext: readMediaThumbnailContext,
  readThumbnailContexts: readMediaThumbnailContextsByEntryIds,
  resolveImageUrl: resolveShutterImageUrl,
  resolvePreview: resolveShutterPreview,
};

export type MediaDeliveryResolveResult =
  | { pending: true; retryAfterMs: number }
  | { pending: false; url: string };

function renditionWidth(variant: "thumbnail" | "preview", size?: number): number {
  return size ?? (variant === "preview" ? PREVIEW_WIDTH : THUMBNAIL_WIDTH);
}

async function resolveRendition(
  context: MediaThumbnailContext,
  variant: "thumbnail" | "preview",
  size: number | undefined,
  dependencies: MediaDeliveryDependencies,
): Promise<MediaDeliveryResolveResult> {
  const width = renditionWidth(variant, size);
  if (context.mediaType === "image" || context.mediaType === "gif") {
    return { pending: false, url: await dependencies.resolveImageUrl(context, width) };
  }

  if (context.mediaType !== "video" && context.mediaType !== "pdf") {
    throw new Error("Rendition unavailable for unsupported media type");
  }

  const preview = await shutterControlLimiter.run(() =>
    dependencies.resolvePreview(context, width),
  );
  if (preview.status === "pending") {
    return { pending: true, retryAfterMs: preview.retryAfterMs };
  }
  if (preview.status === "failed") {
    throw new Error(
      preview.code ? `Shutter rendition failed (${preview.code})` : "Shutter rendition unavailable",
    );
  }
  return { pending: false, url: preview.url };
}

async function resolveOriginalDeliveryUrl(
  mediaId: string,
  dependencies: MediaDeliveryDependencies,
): Promise<string> {
  const media = await dependencies.readDeliveryRequest({ mediaId });
  if (!media) throw new Error("Media not found");
  const delivery = planSignedOriginalDelivery(media);
  return dependencies.createSignedOriginalUrl({
    expiresInSeconds: delivery.expiresInSeconds,
    key: delivery.objectKey,
  });
}

export async function resolveMediaDeliveryUrlForVariant(
  {
    mediaId,
    size,
    variant,
  }: {
    mediaId: string;
    size?: number;
    variant: "thumbnail" | "preview" | "original";
  },
  dependencies: MediaDeliveryDependencies = defaultMediaDeliveryDependencies,
): Promise<MediaDeliveryResolveResult> {
  if (variant === "original") {
    return { pending: false, url: await resolveOriginalDeliveryUrl(mediaId, dependencies) };
  }
  const context = await dependencies.readThumbnailContext({ mediaId });
  if (!context) throw new Error("Media not found");
  return resolveRendition(context, variant, size, dependencies);
}

export interface MediaDeliveryBatchResolveItem {
  mediaId: string;
  size?: number;
  variant: "thumbnail" | "preview" | "original";
}

export type MediaDeliveryBatchResolveResult =
  | { mediaId: string; retryAfterMs: number; size?: number; status: "pending"; variant: string }
  | { mediaId: string; size?: number; status: "ready"; url: string; variant: string }
  | { mediaId: string; size?: number; status: "failed"; variant: string };

function batchResolveKey(item: MediaDeliveryBatchResolveItem): string {
  return `${item.variant}:${item.mediaId}:${item.size ?? "default"}`;
}

export async function resolveMediaDeliveryUrlsForVariants(
  items: MediaDeliveryBatchResolveItem[],
  dependencies: MediaDeliveryDependencies = defaultMediaDeliveryDependencies,
): Promise<MediaDeliveryBatchResolveResult[]> {
  const seen = new Set<string>();
  const uniqueItems = items.filter((item) => {
    const key = batchResolveKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const renditionIds: string[] = [];
  for (const item of uniqueItems) {
    if (item.variant !== "original") {
      renditionIds.push(item.mediaId);
    }
  }
  const contexts = await dependencies.readThumbnailContexts({ mediaIds: renditionIds });

  return Promise.all(
    uniqueItems.map(async (item): Promise<MediaDeliveryBatchResolveResult> => {
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
          result = await resolveRendition(context, item.variant, item.size, dependencies);
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
