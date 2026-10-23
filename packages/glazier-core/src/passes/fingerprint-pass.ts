import { z } from "zod";

import type { SqlParams } from "../catalog/database.js";
import { FINGERPRINT_VERSION, toAbsolutePath } from "../catalog/file-rows.js";
import { FileIdSchema, FileKindSchema } from "../contract.js";
import { probeImage } from "../media/image-probe.js";
import { toError } from "../media/run-tool.js";
import {
  animationFrameTimes,
  fingerprintAnimation,
  fingerprintStill,
  fingerprintVideo,
  formatFingerprint,
} from "../similarity/fingerprint.js";
import { forEachConcurrent, type PassContext, rootClause } from "./context.js";

const PendingSchema = z.object({
  id: FileIdSchema,
  root_path: z.string(),
  rel_path: z.string(),
  kind: FileKindSchema,
  frames: z.number().nullable(),
  duration_ms: z.number().nullable(),
});

/** Files the similarity pass can fingerprint, as a SQL condition on `files f`. */
export const FINGERPRINTABLE_SQL = `f.is_junk = 0 AND f.probe_version > 0 AND f.probe_error IS NULL
  AND f.width IS NOT NULL AND f.height IS NOT NULL
  AND (f.kind = 'image' OR (f.kind = 'video' AND COALESCE(f.duration_ms, 0) > 0))`;

/**
 * Fingerprints every image and video not fingerprinted yet: a perceptual hash for stills, five
 * frame hashes for videos and animations. This decodes every picture, so it only runs when asked.
 */
export async function runFingerprintPass(context: PassContext): Promise<void> {
  const params: SqlParams = { $version: FINGERPRINT_VERSION };

  const pending = context.db.all(
    `SELECT f.id, r.path AS root_path, f.rel_path, f.kind, f.frames, f.duration_ms
      FROM files f JOIN roots r ON r.id = f.root_id
      WHERE f.fingerprint_version < $version AND ${FINGERPRINTABLE_SQL}
        ${rootClause(context, params)}
      ORDER BY f.kind, f.id`,
    PendingSchema,
    params,
  );

  const { ffmpegPath, sharp } = context.toolkit;
  let done = 0;

  await forEachConcurrent(pending, 4, context.checkpoint, async (file) => {
    const absPath = toAbsolutePath(file.root_path, file.rel_path);

    try {
      let fingerprint: string | null = null;

      if (file.kind === "image" && (file.frames ?? 1) > 1) {
        const probe = await probeImage(sharp, absPath);
        const times = animationFrameTimes(probe.frameDelaysMs, probe.frames);
        fingerprint = formatFingerprint(await fingerprintAnimation(sharp, absPath, times));
      } else if (file.kind === "image") {
        fingerprint = formatFingerprint(await fingerprintStill(sharp, absPath));
      } else if (ffmpegPath !== null && file.duration_ms !== null) {
        fingerprint = formatFingerprint(
          await fingerprintVideo(ffmpegPath, absPath, file.duration_ms, context.signal),
        );
      }

      if (fingerprint !== null) {
        context.db.run(
          `UPDATE files SET fingerprint_version = $version, fingerprint = $print,
            fingerprint_error = NULL WHERE id = $id`,
          { $version: FINGERPRINT_VERSION, $print: fingerprint, $id: file.id },
        );
      }
    } catch (error) {
      if (context.signal.aborted) {
        throw error;
      }

      context.db.run(
        `UPDATE files SET fingerprint_version = $version, fingerprint = NULL,
          fingerprint_error = $error WHERE id = $id`,
        {
          $version: FINGERPRINT_VERSION,
          $error: toError(error).message.slice(0, 500),
          $id: file.id,
        },
      );
    }

    done += 1;

    if (done % 20 === 0 || done === pending.length) {
      context.progress({
        done,
        total: pending.length,
        label: "Fingerprinting pictures and videos",
      });
    }
  });
}
