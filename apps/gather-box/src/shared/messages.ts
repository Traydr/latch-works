export const COLLECT_MESSAGE_TYPE = "COLLECT_COMIC_GALLERY" as const;

export interface CollectComicGalleryMessage {
  type: typeof COLLECT_MESSAGE_TYPE;
  requestId: string;
  sourceKey: import("./sites").SiteKey;
  pageUrl: string;
}

export interface CollectComicGalleryResponse {
  requestId: string;
  sourceKey: import("./sites").SiteKey;
  result: import("./types").GalleryCollectResponse;
}

export function isCollectComicGalleryMessage(value: unknown): value is CollectComicGalleryMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === COLLECT_MESSAGE_TYPE &&
    "requestId" in value &&
    typeof value.requestId === "string" &&
    "sourceKey" in value &&
    typeof value.sourceKey === "string" &&
    "pageUrl" in value &&
    typeof value.pageUrl === "string"
  );
}
