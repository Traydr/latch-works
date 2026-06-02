export const COLLECT_MESSAGE_TYPE = "COLLECT_COMIC_GALLERY" as const;

export interface CollectComicGalleryMessage {
  type: typeof COLLECT_MESSAGE_TYPE;
}
