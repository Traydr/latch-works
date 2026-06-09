import {
  API_PRIVATE_CACHE_CONTROL,
  buildSignedCdnDeliveryUrl,
  readDeliveryPurposeForObjectKey,
} from "./cdn-delivery";

export function redirectToCdnDelivery({ objectKey }: { objectKey: string }): Response {
  const location = buildSignedCdnDeliveryUrl({
    objectKey,
    purpose: readDeliveryPurposeForObjectKey(objectKey),
  });

  return new Response(null, {
    headers: {
      "Cache-Control": API_PRIVATE_CACHE_CONTROL,
      Location: location,
    },
    status: 302,
  });
}
