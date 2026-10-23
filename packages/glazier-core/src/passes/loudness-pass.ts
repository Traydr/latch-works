import { z } from "zod";

import type { SqlParams } from "../catalog/database.js";
import { LOUDNESS_VERSION, toAbsolutePath } from "../catalog/file-rows.js";
import { FileIdSchema } from "../contract.js";
import { runTool } from "../media/run-tool.js";
import { forEachConcurrent, type PassContext, rootClause } from "./context.js";

/** Decoding the audio of a long video is fast, but a feature-length file still takes a while. */
const LOUDNESS_TIMEOUT_MS = 10 * 60 * 1000;

const PendingSchema = z.object({ id: FileIdSchema, root_path: z.string(), rel_path: z.string() });

/** The loudest sample of a video's first audio track, in dBFS, from ffmpeg's `volumedetect`. */
async function measurePeakVolume(
  ffmpegPath: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<number> {
  const result = await runTool({
    executable: ffmpegPath,
    args: [
      "-hide_banner",
      "-nostats",
      "-i",
      filePath,
      "-map",
      "0:a:0",
      "-vn",
      "-sn",
      "-dn",
      "-af",
      "volumedetect",
      "-f",
      "null",
      "-",
    ],
    timeoutMs: LOUDNESS_TIMEOUT_MS,
    signal,
  });

  const match = /max_volume:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dB/.exec(result.stderr);

  if (result.code !== 0 || !match?.[1]) {
    throw new Error("ffmpeg could not measure the audio.");
  }

  return match[1] === "-inf" ? -120 : Number(match[1]);
}

/** Measures every video with an audio track whose loudness is unknown. */
export async function runLoudnessPass(context: PassContext): Promise<void> {
  const ffmpegPath = context.toolkit.ffmpegPath;

  if (ffmpegPath === null) {
    return;
  }

  const params: SqlParams = { $version: LOUDNESS_VERSION };

  const pending = context.db.all(
    `SELECT f.id, r.path AS root_path, f.rel_path FROM files f JOIN roots r ON r.id = f.root_id
      WHERE f.kind = 'video' AND f.probe_version > 0 AND COALESCE(f.audio_streams, 0) > 0
        AND f.loudness_version < $version ${rootClause(context, params)}`,
    PendingSchema,
    params,
  );

  let done = 0;

  await forEachConcurrent(pending, 3, context.checkpoint, async (file) => {
    try {
      const peak = await measurePeakVolume(
        ffmpegPath,
        toAbsolutePath(file.root_path, file.rel_path),
        context.signal,
      );

      context.db.run(
        "UPDATE files SET loudness_version = $version, loudness_max_db = $peak WHERE id = $id",
        { $version: LOUDNESS_VERSION, $peak: peak, $id: file.id },
      );
    } catch (error) {
      if (context.signal.aborted) {
        throw error;
      }
    }

    done += 1;

    if (done % 10 === 0 || done === pending.length) {
      context.progress({ done, total: pending.length, label: "Listening for sound" });
    }
  });
}
