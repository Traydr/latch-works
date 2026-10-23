import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";

import { hashFileContents } from "@latch-works/media-index";
import { z } from "zod";

import type { SqlParams } from "../catalog/database.js";
import { toAbsolutePath } from "../catalog/file-rows.js";
import { FileIdSchema } from "../contract.js";
import { wholeMs } from "../scan/walk.js";
import { forEachConcurrent, type PassContext, rootClause } from "./context.js";

/** Bytes read from each end of a file for the cheap first comparison. */
const EDGE_BYTES = 64 * 1024;

const CandidateSchema = z.object({
  id: FileIdSchema,
  root_path: z.string(),
  rel_path: z.string(),
  size: z.number(),
  mtime_ms: z.number(),
  ctime_ms: z.number(),
});

/**
 * Hashes only what could be a duplicate. Files sharing a size get a hash of their first and last
 * 64 KiB; files that still collide get a full SHA-256, the same content ID Lockstep uploads under.
 * A small file is read once and gets both. Most of an archive is never read in full.
 */
export async function runHashPass(context: PassContext): Promise<void> {
  const edgeParams: SqlParams = {};

  const edgeCandidates = context.db.all(
    `SELECT f.id, r.path AS root_path, f.rel_path, f.size, f.mtime_ms, f.ctime_ms
      FROM files f JOIN roots r ON r.id = f.root_id
      WHERE f.head_hash IS NULL AND f.is_junk = 0 AND f.size > 0
        AND f.size IN (SELECT size FROM files WHERE is_junk = 0 AND size > 0
          GROUP BY size HAVING COUNT(*) > 1)
        ${rootClause(context, edgeParams)}`,
    CandidateSchema,
    edgeParams,
  );

  let done = 0;

  await forEachConcurrent(edgeCandidates, 8, context.checkpoint, async (file) => {
    const absPath = toAbsolutePath(file.root_path, file.rel_path);

    try {
      const small = file.size <= EDGE_BYTES * 2;
      const edgeHash = await hashEdges(absPath, file.size);

      if (small) {
        // The edges cover the whole file, so read it once more as one SHA-256 and store both.
        const sha256 = await hashSmallFile(absPath);
        context.db.run("UPDATE files SET head_hash = $edge, sha256 = $sha WHERE id = $id", {
          $edge: edgeHash,
          $sha: sha256,
          $id: file.id,
        });
      } else {
        context.db.run("UPDATE files SET head_hash = $edge WHERE id = $id", {
          $edge: edgeHash,
          $id: file.id,
        });
      }
    } catch {
      // A file that cannot be read stays unhashed; the next scan tries again.
    }

    done += 1;

    if (done % 100 === 0 || done === edgeCandidates.length) {
      context.progress({ done, total: edgeCandidates.length, label: "Comparing file edges" });
    }
  });

  const fullParams: SqlParams = {};

  const fullCandidates = context.db.all(
    `SELECT f.id, r.path AS root_path, f.rel_path, f.size, f.mtime_ms, f.ctime_ms
      FROM files f JOIN roots r ON r.id = f.root_id
      WHERE f.sha256 IS NULL AND f.head_hash IS NOT NULL
        AND (f.size, f.head_hash) IN (SELECT size, head_hash FROM files
          WHERE head_hash IS NOT NULL GROUP BY size, head_hash HAVING COUNT(*) > 1)
        ${rootClause(context, fullParams)}`,
    CandidateSchema,
    fullParams,
  );

  done = 0;

  await forEachConcurrent(fullCandidates, 4, context.checkpoint, async (file) => {
    try {
      const sha256 = await hashFileContents({
        expected: { size: file.size, mtimeMs: file.mtime_ms, ctimeMs: file.ctime_ms },
        filePath: toAbsolutePath(file.root_path, file.rel_path),
        operations: {
          createReadStream,
          // The catalog's fingerprint is whole milliseconds; compare like with like.
          stat: async (filePath) => {
            const current = await stat(filePath, { bigint: true });

            return {
              size: Number(current.size),
              mtimeMs: wholeMs(current.mtimeNs),
              ctimeMs: wholeMs(current.ctimeNs),
            };
          },
        },
        signal: context.signal,
      });

      context.db.run("UPDATE files SET sha256 = $sha WHERE id = $id", {
        $sha: sha256,
        $id: file.id,
      });
    } catch {
      // Changed while hashing or unreadable: left for the next scan.
    }

    done += 1;

    if (done % 20 === 0 || done === fullCandidates.length) {
      context.progress({
        done,
        total: fullCandidates.length,
        label: "Hashing possible duplicates",
      });
    }
  });
}

async function hashEdges(filePath: string, size: number): Promise<string> {
  const handle = await open(filePath, "r");

  try {
    const hash = createHash("sha256");
    hash.update(String(size));
    const head = Buffer.alloc(Math.min(EDGE_BYTES, size));
    await handle.read(head, 0, head.length, 0);
    hash.update(head);

    if (size > EDGE_BYTES) {
      const tailLength = Math.min(EDGE_BYTES, size - EDGE_BYTES);
      const tail = Buffer.alloc(tailLength);
      await handle.read(tail, 0, tailLength, size - tailLength);
      hash.update(tail);
    }

    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function hashSmallFile(filePath: string): Promise<string> {
  const handle = await open(filePath, "r");

  try {
    return createHash("sha256")
      .update(await handle.readFile())
      .digest("hex");
  } finally {
    await handle.close();
  }
}
