import type { PushStage } from "@latch-works/lockstep-core";
import { formatBytes } from "@latch-works/media-domain";

function formatPercent(numerator: number, denominator: number): string {
  if (denominator <= 0) {
    return "0%";
  }

  const percent = Math.min(100, Math.round((numerator / denominator) * 100));

  return `${percent}%`;
}

export interface LineReporter {
  clear(): void;
  log(message: string): void;
  setStatus(message: string): void;
}

/**
 * The fastest a status line is redrawn. Core reports every scanned file and every chunk read, so
 * this is the one place progress is throttled; the latest status is drawn when the interval ends.
 */
const STATUS_INTERVAL_MS = 100;

export function createLineReporter(stream: NodeJS.WritableStream = process.stderr): LineReporter {
  const tty = "isTTY" in stream && Boolean(stream.isTTY);
  let lastLine = "";
  let lastWrite = 0;
  let pendingLine: string | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const writeStatus = (line: string, force = false): void => {
    if (line === lastLine && !force) {
      return;
    }

    const now = Date.now();

    if (!force && now - lastWrite < STATUS_INTERVAL_MS) {
      pendingLine = line;

      if (!flushTimer) {
        flushTimer = setTimeout(
          () => {
            flushTimer = null;

            if (pendingLine) {
              const next = pendingLine;
              pendingLine = null;
              writeStatus(next, true);
            }
          },
          STATUS_INTERVAL_MS - (now - lastWrite),
        );
      }

      return;
    }

    pendingLine = null;
    lastLine = line;
    lastWrite = now;

    if (tty) {
      stream.write(`\r\x1b[2K${line}`);

      return;
    }

    stream.write(`${line}\n`);
  };

  return {
    setStatus(message: string) {
      writeStatus(message);
    },
    clear() {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }

      pendingLine = null;

      if (tty && lastLine) {
        stream.write("\r\x1b[2K");
      }

      lastLine = "";
    },
    log(message: string) {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }

      pendingLine = null;

      if (tty && lastLine) {
        stream.write("\r\x1b[2K");
        lastLine = "";
      }

      stream.write(`${message}\n`);
    },
  };
}

export function formatItemStage({
  bytes,
  current,
  path,
  stage,
  total,
}: {
  bytes?: { done: number; total: number };
  current: number;
  path: string;
  stage: PushStage;
  total: number;
}): string {
  const stageLabel = {
    deleting: "Deleting",
    hashing: "Hashing",
    registering: "Registering",
    uploading: "Uploading",
  } satisfies Record<PushStage, string>;

  const suffix = bytes ? ` — ${formatBytes(bytes.done)} / ${formatBytes(bytes.total)}` : "";

  return `[${current}/${total}] ${stageLabel[stage]} ${path}${suffix}`;
}

export function formatScanStatus(progress: {
  bytesHashed?: number;
  fileSize?: number;
  filesFound: number;
  path?: string;
  skipped: number;
  stage: "hashing" | "scanning";
}): string {
  const counts = `${progress.filesFound.toLocaleString()} media, ${progress.skipped.toLocaleString()} skipped`;

  if (progress.stage === "hashing" && progress.path) {
    const hashDetail =
      progress.bytesHashed !== undefined && progress.fileSize !== undefined
        ? ` (${formatBytes(progress.bytesHashed)} / ${formatBytes(progress.fileSize)}, ${formatPercent(
            progress.bytesHashed,
            progress.fileSize,
          )})`
        : "";

    return `Hashing ${progress.path}${hashDetail} · ${counts}`;
  }

  if (progress.path) {
    return `Indexing ${progress.path} · ${counts}`;
  }

  return `Indexing archive · ${counts}`;
}
