import { originalObjectKey } from "@latch-works/media-storage";
import { mintOriginalDeliveryToken } from "./cdn-delivery";
import { planSignedOriginalDelivery } from "./delivery";
import type { MediaThumbnailContext } from "./repository";

export function mintImageOriginalDeliveryToken(context: MediaThumbnailContext): string {
  const delivery = planSignedOriginalDelivery({
    extension: context.extension,
    mediaType: context.mediaType,
    objectKey: context.originalObjectKey,
    sha256: context.sha256,
  });

  const objectKey =
    delivery.objectKey ??
    originalObjectKey({
      extension: context.extension,
      mediaType: context.mediaType,
      sha256: context.sha256,
    });

  return mintOriginalDeliveryToken(objectKey);
}
