export type ImageDeliveryMode = "bunny" | "inline";

export function readClientImageDeliveryMode(): ImageDeliveryMode {
  const configured = import.meta.env.VITE_IMAGE_DELIVERY_MODE;
  if (configured === "bunny" || configured === "inline") {
    return configured;
  }

  return import.meta.env.VITE_BUNNY_CDN_HOST ? "bunny" : "inline";
}

export function readBunnyCdnHost(): string | undefined {
  return import.meta.env.VITE_BUNNY_CDN_HOST;
}

export function buildBunnyLwImageSrc(token: string): string {
  const host = readBunnyCdnHost();
  if (!host) {
    throw new Error("VITE_BUNNY_CDN_HOST is not configured");
  }

  return `https://${host}/lw/${encodeURIComponent(token)}`;
}
