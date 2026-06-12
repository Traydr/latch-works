import type { FolderNode } from "@latch-works/media-domain";
import { getParentPath, toArchivePath, trimTrailingSlash } from "@latch-works/media-domain";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { isCurrentWebSessionValid } from "../../server/auth/web-session";
import {
  type LibraryMediaItem,
  readDatabaseLibrarySnapshot,
  softDeleteLibraryEntry,
} from "../../server/library/repository";

const fixtureRoots = ["nsfw", "nsfw-stories", "sfw", "sfw/patreon"];
const SEARCH_RESULT_LIMIT = 200;

const libraryRequestSchema = z.object({
  comicMode: z.boolean().optional(),
  path: z.string().optional(),
  query: z.string().optional(),
  recursive: z.boolean().optional(),
  searchOffset: z.number().int().min(0).optional(),
});

export interface LibrarySnapshot {
  allFolders: FolderNode[];
  archiveRoot: string;
  currentPath: string;
  folders: FolderNode[];
  media: LibraryMediaItem[];
  mediaUrlMode: "signed-url";
  roots: string[];
}

const deleteLibraryEntrySchema = z.object({
  entryId: z.string().uuid(),
});

export const deleteLibraryEntry = createServerFn({ method: "POST" })
  .inputValidator(deleteLibraryEntrySchema)
  .handler(async ({ data }): Promise<{ deleted: boolean }> => {
    if (!(await isCurrentWebSessionValid())) {
      throw new Error("Unauthorized");
    }

    const deleted = await softDeleteLibraryEntry({ entryId: data.entryId });
    return { deleted };
  });

export async function assertWebSessionAuthorized(): Promise<void> {
  if (!(await isCurrentWebSessionValid())) {
    throw new Error("Unauthorized");
  }
}

export async function readLibrarySnapshotRequest(
  data: z.infer<typeof libraryRequestSchema>,
): Promise<LibrarySnapshot> {
  const currentPath = normalizeLibraryPath(data.path);
  const query = normalizeQuery(data.query);
  const comicMode = data.comicMode ?? false;
  const recursive = (data.recursive ?? false) || comicMode;
  const searchOffset = data.searchOffset ?? 0;
  const databaseSnapshot = await readDatabaseLibrarySnapshot({
    currentPath,
    includeAllFolders: comicMode,
    limit: query ? SEARCH_RESULT_LIMIT : undefined,
    offset: query ? searchOffset : 0,
    query,
    recursive,
  });

  return {
    allFolders: databaseSnapshot.allFolders,
    archiveRoot: "Synced archive",
    currentPath,
    folders: databaseSnapshot.folders,
    media: databaseSnapshot.media,
    mediaUrlMode: "signed-url",
    roots: databaseSnapshot.roots.length ? databaseSnapshot.roots : readFixtureRoots(currentPath),
  };
}

export const getLibrarySnapshot = createServerFn({ method: "GET" })
  .inputValidator(libraryRequestSchema)
  .handler(async ({ data }): Promise<LibrarySnapshot> => {
    await assertWebSessionAuthorized();
    return readLibrarySnapshotRequest(data);
  });

function normalizeLibraryPath(path: string | undefined): string {
  return trimTrailingSlash(toArchivePath(path ?? ""));
}

function normalizeQuery(query: string | undefined): string | undefined {
  const trimmed = query?.trim();
  return trimmed ? trimmed : undefined;
}

function readFixtureRoots(currentPath: string): string[] {
  return fixtureRoots
    .concat(currentPath, getParentPath(currentPath))
    .filter((path) => path.length > 0)
    .filter(dedupe);
}

function dedupe(value: string, index: number, values: string[]): boolean {
  return values.indexOf(value) === index;
}
