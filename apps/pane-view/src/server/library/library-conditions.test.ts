import type { MediaType } from "@latch-works/media-domain";
import { beforeAll, describe, expect, it } from "vitest";
import { normalizeListingRequest } from "@/features/library/listing-contract";
import { libraryEntries, mediaObjects } from "../db/schema";
import { readDatabaseGalleryListing } from "./repository";
import { testDatabaseForSuite } from "./test-db";

/** The gallery's media-type toggles against executed SQL, through the listing that applies them. */

const testDatabase = testDatabaseForSuite();

const LIBRARY: Array<{ hasAudio: boolean | null; mediaType: MediaType; name: string }> = [
  { hasAudio: null, mediaType: "image", name: "a.jpg" },
  { hasAudio: null, mediaType: "gif", name: "b.gif" },
  { hasAudio: null, mediaType: "pdf", name: "doc.pdf" },
  { hasAudio: true, mediaType: "video", name: "loud.mp4" },
  { hasAudio: false, mediaType: "video", name: "quiet.mp4" },
  { hasAudio: null, mediaType: "video", name: "unknown.mp4" },
];

async function listedNames(visibility: {
  showImages: boolean;
  showVideos: boolean;
  videosWithAudioOnly: boolean;
}): Promise<string[]> {
  const page = await readDatabaseGalleryListing(
    normalizeListingRequest({
      randomSeed: "0123456789abcdef0123456789abcdef",
      sortMode: "name-asc",
      ...visibility,
    }),
    undefined,
    testDatabase().db,
  );

  return page.entries.flatMap((entry) => (entry.kind === "media" ? [entry.media.name] : []));
}

describe("media visibility", () => {
  beforeAll(async () => {
    const { db } = testDatabase();

    for (const [index, { hasAudio, mediaType, name }] of LIBRARY.entries()) {
      const [object] = await db
        .insert(mediaObjects)
        .values({
          contentType: "application/octet-stream",
          extension: name.split(".").at(-1) ?? "",
          hasAudio,
          mediaType,
          objectKey: `originals/${name}`,
          sha256: index.toString(16).padStart(64, "0"),
          size: 1,
        })
        .returning({ id: mediaObjects.id });

      if (!object) throw new Error(`failed to insert ${name}`);

      await db.insert(libraryEntries).values({
        filename: name,
        logicalPath: name,
        mediaObjectId: object.id,
        mtimeMs: 1_700_000_000_000,
        parentPath: "",
      });
    }
  });

  it("lists everything with every toggle on", async () => {
    expect(
      await listedNames({ showImages: true, showVideos: true, videosWithAudioOnly: false }),
    ).toEqual(["a.jpg", "b.gif", "doc.pdf", "loud.mp4", "quiet.mp4", "unknown.mp4"]);
  });

  it("keeps only videos known to have audio, and everything that is not a video", async () => {
    expect(
      await listedNames({ showImages: true, showVideos: true, videosWithAudioOnly: true }),
    ).toEqual(["a.jpg", "b.gif", "doc.pdf", "loud.mp4"]);
  });

  it("hides images and GIFs but never PDFs", async () => {
    expect(
      await listedNames({ showImages: false, showVideos: true, videosWithAudioOnly: true }),
    ).toEqual(["doc.pdf", "loud.mp4"]);
  });

  it("hides every video while videos are off, whatever the audio toggle says", async () => {
    expect(
      await listedNames({ showImages: true, showVideos: false, videosWithAudioOnly: true }),
    ).toEqual(["a.jpg", "b.gif", "doc.pdf"]);
  });
});
