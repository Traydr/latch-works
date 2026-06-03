import type { FolderNode } from "@latch-works/media-domain";
import { getParentPath, toArchivePath, trimTrailingSlash } from "@latch-works/media-domain";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  type LibraryMediaItem,
  readDatabaseLibrarySnapshot,
} from "../../server/library/repository";

const fixtureRoots = ["nsfw", "nsfw-stories", "sfw", "sfw/patreon"];
const libraryRequestSchema = z.object({
  path: z.string().optional(),
  query: z.string().optional(),
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

export const getLibrarySnapshot = createServerFn({ method: "GET" })
  .inputValidator(libraryRequestSchema)
  .handler(async ({ data }): Promise<LibrarySnapshot> => {
    const currentPath = normalizeLibraryPath(data.path);
    const query = normalizeQuery(data.query);
    const databaseSnapshot = await readDatabaseLibrarySnapshot({
      currentPath,
      query,
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
