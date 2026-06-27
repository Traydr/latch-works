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

interface BunnyImageTransformOperations {
  aspect_ratio?: string;
  format?: string;
  height?: number | string;
  quality?: number | string;
  width?: number | string;
  [key: string]: boolean | number | string | undefined;
}

const BUNNY_PLACEHOLDER_MAX_WIDTH = 32;
const BUNNY_PLACEHOLDER_BLUR = 24;
const BUNNY_PLACEHOLDER_QUALITY = 30;
const BUNNY_THUMBNAIL_QUALITY = 75;

function toPositiveNumber(value: boolean | number | string | undefined): number | undefined {
  if (typeof value === "boolean" || value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function buildBunnyLwImageTransformUrl(
  src: string | URL,
  operations: BunnyImageTransformOperations,
): string {
  const url = new URL(src.toString());
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(operations)) {
    if (value === undefined || value === false) {
      continue;
    }

    params.set(key === "format" ? "output" : key, String(value));
  }

  const width = toPositiveNumber(operations.width);
  const height = toPositiveNumber(operations.height);
  if (width && height && !params.has("aspect_ratio")) {
    params.set("aspect_ratio", `${Math.round(width)}:${Math.round(height)}`);
  }

  params.set("optimizer", "image");

  if (!params.has("output") && !params.has("format")) {
    params.set("output", "webp");
  }

  if (!params.has("quality")) {
    params.set(
      "quality",
      String(
        width && width <= BUNNY_PLACEHOLDER_MAX_WIDTH
          ? BUNNY_PLACEHOLDER_QUALITY
          : BUNNY_THUMBNAIL_QUALITY,
      ),
    );
  }

  if (width && width <= BUNNY_PLACEHOLDER_MAX_WIDTH && !params.has("blur")) {
    params.set("blur", String(BUNNY_PLACEHOLDER_BLUR));
  }

  url.search = params.toString();
  return url.toString();
}
