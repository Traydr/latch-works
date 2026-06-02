import { fixtureFolders, fixtureMedia, libraryStats } from "./library-data";

export interface LibrarySnapshot {
  archiveRoot: string;
  currentPath: string;
  folders: typeof fixtureFolders;
  media: typeof fixtureMedia;
  mediaUrlMode: "signed-url";
  roots: string[];
  stats: typeof libraryStats;
}

export async function getLibrarySnapshot(): Promise<LibrarySnapshot> {
  const currentPath = "sfw/patreon";

  return {
    archiveRoot: "T:\\cloud-desktop\\media",
    currentPath,
    folders: fixtureFolders,
    media: fixtureMedia,
    mediaUrlMode: "signed-url",
    roots: ["nsfw", "nsfw-stories", "sfw", "sfw/patreon"],
    stats: libraryStats,
  };
}
