import { snapThumbnailSize } from "@latch-works/media-delivery";
import { createSignedGetUrl } from "@latch-works/media-storage";
import { planSignedOriginalDelivery } from "./delivery";
import { buildDerivativeDeliveryUrl } from "./derivative-delivery-url";
import {
  ensurePreviewDerivative,
  ensureThumbnailDerivative,
  regenerateThumbnailDerivative,
} from "./derivative-service";
import { logDerivativeEvent } from "./derivative-telemetry";
import { readMediaDeliveryRequest, readMediaThumbnailContext } from "./repository";
import { createPaneViewStorageClient } from "./storage-client";

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

export async function resolveDerivativeDeliveryUrl({
  mediaId,
  size,
  variant,
}: {
  mediaId: string;
  size?: number;
  variant: "thumbnail" | "preview";
}): Promise<string> {
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

  logDerivativeEvent("derivative.resolve", {
    durationMs: Date.now() - startedAt,
    mediaType: media.mediaType,
    status: derivative.status,
    variant,
  });

  if (derivative.status === "pending") {
    throw new Error("Derivative pending");
  }

  if (derivative.status === "failed" || derivative.status === "unsupported") {
    if (media.mediaType === "image" || media.mediaType === "gif") {
      return resolveOriginalDeliveryUrl(mediaId);
    }

    throw new Error("Derivative unavailable");
  }

  return buildDerivativeDeliveryUrl(derivative.objectKey);
}

export async function resolveMediaDeliveryUrlForVariant({
  mediaId,
  size,
  variant,
}: {
  mediaId: string;
  size?: number;
  variant: "thumbnail" | "preview" | "original";
}): Promise<string> {
  if (variant === "original") {
    return resolveOriginalDeliveryUrl(mediaId);
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
  const result = await regenerateThumbnailDerivative({
    mediaId,
    requestedSize: snapThumbnailSize(size ?? 320),
  });

  return { status: result.status };
}
