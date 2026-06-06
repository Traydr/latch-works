import { createSignedGetUrl } from "@latch-works/media-storage";
import { snapThumbnailSize } from "@latch-works/media-delivery";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { isCurrentWebSessionValid } from "../../server/auth/web-session";
import { planSignedOriginalDelivery } from "../../server/media/delivery";
import { ensurePreviewDerivative, ensureThumbnailDerivative } from "../../server/media/derivative-service";
import { redirectToSignedStoredObject } from "../../server/media/delivery-redirect";
import { readMediaDeliveryRequest, readMediaThumbnailContext } from "../../server/media/repository";
import { createPaneViewStorageClient } from "../../server/media/storage-client";

const resolveMediaDeliveryRequestSchema = z.object({
  mediaId: z.string().uuid(),
  size: z.number().int().positive().optional(),
  variant: z.enum(["thumbnail", "preview", "original"]),
});

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

async function resolveDerivativeDeliveryUrl({
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

  const derivative =
    variant === "preview"
      ? await ensurePreviewDerivative({ mediaId })
      : await ensureThumbnailDerivative({
          mediaId,
          requestedSize: snapThumbnailSize(size ?? 320),
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

  const redirect = await redirectToSignedStoredObject({ objectKey: derivative.objectKey });
  const location = redirect.headers.get("Location");
  if (!location) {
    throw new Error("Delivery redirect missing");
  }

  return location;
}

export const resolveMediaDeliveryUrl = createServerFn({ method: "GET" })
  .inputValidator(resolveMediaDeliveryRequestSchema)
  .handler(async ({ data }): Promise<{ url: string }> => {
    if (!(await isCurrentWebSessionValid())) {
      throw new Error("Unauthorized");
    }

    if (data.variant === "original") {
      return { url: await resolveOriginalDeliveryUrl(data.mediaId) };
    }

    return {
      url: await resolveDerivativeDeliveryUrl({
        mediaId: data.mediaId,
        size: data.size,
        variant: data.variant,
      }),
    };
  });
