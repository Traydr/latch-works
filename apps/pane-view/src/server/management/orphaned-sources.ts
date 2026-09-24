import { and, eq, isNull, notExists, type SQL, sql } from "drizzle-orm";
import { db } from "../db";
import { libraryEntries, mediaObjects, shutterSourceCleanup } from "../db/schema";

/**
 * The one definition of an orphaned Shutter source: a media object no live
 * library entry references. That includes media no entry references at all,
 * which a content change leaves behind when sync repoints the entry at the
 * new object. Both the purge schedulers' probes and the worker's batches
 * select `mediaObjects` under these conditions; keep them here so the three
 * never drift again.
 *
 * Sync creates a media object and its entry in one transaction, and syncs
 * and cleanup jobs exclude each other, so an object a sync is still linking
 * never shows up here without an entry.
 */

/** Media objects no live library entry references. */
export function orphanedMediaObjectCondition(): SQL {
  const activeReference = db
    .select({ value: sql`1` })
    .from(libraryEntries)
    .where(
      and(eq(libraryEntries.mediaObjectId, mediaObjects.id), isNull(libraryEntries.deletedAt)),
    );

  return notExists(activeReference);
}

/** Orphaned media objects whose Shutter source has not been queued for purge yet. */
export function orphanedShutterSourceCondition(): SQL {
  const alreadyQueued = db
    .select({ value: sql`1` })
    .from(shutterSourceCleanup)
    .where(eq(shutterSourceCleanup.sha256, mediaObjects.sha256));

  // SAFETY: and() is only undefined when called with no conditions; two are given.
  return and(orphanedMediaObjectCondition(), notExists(alreadyQueued)) as SQL;
}
