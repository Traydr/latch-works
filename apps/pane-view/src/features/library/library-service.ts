import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { assertWebSessionAuthorized } from "../auth/assert-web-session";
import {
  type GalleryComic,
  GalleryComicRequestSchema,
  type GalleryListingPage,
  GalleryListingRequestSchema,
  type LibrarySnapshot,
  LibrarySnapshotRequestSchema,
  normalizeComicRequest,
  normalizeListingRequest,
  normalizeSnapshotRequest,
} from "./listing-contract";

export const getGalleryListing = createServerFn({ method: "GET" })
  .validator(GalleryListingRequestSchema)
  .handler(async ({ data }): Promise<GalleryListingPage> => {
    await assertWebSessionAuthorized();

    const request = normalizeListingRequest(data);

    if (request.comicMode) {
      const { readDatabaseComicListing } = await import("../../server/library/comic-listing");

      return readDatabaseComicListing(request, data.cursor);
    }

    const { readDatabaseGalleryListing } = await import("../../server/library/repository");

    return readDatabaseGalleryListing(request, data.cursor);
  });

/**
 * One complete comic (every eligible page in natural order) for the reader.
 * The listing carries only summaries, so this is the only place full page
 * arrays cross the wire; the payload size depends on that comic alone.
 */
export const getGalleryComic = createServerFn({ method: "GET" })
  .validator(GalleryComicRequestSchema)
  .handler(async ({ data }): Promise<GalleryComic> => {
    await assertWebSessionAuthorized();

    const { readDatabaseGalleryComic } = await import("../../server/library/comic-listing");
    const comic = await readDatabaseGalleryComic(normalizeComicRequest(data));

    if (!comic) {
      throw new Error("Comic not found");
    }

    return comic;
  });

export const getLibrarySnapshot = createServerFn({ method: "GET" })
  .validator(LibrarySnapshotRequestSchema)
  .handler(async ({ data }): Promise<LibrarySnapshot> => {
    await assertWebSessionAuthorized();

    const { readDatabaseLibrarySnapshot } = await import("../../server/library/repository");

    return readDatabaseLibrarySnapshot(normalizeSnapshotRequest(data));
  });

export const deleteLibraryEntry = createServerFn({ method: "POST" })
  .validator(z.object({ entryId: z.uuid() }))
  .handler(async ({ data }): Promise<{ deleted: boolean }> => {
    await assertWebSessionAuthorized();

    const { softDeleteLibraryEntry } = await import("../../server/library/repository");

    return { deleted: await softDeleteLibraryEntry({ entryId: data.entryId }) };
  });
