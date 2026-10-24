import { existsSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isSystemJunkDirectory } from "@latch-works/media-domain";
import { app } from "electron";

import type { FolderListing, FolderPlace, FolderPlaces } from "../shared/messages";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Hidden folders, system folders and app bundles are never offered as a place to choose. */
function offered(name: string): boolean {
  return !name.startsWith(".") && !isSystemJunkDirectory(name) && !name.endsWith(".app");
}

/** A typed path as the picker means it: `~` is the home folder, and the rest is resolved. */
function resolveTyped(typed: string): string {
  const home = os.homedir();

  if (typed === "~") {
    return home;
  }

  if (typed.startsWith("~/") || typed.startsWith(`~${path.sep}`)) {
    return path.join(home, typed.slice(2));
  }

  return path.resolve(typed);
}

/** The folders inside `typed`, sorted as Finder sorts them; a symlink to a folder counts. */
export async function listFolder(typed: string): Promise<FolderListing> {
  const folder = resolveTyped(typed);
  const parent = path.dirname(folder) === folder ? null : path.dirname(folder);

  try {
    const entries = await readdir(folder, { withFileTypes: true });

    const folders = await Promise.all(
      entries
        .filter((entry) => offered(entry.name))
        .map(async (entry) => {
          const full = path.join(folder, entry.name);

          const isFolder =
            entry.isDirectory() ||
            (entry.isSymbolicLink() &&
              ((await stat(full).catch(() => null))?.isDirectory() ?? false));

          return isFolder ? { name: entry.name, path: full } : null;
        }),
    );

    return {
      ok: true,
      path: folder,
      parent,
      folders: folders
        .filter((entry) => entry !== null)
        .sort((left, right) => collator.compare(left.name, right.name)),
    };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : null;

    return {
      ok: false,
      path: folder,
      parent,
      message:
        code === "ENOENT"
          ? "There is no folder here."
          : code === "ENOTDIR"
            ? "This is a file, not a folder."
            : code === "EACCES" || code === "EPERM"
              ? "Tidy is not allowed to read this folder."
              : error instanceof Error
                ? error.message
                : String(error),
    };
  }
}

/** Mounted drives: `/Volumes` on macOS, drive letters on Windows, `/media` and `/mnt` on Linux. */
async function listVolumes(): Promise<FolderPlace[]> {
  if (process.platform === "win32") {
    return "CDEFGHIJKLMNOPQRSTUVWXYZ"
      .split("")
      .filter((letter) => existsSync(`${letter}:\\`))
      .map((letter) => ({ kind: "volume", label: `${letter}:`, path: `${letter}:\\` }));
  }

  const user = os.userInfo().username;

  const parents =
    process.platform === "darwin" ? ["/Volumes"] : [`/media/${user}`, `/run/media/${user}`, "/mnt"];

  const volumes: FolderPlace[] = [];

  for (const parent of parents) {
    const names = await readdir(parent).catch(() => []);

    for (const name of names) {
      if (name.startsWith(".") || name.startsWith("com.apple.")) {
        continue;
      }

      // The startup disk shows in /Volumes as a link to `/`.
      const target = await realpath(path.join(parent, name)).catch(() => null);

      if (target !== null && (await stat(target).catch(() => null))?.isDirectory()) {
        volumes.push({ kind: "volume", label: name, path: target });
      }
    }
  }

  return volumes.sort((left, right) => collator.compare(left.label, right.label));
}

export async function folderPlaces(): Promise<FolderPlaces> {
  const home = os.homedir();

  const standard: FolderPlace[] = [
    { kind: "home", label: path.basename(home) || "Home", path: home },
    { kind: "desktop", label: "Desktop", path: app.getPath("desktop") },
    { kind: "documents", label: "Documents", path: app.getPath("documents") },
    { kind: "downloads", label: "Downloads", path: app.getPath("downloads") },
    { kind: "pictures", label: "Pictures", path: app.getPath("pictures") },
    {
      kind: "videos",
      label: process.platform === "darwin" ? "Movies" : "Videos",
      path: app.getPath("videos"),
    },
  ];

  return {
    home,
    separator: path.sep,
    places: standard.filter((place) => existsSync(place.path)),
    volumes: await listVolumes(),
  };
}
