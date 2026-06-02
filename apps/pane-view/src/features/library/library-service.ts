import type { FolderNode, MediaItem } from "@latch-works/media-domain";
import { getParentPath, toArchivePath, trimTrailingSlash } from "@latch-works/media-domain";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { readDatabaseLibrarySnapshot } from "../../server/library/repository";
import { fixtureFolders, fixtureMedia, libraryStats } from "./library-data";

const fixtureCurrentPath = "sfw/patreon";
const fixtureRoots = ["nsfw", "nsfw-stories", "sfw", fixtureCurrentPath];
const libraryRequestSchema = z.object({
  path: z.string().optional(),
  query: z.string().optional(),
});

export interface LibrarySnapshot {
  archiveRoot: string;
  currentPath: string;
  folders: FolderNode[];
  media: MediaItem[];
  mediaUrlMode: "signed-url";
  roots: string[];
  stats: typeof libraryStats;
}

export const getLibrarySnapshot = createServerFn({ method: "GET" })
  .inputValidator(libraryRequestSchema)
  .handler(async ({ data }): Promise<LibrarySnapshot> => {
    const currentPath = normalizeLibraryPath(data.path);
    const query = normalizeQuery(data.query);
    const databaseSnapshot = await readDatabaseLibrarySnapshot({
      currentPath,
      env: process.env,
      query,
    });
    const fixtureSnapshot = readFixtureLibrarySnapshot({ currentPath, query });

    return {
      archiveRoot: databaseSnapshot ? "Synced archive" : "T:\\cloud-desktop\\media",
      currentPath,
      folders: databaseSnapshot?.folders ?? fixtureSnapshot.folders,
      media: databaseSnapshot?.media ?? fixtureSnapshot.media,
      mediaUrlMode: "signed-url",
      roots: databaseSnapshot?.roots.length ? databaseSnapshot.roots : fixtureSnapshot.roots,
      stats: libraryStats,
    };
  });

function normalizeLibraryPath(path: string | undefined): string {
  const normalized = trimTrailingSlash(toArchivePath(path ?? fixtureCurrentPath));
  return normalized || fixtureCurrentPath;
}

function normalizeQuery(query: string | undefined): string | undefined {
  const trimmed = query?.trim();
  return trimmed ? trimmed : undefined;
}

function readFixtureLibrarySnapshot({
  currentPath,
  query,
}: {
  currentPath: string;
  query: string | undefined;
}): Pick<LibrarySnapshot, "folders" | "media" | "roots"> {
  const lowerQuery = query?.toLowerCase();
  const isWithinPath = (path: string) => path === currentPath || path.startsWith(`${currentPath}/`);
  const matchesQuery = (value: string) => !lowerQuery || value.toLowerCase().includes(lowerQuery);

  return {
    folders: fixtureFolders.filter(
      (folder) =>
        folder.parentPath === currentPath &&
        (matchesQuery(folder.path) || matchesQuery(folder.name)),
    ),
    media: fixtureMedia.filter(
      (media) =>
        isWithinPath(media.parentPath) &&
        (matchesQuery(media.path) || matchesQuery(media.name) || matchesQuery(media.parentPath)),
    ),
    roots: fixtureRoots
      .concat(currentPath, getParentPath(currentPath))
      .filter((path) => path.length > 0)
      .filter(dedupe),
  };
}

function dedupe(value: string, index: number, values: string[]): boolean {
  return values.indexOf(value) === index;
}
