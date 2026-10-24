import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  rename,
  rmdir,
  stat,
  unlink,
  utimes,
} from "node:fs/promises";
import path from "node:path";

import { GLAZIER_HOLDING_DIRECTORY_NAME } from "@latch-works/media-domain";
import { z } from "zod";

import type { CatalogDatabase } from "../catalog/database.js";
import { toAbsolutePath } from "../catalog/file-rows.js";
import {
  type HoldingId,
  HoldingIdSchema,
  type HoldingItem,
  type HoldingList,
  type PlanId,
  PlanIdSchema,
  type RootId,
  RootIdSchema,
} from "../contract.js";

/** Where holding lived before it moved out of the root: `<root>/.glazier-holding`. */
function legacyHoldingPath(rootPath: string): string {
  return path.join(rootPath, GLAZIER_HOLDING_DIRECTORY_NAME);
}

/** A root's own folder inside a holding area: `12-Photos`, readable when someone looks. */
function rootFolderName(root: HoldingRoot): string {
  const name = path.basename(root.path).replace(/[^\p{L}\p{N} ._-]+/gu, "_") || "root";

  return `${root.id}-${name}`;
}

/** The folder a path's volume is mounted at: the highest ancestor still on the same device. */
async function mountPointOf(target: string): Promise<string> {
  const device = (await stat(target)).dev;
  let current = path.resolve(target);

  for (;;) {
    const parent = path.dirname(current);

    if (parent === current) {
      return current;
    }

    const parentStat = await stat(parent).catch(() => null);

    if (parentStat?.dev !== device) {
      return current;
    }

    current = parent;
  }
}

export interface HoldingRoot {
  id: RootId;
  path: string;
}

/**
 * Where each root's held files go, always outside the root, so nothing that syncs or indexes the
 * root (Lockstep, Frame View, a cloud drive) ever sees them. That is Glazier's data folder when it
 * shares the root's volume, so holding a file is a rename. A root on another volume holds in a
 * `.glazier-holding` folder at the top of that volume instead, still a rename; only a root that is
 * a whole volume holds in the data folder, by copying across.
 */
export class HoldingPlaces {
  private readonly folders = new Map<RootId, Promise<string>>();

  constructor(private readonly dataDir: string) {}

  folderFor(root: HoldingRoot): Promise<string> {
    const known = this.folders.get(root.id);

    if (known !== undefined) {
      return known;
    }

    const chosen = this.choose(root);
    this.folders.set(root.id, chosen);
    chosen.catch(() => this.folders.delete(root.id));

    return chosen;
  }

  private async choose(root: HoldingRoot): Promise<string> {
    const inDataDir = path.join(this.dataDir, "holding", rootFolderName(root));
    await mkdir(this.dataDir, { recursive: true });

    const [dataStat, rootStat] = await Promise.all([stat(this.dataDir), stat(root.path)]);

    if (dataStat.dev === rootStat.dev) {
      return inDataDir;
    }

    const mountPoint = await mountPointOf(root.path);

    if (path.resolve(mountPoint) === path.resolve(root.path)) {
      return inDataDir;
    }

    const onVolume = path.join(mountPoint, GLAZIER_HOLDING_DIRECTORY_NAME, rootFolderName(root));

    try {
      await mkdir(onVolume, { recursive: true });

      return onVolume;
    } catch {
      return inDataDir;
    }
  }
}

/** One folder per plan run, named so the newest sort last: `2026-10-24_093012-plan-12`. */
export function holdingBatchName(planId: PlanId | null, now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");

  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(
    now.getHours(),
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  return planId === null ? `${stamp}-manual` : `${stamp}-plan-${planId}`;
}

/**
 * Moves a file, by rename when source and target share a volume and by copy-then-delete
 * otherwise, keeping its modification time either way.
 */
export async function moveFile(source: string, target: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });

  try {
    await rename(source, target);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EXDEV") {
      throw error;
    }

    const sourceStat = await stat(source);
    await copyFile(source, target);
    await utimes(target, sourceStat.atime, sourceStat.mtime);
    await unlink(source);
  }
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);

    return true;
  } catch {
    return false;
  }
}

/** A free name for `target`: itself, or `name (2).ext`, `name (3).ext`, … beside it. */
async function freePath(target: string): Promise<string> {
  if (!(await pathExists(target))) {
    return target;
  }

  const parsed = path.parse(target);

  for (let suffix = 2; ; suffix += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name} (${suffix})${parsed.ext}`);

    if (!(await pathExists(candidate))) {
      return candidate;
    }
  }
}

export interface HoldRequest {
  rootId: RootId;
  rootPath: string;
  relPath: string;
  batch: string;
  planId: PlanId | null;
  reason: string;
}

export interface HoldingStore {
  db: CatalogDatabase;
  places: HoldingPlaces;
}

/** Moves a file into its root's holding folder, keeping its path, and records where it went. */
export async function holdFile(store: HoldingStore, request: HoldRequest): Promise<HoldingId> {
  const source = toAbsolutePath(request.rootPath, request.relPath);
  const fileStat = await stat(source);
  const folder = await store.places.folderFor({ id: request.rootId, path: request.rootPath });
  const batchPath = path.join(folder, request.batch);
  const target = await freePath(path.join(batchPath, ...request.relPath.split("/")));

  await moveFile(source, target);

  const inserted = store.db.run(
    `INSERT INTO holding (root_id, original_rel, hold_rel, hold_path, batch, batch_path, size,
        held_at, plan_id, reason)
      VALUES ($root, $original, $hold, $holdPath, $batch, $batchPath, $size, $now, $plan, $reason)`,
    {
      $root: request.rootId,
      $original: request.relPath,
      $hold: path.relative(folder, target).split(path.sep).join("/"),
      $holdPath: target,
      $batch: request.batch,
      $batchPath: batchPath,
      $size: fileStat.size,
      $now: Date.now(),
      $plan: request.planId,
      $reason: request.reason,
    },
  );

  return HoldingIdSchema.parse(inserted.lastInsertRowid);
}

const HoldingRecordSchema = z.object({
  id: HoldingIdSchema,
  root_id: RootIdSchema,
  root_path: z.string(),
  original_rel: z.string(),
  hold_path: z.string(),
  batch: z.string(),
  batch_path: z.string(),
  size: z.number(),
  held_at: z.number(),
  plan_id: PlanIdSchema.nullable(),
  reason: z.string(),
  state: z.enum(["held", "restored", "emptied"]),
});

type HoldingRecord = z.infer<typeof HoldingRecordSchema>;

const HOLDING_COLUMNS = `h.id, h.root_id, r.path AS root_path, h.original_rel, h.hold_path, h.batch,
  h.batch_path, h.size, h.held_at, h.plan_id, h.reason, h.state`;

function toHoldingItem(record: HoldingRecord): HoldingItem {
  return {
    id: record.id,
    rootId: record.root_id,
    originalPath: toAbsolutePath(record.root_path, record.original_rel),
    holdPath: record.hold_path,
    size: record.size,
    heldAt: record.held_at,
    planId: record.plan_id,
    reason: record.reason,
  };
}

const HoldingTotalsSchema = z.object({ total: z.number(), bytes: z.number().nullable() });

export function listHolding(
  db: CatalogDatabase,
  page: { rootId: RootId; offset: number; limit: number },
): HoldingList {
  const totals = db.get(
    "SELECT COUNT(*) AS total, SUM(size) AS bytes FROM holding WHERE root_id = $root AND state = 'held'",
    HoldingTotalsSchema,
    { $root: page.rootId },
  );

  const records = db.all(
    `SELECT ${HOLDING_COLUMNS} FROM holding h JOIN roots r ON r.id = h.root_id
      WHERE h.root_id = $root AND h.state = 'held'
      ORDER BY h.held_at DESC, h.id DESC LIMIT $limit OFFSET $offset`,
    HoldingRecordSchema,
    { $root: page.rootId, $limit: page.limit, $offset: page.offset },
  );

  return {
    total: totals?.total ?? 0,
    totalBytes: totals?.bytes ?? 0,
    items: records.map(toHoldingItem),
  };
}

function getHoldingRecord(db: CatalogDatabase, id: HoldingId): HoldingRecord | null {
  return db.get(
    `SELECT ${HOLDING_COLUMNS} FROM holding h JOIN roots r ON r.id = h.root_id WHERE h.id = $id`,
    HoldingRecordSchema,
    { $id: id },
  );
}

class RestoreConflictError extends Error {
  override readonly name = "RestoreConflictError";
}

/**
 * Moves a held file back to where it came from. Refuses when something now sits at the original
 * path, so a restore never overwrites.
 */
export async function restoreHeld(db: CatalogDatabase, id: HoldingId): Promise<HoldingRecord> {
  const record = getHoldingRecord(db, id);

  if (record?.state !== "held") {
    throw new Error("That item is no longer in holding.");
  }

  const original = toAbsolutePath(record.root_path, record.original_rel);

  if (await pathExists(original)) {
    throw new RestoreConflictError(`Something already exists at ${record.original_rel}.`);
  }

  await moveFile(record.hold_path, original);
  db.run("UPDATE holding SET state = 'restored' WHERE id = $id", { $id: id });

  return record;
}

const BatchPathSchema = z.object({ batch_path: z.string() });

/** The holding batch folders of a root that still hold something, as absolute paths. */
export function heldBatchPaths(db: CatalogDatabase, rootId: RootId): string[] {
  return db
    .all(
      `SELECT DISTINCT batch_path FROM holding WHERE root_id = $root AND state = 'held'
        ORDER BY batch_path`,
      BatchPathSchema,
      { $root: rootId },
    )
    .map(({ batch_path }) => batch_path);
}

/**
 * Records that whole batch folders went to the system Trash. Restored items had already left
 * those folders, so everything still marked held in them is now gone. Only folders this catalog
 * handed out count.
 */
export async function markBatchesEmptied(
  db: CatalogDatabase,
  request: { rootId: RootId; batchPaths: readonly string[] },
): Promise<number> {
  let emptied = 0;

  for (const batchPath of request.batchPaths) {
    emptied += db.run(
      `UPDATE holding SET state = 'emptied'
        WHERE root_id = $root AND batch_path = $batch AND state = 'held'`,
      { $root: request.rootId, $batch: batchPath },
    ).changes;

    // Leave no empty holding folder behind once its last batch is gone.
    await rmdir(path.dirname(batchPath)).catch(() => undefined);
  }

  return emptied;
}

const UnplacedRowSchema = z.object({
  id: HoldingIdSchema,
  root_path: z.string(),
  hold_rel: z.string(),
  batch: z.string(),
});

const LegacyHeldRowSchema = z.object({
  id: HoldingIdSchema,
  root_id: RootIdSchema,
  root_path: z.string(),
  hold_path: z.string(),
  batch: z.string(),
  batch_path: z.string(),
});

/** Removes the empty folders under `folder`, deepest first, and `folder` itself if it empties. */
async function pruneEmptyFolders(folder: string): Promise<void> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => null);

  if (entries === null) {
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      await pruneEmptyFolders(path.join(folder, entry.name));
    }
  }

  await rmdir(folder).catch(() => undefined);
}

export interface RelocationResult {
  moved: number;
  /** Held files that were no longer in the old holding folder, now recorded as gone. */
  missing: number;
  /** Files that could not be moved; they stay where they were and are tried again next start. */
  failed: number;
}

/**
 * Moves what catalogs from before held inside their roots (`<root>/.glazier-holding`) to where
 * holding lives now, and records each file's new place. First every older row gets its old place
 * written down, so each row has one. A root whose folder is not there (an unplugged drive) keeps
 * its files where they are until a later start; a held file missing from a root that is there was
 * deleted outside Glazier, and is recorded as gone since it can no longer be restored.
 */
export async function relocateLegacyHolding(store: HoldingStore): Promise<RelocationResult> {
  const { db } = store;
  const result: RelocationResult = { moved: 0, missing: 0, failed: 0 };

  const unplaced = db.all(
    `SELECT h.id, r.path AS root_path, h.hold_rel, h.batch
      FROM holding h JOIN roots r ON r.id = h.root_id WHERE h.hold_path IS NULL`,
    UnplacedRowSchema,
  );

  for (const row of unplaced) {
    db.run("UPDATE holding SET hold_path = $hold, batch_path = $batch WHERE id = $id", {
      $hold: toAbsolutePath(row.root_path, row.hold_rel),
      $batch: path.join(legacyHoldingPath(row.root_path), row.batch),
      $id: row.id,
    });
  }

  const held = db.all(
    `SELECT h.id, h.root_id, r.path AS root_path, h.hold_path, h.batch, h.batch_path
      FROM holding h JOIN roots r ON r.id = h.root_id WHERE h.state = 'held' ORDER BY h.id`,
    LegacyHeldRowSchema,
  );

  const pruned = new Set<string>();

  for (const row of held) {
    const legacyFolder = legacyHoldingPath(row.root_path);

    if (!row.batch_path.startsWith(legacyFolder + path.sep)) {
      continue;
    }

    if (!(await pathExists(row.root_path))) {
      continue;
    }

    pruned.add(legacyFolder);

    const folder = await store.places.folderFor({ id: row.root_id, path: row.root_path });
    const batchPath = path.join(folder, row.batch);

    if (!(await pathExists(row.hold_path))) {
      db.run("UPDATE holding SET state = 'emptied' WHERE id = $id", { $id: row.id });
      result.missing += 1;

      continue;
    }

    const target = await freePath(
      path.join(batchPath, path.relative(row.batch_path, row.hold_path)),
    );

    try {
      await moveFile(row.hold_path, target);
    } catch {
      result.failed += 1;

      continue;
    }

    db.run(
      `UPDATE holding SET hold_path = $hold, batch_path = $batch, hold_rel = $rel WHERE id = $id`,
      {
        $hold: target,
        $batch: batchPath,
        $rel: path.relative(folder, target).split(path.sep).join("/"),
        $id: row.id,
      },
    );
    result.moved += 1;
  }

  for (const folder of pruned) {
    await pruneEmptyFolders(folder);
  }

  return result;
}
