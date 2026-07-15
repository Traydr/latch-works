import { ensureDirectoryPermission, loadDirectoryHandle } from "../popup/directory-store";
import {
  downloadImages,
  getOrCreateNestedDirectory,
  type DownloadFailure
} from "../popup/downloader";
import { formatError } from "../popup/errors";
import { saveFanfictionStoryPdf } from "../popup/fanfiction-story";
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
  emit: (event: GatherRunEvent) => Promise<void>;
}): Promise<void> {
  const { payload, settings, emit } = input;
  const directoryHandle = await loadDirectoryHandle(payload.site, settings.useGlobalFolder);
  if (!directoryHandle) {
    await emit({ kind: "failed", message: "Choose a destination folder before gathering." });
    return;
  }

  const permission = await ensureDirectoryPermission(directoryHandle, false);
  if (permission !== "granted") {
    await emit({ kind: "permission-required" });
    return;
  }

  const folderSegments = getFolderSegments(payload);
  const destinationPreview = buildFolderPreview(directoryHandle.name, folderSegments);
  const total = payload.outputKind === "generated-story-pdf" ? payload.chapters.length : payload.images.length;
  await emit({ kind: "writing", destinationPreview, folderSegments, total });
  const destinationDirectory = await getOrCreateNestedDirectory(directoryHandle, folderSegments);

  try {
    if (payload.outputKind === "generated-story-pdf") {
      await executeStory(payload, destinationDirectory, emit);
      return;
    }
    await executeFiles(payload, destinationDirectory, settings, emit);
  } catch (error) {
    await emit({ kind: "failed", message: formatError(error) });
  }
}

async function executeFiles(
  payload: DownloadablePayload,
  destinationDirectory: FileSystemDirectoryHandle,
  settings: GatherBoxSettings,
  emit: (event: GatherRunEvent) => Promise<void>
): Promise<void> {
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
      onVerbose: settings.verboseLogging
        ? (message) => {
            void emit({ kind: "log", message });
          }
        : undefined
    },
    {
      credentials: shouldIncludeCredentials(payload, settings) ? "include" : "omit",
      concurrency: settings.downloadConcurrency,
      site: payload.site
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
  destinationDirectory: FileSystemDirectoryHandle,
  emit: (event: GatherRunEvent) => Promise<void>
): Promise<void> {
  await emit({
    kind: "log",
    message: `Found ${payload.chapters.length} chapter(s) in "${payload.title}".`,
    tone: "success"
  });
  await saveFanfictionStoryPdf(payload, destinationDirectory, {
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
  });
  await emit({
    kind: "complete",
    saved: 1,
    skipped: 0,
    failed: 0,
    failedItems: [],
    retryImages: []
  });
}

function buildRetryImages(failedItems: DownloadFailure[], sourceImages: GalleryImage[]): GalleryImage[] {
  const failedNames = new Set(failedItems.map((item) => item.fileName));
  return sourceImages.filter((image) => failedNames.has(image.fileName));
}
