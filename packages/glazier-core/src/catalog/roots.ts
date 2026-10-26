import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  type Root,
  type RootId,
  RootIdSchema,
  type Settings,
  SettingsSchema,
} from "../contract.js";
import type { CatalogDatabase } from "./database.js";

const RootRowSchema = z.object({
  id: RootIdSchema,
  path: z.string(),
  added_at: z.number(),
  last_scan_at: z.number().nullable(),
  file_count: z.number(),
  total_bytes: z.number().nullable(),
});

export function listRoots(db: CatalogDatabase): Root[] {
  return db
    .all(
      `SELECT r.id, r.path, r.added_at, r.last_scan_at,
        (SELECT COUNT(*) FROM files f WHERE f.root_id = r.id) AS file_count,
        (SELECT SUM(size) FROM files f WHERE f.root_id = r.id) AS total_bytes
        FROM roots r ORDER BY r.path COLLATE NOCASE`,
      RootRowSchema,
    )
    .map((row) => ({
      id: row.id,
      path: row.path,
      name: path.basename(row.path) || row.path,
      addedAt: row.added_at,
      lastScanAt: row.last_scan_at,
      fileCount: row.file_count,
      totalBytes: row.total_bytes ?? 0,
    }));
}

class RootError extends Error {
  override readonly name = "RootError";
}

function contains(outer: string, inner: string): boolean {
  const relative = path.relative(outer, inner);

  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Adds a folder as a root. Roots never nest: a file must belong to exactly one, so every
 * holding folder, catalog row and Lockstep path is unambiguous.
 */
export async function addRoot(db: CatalogDatabase, folder: string): Promise<Root> {
  const resolved = await realpath(path.resolve(folder)).catch(() => {
    throw new RootError(`${folder} does not exist.`);
  });

  if (!(await stat(resolved)).isDirectory()) {
    throw new RootError(`${resolved} is not a folder.`);
  }

  for (const existing of listRoots(db)) {
    if (contains(existing.path, resolved) || contains(resolved, existing.path)) {
      throw new RootError(`${resolved} overlaps the root ${existing.path}.`);
    }
  }

  const inserted = db.run("INSERT INTO roots (path, added_at) VALUES ($path, $now)", {
    $path: resolved,
    $now: Date.now(),
  });

  const id = RootIdSchema.parse(inserted.lastInsertRowid);
  const root = listRoots(db).find((candidate) => candidate.id === id);

  if (!root) {
    throw new RootError("The root was not saved.");
  }

  return root;
}

/** Forgets a root and its catalog. Files on disk, including its holding folder, are untouched. */
export function removeRoot(db: CatalogDatabase, rootId: RootId): void {
  db.run("DELETE FROM roots WHERE id = $id", { $id: rootId });
}

export function markScanned(db: CatalogDatabase, rootId: RootId): void {
  db.run("UPDATE roots SET last_scan_at = $now WHERE id = $id", { $now: Date.now(), $id: rootId });
}

const DEFAULT_SETTINGS: Settings = {
  preferredFolders: [],
  similarity: "balanced",
  spotVariants: false,
  reencodeQuality: "high",
  autoAnalyze: true,
};

const SettingsRowSchema = z.object({ value: z.string() });

const FolderListSchema = SettingsSchema.shape.preferredFolders;

/**
 * A stored settings row from any version: each field falls back to its default on its own, and
 * the folders older versions called protected become the preferred folders.
 */
const StoredSettingsSchema = z.object({
  preferredFolders: FolderListSchema.optional().catch(undefined),
  protectedFolders: FolderListSchema.optional().catch(undefined),
  similarity: SettingsSchema.shape.similarity.catch(DEFAULT_SETTINGS.similarity),
  spotVariants: SettingsSchema.shape.spotVariants.catch(DEFAULT_SETTINGS.spotVariants),
  reencodeQuality: SettingsSchema.shape.reencodeQuality.catch(DEFAULT_SETTINGS.reencodeQuality),
  autoAnalyze: SettingsSchema.shape.autoAnalyze.catch(DEFAULT_SETTINGS.autoAnalyze),
});

export function readSettings(db: CatalogDatabase): Settings {
  const row = db.get("SELECT value FROM settings WHERE key = 'settings'", SettingsRowSchema);

  if (!row) {
    return DEFAULT_SETTINGS;
  }

  let stored: z.infer<typeof StoredSettingsSchema>;

  try {
    stored = StoredSettingsSchema.parse(JSON.parse(row.value));
  } catch {
    return DEFAULT_SETTINGS;
  }

  return {
    preferredFolders: stored.preferredFolders ?? stored.protectedFolders ?? [],
    similarity: stored.similarity,
    spotVariants: stored.spotVariants,
    reencodeQuality: stored.reencodeQuality,
    autoAnalyze: stored.autoAnalyze,
  };
}

export function writeSettings(db: CatalogDatabase, settings: Settings): Settings {
  db.run(
    `INSERT INTO settings (key, value) VALUES ('settings', $value)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    { $value: JSON.stringify(settings) },
  );

  return settings;
}
