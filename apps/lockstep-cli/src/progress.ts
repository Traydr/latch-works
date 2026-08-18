import { formatBytes } from "@latch-works/media-domain";
import { z } from "zod";

export { formatBytes };

export function formatPercent(numerator: number, denominator: number): string {
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

export interface CreateLineReporterOptions {
  minIntervalMs?: number;
  stream?: NodeJS.WritableStream;
}

export function createLineReporter(options: CreateLineReporterOptions = {}): LineReporter {
  const stream = options.stream ?? process.stderr;
  const minIntervalMs = options.minIntervalMs ?? 100;
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
    if (!force && now - lastWrite < minIntervalMs) {
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
          minIntervalMs - (now - lastWrite),
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

export const PushStageSchema = z.enum(["deleting", "hashing", "registering", "uploading"]);
export type PushStage = z.infer<typeof PushStageSchema>;

export function formatPushStatus({
  current,
  detail,
  path,
  stage,
  total,
}: {
  current: number;
  detail?: string;
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

  const suffix = detail ? ` — ${detail}` : "";
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
