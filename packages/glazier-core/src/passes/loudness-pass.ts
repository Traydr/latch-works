import { z } from "zod";

import type { CatalogDatabase, SqlParams } from "../catalog/database.js";
import { LOUDNESS_VERSION, toAbsolutePath } from "../catalog/file-rows.js";
import { type FileId, FileIdSchema, type RootId, RootIdSchema } from "../contract.js";
import { runTool } from "../media/run-tool.js";
import {
  forEachConcurrent,
  type PassContext,
  rootClause,
  SAME_ROW_SQL,
  sameRowParams,
  stillSelected,
} from "./context.js";

/** Decoding the audio of a long video is fast, but a feature-length file still takes a while. */
const LOUDNESS_TIMEOUT_MS = 10 * 60 * 1000;

/** Videos with an audio track the pass has not measured, as a condition on `files f`. */
const UNMEASURED_SQL = `f.kind = 'video' AND f.probe_version > 0 AND COALESCE(f.audio_streams, 0) > 0
  AND f.loudness_version < $version`;

const PendingSchema = z.object({
  id: FileIdSchema,
  root_id: RootIdSchema,
  root_path: z.string(),
  rel_path: z.string(),
  size: z.number(),
  mtime_ms: z.number(),
});

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

/** How many videos of a root the pass would measure now. */
export function pendingLoudness(db: CatalogDatabase, rootId: RootId): number {
  return (
    db.get(
      `SELECT COUNT(*) AS pending FROM files f WHERE ${UNMEASURED_SQL} AND f.root_id = $root`,
      z.object({ pending: z.number() }),
      { $version: LOUDNESS_VERSION, $root: rootId },
    )?.pending ?? 0
  );
}

/** True once another pass, run meanwhile, measured the file. */
function measuredAlready(context: PassContext, id: FileId): boolean {
  const row = context.db.get(
    "SELECT loudness_version AS version FROM files WHERE id = $id",
    z.object({ version: z.number() }),
    { $id: id },
  );

  return (row?.version ?? 0) >= LOUDNESS_VERSION;
}

/**
 * Measures every video with an audio track whose loudness is unknown. A track ffmpeg cannot
 * measure is recorded as tried, without a level, so it stays unmeasured instead of being decoded
 * again after every scan. Each file is checked against the catalog again just before and after.
 */
export async function runLoudnessPass(context: PassContext): Promise<void> {
  const ffmpegPath = context.toolkit.ffmpegPath;

  if (ffmpegPath === null) {
    return;
  }

  const params: SqlParams = { $version: LOUDNESS_VERSION };

  const pending = context.db.all(
    `SELECT f.id, f.root_id, r.path AS root_path, f.rel_path, f.size, f.mtime_ms
      FROM files f JOIN roots r ON r.id = f.root_id
      WHERE ${UNMEASURED_SQL} ${rootClause(context, params)}`,
    PendingSchema,
    params,
  );

  let done = 0;

  await forEachConcurrent(pending, 3, context.checkpoint, async (file) => {
    if (stillSelected(context, file) && !measuredAlready(context, file.id)) {
      let peak: number | null = null;

      try {
        peak = await measurePeakVolume(
          ffmpegPath,
          toAbsolutePath(file.root_path, file.rel_path),
          context.signal,
        );
      } catch (error) {
        if (context.signal.aborted) {
          throw error;
        }
      }

      context.db.run(
        `UPDATE files SET loudness_version = $version, loudness_max_db = $peak
          WHERE ${SAME_ROW_SQL}`,
        { ...sameRowParams(file), $version: LOUDNESS_VERSION, $peak: peak },
      );
    }

    done += 1;

    if (done % 10 === 0 || done === pending.length) {
      context.progress({ done, total: pending.length, label: "Listening for sound" });
    }
  });
}
