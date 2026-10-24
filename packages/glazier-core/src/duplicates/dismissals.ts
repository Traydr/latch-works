import { z } from "zod";

import type { CatalogDatabase } from "../catalog/database.js";
import { rootsOfFiles } from "../catalog/files.js";
import { type FileId, FileIdSchema, type PlanId } from "../contract.js";

const DismissalRowSchema = z.object({ id: z.number(), file_id: FileIdSchema });

/**
 * The owner's word that some files are not duplicates of each other. A set is dismissed when all
 * its files fall inside one dismissal: a set that gains a file comes back, one that loses files
 * stays hidden. Dismissals a draft plan records count only once the plan is applied.
 */
export class Dismissals {
  private readonly filesById = new Map<number, Set<FileId>>();

  private readonly idsByFile = new Map<FileId, number[]>();

  static load(db: CatalogDatabase): Dismissals {
    const dismissals = new Dismissals();

    const rows = db.all(
      `SELECT d.id, df.file_id FROM duplicate_dismissals d
        JOIN duplicate_dismissal_files df ON df.dismissal_id = d.id
        LEFT JOIN plans p ON p.id = d.plan_id
        WHERE d.plan_id IS NULL OR p.status != 'draft'
        ORDER BY d.id`,
      DismissalRowSchema,
    );

    for (const row of rows) {
      const files = dismissals.filesById.get(row.id) ?? new Set<FileId>();
      files.add(row.file_id);
      dismissals.filesById.set(row.id, files);

      const ids = dismissals.idsByFile.get(row.file_id) ?? [];
      ids.push(row.id);
      dismissals.idsByFile.set(row.file_id, ids);
    }

    return dismissals;
  }

  /** The dismissal that covers every one of these files, or null. */
  covering(fileIds: readonly FileId[]): number | null {
    const [first] = fileIds;

    if (first === undefined) {
      return null;
    }

    for (const id of this.idsByFile.get(first) ?? []) {
      const files = this.filesById.get(id);

      if (files && fileIds.every((fileId) => files.has(fileId))) {
        return id;
      }
    }

    return null;
  }
}

/** Records that these files are not duplicates of each other, optionally as part of a plan. */
export function addDismissal(
  db: CatalogDatabase,
  request: { fileIds: readonly FileId[]; planId: PlanId | null },
): number {
  const fileIds = [...new Set(request.fileIds)];
  const roots = rootsOfFiles(db, fileIds);

  const inserted = db.run(
    "INSERT INTO duplicate_dismissals (root_id, plan_id, created_at) VALUES ($root, $plan, $now)",
    {
      $root: roots.length === 1 ? (roots[0] ?? null) : null,
      $plan: request.planId,
      $now: Date.now(),
    },
  );

  for (const fileId of fileIds) {
    db.run(
      `INSERT INTO duplicate_dismissal_files (dismissal_id, file_id)
        SELECT $dismissal, id FROM files WHERE id = $file`,
      { $dismissal: inserted.lastInsertRowid, $file: fileId },
    );
  }

  return inserted.lastInsertRowid;
}

export function removeDismissal(db: CatalogDatabase, dismissalId: number): void {
  db.run("DELETE FROM duplicate_dismissals WHERE id = $id", { $id: dismissalId });
}

/** Forgets the dismissals a plan recorded, when the plan is undone. */
export function removePlanDismissals(db: CatalogDatabase, planId: PlanId): void {
  db.run("DELETE FROM duplicate_dismissals WHERE plan_id = $plan", { $plan: planId });
}
