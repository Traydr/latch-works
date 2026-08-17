import { and, eq, exists, isNotNull, isNull, notExists, type SQL, sql } from "drizzle-orm";
import { db } from "../db";
import { libraryEntries, mediaObjects, shutterSourceCleanup } from "../db/schema";

/**
 * The one definition of an orphaned Shutter source: a media object with at
 * least one soft-deleted library entry and no live one. Both the purge
 * schedulers' probes and the worker's batches select `mediaObjects` under
 * these conditions; keep them here so the three never drift again.
 */

/** Media objects referenced only by soft-deleted entries. */
export function orphanedMediaObjectCondition(): SQL {
  const deletedReference = db
    .select({ value: sql`1` })
    .from(libraryEntries)
    .where(
      and(eq(libraryEntries.mediaObjectId, mediaObjects.id), isNotNull(libraryEntries.deletedAt)),
    );
  const activeReference = db
    .select({ value: sql`1` })
    .from(libraryEntries)
    .where(
      and(eq(libraryEntries.mediaObjectId, mediaObjects.id), isNull(libraryEntries.deletedAt)),
    );

  return and(exists(deletedReference), notExists(activeReference)) as SQL;
}

/** Orphaned media objects whose Shutter source has not been queued for purge yet. */
export function orphanedShutterSourceCondition(): SQL {
  const alreadyQueued = db
    .select({ value: sql`1` })
    .from(shutterSourceCleanup)
    .where(eq(shutterSourceCleanup.sha256, mediaObjects.sha256));

  return and(orphanedMediaObjectCondition(), notExists(alreadyQueued)) as SQL;
}
