import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import type { KnownFolder, ModeId } from "../shared/shell";

const RootPathRowSchema = z.object({ path: z.string() });

/** The folders Tidy tidies, read from Glazier's catalog without starting the engine. */
export function glazierRoots(glazierDir: string): string[] {
  const file = path.join(glazierDir, "catalog.sqlite");

  if (!existsSync(file)) {
    return [];
  }

  try {
    const db = new DatabaseSync(file, { readOnly: true });

    try {
      return db
        .prepare("SELECT path FROM roots ORDER BY id")
        .all()
        .map((row) => RootPathRowSchema.parse(row).path);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/** Where each mode keeps its folders, read fresh each time the window asks. */
export interface FolderSources {
  view: () => string | null;
  tidy: () => string[];
  sync: () => string[];
  /** The folders the first start found in the old apps. */
  migrated: () => string[];
}

/** Every folder a mode works on, with the modes that use it, in the order first found. */
export function knownFolders(sources: FolderSources): KnownFolder[] {
  const byPath = new Map<string, Set<ModeId>>();

  const add = (folders: readonly string[], mode: ModeId | null) => {
    for (const folder of folders) {
      const key = path.resolve(folder);
      const modes = byPath.get(key) ?? new Set<ModeId>();

      if (mode) {
        modes.add(mode);
      }

      byPath.set(key, modes);
    }
  };

  const viewFolder = sources.view();

  add(viewFolder ? [viewFolder] : [], "view");
  add(sources.tidy(), "tidy");
  add(sources.sync(), "sync");
  add(sources.migrated(), null);

  return [...byPath].map(([folder, modes]) => ({ path: folder, modes: [...modes] }));
}

/** Whether `target` is `folder` or inside it. */
export function isInside(folder: string, target: string): boolean {
  const relative = path.relative(path.resolve(folder), path.resolve(target));

  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
