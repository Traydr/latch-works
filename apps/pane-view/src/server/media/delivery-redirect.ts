import { API_PRIVATE_CACHE_CONTROL } from "./cdn-delivery";
import { buildDerivativeDeliveryUrl } from "./derivative-delivery-url";

export async function redirectToCdnDelivery({
  objectKey,
}: {
  objectKey: string;
}): Promise<Response> {
  const location = await buildDerivativeDeliveryUrl(objectKey);

  return new Response(null, {
    headers: {
      "Cache-Control": API_PRIVATE_CACHE_CONTROL,
      Location: location,
    },
    status: 302,
  });
}
