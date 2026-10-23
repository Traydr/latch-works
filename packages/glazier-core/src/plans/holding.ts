import { copyFile, lstat, mkdir, rename, rmdir, stat, unlink, utimes } from "node:fs/promises";
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

/** The holding folder of a root. Every scanner in Latch Works skips it. */
function holdingRootPath(rootPath: string): string {
  return path.join(rootPath, GLAZIER_HOLDING_DIRECTORY_NAME);
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
 * Moves a file, by rename when source and target share a volume (always, inside one root) and
 * by copy-then-delete otherwise, keeping its modification time either way.
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

/** Moves a file into its root's holding folder, keeping its path, and records where it went. */
export async function holdFile(db: CatalogDatabase, request: HoldRequest): Promise<HoldingId> {
  const source = toAbsolutePath(request.rootPath, request.relPath);
  const fileStat = await stat(source);

  const target = await freePath(
    path.join(holdingRootPath(request.rootPath), request.batch, ...request.relPath.split("/")),
  );

  await moveFile(source, target);

  const holdRel = path.relative(request.rootPath, target).split(path.sep).join("/");

  const inserted = db.run(
    `INSERT INTO holding (root_id, original_rel, hold_rel, batch, size, held_at, plan_id, reason)
      VALUES ($root, $original, $hold, $batch, $size, $now, $plan, $reason)`,
    {
      $root: request.rootId,
      $original: request.relPath,
      $hold: holdRel,
      $batch: request.batch,
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
  hold_rel: z.string(),
  batch: z.string(),
  size: z.number(),
  held_at: z.number(),
  plan_id: PlanIdSchema.nullable(),
  reason: z.string(),
  state: z.enum(["held", "restored", "emptied"]),
});

type HoldingRecord = z.infer<typeof HoldingRecordSchema>;

const HOLDING_COLUMNS = `h.id, h.root_id, r.path AS root_path, h.original_rel, h.hold_rel, h.batch,
  h.size, h.held_at, h.plan_id, h.reason, h.state`;

function toHoldingItem(record: HoldingRecord): HoldingItem {
  return {
    id: record.id,
    rootId: record.root_id,
    originalPath: toAbsolutePath(record.root_path, record.original_rel),
    holdPath: toAbsolutePath(record.root_path, record.hold_rel),
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

  await moveFile(toAbsolutePath(record.root_path, record.hold_rel), original);
  db.run("UPDATE holding SET state = 'restored' WHERE id = $id", { $id: id });

  return record;
}

const BatchSchema = z.object({ batch: z.string() });

/** The holding batch folders of a root that still hold something, as absolute paths. */
export function heldBatchPaths(db: CatalogDatabase, rootId: RootId, rootPath: string): string[] {
  return db
    .all(
      "SELECT DISTINCT batch FROM holding WHERE root_id = $root AND state = 'held' ORDER BY batch",
      BatchSchema,
      { $root: rootId },
    )
    .map(({ batch }) => path.join(holdingRootPath(rootPath), batch));
}

/**
 * Records that whole batch folders went to the system Trash. Restored items had already left
 * those folders, so everything still marked held in them is now gone.
 */
export async function markBatchesEmptied(
  db: CatalogDatabase,
  request: { rootId: RootId; rootPath: string; batchPaths: readonly string[] },
): Promise<number> {
  const holdingRoot = holdingRootPath(request.rootPath);
  let emptied = 0;

  for (const batchPath of request.batchPaths) {
    const batch = path.relative(holdingRoot, batchPath);

    if (batch === "" || batch.startsWith("..") || batch.includes(path.sep)) {
      continue;
    }

    emptied += db.run(
      "UPDATE holding SET state = 'emptied' WHERE root_id = $root AND batch = $batch AND state = 'held'",
      { $root: request.rootId, $batch: batch },
    ).changes;
  }

  // Leave no empty holding folder behind once its last batch is gone.
  await rmdir(holdingRoot).catch(() => undefined);

  return emptied;
}
