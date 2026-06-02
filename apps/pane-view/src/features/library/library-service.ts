import { createServerFn } from "@tanstack/react-start";
import { readDatabaseLibrarySnapshot } from "../../server/library/repository";
import { fixtureFolders, fixtureMedia, libraryStats } from "./library-data";

const fixtureCurrentPath = "sfw/patreon";
const fixtureRoots = ["nsfw", "nsfw-stories", "sfw", fixtureCurrentPath];

export interface LibrarySnapshot {
  archiveRoot: string;
  currentPath: string;
  folders: typeof fixtureFolders;
  media: typeof fixtureMedia;
  mediaUrlMode: "signed-url";
  roots: string[];
  stats: typeof libraryStats;
}

export const getLibrarySnapshot = createServerFn({ method: "GET" }).handler(
  async (): Promise<LibrarySnapshot> => {
    const databaseSnapshot = await readDatabaseLibrarySnapshot({
      currentPath: fixtureCurrentPath,
      env: process.env,
    });

    return {
      archiveRoot: databaseSnapshot ? "Synced archive" : "T:\\cloud-desktop\\media",
      currentPath: fixtureCurrentPath,
      folders: databaseSnapshot?.folders ?? fixtureFolders,
      media: databaseSnapshot?.media ?? fixtureMedia,
      mediaUrlMode: "signed-url",
      roots: databaseSnapshot?.roots.length ? databaseSnapshot.roots : fixtureRoots,
      stats: libraryStats,
    };
  },
);
