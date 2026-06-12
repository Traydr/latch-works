import { snapThumbnailSize } from "@latch-works/media-delivery";

type PaneViewTransformOperations = {
  width?: number;
  height?: number;
  format?: string;
};

export function paneViewImageTransformer(
  src: string | URL,
  operations: PaneViewTransformOperations,
): string {
  const parsed = new URL(src.toString(), "http://localhost");

  if (!parsed.pathname.endsWith("/thumbnail")) {
    return `${parsed.pathname}${parsed.search}`;
  }

  const requestedWidth = operations.width ?? (Number(parsed.searchParams.get("size")) || 320);
  const size = snapThumbnailSize(requestedWidth);
  parsed.searchParams.set("size", String(size));

  return `${parsed.pathname}${parsed.search}`;
}
