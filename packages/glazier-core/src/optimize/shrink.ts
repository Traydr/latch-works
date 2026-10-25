import { planVideoReencode } from "@latch-works/media-format";
import { z } from "zod";

import type { CatalogDatabase } from "../catalog/database.js";
import {
  FILE_COLUMNS,
  FILES_FROM,
  type FileRecord,
  FileRecordSchema,
} from "../catalog/file-rows.js";
import type { FileId, RootId, ShrinkItem } from "../contract.js";
import {
  type CandidateHolds,
  NO_HOLDS,
  openDuplicateCopies,
  SKIP_DUPLICATE,
  SKIP_REVIEW,
  SKIP_UNCHECKED,
  uncheckedFiles,
  videoSourceOf,
} from "./candidates.js";

/**
 * Below this many bits per pixel each second a video is already compact: an AV1 re-encode at
 * Tidy's settings saves little and can come out larger.
 */
const COMPACT_BITS_PER_PIXEL_SECOND = 0.8;

/**
 * The share of its bytes a video is expected to keep as AV1 (SVT-AV1, CRF 35), from its bits per
 * pixel each second. Fitted to measurements on the owner's library, where busy high-bitrate video
 * kept about a fifth and leaner video more (see docs/plans/060-shrink-videos.md). It ranks videos
 * and sizes batches; the encode itself decides what is kept.
 */
function expectedShare(bitsPerPixelSecond: number): number {
  return Math.min(1, Math.max(0.2, 0.55 / bitsPerPixelSecond));
}

/** Encode speed as a multiple of real time, by picture size, measured on an M5 Pro. */
function encodeSpeed(pixels: number): number {
  if (pixels <= 1_000_000) {
    return 3.5;
  }

  return pixels <= 2_200_000 ? 2.4 : 1.7;
}

interface ShrinkCandidate {
  record: FileRecord;
  item: ShrinkItem;
}

export interface ShrinkScan {
  candidates: ShrinkCandidate[];
  skipped: Map<string, number>;
}

const SKIP_NOT_SMALLER = "Came out no smaller as AV1";

/**
 * Every video under a root that an AV1 re-encode should shrink, the most bytes saved first.
 * Videos already AV1 or already compact are left out, as are those duplicate review still needs
 * as they are (the same holds as Convert) and those an earlier attempt could not shrink.
 */
export function findShrinkCandidates(
  db: CatalogDatabase,
  rootId: RootId,
  holds: CandidateHolds = NO_HOLDS,
): ShrinkScan {
  const params = { $root: rootId };

  const records = db.all(
    `SELECT ${FILE_COLUMNS} FROM ${FILES_FROM}
      WHERE f.root_id = $root AND f.kind = 'video' AND f.is_junk = 0 AND f.size > 0
        AND f.probe_version > 0`,
    FileRecordSchema,
    params,
  );

  const taken = new Set(
    db
      .all(
        "SELECT rel_path FROM files WHERE root_id = $root",
        z.object({ rel_path: z.string() }),
        params,
      )
      .map((row) => row.rel_path.toLowerCase()),
  );

  const duplicates = openDuplicateCopies(db, rootId);
  const unchecked = holds.waitForFingerprints ? uncheckedFiles(db, rootId) : new Set<FileId>();
  const candidates: ShrinkCandidate[] = [];
  const skipped = new Map<string, number>();
  const skip = (reason: string) => skipped.set(reason, (skipped.get(reason) ?? 0) + 1);

  for (const record of records) {
    const reason = skipReason(record, { duplicates, unchecked, holds });

    if (reason !== null) {
      skip(reason);

      continue;
    }

    const source = videoSourceOf(record);
    const plan = source === null ? null : planVideoReencode(source, "av1");

    if (plan?.action !== "convert-mp4") {
      skip("Can't be re-encoded");

      continue;
    }

    const { width, height, bitrate, duration_ms: durationMs } = record;

    if (width === null || height === null || bitrate === null || durationMs === null) {
      skip("Size or bitrate unknown");

      continue;
    }

    const pixels = width * height;
    const bitsPerPixelSecond = pixels > 0 ? bitrate / pixels : 0;

    if (bitsPerPixelSecond < COMPACT_BITS_PER_PIXEL_SECOND) {
      skip("Already compact");

      continue;
    }

    const targetRel = (record.dir ? `${record.dir}/${plan.fileName}` : plan.fileName).toLowerCase();

    if (targetRel !== record.rel_path.toLowerCase() && taken.has(targetRel)) {
      skip("A file with the target name already exists");

      continue;
    }

    candidates.push({
      record,
      item: {
        fileId: record.id,
        bytes: record.size,
        estimatedBytes: Math.round(record.size * expectedShare(bitsPerPixelSecond)),
        durationMs,
        encodeMs: Math.round(durationMs / encodeSpeed(pixels)),
      },
    });
  }

  const saved = (candidate: ShrinkCandidate) =>
    candidate.item.bytes - candidate.item.estimatedBytes;

  candidates.sort(
    (left, right) =>
      saved(right) - saved(left) || left.record.rel_path.localeCompare(right.record.rel_path),
  );

  return { candidates, skipped };
}

function skipReason(
  record: FileRecord,
  context: { duplicates: Set<FileId>; unchecked: Set<FileId>; holds: CandidateHolds },
): string | null {
  if (record.probe_error !== null) {
    return "Won't decode";
  }

  if (record.video_codec === "av1") {
    return "Already AV1";
  }

  if (record.shrink_not_smaller === 1) {
    return SKIP_NOT_SMALLER;
  }

  if (context.duplicates.has(record.id)) {
    return SKIP_DUPLICATE;
  }

  if (context.holds.reviewing.has(record.id)) {
    return SKIP_REVIEW;
  }

  return context.unchecked.has(record.id) ? SKIP_UNCHECKED : null;
}
