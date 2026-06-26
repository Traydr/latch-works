import { GALLERY_THUMBNAIL_SIZE, PREVIEW_DERIVATIVE_SIZE, snapThumbnailSize } from "@latch-works/media-delivery";
import { createSignedGetUrl } from "@latch-works/media-storage";
import { resolveImageDeliveryMode } from "../../env/image-delivery";
import { planSignedOriginalDelivery } from "./delivery";
import { buildDerivativeDeliveryUrl } from "./derivative-delivery-url";
import {
  ensurePreviewDerivative,
  ensureThumbnailDerivative,
  ensureThumbnailDerivativeForContext,
  regenerateThumbnailDerivative,
} from "./derivative-service";
import { logDerivativeEvent } from "./derivative-telemetry";
import { mintImageOriginalDeliveryToken } from "./image-delivery";
import {
  readMediaDeliveryRequest,
  readMediaThumbnailContext,
  readMediaThumbnailContextsByEntryIds,
} from "./repository";
import { createPaneViewStorageClient } from "./storage-client";

export type MediaDeliveryResolveResult =
  | { pending: true }
  | { pending: false; deliveryToken?: string; url?: string };

let readyResolveLogCount = 0;

function isImageMediaType(mediaType: string): boolean {
  return mediaType === "image" || mediaType === "gif";
}

async function resolveOriginalDeliveryUrl(mediaId: string): Promise<string> {
  const media = await readMediaDeliveryRequest({ mediaId });
  if (!media) {
    throw new Error("Media not found");
  }

  const delivery = planSignedOriginalDelivery(media);
  return createSignedGetUrl({
    expiresInSeconds: delivery.expiresInSeconds,
    key: delivery.objectKey,
    storage: createPaneViewStorageClient(),
  });
}

async function resolveImageThumbnailHybrid({
  context,
  mediaId,
  size,
}: {
  context: NonNullable<Awaited<ReturnType<typeof readMediaThumbnailContext>>>;
  mediaId: string;
  size?: number;
}): Promise<MediaDeliveryResolveResult> {
  const derivative = await ensureThumbnailDerivativeForContext({
    context,
    requestedSize: snapThumbnailSize(size ?? GALLERY_THUMBNAIL_SIZE),
  });

  if (derivative.status === "ready") {
    return {
      pending: false,
      url: await buildDerivativeDeliveryUrl(derivative.objectKey),
    };
  }

  if (resolveImageDeliveryMode() === "bunny") {
    return {
      deliveryToken: mintImageOriginalDeliveryToken(context),
      pending: false,
    };
  }

  if (derivative.status === "pending") {
    return { pending: true };
  }

  return { pending: false, url: await resolveOriginalDeliveryUrl(mediaId) };
}

async function resolveImageThumbnailDelivery({
  mediaId,
  size,
}: {
  mediaId: string;
  size?: number;
}): Promise<MediaDeliveryResolveResult> {
  const media = await readMediaThumbnailContext({ mediaId });
  if (!media) {
    throw new Error("Media not found");
  }

  return resolveImageThumbnailHybrid({ context: media, mediaId, size });
}

async function resolveQueuedDerivativeDeliveryUrl({
  mediaId,
  size,
  variant,
}: {
  mediaId: string;
  size?: number;
  variant: "thumbnail" | "preview";
}): Promise<MediaDeliveryResolveResult> {
  const media = await readMediaThumbnailContext({ mediaId });
  if (!media) {
    throw new Error("Media not found");
  }

  const startedAt = Date.now();
  const derivative =
    variant === "preview"
      ? await ensurePreviewDerivative({ mediaId })
      : await ensureThumbnailDerivative({
          mediaId,
          requestedSize: snapThumbnailSize(size ?? 320),
        });

  if (derivative.status !== "ready" || readyResolveLogCount % 100 === 0) {
    logDerivativeEvent("derivative.resolve", {
      durationMs: Date.now() - startedAt,
      mediaType: media.mediaType,
      sampled: derivative.status === "ready",
      status: derivative.status,
      variant,
    });
  }
  if (derivative.status === "ready") {
    readyResolveLogCount += 1;
  }

  if (derivative.status === "pending") {
    return { pending: true };
  }

  if (derivative.status === "failed" || derivative.status === "unsupported") {
    if (isImageMediaType(media.mediaType)) {
      return { pending: false, url: await resolveOriginalDeliveryUrl(mediaId) };
    }

    throw new Error("Derivative unavailable");
  }

  return {
    pending: false,
    url: await buildDerivativeDeliveryUrl(derivative.objectKey),
  };
}

export async function resolveDerivativeDeliveryUrl({
  mediaId,
  size,
  variant,
}: {
  mediaId: string;
  size?: number;
  variant: "thumbnail" | "preview";
}): Promise<MediaDeliveryResolveResult> {
  if (variant === "thumbnail") {
    const media = await readMediaThumbnailContext({ mediaId });
    if (!media) {
      throw new Error("Media not found");
    }

    if (isImageMediaType(media.mediaType)) {
      return resolveImageThumbnailDelivery({ mediaId, size });
    }
  }

  return resolveQueuedDerivativeDeliveryUrl({
    mediaId,
    size,
    variant,
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

  return resolveDerivativeDeliveryUrl({
    mediaId,
    size,
    variant,
  });
}

export async function regenerateMediaThumbnailDerivative({
  mediaId,
  size,
}: {
  mediaId: string;
  size?: number;
}): Promise<{ status: string }> {
  const media = await readMediaThumbnailContext({ mediaId });
  if (!media) {
    return { status: "failed" };
  }

  const result = await regenerateThumbnailDerivative({
    mediaId,
    requestedSize: snapThumbnailSize(size ?? GALLERY_THUMBNAIL_SIZE),
  });

  return { status: result.status };
}

export interface MediaDeliveryBatchResolveItem {
  mediaId: string;
  size?: number;
  variant: "thumbnail" | "preview" | "original";
}

export type MediaDeliveryBatchResolveResult =
  | { mediaId: string; retryAfterMs: number; size?: number; status: "pending"; variant: string }
  | {
      deliveryToken?: string;
      mediaId: string;
      size?: number;
      status: "ready";
      url?: string;
      variant: string;
    }
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
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });

  const thumbnailPreviewIds = uniqueItems
    .filter((item) => item.variant === "thumbnail" || item.variant === "preview")
    .map((item) => item.mediaId);
  const contexts = await readMediaThumbnailContextsByEntryIds({ mediaIds: thumbnailPreviewIds });

  const results = await Promise.all(
    uniqueItems.map(async (item): Promise<MediaDeliveryBatchResolveResult> => {
      try {
        if (item.variant === "original") {
          const result = await resolveMediaDeliveryUrlForVariant({
            mediaId: item.mediaId,
            size: item.size,
            variant: item.variant,
          });

          if (result.pending) {
            return {
              mediaId: item.mediaId,
              retryAfterMs: 15_000,
              size: item.size,
              status: "pending",
              variant: item.variant,
            };
          }

          return {
            deliveryToken: result.deliveryToken,
            mediaId: item.mediaId,
            size: item.size,
            status: "ready",
            url: result.url,
            variant: item.variant,
          };
        }

        const context = contexts.get(item.mediaId);
        if (!context) {
          return {
            mediaId: item.mediaId,
            size: item.size,
            status: "failed",
            variant: item.variant,
          };
        }

        if (item.variant === "thumbnail" && isImageMediaType(context.mediaType)) {
          const imageResult = await resolveImageThumbnailHybrid({
            context,
            mediaId: item.mediaId,
            size: item.size,
          });

          if (imageResult.pending) {
            return {
              mediaId: item.mediaId,
              retryAfterMs: 15_000,
              size: item.size,
              status: "pending",
              variant: item.variant,
            };
          }

          return {
            deliveryToken: imageResult.deliveryToken,
            mediaId: item.mediaId,
            size: item.size,
            status: "ready",
            url: imageResult.url,
            variant: item.variant,
          };
        }

        const startedAt = Date.now();
        const derivative =
          item.variant === "preview"
            ? await ensureThumbnailDerivativeForContext({
                context,
                requestedSize: PREVIEW_DERIVATIVE_SIZE,
              })
            : await ensureThumbnailDerivativeForContext({
                context,
                requestedSize: snapThumbnailSize(item.size ?? 320),
              });

        if (derivative.status !== "ready" || readyResolveLogCount % 100 === 0) {
          logDerivativeEvent("derivative.resolve", {
            durationMs: Date.now() - startedAt,
            mediaType: context.mediaType,
            sampled: derivative.status === "ready",
            status: derivative.status,
            variant: item.variant,
          });
        }
        if (derivative.status === "ready") {
          readyResolveLogCount += 1;
        }

        if (derivative.status === "pending") {
          return {
            mediaId: item.mediaId,
            retryAfterMs: 15_000,
            size: item.size,
            status: "pending",
            variant: item.variant,
          };
        }

        if (derivative.status === "failed" || derivative.status === "unsupported") {
          if (isImageMediaType(context.mediaType)) {
            return {
              mediaId: item.mediaId,
              size: item.size,
              status: "ready",
              url: await resolveOriginalDeliveryUrl(item.mediaId),
              variant: item.variant,
            };
          }

          return {
            mediaId: item.mediaId,
            size: item.size,
            status: "failed",
            variant: item.variant,
          };
        }

        return {
          mediaId: item.mediaId,
          size: item.size,
          status: "ready",
          url: await buildDerivativeDeliveryUrl(derivative.objectKey),
          variant: item.variant,
        };
      } catch {
        return {
          mediaId: item.mediaId,
          size: item.size,
          status: "failed",
          variant: item.variant,
        };
      }
    }),
  );

  return results;
}
