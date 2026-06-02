import { buildFolderPreview, getFolderSegments } from "../shared/path";
import { getSiteKeyFromUrl, isSupportedUrl, type SiteKey } from "../shared/sites";
import type { DownloadablePayload, GeneratedStoryPayload } from "../shared/types";
import { ensureCollectorAndCollect, getActiveTab } from "./active-tab";
import {
  addLog,
  clearLog,
  flashDownloadComplete,
  getPopupElements,
  resetProgress,
  setBadge,
  setFolder,
  setProgress,
  syncActions,
  updatePageStatus,
  type PopupElements
} from "./dom";
import { ensureDirectoryPermission, loadDirectoryHandle, saveDirectoryHandle } from "./directory-store";
import { downloadImages, getOrCreateNestedDirectory } from "./downloader";
import { formatError } from "./errors";
import { saveFanfictionStoryPdf } from "./fanfiction-story";
import type { PopupStatus } from "./status";

interface PopupState {
  activeTab: chrome.tabs.Tab | null;
  siteKey: SiteKey | null;
  directoryHandle: FileSystemDirectoryHandle | null;
  status: PopupStatus;
  running: boolean;
}

interface DirectoryPickerWindow extends Window {
  showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
}

const state: PopupState = {
  activeTab: null,
  siteKey: null,
  directoryHandle: null,
  status: "idle",
  running: false
};

let elements: PopupElements;

document.addEventListener("DOMContentLoaded", () => {
  void init();
});

async function init(): Promise<void> {
  elements = getPopupElements(document);
  elements.chooseFolder.addEventListener("click", () => {
    void handleChooseFolder();
  });
  elements.downloadButton.addEventListener("click", () => {
    void handleDownload();
  });

  setStatus("idle");
  resetProgress(elements);
  await detectActiveTab();
  await restoreSavedDirectoryHandle();
  syncPopupActions();
}

async function detectActiveTab(): Promise<void> {
  try {
    const tab = await getActiveTab();
    state.activeTab = tab;

    if (!tab || typeof tab.id !== "number" || !tab.url) {
      state.siteKey = null;
      state.directoryHandle = null;
      updatePageStatus(elements, "No active page", "Open a supported post page and reopen this popup.");
      syncPopupActions();
      return;
    }

    if (!isSupportedUrl(tab.url)) {
      state.siteKey = null;
      state.directoryHandle = null;
      updatePageStatus(
        elements,
        "Unsupported page",
        "Open a supported MyHentaiGallery, Kemono, FANBOX, AO3, Hentai Foundry story, or fanfiction.net story page."
      );
      syncPopupActions();
      return;
    }

    state.siteKey = getSiteKeyFromUrl(tab.url);
    updatePageStatus(elements, "Supported page detected", tab.url);
    syncPopupActions();
  } catch (error) {
    state.siteKey = null;
    state.directoryHandle = null;
    updatePageStatus(elements, "Error", formatError(error));
    syncPopupActions();
  }
}

async function handleChooseFolder(): Promise<void> {
  if (state.running) {
    return;
  }

  const pickerWindow = window as DirectoryPickerWindow;
  if (typeof pickerWindow.showDirectoryPicker !== "function") {
    setStatus("error");
    addLog(elements, "Folder picking is unavailable in this context.", "error");
    elements.folderDetail.textContent = "This browser context does not support showDirectoryPicker().";
    return;
  }

  try {
    setStatus("pickingFolder");
    const directoryHandle = await pickerWindow.showDirectoryPicker({ mode: "readwrite" });
    await setDirectoryHandle(directoryHandle);
    elements.folderDetail.textContent = state.siteKey
      ? "Remembered for this site."
      : "Available for this popup session.";
    addLog(elements, `Folder selected: ${directoryHandle.name}`, "success");
    setStatus("idle");
  } catch (error) {
    if (isAbortError(error)) {
      setStatus("idle");
      addLog(elements, "Folder selection canceled.", "error");
    } else {
      setStatus("error");
      addLog(elements, `Failed to choose folder: ${formatError(error)}`, "error");
    }
  } finally {
    syncPopupActions();
  }
}

async function handleDownload(): Promise<void> {
  if (state.running) {
    return;
  }

  if (!isSupportedTab()) {
    addLog(elements, "Active tab is not a supported content page.", "error");
    syncPopupActions();
    return;
  }

  if (!state.directoryHandle) {
    addLog(elements, "Choose a folder before downloading.", "error");
    syncPopupActions();
    return;
  }

  const hasPermission = await ensureDirectoryPermission(state.directoryHandle);
  if (!hasPermission) {
    addLog(elements, "Folder is no longer writable. Choose it again.", "error");
    elements.folderDetail.textContent = "Access denied. Pick the folder again.";
    syncPopupActions();
    return;
  }

  state.running = true;
  clearLog(elements);
  resetProgress(elements);
  setStatus("collecting");
  syncPopupActions();
  addLog(elements, "Collecting content metadata...");
  let shouldFlashDownloadButton = false;

  try {
    const payload = await collectGalleryFromPage();
    if (payload.outputKind === "generated-story-pdf") {
      await handleGeneratedStoryDownload(payload);
      shouldFlashDownloadButton = true;
    } else {
      shouldFlashDownloadButton = await handleDownloadableFiles(payload);
    }
  } catch (error) {
    setStatus("error");
    elements.progressText.textContent = "Download stopped due to an error.";
    addLog(elements, formatError(error), "error");
  } finally {
    state.running = false;
    syncPopupActions();
    if (shouldFlashDownloadButton) {
      flashDownloadComplete(elements);
    }
  }
}

async function handleDownloadableFiles(payload: DownloadablePayload): Promise<boolean> {
  const skippedCount = Number(payload.skippedCount || 0);
  const itemName = getItemName(payload);
  addLog(elements, `Found ${formatItemCount(payload.images.length, itemName)} in "${payload.title}".`, "success");
  if (skippedCount > 0) {
    addLog(elements, `Skipped ${skippedCount} entries without valid URLs.`, "error");
  }

  setStatus("downloading");
  const destinationDirectory = await getDestinationDirectory(payload);
  const summary = await downloadImages(
    payload.images,
    destinationDirectory,
    {
      onStart(total) {
        setProgress(elements, 0, total || 1, `Starting ${total} downloads...`);
      },
      onProgress(completed, total) {
        setProgress(
          elements,
          completed,
          total || 1,
          `Processed ${completed} of ${formatItemCount(total, itemName)}.`
        );
      },
      onSaved(fileName) {
        addLog(elements, `Saved ${fileName}`, "success");
      }
    },
    {
      credentials: shouldIncludeCredentials(payload) ? "include" : "omit"
    }
  );
  const stateName: PopupStatus = summary.failed > 0 ? "error" : "complete";

  setStatus(stateName);
  elements.progressText.textContent = `Done. Saved ${summary.saved} of ${formatItemCount(
    payload.images.length,
    itemName
  )}.`;
  addLog(
    elements,
    `Complete. Saved ${summary.saved}, failed ${summary.failed}, skipped ${skippedCount}.`,
    stateName === "complete" ? "success" : "error"
  );

  for (const item of summary.failedItems) {
    addLog(elements, `Failed ${item.fileName}: ${item.reason}`, "error");
  }

  return stateName === "complete";
}

async function handleGeneratedStoryDownload(payload: GeneratedStoryPayload): Promise<void> {
  addLog(elements, `Found ${formatItemCount(payload.chapters.length, "chapter")} in "${payload.title}".`, "success");
  setStatus("downloading");
  const destinationDirectory = await getDestinationDirectory(payload);

  await saveFanfictionStoryPdf(payload, destinationDirectory, {
    onStart(total) {
      setProgress(elements, 0, total || 1, `Collecting ${formatItemCount(total, "chapter")}...`);
    },
    onChapterFetched(completed, total) {
      setProgress(elements, completed, total || 1, `Fetched chapter ${completed} of ${total}.`);
    },
    onGenerating() {
      setProgress(
        elements,
        payload.chapters.length,
        payload.chapters.length || 1,
        "Generating PDF..."
      );
      addLog(elements, "Generating PDF...");
    },
    onSaved(fileName) {
      addLog(elements, `Saved ${fileName}`, "success");
    }
  });

  setStatus("complete");
  elements.progressText.textContent = "Done. Saved 1 file.";
  addLog(elements, "Complete. Saved 1 file, failed 0, skipped 0.", "success");
}

async function getDestinationDirectory(
  payload: DownloadablePayload | GeneratedStoryPayload
): Promise<FileSystemDirectoryHandle> {
  if (!state.directoryHandle) {
    throw new Error("Choose a folder before downloading.");
  }

  const folderSegments = getFolderSegments(payload);
  const destinationDirectory = await getOrCreateNestedDirectory(state.directoryHandle, folderSegments);
  addLog(elements, `Writing to ${buildFolderPreview(state.directoryHandle.name, folderSegments)}`, "success");

  return destinationDirectory;
}

async function collectGalleryFromPage(): Promise<DownloadablePayload | GeneratedStoryPayload> {
  const tabId = state.activeTab && typeof state.activeTab.id === "number" ? state.activeTab.id : null;

  if (tabId === null) {
    throw new Error("No active tab available.");
  }

  const response = await ensureCollectorAndCollect(tabId, () => {
    addLog(elements, "Injecting collector into page...");
  });

  if (!response || response.ok !== true) {
    const message = response && response.message ? response.message : "The page did not return gallery data.";
    throw new Error(message);
  }

  return response;
}

async function restoreSavedDirectoryHandle(): Promise<void> {
  if (!state.siteKey) {
    setFolder(elements, "No folder selected", "Choose a writable folder for this site.");
    return;
  }

  try {
    const directoryHandle = await loadDirectoryHandle(state.siteKey);
    if (!directoryHandle) {
      setFolder(elements, "No folder selected", "Choose a writable folder for this site.");
      return;
    }

    state.directoryHandle = directoryHandle;
    setFolder(elements, directoryHandle.name, "Remembered for this site.");
  } catch (error) {
    elements.folderDetail.textContent = `Could not restore folder: ${formatError(error)}`;
  }
}

async function setDirectoryHandle(directoryHandle: FileSystemDirectoryHandle): Promise<void> {
  state.directoryHandle = directoryHandle;
  elements.folderName.textContent = directoryHandle.name;

  try {
    await saveDirectoryHandle(state.siteKey, directoryHandle);
  } catch (error) {
    addLog(elements, `Folder could not be persisted: ${formatError(error)}`, "error");
    elements.folderDetail.textContent = "Works for this session only.";
  }
}

function isSupportedTab(): boolean {
  return Boolean(state.activeTab?.url && isSupportedUrl(state.activeTab.url));
}

function syncPopupActions(): void {
  syncActions(elements, isSupportedTab() && Boolean(state.directoryHandle) && !state.running, state.running, Boolean(state.directoryHandle));
}

function setStatus(status: PopupStatus): void {
  state.status = status;
  setBadge(elements, status);
}

function shouldIncludeCredentials(payload: DownloadablePayload): boolean {
  return payload.site === "archiveofourown" || payload.site === "fanbox" || payload.site === "hentaifoundry-stories";
}

function getItemName(payload: DownloadablePayload): string {
  return payload.site === "archiveofourown" || payload.site === "hentaifoundry-stories" ? "file" : "image";
}

function formatItemCount(count: number, itemName: string): string {
  return `${count} ${count === 1 ? itemName : `${itemName}s`}`;
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}
