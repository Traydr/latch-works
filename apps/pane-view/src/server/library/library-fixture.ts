import type { MediaType } from "@latch-works/media-domain";
import { getBaseName, getParentPath } from "@latch-works/media-domain";
import { folders, libraryEntries, mediaObjects } from "../db/schema";
import type { TestDatabase } from "./test-db";

/**
 * Test-only. One deterministic archive for every pglite repository test:
 * fixed UUIDs, fixed mtimes (with duplicates), three roots, leaf folders and
 * folders with children, padded and unpadded comic page names, media directly
 * under a root, soft-deleted rows, and filenames that do and do not match
 * `FIXTURE_SEARCH_TERM`. Tests compute their expected order from these rows
 * in TypeScript and compare it to what the SQL returns.
 */

export const FIXTURE_SEARCH_TERM = "hero";

export interface FixtureFolder {
  deleted?: boolean;
  path: string;
}

export interface FixtureEntry {
  deleted?: boolean;
  id: string;
  mediaType: MediaType;
  mtimeMs: number;
  path: string;
  size: number;
}

export interface LibraryFixture {
  entries: FixtureEntry[];
  folders: FixtureFolder[];
}

const MTIMES = [
  1_700_000_000_000, 1_700_000_100_000, 1_700_000_200_000, 1_700_000_300_000, 1_700_000_400_000,
  1_700_000_500_000, 1_700_000_600_000, 1_700_000_700_000, 1_700_000_800_000, 1_700_000_900_000,
  1_700_001_000_000, 1_700_001_100_000, 1_700_001_200_000,
];

function mediaTypeFor(name: string): MediaType {
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (extension === "gif") return "gif";
  if (extension === "mp4" || extension === "webm") return "video";
  if (extension === "pdf") return "pdf";
  return "image";
}

export function buildLibraryFixture(): LibraryFixture {
  const folderPaths = new Map<string, boolean>();
  const entries: FixtureEntry[] = [];
  let sequence = 0;

  const folder = (path: string, deleted = false) => {
    folderPaths.set(path, deleted);
    // Every ancestor exists too.
    let parent = getParentPath(path);
    while (parent) {
      if (!folderPaths.has(parent)) folderPaths.set(parent, false);
      parent = getParentPath(parent);
    }
  };

  const file = (path: string, options: { deleted?: boolean } = {}) => {
    sequence += 1;
    const id = `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`;
    entries.push({
      deleted: options.deleted,
      id,
      mediaType: mediaTypeFor(getBaseName(path)),
      // Duplicated mtimes on purpose: date modes must tie-break deterministically.
      mtimeMs: MTIMES[(sequence * 7) % MTIMES.length] as number,
      path,
      size: 1000 + ((sequence * 131) % 9000),
    });
    folder(getParentPath(path));
  };

  // --- alpha ---------------------------------------------------------------
  folder("alpha");
  // Media directly under a root: never a comic.
  for (let index = 1; index <= 12; index += 1) {
    file(`alpha/photo-${String(index).padStart(2, "0")}.jpg`);
  }
  file("alpha/hero-shot.jpg");
  file("alpha/intro.mp4");
  file("alpha/loop.gif");
  file("alpha/notes.pdf");
  // Padded page names.
  for (let index = 1; index <= 30; index += 1) {
    file(`alpha/comic-padded/${String(index).padStart(3, "0")}.jpg`);
  }
  // Unpadded page names starting at 2: natural order makes 2.jpg the cover;
  // byte order would pick 10.jpg.
  for (let index = 2; index <= 12; index += 1) {
    file(`alpha/comic-unpadded/${index}.jpg`);
  }
  // A folder with child folders holds pages but is not a comic; its children are.
  file("alpha/series/cover.jpg");
  file("alpha/series/hero-poster.png");
  file("alpha/series/teaser.mp4");
  for (let index = 1; index <= 15; index += 1) {
    file(`alpha/series/vol-1/page-${String(index).padStart(2, "0")}.png`);
  }
  file("alpha/series/vol-1/trailer.mp4");
  file("alpha/series/vol-1/bonus.gif");
  for (let index = 1; index <= 15; index += 1) {
    file(`alpha/series/vol-2/Page ${index}.jpg`);
  }
  // Images and videos together: only images and gifs are pages.
  for (let index = 1; index <= 6; index += 1) {
    file(`alpha/mixed/still-${index}.jpg`);
    file(`alpha/mixed/clip-${index}.mp4`);
  }
  // Videos only: never a comic.
  for (let index = 1; index <= 4; index += 1) {
    file(`alpha/videos-only/take-${index}.webm`);
  }
  // Primary-equal names: the collation ties, the id breaks the tie.
  file("alpha/case-tie/a.jpg");
  file("alpha/case-tie/A.jpg");
  file("alpha/case-tie/b.jpg");
  // A soft-deleted child folder does not disqualify its parent as a comic.
  for (let index = 1; index <= 5; index += 1) {
    file(`alpha/orphaned-child/${index}.png`);
  }
  folder("alpha/orphaned-child/gone", true);

  // --- beta: many small leaf comics ---------------------------------------
  folder("beta");
  for (let set = 0; set < 72; set += 1) {
    const setPath = `beta/set-${String(set).padStart(3, "0")}`;
    for (let index = 1; index <= 15; index += 1) {
      const name =
        set % 9 === 0 && index === 3
          ? `hero-${index}.jpg`
          : index % 5 === 0
            ? `img_${index}.png`
            : `img-${index}.jpg`;
      // Some soft-deleted pages sprinkled through.
      file(`${setPath}/${name}`, { deleted: set % 11 === 0 && index === 7 });
    }
  }

  // --- gamma ---------------------------------------------------------------
  folder("gamma");
  file("gamma/root-video.mp4");
  file("gamma/root-image.jpg");
  // Folder path matches the search term even though the page names do not.
  for (let index = 1; index <= 10; index += 1) {
    file(`gamma/heroes/scan-${String(index).padStart(2, "0")}.jpg`);
  }
  // A folder that exists only as a parent.
  folder("gamma/empty-parent");
  for (let index = 1; index <= 8; index += 1) {
    file(`gamma/empty-parent/deep/${String(index).padStart(2, "0")}.jpg`);
  }
  // Every page soft-deleted: no comic.
  for (let index = 1; index <= 5; index += 1) {
    file(`gamma/deleted-comic/${index}.jpg`, { deleted: true });
  }
  // One page soft-deleted: page count 4.
  for (let index = 1; index <= 5; index += 1) {
    file(`gamma/one-deleted/${index}.jpg`, { deleted: index === 2 });
  }
  // A folder whose only page is a video: not a comic; the video is regular media.
  file("gamma/talks/keynote.mp4");

  return {
    entries,
    folders: [...folderPaths].map(([path, deleted]) => ({ deleted, path })),
  };
}

export async function seedLibraryFixture(db: TestDatabase, fixture: LibraryFixture): Promise<void> {
  const deletedAt = new Date("2026-08-01T00:00:00.000Z");
  const now = new Date("2026-08-15T00:00:00.000Z");

  const folderRows = fixture.folders.map((folder) => ({
    createdAt: now,
    deletedAt: folder.deleted ? deletedAt : null,
    depth: folder.path.split("/").length,
    entryCount: fixture.entries.filter(
      (entry) => !entry.deleted && getParentPath(entry.path) === folder.path,
    ).length,
    folderCount: fixture.folders.filter(
      (candidate) => !candidate.deleted && getParentPath(candidate.path) === folder.path,
    ).length,
    name: getBaseName(folder.path),
    parentPath: getParentPath(folder.path),
    path: folder.path,
    updatedAt: now,
  }));

  const objectRows = fixture.entries.map((entry) => ({
    contentType: entry.mediaType === "video" ? "video/mp4" : "image/jpeg",
    createdAt: now,
    extension: entry.path.slice(entry.path.lastIndexOf(".") + 1),
    id: entry.id,
    mediaType: entry.mediaType,
    objectKey: `objects/${entry.id}`,
    sha256: entry.id.replace(/-/gu, "").padEnd(64, "0"),
    size: entry.size,
  }));

  const entryRows = fixture.entries.map((entry) => ({
    deletedAt: entry.deleted ? deletedAt : null,
    filename: getBaseName(entry.path),
    firstSeenAt: now,
    id: entry.id,
    lastSeenAt: now,
    logicalPath: entry.path,
    mediaObjectId: entry.id,
    mtimeMs: entry.mtimeMs,
    parentPath: getParentPath(entry.path),
    size: entry.size,
  }));

  const CHUNK = 200;
  for (let index = 0; index < folderRows.length; index += CHUNK) {
    await db.insert(folders).values(folderRows.slice(index, index + CHUNK));
  }
  for (let index = 0; index < objectRows.length; index += CHUNK) {
    await db.insert(mediaObjects).values(objectRows.slice(index, index + CHUNK));
  }
  for (let index = 0; index < entryRows.length; index += CHUNK) {
    await db.insert(libraryEntries).values(entryRows.slice(index, index + CHUNK));
  }
}
