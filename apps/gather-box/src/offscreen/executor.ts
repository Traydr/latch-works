import { getOrCreateNestedDirectory, type WritableDirectory } from "../shared/archive-writer";
import { requestCredentials } from "../shared/credentials";
import { ensureDirectoryPermission, loadDirectoryDestination } from "../shared/directory-store";
import { type DownloadFailure, folderScope, outputTotal } from "../shared/gather-run";
import { loadMediaTransformer } from "../shared/media/media-transformer";
import { buildFolderPreview, sanitizeFolderSegments } from "../shared/path";
import type { GatherRunEvent } from "../shared/protocol/run-events";
import type { GatherBoxSettings } from "../shared/settings";
import { getGatherSource } from "../shared/source-catalog";
import type {
  DownloadableFile,
  DownloadablePayload,
  GatherOutput,
  GeneratedStoryPayload,
} from "../shared/types";
import { downloadImages } from "./downloader";
import { resolveCompatibleFolderSegments } from "./folder-compatibility";

export async function executeGatherOutput(input: {
  payload: GatherOutput;
  settings: GatherBoxSettings;
  /** The remembered folder the output was queued for; null writes to the current one. */
  destinationId: string | null;
  /** The profile whose remembered folders the output writes to. */
  profileId: string;
  emit: (event: GatherRunEvent) => Promise<void>;
  signal?: AbortSignal;
}): Promise<void> {
  const { payload, settings, destinationId, profileId, emit, signal } = input;

  const scope = folderScope(payload.site, settings.useGlobalFolder);
  const destination = await loadDirectoryDestination(scope, profileId);

  if (!destination) {
    await emit({ kind: "failed", message: "Choose a destination folder before gathering." });

    return;
  }

  const directoryHandle = destination.handle;

  if (destinationId && destination.id !== destinationId) {
    await emit(destinationChangedEvent(payload));

    return;
  }

  const permission = await ensureDirectoryPermission(directoryHandle, false);

  if (permission !== "granted") {
    await emit({ kind: "permission-required", scope: scope.kind });

    return;
  }

  const standardFolderSegments = sanitizeFolderSegments(payload.folderSegments);

  const { segments: folderSegments, usedLegacyFolder } = await resolveCompatibleFolderSegments(
    directoryHandle,
    payload.site,
    standardFolderSegments,
  );

  if (usedLegacyFolder) {
    await emit({
      kind: "log",
      message: `Using existing legacy artist folder "${folderSegments[0]}".`,
    });
  }

  const destinationPreview = buildFolderPreview(directoryHandle.name, folderSegments);
  await emit({ kind: "writing", destinationPreview, folderSegments, total: outputTotal(payload) });
  const destinationDirectory = await getOrCreateNestedDirectory(directoryHandle, folderSegments);

  if (payload.outputKind === "generated-story-pdf") {
    await executeStory(payload, destinationDirectory, settings, emit, signal);

    return;
  }

  await executeFiles(payload, destinationDirectory, settings, emit, signal);
}

async function executeFiles(
  payload: DownloadablePayload,
  destinationDirectory: WritableDirectory,
  settings: GatherBoxSettings,
  emit: (event: GatherRunEvent) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const mediaTransformer = await loadMediaTransformer(settings);

  await emit({
    kind: "log",
    message: `Found ${payload.images.length} item(s) in "${payload.title}".`,
    tone: "success",
  });

  const summary = await downloadImages(
    payload.images,
    destinationDirectory,
    {
      onProgress: (completed, total) => {
        void emit({
          kind: "progress",
          completed,
          total,
          message: `Processed ${completed} of ${total}.`,
        });
      },
      onSaved: (fileName) => {
        void emit({ kind: "log", message: `Saved ${fileName}`, tone: "success" });
      },
      onSkipped: (fileName) => {
        void emit({ kind: "log", message: `Skipped existing ${fileName}`, tone: "success" });
      },
      onKeptOriginal: (fileName, reason) => {
        void emit({
          kind: "log",
          message: `Kept original ${fileName}: could not convert (${reason})`,
        });
      },
      onVerbose: settings.verboseLogging
        ? (message) => {
            void emit({ kind: "log", message });
          }
        : undefined,
    },
    {
      credentials: requestCredentials(payload, settings),
      concurrency: settings.downloadConcurrency,
      mediaTransformer,
      site: payload.site,
      signal,
    },
  );

  for (const failure of summary.failedItems) {
    await emit({
      kind: "log",
      message: `Failed ${failure.fileName}: ${failure.reason}`,
      tone: "error",
    });
  }

  await emit({
    kind: "complete",
    saved: summary.saved,
    skipped: summary.skipped,
    failed: summary.failed,
    failedItems: summary.failedItems,
    retryImages: buildRetryImages(summary.failedItems, payload.images),
  });
}

async function executeStory(
  payload: GeneratedStoryPayload,
  destinationDirectory: WritableDirectory,
  settings: GatherBoxSettings,
  emit: (event: GatherRunEvent) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const source = getGatherSource(payload.site);

  if (source?.output.kind !== "generated-story-pdf") {
    throw new Error(`${payload.site} does not generate stories.`);
  }

  const { saveGeneratedStoryPdf } = await import("./generated-story");
  await emit({
    kind: "log",
    message: `Found ${payload.chapters.length} chapter(s) in "${payload.title}".`,
    tone: "success",
  });
  await saveGeneratedStoryPdf(
    payload,
    source.output,
    destinationDirectory,
    {
      onChapterFetched: (completed, total) => {
        void emit({
          kind: "progress",
          completed,
          total,
          message: `Fetched chapter ${completed} of ${total}.`,
        });
      },
      onGenerating: () => {
        void emit({
          kind: "progress",
          completed: payload.chapters.length,
          total: payload.chapters.length,
          message: "Generating PDF...",
        });
      },
      onSaved: (fileName) => {
        void emit({ kind: "log", message: `Saved ${fileName}`, tone: "success" });
      },
    },
    { settings, signal },
  );
  await emit({
    kind: "complete",
    saved: 1,
    skipped: 0,
    failed: 0,
    failedItems: [],
    retryImages: [],
  });
}

const DESTINATION_CHANGED =
  "The remembered folder changed after this page was queued, so nothing was written.";

/**
 * Writing into whichever folder is remembered now would silently move this output. Files fail as
 * retryable items instead, so Retry Failed sends them to the new folder only when asked; a story
 * has no per-item retry and needs gathering again.
 */
function destinationChangedEvent(payload: GatherOutput): GatherRunEvent {
  if (payload.outputKind === "generated-story-pdf") {
    return { kind: "failed", message: `${DESTINATION_CHANGED} Gather the story again.` };
  }

  const failedItems = payload.images.map((image) => ({
    fileName: image.fileName,
    reason: DESTINATION_CHANGED,
    originalUrl: image.originalUrl,
    kind: "error" as const,
  }));

  return {
    kind: "complete",
    saved: 0,
    skipped: 0,
    failed: failedItems.length,
    failedItems,
    retryImages: payload.images,
  };
}

function buildRetryImages(
  failedItems: DownloadFailure[],
  sourceImages: DownloadableFile[],
): DownloadableFile[] {
  const failedNames = new Set(failedItems.map((item) => item.fileName));

  return sourceImages.filter((image) => failedNames.has(image.fileName));
}
