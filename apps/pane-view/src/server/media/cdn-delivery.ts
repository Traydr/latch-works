import {
  buildCdnDeliveryPath,
  createDeliveryTokenSigner,
  type DeliveryPurpose,
} from "@latch-works/media-delivery";
import { env } from "../../env/server";

const deliverySigner = createDeliveryTokenSigner(env.MEDIA_DELIVERY_SECRET);

export function buildSignedCdnDeliveryUrl({
  objectKey,
  purpose,
}: {
  objectKey: string;
  purpose: DeliveryPurpose;
}): string {
  const token = deliverySigner.sign({
    exp: Math.floor(Date.now() / 1000) + env.MEDIA_DELIVERY_TTL_SECONDS,
    objectKey,
    purpose,
  });

  return buildCdnDeliveryPath(token);
}

export function verifyCdnDeliveryToken(token: string) {
  return deliverySigner.verify(token);
}

export const CDN_CACHE_CONTROL = "public, max-age=31536000, immutable";

export const API_PRIVATE_CACHE_CONTROL = "private, no-store";

export function readDeliveryPurposeForObjectKey(objectKey: string): DeliveryPurpose {
  return objectKey.startsWith("previews/") ? "preview" : "thumbnail";
}

export function buildGalleryThumbnailUrl({
  entryId,
  mediaType,
  objectKey,
}: {
  entryId: string;
  mediaType: string;
  objectKey?: string;
}): string | undefined {
  if (mediaType !== "image" && mediaType !== "gif" && mediaType !== "video") {
    return undefined;
  }

  if (objectKey) {
    return buildSignedCdnDeliveryUrl({
      objectKey,
      purpose: readDeliveryPurposeForObjectKey(objectKey),
    });
  }

  return `/api/media/${entryId}/thumbnail?size=320`;
}
