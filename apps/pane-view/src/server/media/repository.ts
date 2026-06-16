import type { MediaType } from "@latch-works/media-domain";
import { and, eq, inArray, isNull } from "drizzle-orm";
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
  const contexts = await readMediaThumbnailContextsByEntryIds({ mediaIds: [mediaId] });
  return contexts.get(mediaId) ?? null;
}

export async function readMediaThumbnailContextsByEntryIds({
  mediaIds,
}: {
  mediaIds: string[];
}): Promise<Map<string, MediaThumbnailContext>> {
  const uniqueIds = [...new Set(mediaIds)];
  if (uniqueIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .select({
      entryId: libraryEntries.id,
      extension: mediaObjects.extension,
      mediaObjectId: mediaObjects.id,
      mediaType: mediaObjects.mediaType,
      originalObjectKey: mediaObjects.objectKey,
      sha256: mediaObjects.sha256,
    })
    .from(libraryEntries)
    .innerJoin(mediaObjects, eq(libraryEntries.mediaObjectId, mediaObjects.id))
    .where(and(inArray(libraryEntries.id, uniqueIds), isNull(libraryEntries.deletedAt)));

  const contexts = new Map<string, MediaThumbnailContext>();
  for (const row of rows) {
    contexts.set(row.entryId, {
      extension: row.extension,
      mediaObjectId: row.mediaObjectId,
      mediaType: row.mediaType,
      originalObjectKey: row.originalObjectKey,
      sha256: row.sha256,
    });
  }

  return contexts;
}
