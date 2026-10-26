import { z } from "zod";

import type { CatalogDatabase } from "../catalog/database.js";
import { toAbsolutePath } from "../catalog/file-rows.js";
import { type FileId, FileIdSchema, RootIdSchema } from "../contract.js";
import { toError } from "../media/run-tool.js";
import { DETAIL_VERSION, detailOfStill } from "../similarity/detail.js";
import {
  forEachConcurrent,
  type PassContext,
  SAME_ROW_SQL,
  sameRowParams,
  stillSelected,
} from "./context.js";

/** A print row that still describes its file: this version, made from the bytes there now. */
const CURRENT_DETAIL_JOIN = `file_details d ON d.file_id = f.id AND d.version = $version
  AND d.size = f.size AND d.mtime_ms = f.mtime_ms`;

const PendingSchema = z.object({
  id: FileIdSchema,
  root_id: RootIdSchema,
  root_path: z.string(),
  rel_path: z.string(),
  size: z.number(),
  mtime_ms: z.number(),
});

/**
 * Makes detail prints for those of `fileIds` that are stills without a current one. Spot
 * variants needs them only for members of similar sets, so the engine passes those, not every
 * picture. Each file is checked against the catalog again before and after, as other passes do.
 */
export async function runDetailPass(
  context: PassContext,
  fileIds: readonly FileId[],
): Promise<void> {
  const pending = context.db.all(
    `SELECT f.id, f.root_id, r.path AS root_path, f.rel_path, f.size, f.mtime_ms
      FROM files f JOIN roots r ON r.id = f.root_id
      LEFT JOIN ${CURRENT_DETAIL_JOIN}
      WHERE f.id IN (SELECT value FROM json_each($ids)) AND f.fingerprint LIKE 's:%'
        AND d.file_id IS NULL
      ORDER BY f.id`,
    PendingSchema,
    { $ids: JSON.stringify(fileIds), $version: DETAIL_VERSION },
  );

  let done = 0;

  await forEachConcurrent(pending, 4, context.checkpoint, async (file) => {
    if (stillSelected(context, file)) {
      await printFile(context, file);
    }

    done += 1;

    if (done % 20 === 0 || done === pending.length) {
      context.progress({ done, total: pending.length, label: "Comparing similar versions" });
    }
  });
}

/** Records a file's print, or why it has none, so a file that fails is not tried again. */
async function printFile(context: PassContext, file: z.infer<typeof PendingSchema>): Promise<void> {
  let print: Uint8Array | null = null;
  let error: string | null = null;

  try {
    print = await detailOfStill(
      context.toolkit.sharp,
      toAbsolutePath(file.root_path, file.rel_path),
    );
  } catch (cause) {
    if (context.signal.aborted) {
      throw cause;
    }

    error = toError(cause).message.slice(0, 500);
  }

  context.db.run(
    `INSERT INTO file_details (file_id, version, size, mtime_ms, print, error)
      SELECT $id, $version, $size, $mtime_ms, $print, $error
        WHERE EXISTS (SELECT 1 FROM files WHERE ${SAME_ROW_SQL})
      ON CONFLICT (file_id) DO UPDATE SET version = excluded.version, size = excluded.size,
        mtime_ms = excluded.mtime_ms, print = excluded.print, error = excluded.error`,
    { ...sameRowParams(file), $version: DETAIL_VERSION, $print: print, $error: error },
  );
}

const DetailRowSchema = z.object({
  file_id: FileIdSchema,
  print: z.instanceof(Uint8Array).nullable(),
});

/**
 * The current prints of these files. A file whose print failed maps to null; one not printed yet
 * is missing.
 */
export function loadDetails(
  db: CatalogDatabase,
  fileIds: readonly FileId[],
): Map<FileId, Uint8Array | null> {
  const rows = db.all(
    `SELECT d.file_id, d.print FROM files f JOIN ${CURRENT_DETAIL_JOIN}
      WHERE f.id IN (SELECT value FROM json_each($ids))`,
    DetailRowSchema,
    { $ids: JSON.stringify(fileIds), $version: DETAIL_VERSION },
  );

  return new Map(rows.map((row) => [row.file_id, row.print]));
}
