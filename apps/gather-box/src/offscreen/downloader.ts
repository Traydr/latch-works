import {
  getExistingFileHandle,
  hasPendingBlobCommit,
  saveArchiveItem,
  type WritableDirectory,
} from "../shared/archive-writer";
import { prepareDownloadImage } from "../shared/download-policy";
import { isAbortError, SiteCheckError, throwIfAborted, toError } from "../shared/errors";
import type { DownloadFailure } from "../shared/gather-run";
import type { MediaTransformer } from "../shared/media/media-transformer";
import type { SiteKey } from "../shared/source-catalog";
import type { DownloadableFile } from "../shared/types";

export interface DownloadSummary {
  saved: number;
  failed: number;
  skipped: number;
  failedItems: DownloadFailure[];
}

export interface DownloadCallbacks {
  onProgress(completed: number, total: number): void;
  onSaved(fileName: string): void;
  onSkipped?(fileName: string): void;
  onKeptOriginal?(fileName: string, reason: string): void;
  onVerbose?(message: string): void;
}

export interface DownloadOptions {
  /** Every file must match this source's download allowlist. */
  site: SiteKey;
  credentials: RequestCredentials;
  concurrency: number;
  mediaTransformer: MediaTransformer;
  signal?: AbortSignal;
}

export async function downloadImages(
  images: DownloadableFile[],
  destinationDirectory: WritableDirectory,
  callbacks: DownloadCallbacks,
  options: DownloadOptions,
): Promise<DownloadSummary> {
  const summary: DownloadSummary = {
    saved: 0,
    failed: 0,
    skipped: 0,
    failedItems: [],
  };

  let completed = 0;
  const total = images.length;
  const { mediaTransformer } = options;

  throwIfAborted(options.signal);

  await runPool(images, options.concurrency, async (image) => {
    try {
      throwIfAborted(options.signal);
      const preparedImage = prepareDownloadImage(options.site, image);

      if (!preparedImage) {
        throw new Error("Download URL or filename is not allowed");
      }

      const expectedTarget = mediaTransformer.expectedTarget(preparedImage.fileName);

      if (
        expectedTarget &&
        (await getExistingFileHandle(destinationDirectory, expectedTarget)) &&
        !(await hasPendingBlobCommit(destinationDirectory, expectedTarget))
      ) {
        summary.skipped += 1;
        callbacks.onSkipped?.(expectedTarget);
        callbacks.onVerbose?.(`Skipped existing converted file ${expectedTarget}`);

        return;
      }

      callbacks.onVerbose?.(`Fetching ${preparedImage.originalUrl}`);

      const response = await fetch(preparedImage.originalUrl, {
        credentials: options.credentials,
        signal: options.signal,
      });

      if (!response.ok) {
        if (response.headers.get("cf-mitigated") === "challenge") {
          throw new SiteCheckError(response.status);
        }

        throw new Error(`HTTP ${response.status}`);
      }

      const saved = await saveArchiveItem(
        {
          blob: await response.blob(),
          contentType: response.headers.get("content-type") ?? "",
          fileName: preparedImage.fileName,
        },
        destinationDirectory,
        mediaTransformer,
        options.signal,
      );

      if (saved.convertedFrom) {
        callbacks.onVerbose?.(`Converted ${saved.convertedFrom} to ${saved.fileName}`);
      }

      if (saved.conversionFailure) {
        callbacks.onKeptOriginal?.(saved.fileName, saved.conversionFailure);
      }

      if (saved.skipped) {
        summary.skipped += 1;
        callbacks.onSkipped?.(saved.fileName);
        callbacks.onVerbose?.(`Skipped identical existing file ${saved.fileName}`);

        return;
      }

      summary.saved += 1;
      callbacks.onSaved(saved.fileName);
    } catch (error) {
      if (isAbortError(toError(error)) || options.signal?.aborted) {
        throw isAbortError(toError(error))
          ? error
          : new DOMException("The operation was aborted.", "AbortError");
      }

      summary.failed += 1;
      summary.failedItems.push({
        fileName: image.fileName,
        reason: toError(error).message,
        originalUrl: image.originalUrl,
        kind: error instanceof SiteCheckError ? "site-check" : "error",
      });
    } finally {
      completed += 1;
      callbacks.onProgress(completed, total);
    }
  });

  throwIfAborted(options.signal);

  return summary;
}

export async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  let nextIndex = 0;
  const failures: Error[] = [];

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (failures.length === 0) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      const item = items[currentIndex];

      if (item === undefined) {
        return;
      }

      try {
        await worker(item, currentIndex);
      } catch (error) {
        failures.push(toError(error));
      }
    }
  });

  // A failure (usually cancellation) stops new items, but the pool settles only after every
  // active worker has finished its own cleanup, so no write outlives the run that owns it.
  await Promise.all(runners);

  if (failures.length > 0) {
    throw failures[0];
  }
}
