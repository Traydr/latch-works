import { env } from "./server";

export type ImageDeliveryMode = "bunny" | "inline";

export function resolveImageDeliveryMode(): ImageDeliveryMode {
  if (env.IMAGE_DELIVERY_MODE) {
    return env.IMAGE_DELIVERY_MODE;
  }

  return env.BUNNY_CDN_HOST ? "bunny" : "inline";
}
