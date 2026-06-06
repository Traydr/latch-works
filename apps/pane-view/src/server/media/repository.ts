import type { MediaType } from "@latch-works/media-domain";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { libraryEntries, mediaObjects, thumbnails } from "../db/schema";
import type { MediaDeliveryRequest, StoredMediaDeliveryRequest } from "./delivery";

export interface MediaThumbnailContext {
  extension: string;
  mediaObjectId: string;
  mediaType: MediaType;
  originalObjectKey: string;
  sha256: string;
}

export async function readMediaDeliveryRequest({
  mediaId,
}: {
  mediaId: string;
}): Promise<MediaDeliveryRequest | null> {
  const [media] = await db
    .select({
      extension: mediaObjects.extension,
      mediaType: mediaObjects.mediaType,
      objectKey: mediaObjects.objectKey,
      sha256: mediaObjects.sha256,
    })
    .from(libraryEntries)
    .innerJoin(mediaObjects, eq(libraryEntries.mediaObjectId, mediaObjects.id))
    .where(and(eq(libraryEntries.id, mediaId), isNull(libraryEntries.deletedAt)))
    .limit(1);

  return media ?? null;
}

export async function readThumbnailDeliveryRequest({
  mediaId,
  size,
}: {
  mediaId: string;
  size: number;
}): Promise<StoredMediaDeliveryRequest | null> {
  const [thumbnail] = await db
    .select({
      objectKey: thumbnails.objectKey,
    })
    .from(libraryEntries)
    .innerJoin(mediaObjects, eq(libraryEntries.mediaObjectId, mediaObjects.id))
    .innerJoin(thumbnails, eq(thumbnails.mediaObjectId, mediaObjects.id))
    .where(
      and(
        eq(libraryEntries.id, mediaId),
        eq(thumbnails.size, size),
        eq(thumbnails.status, "ready"),
        isNull(libraryEntries.deletedAt),
      ),
    )
    .limit(1);

  return thumbnail ?? null;
}

export async function readMediaThumbnailContext({
  mediaId,
}: {
  mediaId: string;
}): Promise<MediaThumbnailContext | null> {
  const [media] = await db
    .select({
      extension: mediaObjects.extension,
      mediaObjectId: mediaObjects.id,
      mediaType: mediaObjects.mediaType,
      originalObjectKey: mediaObjects.objectKey,
      sha256: mediaObjects.sha256,
    })
    .from(libraryEntries)
    .innerJoin(mediaObjects, eq(libraryEntries.mediaObjectId, mediaObjects.id))
    .where(and(eq(libraryEntries.id, mediaId), isNull(libraryEntries.deletedAt)))
    .limit(1);

  return media ?? null;
}
