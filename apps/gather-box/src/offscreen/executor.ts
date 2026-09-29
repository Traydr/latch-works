import {
  ensureDirectoryPermission,
  getDirectoryDestinationId,
  loadDirectoryHandle
} from "../gather/directory-store";
import {
  downloadImages,
  getOrCreateNestedDirectory,
  type DownloadFailure,
  type WritableDirectory
} from "../gather/downloader";
import { formatError, isAbortError, toError } from "../gather/errors";
import { resolveCompatibleFolderSegments } from "../gather/folder-compatibility";
import { shouldIncludeCredentials } from "../shared/credentials";
import type { GatherRunEvent } from "../shared/gather-run-messages";
import { buildFolderPreview, getFolderSegments } from "../shared/path";
import type { GatherBoxSettings } from "../shared/settings";
import type {
  DownloadablePayload,
  GeneratedStoryPayload,
  GalleryImage
} from "../shared/types";

export async function executeGatherOutput(input: {
  payload: DownloadablePayload | GeneratedStoryPayload;
  settings: GatherBoxSettings;
  /** The remembered folder the output was queued for; null writes to the current one. */
  destinationId: string | null;
  emit: (event: GatherRunEvent) => Promise<void>;
  signal?: AbortSignal;
}): Promise<void> {
  const { payload, settings, destinationId, emit, signal } = input;
  const directoryHandle = await loadDirectoryHandle(payload.site, settings.useGlobalFolder);

  if (!directoryHandle) {
    await emit({ kind: "failed", message: "Choose a destination folder before gathering." });

    return;
  }

  if (
    destinationId &&
    (await getDirectoryDestinationId(payload.site, settings.useGlobalFolder)) !== destinationId
  ) {
    await emit(destinationChangedEvent(payload));

    return;
  }

  const permission = await ensureDirectoryPermission(directoryHandle, false);

  if (permission !== "granted") {
    await emit({
      kind: "permission-required",
      scope: settings.useGlobalFolder ? "global" : "site"
    });

    return;
  }

  const standardFolderSegments = getFolderSegments(payload);

  const { segments: folderSegments, usedLegacyFolder } = await resolveCompatibleFolderSegments(
    directoryHandle,
    payload.site,
    standardFolderSegments
  );

  if (usedLegacyFolder) {
    await emit({
      kind: "log",
      message: `Using existing legacy artist folder "${folderSegments[0]}".`
    });
  }

  const destinationPreview = buildFolderPreview(directoryHandle.name, folderSegments);
  const total = payload.outputKind === "generated-story-pdf" ? payload.chapters.length : payload.images.length;
  await emit({ kind: "writing", destinationPreview, folderSegments, total });
  const destinationDirectory = await getOrCreateNestedDirectory(directoryHandle, folderSegments);

  try {
    if (payload.outputKind === "generated-story-pdf") {
      await executeStory(payload, destinationDirectory, settings, emit, signal);

      return;
    }

    await executeFiles(payload, destinationDirectory, settings, emit, signal);
  } catch (error) {
    if (isAbortError(toError(error)) || signal?.aborted) {
      await emit({ kind: "cancelled", message: "Gather Run cancelled." });

      return;
    }

    await emit({ kind: "failed", message: formatError(toError(error)) });
  }
}

async function executeFiles(
  payload: DownloadablePayload,
  destinationDirectory: WritableDirectory,
  settings: GatherBoxSettings,
  emit: (event: GatherRunEvent) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  const mediaTransformer = settings.mediaCompatibilityMode
    ? await import("../gather/archive-media-transformer").then(
        ({ ARCHIVE_MEDIA_TRANSFORMER }) => ARCHIVE_MEDIA_TRANSFORMER
      )
    : undefined;

  await emit({
    kind: "log",
    message: `Found ${payload.images.length} item(s) in "${payload.title}".`,
    tone: "success"
  });

  const summary = await downloadImages(
    payload.images,
    destinationDirectory,
    {
      onStart: () => undefined,
      onProgress: (completed, total) => {
        void emit({ kind: "progress", completed, total, message: `Processed ${completed} of ${total}.` });
      },
      onSaved: (fileName) => {
        void emit({ kind: "log", message: `Saved ${fileName}`, tone: "success" });
      },
      onSkipped: (fileName) => {
        void emit({ kind: "log", message: `Skipped existing ${fileName}`, tone: "success" });
      },
      onKeptOriginal: (fileName, reason) => {
        void emit({ kind: "log", message: `Kept original ${fileName}: could not convert (${reason})` });
      },
      onVerbose: settings.verboseLogging
        ? (message) => {
            void emit({ kind: "log", message });
          }
        : undefined
    },
    {
      credentials: shouldIncludeCredentials(payload, settings) ? "include" : "omit",
      concurrency: settings.downloadConcurrency,
      mediaTransformer,
      site: payload.site,
      signal
    }
  );

  for (const failure of summary.failedItems) {
    await emit({ kind: "log", message: `Failed ${failure.fileName}: ${failure.reason}`, tone: "error" });
  }

  await emit({
    kind: "complete",
    saved: summary.saved,
    skipped: summary.skipped,
    failed: summary.failed,
    failedItems: summary.failedItems,
    retryImages: buildRetryImages(summary.failedItems, payload.images)
  });
}

async function executeStory(
  payload: GeneratedStoryPayload,
  destinationDirectory: WritableDirectory,
  settings: GatherBoxSettings,
  emit: (event: GatherRunEvent) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  const { saveFanfictionStoryPdf } = await import("../gather/fanfiction-story");
  await emit({
    kind: "log",
    message: `Found ${payload.chapters.length} chapter(s) in "${payload.title}".`,
    tone: "success"
  });
  await saveFanfictionStoryPdf(
    payload,
    destinationDirectory,
    {
      onStart: () => undefined,
      onChapterFetched: (completed, total) => {
        void emit({
          kind: "progress",
          completed,
          total,
          message: `Fetched chapter ${completed} of ${total}.`
        });
      },
      onGenerating: () => {
        void emit({
          kind: "progress",
          completed: payload.chapters.length,
          total: payload.chapters.length,
          message: "Generating PDF..."
        });
      },
      onSaved: (fileName) => {
        void emit({ kind: "log", message: `Saved ${fileName}`, tone: "success" });
      }
    },
    { settings, signal }
  );
  await emit({
    kind: "complete",
    saved: 1,
    skipped: 0,
    failed: 0,
    failedItems: [],
    retryImages: []
  });
}

const DESTINATION_CHANGED =
  "The remembered folder changed after this page was queued, so nothing was written.";

/**
 * Writing into whichever folder is remembered now would silently move this output. Files fail as
 * retryable items instead, so Retry Failed sends them to the new folder only when asked; a story
 * has no per-item retry and needs gathering again.
 */
function destinationChangedEvent(
  payload: DownloadablePayload | GeneratedStoryPayload
): GatherRunEvent {
  if (payload.outputKind === "generated-story-pdf") {
    return { kind: "failed", message: `${DESTINATION_CHANGED} Gather the story again.` };
  }

  const failedItems = payload.images.map((image) => ({
    fileName: image.fileName,
    reason: DESTINATION_CHANGED,
    originalUrl: image.originalUrl
  }));

  return {
    kind: "complete",
    saved: 0,
    skipped: 0,
    failed: failedItems.length,
    failedItems,
    retryImages: payload.images
  };
}

function buildRetryImages(failedItems: DownloadFailure[], sourceImages: GalleryImage[]): GalleryImage[] {
  const failedNames = new Set(failedItems.map((item) => item.fileName));

  return sourceImages.filter((image) => failedNames.has(image.fileName));
}
