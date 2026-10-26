import { z } from "zod";

import type { CatalogDatabase } from "../catalog/database.js";

/**
 * SVT-AV1's speed as a multiple of real time, by picture size, measured on an M5 Pro at preset 6
 * (plan 060). It is the guess until this machine has timed encodes of its own.
 */
const M5_PRO_SPEEDS = [
  { maxPixels: 1_000_000, speed: 3.5 },
  { maxPixels: 2_200_000, speed: 2.4 },
  { maxPixels: Number.POSITIVE_INFINITY, speed: 1.7 },
] as const;

/** A size class needs this many timed encodes before its own speed counts. */
const MIN_SAMPLES = 3;

/** A size class's speed is the median of its latest this many encodes. */
const RECENT = 50;

/** Clips shorter than this mostly time ffmpeg starting up, so they say little about the encoder. */
const MIN_MEDIA_MS = 10_000;

/** Timings kept; older ones are dropped as new ones come in. */
const KEPT = 500;

/**
 * Records how long one SVT-AV1 encode took. The catalog lives in each machine's data folder, so
 * these are this machine's speeds.
 */
export function recordEncodeTiming(
  db: CatalogDatabase,
  timing: { pixels: number; mediaMs: number; wallMs: number },
): void {
  db.run(
    `INSERT INTO encode_timings (encoder, pixels, media_ms, wall_ms, at)
      VALUES ('svt-av1', $pixels, $media, $wall, $now)`,
    { $pixels: timing.pixels, $media: timing.mediaMs, $wall: timing.wallMs, $now: Date.now() },
  );

  db.run(`DELETE FROM encode_timings WHERE id <= (SELECT MAX(id) FROM encode_timings) - $kept`, {
    $kept: KEPT,
  });
}

export interface EncodeSpeed {
  /** The real-time multiple to expect for a video of this many pixels. */
  at: (pixels: number) => number;
  /** Whether the speeds come from this machine's encodes rather than the M5 Pro's. */
  measured: boolean;
}

const TimingSchema = z.object({ pixels: z.number(), media_ms: z.number(), wall_ms: z.number() });

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);

  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function classOf(pixels: number): number {
  return M5_PRO_SPEEDS.findIndex((size) => pixels <= size.maxPixels);
}

/**
 * This machine's SVT-AV1 speed, from its latest timed encodes: each size class that has enough
 * of them uses their median, and one that has not scales the M5 Pro's figure by how this machine
 * compares in the classes it has timed. With no timings yet, the M5 Pro's figures stand.
 */
export function encodeSpeed(db: CatalogDatabase): EncodeSpeed {
  const timings = db.all(
    `SELECT pixels, media_ms, wall_ms FROM encode_timings
      WHERE encoder = 'svt-av1' AND media_ms >= $min AND wall_ms > 0
      ORDER BY id DESC LIMIT $kept`,
    TimingSchema,
    { $min: MIN_MEDIA_MS, $kept: KEPT },
  );

  const speedsByClass = M5_PRO_SPEEDS.map((): number[] => []);

  for (const timing of timings) {
    const speeds = speedsByClass[classOf(timing.pixels)];

    if (speeds !== undefined && speeds.length < RECENT) {
      speeds.push(timing.media_ms / timing.wall_ms);
    }
  }

  const measured = speedsByClass.map((speeds) =>
    speeds.length >= MIN_SAMPLES ? median(speeds) : null,
  );

  const ratios = measured.flatMap((speed, index) => {
    const guess = M5_PRO_SPEEDS[index]?.speed;

    return speed !== null && guess !== undefined ? [speed / guess] : [];
  });

  const factor = ratios.length > 0 ? median(ratios) : 1;

  return {
    at: (pixels) => {
      const index = classOf(pixels);

      return measured[index] ?? (M5_PRO_SPEEDS[index]?.speed ?? 1.7) * factor;
    },
    measured: ratios.length > 0,
  };
}
