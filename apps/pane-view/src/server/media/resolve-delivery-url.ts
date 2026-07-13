import { createSignedGetUrl } from "@latch-works/media-storage";
import { createConcurrencyLimiter } from "./concurrency-limiter";
import { planSignedOriginalDelivery } from "./delivery";
import {
  type MediaThumbnailContext,
  readMediaDeliveryRequest,
  readMediaThumbnailContext,
  readMediaThumbnailContextsByEntryIds,
} from "./repository";
import { resolveShutterImageUrl, resolveShutterPreview } from "./shutter-client";
import { createPaneViewStorageClient } from "./storage-client";

const THUMBNAIL_WIDTH = 320;
const PREVIEW_WIDTH = 960;
const shutterControlLimiter = createConcurrencyLimiter(6);

export type MediaDeliveryResolveResult =
  | { pending: true; retryAfterMs: number }
  | { pending: false; url: string };

function renditionWidth(variant: "thumbnail" | "preview", size?: number): number {
  return size ?? (variant === "preview" ? PREVIEW_WIDTH : THUMBNAIL_WIDTH);
}

async function resolveRendition(
  context: MediaThumbnailContext,
  variant: "thumbnail" | "preview",
  size?: number,
): Promise<MediaDeliveryResolveResult> {
  const width = renditionWidth(variant, size);
  if (context.mediaType === "image" || context.mediaType === "gif") {
    return { pending: false, url: await resolveShutterImageUrl(context, width) };
  }

  if (context.mediaType !== "video" && context.mediaType !== "pdf") {
    throw new Error("Rendition unavailable for unsupported media type");
  }

  const preview = await shutterControlLimiter.run(() => resolveShutterPreview(context, width));
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

async function resolveOriginalDeliveryUrl(mediaId: string): Promise<string> {
  const media = await readMediaDeliveryRequest({ mediaId });
  if (!media) throw new Error("Media not found");
  const delivery = planSignedOriginalDelivery(media);
  return createSignedGetUrl({
    expiresInSeconds: delivery.expiresInSeconds,
    key: delivery.objectKey,
    storage: createPaneViewStorageClient(),
  });
}

export async function resolveMediaDeliveryUrlForVariant({
  mediaId,
  size,
  variant,
}: {
  mediaId: string;
  size?: number;
  variant: "thumbnail" | "preview" | "original";
}): Promise<MediaDeliveryResolveResult> {
  if (variant === "original") {
    return { pending: false, url: await resolveOriginalDeliveryUrl(mediaId) };
  }
  const context = await readMediaThumbnailContext({ mediaId });
  if (!context) throw new Error("Media not found");
  return resolveRendition(context, variant, size);
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
): Promise<MediaDeliveryBatchResolveResult[]> {
  const seen = new Set<string>();
  const uniqueItems = items.filter((item) => {
    const key = batchResolveKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const renditionIds = uniqueItems
    .filter((item) => item.variant !== "original")
    .map((item) => item.mediaId);
  const contexts = await readMediaThumbnailContextsByEntryIds({ mediaIds: renditionIds });

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
          result = await resolveMediaDeliveryUrlForVariant(item);
        } else {
          if (!context) throw new Error("Media not found");
          result = await resolveRendition(context, item.variant, item.size);
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
