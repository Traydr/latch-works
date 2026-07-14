import { ensureCollectorAndCollect, getActiveTab } from "../popup/active-tab";
import {
  clearDirectoryHandle,
  ensureDirectoryPermission,
  getDirectoryScopeLabel,
  loadDirectoryHandle,
  saveDirectoryHandle
} from "../popup/directory-store";
import {
  addLog,
  clearLog,
  flashDownloadComplete,
  getPopupElements,
  restoreLog,
  setBadge,
  setDestinationPreview,
  setFolder,
  setLogExpanded,
  setPageState,
  setProgress,
  resetProgress,
  syncActions,
  updateSaveBehavior,
  type LogTone,
  type PopupElements
} from "../popup/dom";
import { downloadImages, getOrCreateNestedDirectory, type DownloadFailure } from "../popup/downloader";
import { formatError } from "../popup/errors";
import { saveFanfictionStoryPdf } from "../popup/fanfiction-story";
import type { PopupStatus } from "../popup/status";
import { shouldIncludeCredentials } from "./credentials";
import {
  getSiteKeyFromUrl,
  isSupportedUrl,
  type SiteKey
} from "./sites";
import {
  EMPTY_LAST_RUN,
  LastRunWriter,
  loadLastRun,
  type LastRunLogEntry,
  type LastRunState
} from "./last-run";
import {
  buildFolderPreview,
  getFolderSegments
} from "./path";
import {
  PENDING_DOWNLOAD_SESSION_KEY,
  START_DOWNLOAD_MESSAGE,
  TOGGLE_OPEN_UI_MESSAGE,
  type GatherRuntimeMessage
} from "./runtime-messages";
import { loadSettings, DEFAULT_SETTINGS, type GatherBoxSettings } from "./settings";
import { installShortcutKeyListener } from "./shortcut-keys";
import type { DownloadablePayload, GeneratedStoryPayload, GalleryImage } from "./types";

interface PopupState {
  activeTab: chrome.tabs.Tab | null;
  siteKey: SiteKey | null;
  directoryHandle: FileSystemDirectoryHandle | null;
  status: PopupStatus;
  running: boolean;
  settings: GatherBoxSettings;
  lastRun: LastRunState;
}

interface DirectoryPickerWindow extends Window {
  showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
}

export interface GatherControllerOptions {
  includeOpenSidePanel?: boolean;
  onOpenSidePanel?: () => void;
  onToggleShortcut?: () => void;
}

export class GatherController {
  private readonly state: PopupState = {
    activeTab: null,
    siteKey: null,
    directoryHandle: null,
    status: "idle",
    running: false,
    settings: { ...DEFAULT_SETTINGS },
    lastRun: { ...EMPTY_LAST_RUN }
  };

  private elements!: PopupElements;
  private logEntries: LastRunLogEntry[] = [];
  private readonly lastRunWriter = new LastRunWriter();
  private readonly options: GatherControllerOptions;
  private keydownHandler: ((event: KeyboardEvent) => void) | null = null;
  private shortcutCleanup: (() => void) | null = null;
  private messageHandler:
    | ((
        message: GatherRuntimeMessage,
        sender: chrome.runtime.MessageSender,
        sendResponse: (response?: unknown) => void
      ) => boolean)
    | null = null;
  private storageHandler:
    | ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void)
    | null = null;

  constructor(options: GatherControllerOptions = {}) {
    this.options = options;
  }

  async init(document: Document): Promise<void> {
    this.elements = getPopupElements(document, {
      includeOpenSidePanel: this.options.includeOpenSidePanel
    });

    this.elements.chooseFolder.addEventListener("click", () => {
      void this.handleChooseFolder();
    });
    this.elements.clearFolder.addEventListener("click", () => {
      void this.handleClearFolder();
    });
    this.elements.downloadButton.addEventListener("click", () => {
      void this.handleDownload(true);
    });
    this.elements.retryButton.addEventListener("click", () => {
      void this.handleRetryFailed();
    });
    this.elements.copyErrorsButton.addEventListener("click", () => {
      void this.handleCopyErrors();
    });
    this.elements.openSidePanelButton?.addEventListener("click", () => {
      this.options.onOpenSidePanel?.();
    });

    this.keydownHandler = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.repeat) {
        return;
      }

      if (this.elements.downloadButton.disabled || this.state.running) {
        return;
      }

      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return;
      }

      event.preventDefault();
      void this.handleDownload(true);
    };
    document.addEventListener("keydown", this.keydownHandler);

    this.shortcutCleanup = installShortcutKeyListener(
      document,
      () => this.state.settings.shortcutsEnabled,
      (action) => {
        if (action === "toggle") {
          this.options.onToggleShortcut?.();
          return;
        }

        void this.handleDownload(true);
      }
    );

    this.messageHandler = (message: GatherRuntimeMessage, _sender, sendResponse) => {
      if (message.type === START_DOWNLOAD_MESSAGE) {
        sendResponse({ accepted: true });
        void this.handleDownload(false);
      }
      if (message.type === TOGGLE_OPEN_UI_MESSAGE) {
        sendResponse({ accepted: true });
        this.options.onToggleShortcut?.();
      }
      return false;
    };
    chrome.runtime.onMessage.addListener(this.messageHandler);

    this.storageHandler = (changes, areaName) => {
      if (areaName === "sync" && changes["gather-box-settings"]) {
        void this.refreshSettings();
      }
    };
    chrome.storage.onChanged.addListener(this.storageHandler);

    this.state.settings = await loadSettings();
    this.state.lastRun = await loadLastRun();
    this.logEntries = [...this.state.lastRun.log];

    this.setStatus("idle");
    resetProgress(this.elements);
    restoreLog(this.elements, this.logEntries);

    if (this.state.lastRun.destinationPreview) {
      setDestinationPreview(this.elements, this.state.lastRun.destinationPreview);
    }

    await this.detectActiveTab();
    await this.restoreSavedDirectoryHandle();
    this.syncPopupActions();

    const pending = await chrome.storage.session.get(PENDING_DOWNLOAD_SESSION_KEY);
    if (pending[PENDING_DOWNLOAD_SESSION_KEY]) {
      await chrome.storage.session.remove(PENDING_DOWNLOAD_SESSION_KEY);
      void this.handleDownload(false);
    }
  }

  async refreshSettings(): Promise<void> {
    this.state.settings = await loadSettings();
    await this.restoreSavedDirectoryHandle();
    this.syncPopupActions();
    updateSaveBehavior(this.state.siteKey);
  }

  destroy(): void {
    if (this.keydownHandler) {
      document.removeEventListener("keydown", this.keydownHandler);
      this.keydownHandler = null;
    }
    this.shortcutCleanup?.();
    this.shortcutCleanup = null;
    if (this.messageHandler) {
      chrome.runtime.onMessage.removeListener(this.messageHandler);
      this.messageHandler = null;
    }
    if (this.storageHandler) {
      chrome.storage.onChanged.removeListener(this.storageHandler);
      this.storageHandler = null;
    }
  }

  private async detectActiveTab(): Promise<void> {
    try {
      const tab = await getActiveTab();
      this.state.activeTab = tab;

      if (!tab || typeof tab.id !== "number" || !tab.url) {
        this.state.siteKey = null;
        setPageState(this.elements, false, "No active page detected. Open a supported post page, then reopen Gather Box.");
        updateSaveBehavior(this.state.siteKey);
        await this.restoreSavedDirectoryHandle();
        this.syncPopupActions();
        return;
      }

      if (!isSupportedUrl(tab.url)) {
        this.state.siteKey = null;
        setPageState(
          this.elements,
          false,
          "This isn't a supported page. Open an X post, pixiv artwork, MyHentaiGallery, Kemono, FANBOX, AO3, Hentai Foundry, or fanfiction.net page."
        );
        updateSaveBehavior(this.state.siteKey);
        await this.restoreSavedDirectoryHandle();
        this.syncPopupActions();
        return;
      }

      this.state.siteKey = getSiteKeyFromUrl(tab.url);
      setPageState(this.elements, true);
      updateSaveBehavior(this.state.siteKey);
      this.syncPopupActions();
    } catch (error) {
      this.state.siteKey = null;
      this.state.directoryHandle = null;
      setPageState(this.elements, false, formatError(error));
      updateSaveBehavior(this.state.siteKey);
      this.syncPopupActions();
    }
  }

  private async handleChooseFolder(): Promise<void> {
    if (this.state.running) {
      return;
    }

    const pickerWindow = window as DirectoryPickerWindow;
    if (typeof pickerWindow.showDirectoryPicker !== "function") {
      this.setStatus("error");
      this.appendLog("Folder picking is unavailable in this context.", "error");
      this.elements.folderDetail.textContent =
        "This browser context does not support showDirectoryPicker().";
      return;
    }

    try {
      this.setStatus("pickingFolder");
      const directoryHandle = await pickerWindow.showDirectoryPicker({ mode: "readwrite" });
      await this.setDirectoryHandle(directoryHandle);
      this.elements.folderDetail.textContent = this.state.siteKey
        ? `Remembered for ${getDirectoryScopeLabel(this.state.settings.useGlobalFolder)}.`
        : "Available for this session.";
      this.appendLog(`Folder selected: ${directoryHandle.name}`, "success");
      this.setStatus("idle");
    } catch (error) {
      if (isAbortError(error)) {
        this.setStatus("idle");
        this.appendLog("Folder selection canceled.", "error");
      } else {
        this.setStatus("error");
        this.appendLog(`Failed to choose folder: ${formatError(error)}`, "error");
      }
    } finally {
      this.syncPopupActions();
    }
  }

  private async handleClearFolder(): Promise<void> {
    if (this.state.running) {
      return;
    }

    try {
      await clearDirectoryHandle(this.state.siteKey, this.state.settings.useGlobalFolder);
      this.state.directoryHandle = null;
      setFolder(
        this.elements,
        "No folder selected",
        `Choose a writable folder for ${getDirectoryScopeLabel(this.state.settings.useGlobalFolder)}.`
      );
      this.appendLog("Cleared remembered folder.", "success");
      this.setStatus("idle");
    } catch (error) {
      this.setStatus("error");
      this.appendLog(`Failed to clear folder: ${formatError(error)}`, "error");
    } finally {
      this.syncPopupActions();
    }
  }

  private async handleDownload(allowPermissionPrompt: boolean): Promise<void> {
    if (this.state.running) {
      return;
    }

    if (!this.isSupportedTab()) {
      this.appendLog("Active tab is not a supported content page.", "error");
      this.syncPopupActions();
      return;
    }

    if (!this.state.directoryHandle) {
      this.appendLog("Choose a folder before downloading.", "error");
      this.syncPopupActions();
      return;
    }

    const permission = await ensureDirectoryPermission(
      this.state.directoryHandle,
      allowPermissionPrompt
    );
    if (permission === "requires-user-activation") {
      this.appendLog(
        "Folder access needs confirmation. Click Download Content to grant access and continue.",
        "error"
      );
      this.elements.folderDetail.textContent = "Click Download Content to confirm folder access.";
      this.syncPopupActions();
      return;
    }
    if (permission !== "granted") {
      this.appendLog("Folder is no longer writable. Choose it again.", "error");
      this.elements.folderDetail.textContent = "Access denied. Pick the folder again.";
      this.syncPopupActions();
      return;
    }

    this.state.running = true;
    clearLog(this.elements);
    this.logEntries = [];
    resetProgress(this.elements);
    this.setStatus("collecting");
    this.syncPopupActions();
    this.appendLog("Collecting content metadata...");
    let shouldFlashDownloadButton = false;

    try {
      const payload = await this.collectGalleryFromPage();
      const destinationPreview = await this.previewDestination(payload);
      setDestinationPreview(this.elements, destinationPreview);
      await this.persistLastRun({
        destinationPreview,
        failedItems: [],
        retryImages: [],
        canRetry: false
      });

      if (payload.outputKind === "generated-story-pdf") {
        await this.handleGeneratedStoryDownload(payload);
        shouldFlashDownloadButton = true;
      } else {
        shouldFlashDownloadButton = await this.handleDownloadableFiles(payload);
      }
    } catch (error) {
      this.setStatus("error");
      this.elements.progressText.textContent = "Download stopped due to an error.";
      this.appendLog(formatError(error), "error");
      setLogExpanded(this.elements, true);
    } finally {
      await this.lastRunWriter.flush();
      this.state.running = false;
      this.syncPopupActions();
      if (shouldFlashDownloadButton) {
        flashDownloadComplete(this.elements);
      }
    }
  }

  private async handleRetryFailed(): Promise<void> {
    if (this.state.running || !this.state.lastRun.canRetry || this.state.lastRun.retryImages.length === 0) {
      return;
    }

    if (!this.state.directoryHandle) {
      this.appendLog("Choose a folder before retrying.", "error");
      this.syncPopupActions();
      return;
    }

    const permission = await ensureDirectoryPermission(this.state.directoryHandle, true);
    if (permission !== "granted") {
      this.appendLog("Folder is no longer writable. Choose it again.", "error");
      this.syncPopupActions();
      return;
    }

    const destinationPreview = this.state.lastRun.destinationPreview;
    if (!destinationPreview) {
      this.appendLog("No remembered destination path for retry.", "error");
      return;
    }

    this.state.running = true;
    this.setStatus("downloading");
    this.syncPopupActions();
    this.appendLog(`Retrying ${this.state.lastRun.retryImages.length} failed file(s)...`);

    try {
      const destinationDirectory = await this.getDestinationDirectoryFromPreview(destinationPreview);
      const summary = await downloadImages(
        this.state.lastRun.retryImages,
        destinationDirectory,
        {
          onStart: (total) => {
            setProgress(this.elements, 0, total || 1, `Retrying ${total} file(s)...`);
          },
          onProgress: (completed, total) => {
            setProgress(
              this.elements,
              completed,
              total || 1,
              `Retried ${completed} of ${total} file(s).`
            );
          },
          onSaved: (fileName) => {
            this.appendLog(`Saved ${fileName}`, "success");
          },
          onSkipped: (fileName) => {
            this.appendLog(`Skipped existing ${fileName}`, "success");
          },
          onVerbose: (message) => {
            this.logVerbose(message);
          }
        },
        this.getDownloadOptionsForRetry()
      );

      const stateName: PopupStatus = summary.failed > 0 ? "error" : "complete";
      this.setStatus(stateName);
      this.elements.progressText.textContent = `Retry done. Saved ${summary.saved}, failed ${summary.failed}.`;
      this.appendLog(
        `Retry complete. Saved ${summary.saved}, failed ${summary.failed}, skipped ${summary.skipped}.`,
        stateName === "complete" ? "success" : "error"
      );

      for (const item of summary.failedItems) {
        this.appendLog(`Failed ${item.fileName}: ${item.reason}`, "error");
      }

      await this.persistLastRun({
        failedItems: summary.failedItems,
        retryImages: this.buildRetryImages(summary.failedItems, this.state.lastRun.retryImages),
        canRetry: summary.failedItems.length > 0
      });

      if (stateName === "error") {
        setLogExpanded(this.elements, true);
      }
    } catch (error) {
      this.setStatus("error");
      this.appendLog(`Retry failed: ${formatError(error)}`, "error");
      setLogExpanded(this.elements, true);
    } finally {
      await this.lastRunWriter.flush();
      this.state.running = false;
      this.syncPopupActions();
    }
  }

  private async handleDownloadableFiles(payload: DownloadablePayload): Promise<boolean> {
    const skippedCount = Number(payload.skippedCount || 0);
    const itemName = getItemName(payload);
    this.appendLog(`Found ${formatItemCount(payload.images.length, itemName)} in "${payload.title}".`, "success");
    if (skippedCount > 0) {
      this.appendLog(`Skipped ${skippedCount} entries without valid URLs.`, "error");
    }

    if (this.state.settings.verboseLogging) {
      for (const image of payload.images) {
        this.logVerbose(`${image.fileName} -> ${image.originalUrl}`);
      }
    }

    this.setStatus("downloading");
    const destinationDirectory = await this.getDestinationDirectory(payload);
    const summary = await downloadImages(
      payload.images,
      destinationDirectory,
      {
        onStart: (total) => {
          setProgress(this.elements, 0, total || 1, `Starting ${total} downloads...`);
        },
        onProgress: (completed, total) => {
          setProgress(
            this.elements,
            completed,
            total || 1,
            `Processed ${completed} of ${formatItemCount(total, itemName)}.`
          );
        },
        onSaved: (fileName) => {
          this.appendLog(`Saved ${fileName}`, "success");
        },
        onSkipped: (fileName) => {
          this.appendLog(`Skipped existing ${fileName}`, "success");
        },
        onVerbose: (message) => {
          this.logVerbose(message);
        }
      },
      {
        credentials: shouldIncludeCredentials(payload, this.state.settings) ? "include" : "omit",
        concurrency: this.state.settings.downloadConcurrency,
        site: payload.site
      }
    );

    const stateName: PopupStatus = summary.failed > 0 ? "error" : "complete";
    this.setStatus(stateName);
    this.elements.progressText.textContent = `Done. Saved ${summary.saved} of ${formatItemCount(
      payload.images.length,
      itemName
    )}.`;
    this.appendLog(
      `Complete. Saved ${summary.saved}, failed ${summary.failed}, skipped ${summary.skipped}, collector skipped ${skippedCount}.`,
      stateName === "complete" ? "success" : "error"
    );

    for (const item of summary.failedItems) {
      this.appendLog(`Failed ${item.fileName}: ${item.reason}`, "error");
    }

    await this.persistLastRun({
      failedItems: summary.failedItems,
      retryImages: this.buildRetryImages(summary.failedItems, payload.images),
      canRetry: summary.failedItems.length > 0
    });

    if (stateName === "error") {
      setLogExpanded(this.elements, true);
    }

    return stateName === "complete";
  }

  private async handleGeneratedStoryDownload(payload: GeneratedStoryPayload): Promise<void> {
    this.appendLog(
      `Found ${formatItemCount(payload.chapters.length, "chapter")} in "${payload.title}".`,
      "success"
    );
    this.setStatus("downloading");
    const destinationDirectory = await this.getDestinationDirectory(payload);

    await saveFanfictionStoryPdf(payload, destinationDirectory, {
      onStart: (total) => {
        setProgress(this.elements, 0, total || 1, `Collecting ${formatItemCount(total, "chapter")}...`);
      },
      onChapterFetched: (completed, total) => {
        setProgress(this.elements, completed, total || 1, `Fetched chapter ${completed} of ${total}.`);
      },
      onGenerating: () => {
        setProgress(
          this.elements,
          payload.chapters.length,
          payload.chapters.length || 1,
          "Generating PDF..."
        );
        this.appendLog("Generating PDF...");
      },
      onSaved: (fileName) => {
        this.appendLog(`Saved ${fileName}`, "success");
      }
    });

    this.setStatus("complete");
    this.elements.progressText.textContent = "Done. Saved 1 file.";
    this.appendLog("Complete. Saved 1 file, failed 0, skipped 0.", "success");
    await this.persistLastRun({
      failedItems: [],
      retryImages: [],
      canRetry: false
    });
  }

  private async handleCopyErrors(): Promise<void> {
    const failedItems = this.state.lastRun.failedItems;
    if (failedItems.length === 0) {
      return;
    }

    const report = buildErrorReport(failedItems, this.state.lastRun);
    try {
      await navigator.clipboard.writeText(report);
      this.appendLog("Copied error report to clipboard.", "success");
    } catch (error) {
      this.appendLog(`Could not copy error report: ${formatError(error)}`, "error");
      setLogExpanded(this.elements, true);
    }
  }

  private async getDestinationDirectory(
    payload: DownloadablePayload | GeneratedStoryPayload
  ): Promise<FileSystemDirectoryHandle> {
    if (!this.state.directoryHandle) {
      throw new Error("Choose a folder before downloading.");
    }

    const folderSegments = getFolderSegments(payload);
    const destinationDirectory = await getOrCreateNestedDirectory(
      this.state.directoryHandle,
      folderSegments
    );
    const preview = buildFolderPreview(this.state.directoryHandle.name, folderSegments);
    this.appendLog(`Writing to ${preview}`, "success");

    return destinationDirectory;
  }

  private async getDestinationDirectoryFromPreview(
    destinationPreview: string
  ): Promise<FileSystemDirectoryHandle> {
    if (!this.state.directoryHandle) {
      throw new Error("Choose a folder before downloading.");
    }

    const segments = destinationPreview.includes("/")
      ? destinationPreview.split("/").slice(1)
      : [];

    return getOrCreateNestedDirectory(this.state.directoryHandle, segments);
  }

  private async previewDestination(
    payload: DownloadablePayload | GeneratedStoryPayload
  ): Promise<string> {
    if (!this.state.directoryHandle) {
      return "";
    }

    const folderSegments = getFolderSegments(payload);
    return buildFolderPreview(this.state.directoryHandle.name, folderSegments);
  }

  private async collectGalleryFromPage(): Promise<DownloadablePayload | GeneratedStoryPayload> {
    const tabId =
      this.state.activeTab && typeof this.state.activeTab.id === "number"
        ? this.state.activeTab.id
        : null;

    if (tabId === null) {
      throw new Error("No active tab available.");
    }

    const response = await ensureCollectorAndCollect(tabId, () => {
      this.appendLog("Injecting collector into page...");
    });

    if (!response || response.ok !== true) {
      const message =
        response && "message" in response && response.message
          ? response.message
          : "The page did not return gallery data.";
      throw new Error(message);
    }

    return response;
  }

  private async restoreSavedDirectoryHandle(): Promise<void> {
    const scopeLabel = getDirectoryScopeLabel(this.state.settings.useGlobalFolder);

    if (!this.state.siteKey && !this.state.settings.useGlobalFolder) {
      setFolder(this.elements, "No folder selected", `Choose a writable folder for ${scopeLabel}.`);
      return;
    }

    try {
      const directoryHandle = await loadDirectoryHandle(
        this.state.siteKey,
        this.state.settings.useGlobalFolder
      );
      if (!directoryHandle) {
        setFolder(this.elements, "No folder selected", `Choose a writable folder for ${scopeLabel}.`);
        return;
      }

      this.state.directoryHandle = directoryHandle;
      setFolder(this.elements, directoryHandle.name, `Remembered for ${scopeLabel}.`);
    } catch (error) {
      this.elements.folderDetail.textContent = `Could not restore folder: ${formatError(error)}`;
    }
  }

  private async setDirectoryHandle(directoryHandle: FileSystemDirectoryHandle): Promise<void> {
    this.state.directoryHandle = directoryHandle;
    this.elements.folderName.textContent = directoryHandle.name;

    try {
      await saveDirectoryHandle(
        this.state.siteKey,
        directoryHandle,
        this.state.settings.useGlobalFolder
      );
    } catch (error) {
      this.appendLog(`Folder could not be persisted: ${formatError(error)}`, "error");
      this.elements.folderDetail.textContent = "Works for this session only.";
    }
  }

  private getDownloadOptionsForRetry(): {
    credentials: RequestCredentials;
    concurrency: number;
    site?: SiteKey;
  } {
    const siteKey = this.state.lastRun.siteKey;
    const credentials =
      siteKey &&
      shouldIncludeCredentials(
        {
          site: siteKey,
          outputKind: "downloadable-files"
        } as DownloadablePayload,
        this.state.settings
      )
        ? "include"
        : "omit";

    return {
      credentials,
      concurrency: this.state.settings.downloadConcurrency,
      site: siteKey ?? undefined
    };
  }

  private isSupportedTab(): boolean {
    return Boolean(this.state.activeTab?.url && isSupportedUrl(this.state.activeTab.url));
  }

  private syncPopupActions(): void {
    syncActions(
      this.elements,
      this.isSupportedTab() && Boolean(this.state.directoryHandle) && !this.state.running,
      this.state.running,
      Boolean(this.state.directoryHandle),
      this.state.lastRun.canRetry && this.state.lastRun.retryImages.length > 0,
      this.state.lastRun.failedItems.length > 0
    );
  }

  private setStatus(status: PopupStatus): void {
    this.state.status = status;
    setBadge(this.elements, status);

    if (status === "error") {
      setLogExpanded(this.elements, true);
    }
  }

  private appendLog(message: string, tone?: LogTone): void {
    addLog(this.elements, message, tone);
    this.logEntries.push({ message, tone });
    void this.persistLastRun({});
  }

  private logVerbose(message: string): void {
    if (!this.state.settings.verboseLogging) {
      return;
    }

    this.appendLog(message);
  }

  private buildRetryImages(
    failedItems: DownloadFailure[],
    sourceImages: GalleryImage[]
  ): GalleryImage[] {
    const failedNames = new Set(failedItems.map((item) => item.fileName));

    return sourceImages.filter((image) => failedNames.has(image.fileName));
  }

  private async persistLastRun(patch: Partial<LastRunState>): Promise<void> {
    this.state.lastRun = {
      timestamp: Date.now(),
      siteKey: this.state.siteKey,
      tabUrl: this.state.activeTab?.url ?? null,
      destinationPreview:
        patch.destinationPreview ?? this.state.lastRun.destinationPreview ?? null,
      log: this.logEntries,
      failedItems: patch.failedItems ?? this.state.lastRun.failedItems,
      retryImages: patch.retryImages ?? this.state.lastRun.retryImages,
      canRetry: patch.canRetry ?? this.state.lastRun.canRetry
    };

    this.lastRunWriter.enqueue(copyLastRun(this.state.lastRun));
    await this.lastRunWriter.flush();
    this.syncPopupActions();
  }
}

function copyLastRun(state: LastRunState): LastRunState {
  return {
    ...state,
    log: state.log.map((entry) => ({ ...entry })),
    failedItems: state.failedItems.map((item) => ({ ...item })),
    retryImages: state.retryImages.map((image) => ({ ...image }))
  };
}

function getItemName(payload: DownloadablePayload): string {
  if (payload.site === "x") {
    return "media item";
  }

  return payload.site === "archiveofourown" || payload.site === "hentaifoundry-stories"
    ? "file"
    : "image";
}

function formatItemCount(count: number, itemName: string): string {
  return `${count} ${count === 1 ? itemName : `${itemName}s`}`;
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function buildErrorReport(failedItems: DownloadFailure[], lastRun: LastRunState): string {
  const lines = [
    "Gather Box error report",
    `Generated: ${new Date().toISOString()}`,
    `Site: ${lastRun.siteKey ?? "unknown"}`,
    `Page: ${lastRun.tabUrl ?? "unknown"}`,
    `Destination: ${lastRun.destinationPreview ?? "unknown"}`,
    "",
    ...failedItems.map((item) => {
      const url = item.originalUrl ? `\n  URL: ${item.originalUrl}` : "";
      return `- ${item.fileName}: ${item.reason}${url}`;
    })
  ];

  return lines.join("\n");
}
