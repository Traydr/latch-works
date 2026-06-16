import { snapThumbnailSize } from "@latch-works/media-delivery";
import { createSignedGetUrl } from "@latch-works/media-storage";
import { resolveImageDeliveryMode } from "../../env/image-delivery";
import { planSignedOriginalDelivery } from "./delivery";
import { buildDerivativeDeliveryUrl } from "./derivative-delivery-url";
import {
  ensurePreviewDerivative,
  ensureThumbnailDerivative,
  regenerateThumbnailDerivative,
} from "./derivative-service";
import { logDerivativeEvent } from "./derivative-telemetry";
import { mintImageOriginalDeliveryToken } from "./image-delivery";
import { readMediaDeliveryRequest, readMediaThumbnailContext } from "./repository";
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

  if (resolveImageDeliveryMode() === "bunny") {
    return {
      deliveryToken: mintImageOriginalDeliveryToken(media),
      pending: false,
    };
  }

  return resolveQueuedDerivativeDeliveryUrl({
    mediaId,
    size,
    variant: "thumbnail",
  });
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

  if (isImageMediaType(media.mediaType) && resolveImageDeliveryMode() === "bunny") {
    return { status: "unsupported" };
  }

  const result = await regenerateThumbnailDerivative({
    mediaId,
    requestedSize: snapThumbnailSize(size ?? 320),
  });

  return { status: result.status };
}
