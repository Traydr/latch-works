import { getActiveTab } from "../gather/active-tab";
import {
  clearDirectoryHandle,
  ensureDirectoryPermission,
  getDirectoryScopeLabel,
  loadDirectoryHandle,
  saveDirectoryHandle
} from "../gather/directory-store";
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
  syncActions,
  updateSaveBehavior,
  type LogTone,
  type PopupElements
} from "../gather/dom";
import { formatError } from "../gather/errors";
import type { PopupStatus } from "../gather/status";
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
import { GATHER_RUN_STATE_KEY, normalizeGatherRunState, type GatherRunState } from "./gather-run";
import {
  RETRY_GATHER_RUN_REQUEST,
  START_GATHER_RUN_REQUEST,
  type GatherRunResponse
} from "./gather-run-messages";
import { loadGatherRun } from "./gather-run-store";
import { loadSettings, type GatherBoxSettings } from "./settings";
import { installShortcutKeyListener } from "./shortcut-keys";

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
    settings: {
      downloadConcurrency: 4,
      useGlobalFolder: false,
      verboseLogging: false,
      pageShortcutsEnabled: true,
      credentialsMode: "auto",
      credentialsPerSite: {}
    },
    lastRun: { ...EMPTY_LAST_RUN }
  };

  private elements!: PopupElements;
  private logEntries: LastRunLogEntry[] = [];
  private readonly lastRunWriter = new LastRunWriter();
  private readonly options: GatherControllerOptions;
  private keydownHandler: ((event: KeyboardEvent) => void) | null = null;
  private shortcutCleanup: (() => void) | null = null;
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
      () => this.state.settings.pageShortcutsEnabled,
      (action) => {
        if (action === "toggle") {
          this.options.onToggleShortcut?.();
          return;
        }

        void this.handleDownload(true);
      }
    );

    this.storageHandler = (changes, areaName) => {
      if (areaName === "sync" && changes["gather-box-settings"]) {
        void this.refreshSettings();
      }
      if (areaName === "local" && changes[GATHER_RUN_STATE_KEY]?.newValue) {
        const run = normalizeGatherRunState(changes[GATHER_RUN_STATE_KEY].newValue);
        if (run) {
          this.applyGatherRun(run);
        }
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
    const currentRun = await loadGatherRun();
    if (currentRun) {
      this.applyGatherRun(currentRun);
    }
    this.syncPopupActions();

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
          "This isn't a supported page. Open an X or Reddit post, pixiv artwork, MyHentaiGallery, Kemono, FANBOX, AO3, Hentai Foundry, or fanfiction.net page."
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

    if (allowPermissionPrompt) {
      const permission = await ensureDirectoryPermission(this.state.directoryHandle, true);
      if (permission === "requires-user-activation") {
        this.appendLog("Folder access needs confirmation. Click Download Content again.", "error");
        this.syncPopupActions();
        return;
      }
      if (permission !== "granted") {
        this.appendLog("Folder is no longer writable. Choose it again.", "error");
        this.syncPopupActions();
        return;
      }
    }

    const tabId = this.state.activeTab?.id;
    if (typeof tabId !== "number") {
      this.appendLog("No active source tab is available.", "error");
      return;
    }

    this.state.running = true;
    this.setStatus("collecting");
    this.syncPopupActions();
    try {
      const response = await chrome.runtime.sendMessage<
        { type: typeof START_GATHER_RUN_REQUEST; target: "background"; tabId: number },
        GatherRunResponse
      >({ type: START_GATHER_RUN_REQUEST, target: "background", tabId });
      if (response.outcome === "started" || response.outcome === "already-running") {
        this.applyGatherRun(response.run);
      } else if (response.outcome === "unsupported-source") {
        this.appendLog("Active tab is not a supported Gather Source.", "error");
      } else if (response.outcome === "target-unavailable") {
        this.appendLog("The source tab is no longer available.", "error");
      } else {
        this.appendLog(response.message, "error");
      }
    } catch (error) {
      this.appendLog(`Could not start Gather Run: ${formatError(error)}`, "error");
    } finally {
      this.state.running = false;
      this.syncPopupActions();
    }
  }

  private async handleRetryFailed(): Promise<void> {
    if (this.state.running || !this.state.lastRun.canRetry || this.state.lastRun.retryImages.length === 0) {
      return;
    }

    const run = await loadGatherRun();
    if (!run || run.retryImages.length === 0) {
      this.appendLog("No retryable Gather Run was found.", "error");
      return;
    }
    if (!this.state.directoryHandle) {
      this.appendLog("Choose a folder before retrying.", "error");
      return;
    }
    const permission = await ensureDirectoryPermission(this.state.directoryHandle, true);
    if (permission !== "granted") {
      this.appendLog("Folder is no longer writable. Choose it again.", "error");
      return;
    }
    const response = await chrome.runtime.sendMessage<
      { type: typeof RETRY_GATHER_RUN_REQUEST; target: "background"; runId: string },
      GatherRunResponse
    >({ type: RETRY_GATHER_RUN_REQUEST, target: "background", runId: run.id });
    if (response.outcome === "started" || response.outcome === "already-running") {
      this.applyGatherRun(response.run);
    } else if (response.outcome === "failed") {
      this.appendLog(response.message, "error");
    }
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

  private applyGatherRun(run: GatherRunState): void {
    const status: PopupStatus =
      run.phase === "complete"
        ? "complete"
        : run.phase === "failed" || run.phase === "interrupted" || run.phase === "permission-required"
          ? "error"
          : run.phase === "writing"
            ? "downloading"
            : "collecting";
    this.setStatus(status);
    setProgress(
      this.elements,
      run.progress.completed,
      run.progress.total || 1,
      run.progress.message
    );
    if (run.destinationPreview) {
      setDestinationPreview(this.elements, run.destinationPreview);
    }
    this.logEntries = [...run.log];
    restoreLog(this.elements, this.logEntries);
    this.state.lastRun = {
      timestamp: run.updatedAt,
      siteKey: run.siteKey,
      tabUrl: run.tabUrl,
      destinationPreview: run.destinationPreview,
      log: run.log,
      failedItems: run.failedItems,
      retryImages: run.retryImages,
      canRetry: run.retryImages.length > 0
    };
    if (run.phase === "complete") {
      flashDownloadComplete(this.elements);
    }
    this.syncPopupActions();
  }

  private appendLog(message: string, tone?: LogTone): void {
    addLog(this.elements, message, tone);
    this.logEntries.push({ message, tone });
    void this.persistLastRun({});
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

function resetProgress(elements: PopupElements): void {
  elements.progressBar.max = 1;
  elements.progressBar.value = 0;
  elements.progressText.textContent = "Waiting for a supported page and folder.";
  setDestinationPreview(elements, "");
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function buildErrorReport(failedItems: LastRunState["failedItems"], lastRun: LastRunState): string {
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
