import { originalObjectKey } from "@latch-works/media-storage";

export interface MediaDeliveryRequest {
  extension: string;
  mediaType: "image" | "gif" | "video" | "pdf" | "unknown";
  objectKey?: string | null;
  sha256: string;
}

export interface MediaDeliveryPlan {
  expiresInSeconds: number;
  objectKey: string;
  strategy: "signed-url";
}

export function planSignedOriginalDelivery(request: MediaDeliveryRequest): MediaDeliveryPlan {
  return {
    expiresInSeconds: 60,
    objectKey: request.objectKey ?? originalObjectKey(request),
    strategy: "signed-url",
  };
}
