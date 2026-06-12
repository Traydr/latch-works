import { createSignedGetUrl } from "@latch-works/media-storage";
import { env } from "../../env/server";
import { buildSignedCdnDeliveryUrl, readDeliveryPurposeForObjectKey } from "./cdn-delivery";
import { createPaneViewStorageClient } from "./storage-client";

export async function buildDerivativeDeliveryUrl(objectKey: string): Promise<string> {
  if (env.NODE_ENV === "development") {
    return createSignedGetUrl({
      expiresInSeconds: env.MEDIA_DELIVERY_TTL_SECONDS,
      key: objectKey,
      storage: createPaneViewStorageClient(),
    });
  }

  return buildSignedCdnDeliveryUrl({
    objectKey,
    purpose: readDeliveryPurposeForObjectKey(objectKey),
  });
}
