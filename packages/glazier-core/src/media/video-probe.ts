import { z } from "zod";

import { runTool } from "./run-tool.js";

const PROBE_TIMEOUT_MS = 30_000;

const NumericStringSchema = z
  .union([z.string(), z.number()])
  .transform((value) => Number(value))
  .pipe(z.number());

/** The slice of `ffprobe -show_streams -show_format` JSON Glazier reads. */
const FfprobeOutputSchema = z.object({
  streams: z
    .array(
      z.object({
        codec_type: z.string().optional(),
        codec_name: z.string().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        duration: NumericStringSchema.optional().catch(undefined),
        disposition: z.object({ attached_pic: z.number().optional() }).optional(),
        tags: z.object({ rotate: NumericStringSchema.optional().catch(undefined) }).optional(),
        side_data_list: z
          .array(z.object({ rotation: z.number().optional() }))
          .optional()
          .catch(undefined),
      }),
    )
    .default([]),
  format: z
    .object({
      duration: NumericStringSchema.optional().catch(undefined),
      bit_rate: NumericStringSchema.optional().catch(undefined),
    })
    .default({}),
});

export interface VideoProbe {
  /** Display dimensions, after rotation metadata; null when the file has no picture. */
  width: number | null;
  height: number | null;
  durationMs: number | null;
  /** ffprobe's codec name for the primary video track, such as `h264`. */
  videoCodec: string | null;
  /** ffprobe's codec name for the first audio track. */
  audioCodec: string | null;
  audioStreams: number;
  bitrate: number | null;
}

export async function probeVideo(ffprobePath: string, filePath: string): Promise<VideoProbe> {
  const result = await runTool({
    executable: ffprobePath,
    args: ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", filePath],
    timeoutMs: PROBE_TIMEOUT_MS,
  });

  if (result.code !== 0) {
    throw new Error(result.stderr.trim().split("\n").at(-1) || "ffprobe could not read the file.");
  }

  const output = FfprobeOutputSchema.parse(JSON.parse(result.stdout.toString("utf8")));

  const video = output.streams.find(
    (stream) => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1,
  );

  const audio = output.streams.filter((stream) => stream.codec_type === "audio");
  const rotation = video?.side_data_list?.find((entry) => entry.rotation !== undefined)?.rotation;
  const turns = Math.abs(Math.round((rotation ?? video?.tags?.rotate ?? 0) / 90)) % 2;
  const width = video?.width ?? null;
  const height = video?.height ?? null;
  const seconds = video?.duration ?? output.format.duration;

  return {
    width: turns === 1 ? height : width,
    height: turns === 1 ? width : height,
    durationMs:
      seconds !== undefined && Number.isFinite(seconds) ? Math.round(seconds * 1000) : null,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio[0]?.codec_name ?? null,
    audioStreams: audio.length,
    bitrate: output.format.bit_rate ?? null,
  };
}
