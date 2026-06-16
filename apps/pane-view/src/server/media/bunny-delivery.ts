import { env } from "../../env/server";
import { API_PRIVATE_CACHE_CONTROL, mintOriginalDeliveryToken } from "./cdn-delivery";
import { planSignedOriginalDelivery } from "./delivery";
import { mintImageOriginalDeliveryToken } from "./image-delivery";
import { readMediaThumbnailContext } from "./repository";

export function buildBunnyThumbnailRedirectLocation({
  deliveryToken,
  size,
}: {
  deliveryToken: string;
  size: number;
}): string {
  if (!env.BUNNY_CDN_HOST) {
    throw new Error("BUNNY_CDN_HOST is not configured");
  }

  const params = new URLSearchParams({
    height: String(size),
    quality: "80",
    width: String(size),
  });

  return `https://${env.BUNNY_CDN_HOST}/lw/${encodeURIComponent(deliveryToken)}?${params.toString()}`;
}

export async function redirectImageToBunnyThumbnail({
  mediaId,
  size,
}: {
  mediaId: string;
  size: number;
}): Promise<Response> {
  const media = await readMediaThumbnailContext({ mediaId });
  if (!media) {
    return new Response("Media not found", {
      headers: { "Cache-Control": API_PRIVATE_CACHE_CONTROL },
      status: 404,
    });
  }

  const deliveryToken = mintImageOriginalDeliveryToken(media);

  return new Response(null, {
    headers: {
      "Cache-Control": API_PRIVATE_CACHE_CONTROL,
      Location: buildBunnyThumbnailRedirectLocation({ deliveryToken, size }),
    },
    status: 302,
  });
}

export function mintOriginalDeliveryTokenForMedia(media: {
  extension: string;
  mediaType: "image" | "gif" | "video" | "pdf" | "unknown";
  objectKey?: string | null;
  sha256: string;
}): string {
  const delivery = planSignedOriginalDelivery(media);
  return mintOriginalDeliveryToken(delivery.objectKey);
}
