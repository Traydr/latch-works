import { originalObjectKey } from "@latch-works/media-storage";
import { expectedContentTypeForExtension } from "../sync/validation";

export interface MediaDeliveryRequest {
  extension: string;
  mediaType: "image" | "gif" | "video" | "pdf" | "unknown";
  objectKey?: string | null;
  sha256: string;
}

/**
 * The content types Shutter's Source Delivery passes through (its
 * `docs/contracts/v1/source-delivery.md`). Lockstep signs the upload's
 * Content-Type from the extension, so the type an original was stored with is
 * the type Shutter sees; anything else Shutter answers 415.
 */
const SHUTTER_SOURCE_DELIVERY_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "application/pdf",
]);

/**
 * A signed URL must outlive the client caches, which keep every delivery URL
 * for the session on the strength of the one-day Shutter token lifetime. A
 * shorter expiry would 403 while the resolver keeps serving the cached URL.
 */
export const SIGNED_URL_LIFETIME_SECONDS = 24 * 60 * 60;

export type MediaDeliveryPlan =
  | { objectKey: string; sha256: string; strategy: "shutter" }
  | { expiresInSeconds: number; objectKey: string; strategy: "signed-url" };

/**
 * Shutter delivers an original when it is on and will pass the object's
 * content type through; the bucket signs the rest itself. The `mkv` and
 * `bmp` originals Lockstep accepts upload as `application/octet-stream`, so
 * they stay signed.
 */
export function planOriginalDelivery(
  request: MediaDeliveryRequest,
  options: { shutter: boolean },
): MediaDeliveryPlan {
  const objectKey = request.objectKey ?? originalObjectKey(request);

  if (
    options.shutter &&
    SHUTTER_SOURCE_DELIVERY_TYPES.has(expectedContentTypeForExtension(request.extension))
  ) {
    return { objectKey, sha256: request.sha256, strategy: "shutter" };
  }

  return { expiresInSeconds: SIGNED_URL_LIFETIME_SECONDS, objectKey, strategy: "signed-url" };
}
