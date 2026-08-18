import * as z from "zod/mini";
import type { SiteKey } from "./sites";
import { SiteKeySchema } from "./source-catalog";
import type { GalleryCollectResponse } from "./types";

export const COLLECT_MESSAGE_TYPE = "COLLECT_COMIC_GALLERY" as const;

export const CollectComicGalleryMessageSchema = z.object({
  type: z.literal(COLLECT_MESSAGE_TYPE),
  requestId: z.string(),
  sourceKey: SiteKeySchema,
  pageUrl: z.string()
});

export type CollectComicGalleryMessage = z.infer<typeof CollectComicGalleryMessageSchema>;

export interface CollectComicGalleryResponse {
  requestId: string;
  sourceKey: SiteKey;
  result: GalleryCollectResponse;
}
