import { and, eq, isNull } from "drizzle-orm";
import { createPaneViewDb, readDatabaseUrl } from "../db/client";
import { libraryEntries, mediaObjects } from "../db/schema";
import type { MediaDeliveryRequest } from "./delivery";

export async function readMediaDeliveryRequest({
  env,
  mediaId,
}: {
  env: NodeJS.ProcessEnv;
  mediaId: string;
}): Promise<MediaDeliveryRequest | null> {
  const databaseUrl = readDatabaseUrl(env);
  if (!databaseUrl) {
    return null;
  }

  const db = createPaneViewDb(databaseUrl);
  const [media] = await db
    .select({
      extension: mediaObjects.extension,
      mediaType: mediaObjects.mediaType,
      sha256: mediaObjects.sha256,
    })
    .from(libraryEntries)
    .innerJoin(mediaObjects, eq(libraryEntries.mediaObjectId, mediaObjects.id))
    .where(and(eq(libraryEntries.id, mediaId), isNull(libraryEntries.deletedAt)))
    .limit(1);

  return media ?? null;
}
