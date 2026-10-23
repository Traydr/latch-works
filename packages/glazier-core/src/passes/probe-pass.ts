import { z } from "zod";

import type { SqlParams } from "../catalog/database.js";
import { PROBE_VERSION, toAbsolutePath } from "../catalog/file-rows.js";
import { FileIdSchema, FileKindSchema } from "../contract.js";
import { probeImage } from "../media/image-probe.js";
import { toError } from "../media/run-tool.js";
import { probeVideo } from "../media/video-probe.js";
import { animationFrameTimes } from "../similarity/fingerprint.js";
import { forEachConcurrent, type PassContext, rootClause } from "./context.js";

const PendingSchema = z.object({
  id: FileIdSchema,
  root_path: z.string(),
  rel_path: z.string(),
  kind: FileKindSchema,
});

/** Formats sharp's prebuilt libvips cannot decode, so they are reported rather than probed. */
const UNDECODABLE_IMAGE_FORMATS = "'heic', 'psd', 'svg'";

/**
 * Reads dimensions, frame counts, codecs, duration and audio tracks for every media file not
 * probed yet. A file that fails records why, which is what the "won't decode" finding lists.
 */
export async function runProbePass(context: PassContext): Promise<void> {
  const params: SqlParams = { $version: PROBE_VERSION };

  const pending = context.db.all(
    `SELECT f.id, r.path AS root_path, f.rel_path, f.kind
      FROM files f JOIN roots r ON r.id = f.root_id
      WHERE f.probe_version < $version AND f.is_junk = 0 AND f.size > 0
        AND (f.kind = 'image' AND COALESCE(f.format, '') NOT IN (${UNDECODABLE_IMAGE_FORMATS})
          OR f.kind = 'video')
        ${rootClause(context, params)}`,
    PendingSchema,
    params,
  );

  const { ffprobePath, sharp } = context.toolkit;
  let done = 0;

  await forEachConcurrent(pending, 6, context.checkpoint, async (file) => {
    const absPath = toAbsolutePath(file.root_path, file.rel_path);

    try {
      if (file.kind === "image") {
        const probe = await probeImage(sharp, absPath);
        const times = animationFrameTimes(probe.frameDelaysMs, probe.frames);

        context.db.run(
          `UPDATE files SET probe_version = $version, probe_error = NULL, width = $width,
            height = $height, frames = $frames, has_alpha = $alpha, duration_ms = $duration
            WHERE id = $id`,
          {
            $version: PROBE_VERSION,
            $width: probe.width,
            $height: probe.height,
            $frames: probe.frames,
            $alpha: probe.hasAlpha ? 1 : 0,
            $duration: probe.frames > 1 ? times.reduce((sum, time) => sum + time, 0) : null,
            $id: file.id,
          },
        );
      } else if (ffprobePath !== null) {
        const probe = await probeVideo(ffprobePath, absPath);

        context.db.run(
          `UPDATE files SET probe_version = $version, probe_error = NULL, width = $width,
            height = $height, duration_ms = $duration, video_codec = $video, audio_codec = $audio,
            audio_streams = $streams, bitrate = $bitrate,
            kind = CASE WHEN $video IS NULL AND $streams > 0 THEN 'audio' ELSE kind END
            WHERE id = $id`,
          {
            $version: PROBE_VERSION,
            $width: probe.width,
            $height: probe.height,
            $duration: probe.durationMs,
            $video: probe.videoCodec,
            $audio: probe.audioCodec,
            $streams: probe.audioStreams,
            $bitrate: probe.bitrate,
            $id: file.id,
          },
        );
      }
    } catch (error) {
      context.db.run(
        "UPDATE files SET probe_version = $version, probe_error = $error WHERE id = $id",
        { $version: PROBE_VERSION, $error: toError(error).message.slice(0, 500), $id: file.id },
      );
    }

    done += 1;

    if (done % 50 === 0 || done === pending.length) {
      context.progress({ done, total: pending.length, label: "Reading media details" });
    }
  });
}
