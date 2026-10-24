import { z } from "zod";
import type { SqlParams } from "../catalog/database.js";
import { toAbsolutePath } from "../catalog/file-rows.js";
import { initialKind } from "../catalog/files.js";
import { FileIdSchema } from "../contract.js";
import { isExtensionMismatch, kindForFormat, sniffFile } from "../scan/sniff.js";
import { forEachConcurrent, type PassContext, rootClause } from "./context.js";

const PendingSchema = z.object({
  id: FileIdSchema,
  root_path: z.string(),
  rel_path: z.string(),
  name: z.string(),
  ext: z.string(),
  size: z.number(),
  is_junk: z.number(),
});

/** Reads the first bytes of every file not yet identified and records its real format. */
export async function runSniffPass(context: PassContext): Promise<void> {
  const params: SqlParams = {};

  const pending = context.db.all(
    `SELECT f.id, r.path AS root_path, f.rel_path, f.name, f.ext, f.size, f.is_junk
      FROM files f JOIN roots r ON r.id = f.root_id
      WHERE f.format IS NULL ${rootClause(context, params)}`,
    PendingSchema,
    params,
  );

  let done = 0;

  await forEachConcurrent(pending, 16, context.checkpoint, async (file) => {
    const format = await sniffFile(toAbsolutePath(file.root_path, file.rel_path), file.size).catch(
      () => "unknown" as const,
    );

    const junk = file.is_junk === 1;
    const unidentified = format === "unknown" || format === "empty";
    const kind = junk || unidentified ? initialKind(file.name, junk) : kindForFormat(format);

    context.db.run(
      "UPDATE files SET format = $format, kind = $kind, ext_mismatch = $mismatch WHERE id = $id",
      {
        $format: format,
        $kind: kind,
        $mismatch: !junk && isExtensionMismatch(format, file.ext) ? 1 : 0,
        $id: file.id,
      },
    );

    done += 1;

    if (done % 200 === 0 || done === pending.length) {
      context.progress({ done, total: pending.length, label: "Identifying formats" });
    }
  });
}
