import { getActiveTab } from "../gather/active-tab";
import { directoryStore, type DirectoryStore } from "../gather/directory-store";
import {
  addLog,
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
import { formatError, isAbortError, toError } from "../gather/errors";
import type { PopupStatus } from "../gather/status";
import {
  getSiteKeyFromUrl,
  isSupportedUrl,
  type SiteKey
} from "./sites";
import { getGatherSource } from "./source-catalog";
import {
  EMPTY_LAST_RUN,
  LastRunWriter,
  loadLastRun,
  type LastRunLogEntry,
  type LastRunState
} from "./last-run";
import {
  isTerminalGatherRunPhase,
  type GatherRunState
} from "./gather-run";
import {
  CANCEL_GATHER_RUN_REQUEST,
  RETRY_GATHER_RUN_REQUEST,
  START_GATHER_RUN_REQUEST,
  type GatherRunCancelOutcome,
  type GatherRunResponse
} from "./gather-run-messages";
import {
  GATHER_QUEUE_STATE_KEY,
  getGatherQueueDisplayRun,
  getLatestGatherQueueResult,
  getRetryableGatherQueueResult,
  loadGatherQueue,
  GatherQueueStateSchema,
  type GatherQueueState
} from "./gather-queue";
import { DEFAULT_SETTINGS, loadSettings, type GatherBoxSettings } from "./settings";
import { installShortcutKeyListener } from "./shortcut-keys";

interface PopupState {
  activeTab: chrome.tabs.Tab | null;
  siteKey: SiteKey | null;
  directoryHandle: FileSystemDirectoryHandle | null;
  status: PopupStatus;
  running: boolean;
  activeRunId: string | null;
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
  /** Replaceable so tests can drive folder permission outcomes without a real handle store. */
  directoryStore?: DirectoryStore;
}

export class GatherController {
  private readonly state: PopupState = {
    activeTab: null,
    siteKey: null,
    directoryHandle: null,
    status: "idle",
    running: false,
    activeRunId: null,
    settings: { ...DEFAULT_SETTINGS },
    lastRun: { ...EMPTY_LAST_RUN }
  };

  private elements!: PopupElements;
  private logEntries: LastRunLogEntry[] = [];
  private readonly lastRunWriter = new LastRunWriter();
  private readonly options: GatherControllerOptions;
  /** Retry writes under the failed run's site, not whichever tab is active now. */
  private retryTarget: { runId: string; siteKey: SiteKey } | null = null;
  private keydownHandler: ((event: KeyboardEvent) => void) | null = null;
  private shortcutCleanup: (() => void) | null = null;
  private storageHandler:
    | ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void)
    | null = null;
  private tabActivatedHandler: ((activeInfo: { tabId: number; windowId: number }) => void) | null =
    null;
  private tabUpdatedHandler:
    | ((
        tabId: number,
        changeInfo: { status?: string; url?: string },
        tab: chrome.tabs.Tab
      ) => void)
    | null = null;

  private readonly directories: DirectoryStore;

  constructor(options: GatherControllerOptions = {}) {
    this.options = options;
    this.directories = options.directoryStore ?? directoryStore;
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
    this.elements.cancelButton.addEventListener("click", () => {
      void this.handleCancel();
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
      if (areaName === "local" && changes[GATHER_QUEUE_STATE_KEY]?.newValue) {
        this.applyGatherQueue(
          GatherQueueStateSchema.parse(changes[GATHER_QUEUE_STATE_KEY].newValue)
        );
      }
    };
    chrome.storage.onChanged.addListener(this.storageHandler);

    this.tabActivatedHandler = () => {
      void this.detectActiveTab();
    };
    this.tabUpdatedHandler = (_tabId, changeInfo) => {
      if (changeInfo.status === "complete" || changeInfo.url) {
        void this.detectActiveTab();
      }
    };
    chrome.tabs.onActivated.addListener(this.tabActivatedHandler);
    chrome.tabs.onUpdated.addListener(this.tabUpdatedHandler);

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
    this.applyGatherQueue(await loadGatherQueue());
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
    if (this.tabActivatedHandler) {
      chrome.tabs.onActivated.removeListener(this.tabActivatedHandler);
      this.tabActivatedHandler = null;
    }
    if (this.tabUpdatedHandler) {
      chrome.tabs.onUpdated.removeListener(this.tabUpdatedHandler);
      this.tabUpdatedHandler = null;
    }
  }

  private async detectActiveTab(): Promise<void> {
    try {
      const tab = await getActiveTab();
      this.state.activeTab = tab;

      if (!tab || tab.id === undefined || !tab.url) {
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
          "This isn't a supported page. Open an X, Reddit post, pixiv artwork, AO3, or fanfiction.net page."
        );
        updateSaveBehavior(this.state.siteKey);
        await this.restoreSavedDirectoryHandle();
        this.syncPopupActions();
        return;
      }

      this.state.siteKey = getSiteKeyFromUrl(tab.url);
      setPageState(this.elements, true);
      updateSaveBehavior(this.state.siteKey);
      await this.restoreSavedDirectoryHandle();
      this.syncPopupActions();
    } catch (error) {
      this.state.siteKey = null;
      this.state.directoryHandle = null;
      setPageState(this.elements, false, formatError(toError(error)));
      updateSaveBehavior(this.state.siteKey);
      this.syncPopupActions();
    }
  }

  private async handleChooseFolder(): Promise<void> {
    if (this.state.running) {
      return;
    }

    const pickerWindow: DirectoryPickerWindow = window;
    const showDirectoryPicker = pickerWindow.showDirectoryPicker;
    if (!showDirectoryPicker) {
      this.setStatus("error");
      this.appendLog("Folder picking is unavailable in this context.", "error");
      this.elements.folderDetail.textContent =
        "This browser context does not support showDirectoryPicker().";
      return;
    }

    try {
      this.setStatus("pickingFolder");
      const directoryHandle = await showDirectoryPicker.call(pickerWindow, {
        mode: "readwrite"
      });
      await this.setDirectoryHandle(directoryHandle);
      this.elements.folderDetail.textContent = this.state.siteKey
        ? `Remembered for ${this.directories.getDirectoryScopeLabel(this.state.settings.useGlobalFolder)}.`
        : "Available for this session.";
      this.appendLog(`Folder selected: ${directoryHandle.name}`, "success");
      this.setStatus("idle");
    } catch (error) {
      if (isAbortError(toError(error))) {
        this.setStatus("idle");
        this.appendLog("Folder selection canceled.", "error");
      } else {
        this.setStatus("error");
        this.appendLog(`Failed to choose folder: ${formatError(toError(error))}`, "error");
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
      await this.directories.clearDirectoryHandle(this.state.siteKey, this.state.settings.useGlobalFolder);
      this.state.directoryHandle = null;
      setFolder(
        this.elements,
        "No folder selected",
        `Choose a writable folder for ${this.directories.getDirectoryScopeLabel(this.state.settings.useGlobalFolder)}.`
      );
      this.appendLog("Cleared remembered folder.", "success");
      this.setStatus("idle");
    } catch (error) {
      this.setStatus("error");
      this.appendLog(`Failed to clear folder: ${formatError(toError(error))}`, "error");
    } finally {
      this.syncPopupActions();
    }
  }

  private async handleDownload(allowPermissionPrompt: boolean): Promise<void> {
    if (this.state.running) {
      return;
    }

    await this.detectActiveTab();

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
      const permission = await this.directories.ensureDirectoryPermission(this.state.directoryHandle, true);
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
    if (tabId === undefined) {
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
      if (response.outcome === "started" || response.outcome === "queued") {
        this.applyGatherRun(response.run);
        if (response.outcome === "queued") {
          this.appendLog(`Added to queue at position ${response.position}.`, "success");
        }
      } else if (response.outcome === "unsupported-source") {
        this.appendLog("Active tab is not a supported Gather Source.", "error");
      } else if (response.outcome === "target-unavailable") {
        this.appendLog("The source tab is no longer available.", "error");
      } else {
        this.appendLog(response.message, "error");
      }
    } catch (error) {
      this.appendLog(`Could not start Gather Run: ${formatError(toError(error))}`, "error");
    } finally {
      this.state.running = false;
      this.syncPopupActions();
    }
  }

  private async handleCancel(): Promise<void> {
    const runId = this.state.activeRunId;
    if (!runId) {
      return;
    }

    try {
      const response = await chrome.runtime.sendMessage<
        { type: typeof CANCEL_GATHER_RUN_REQUEST; target: "background"; runId: string },
        GatherRunCancelOutcome
      >({ type: CANCEL_GATHER_RUN_REQUEST, target: "background", runId });
      if (response.outcome === "cancelled") {
        this.applyGatherRun(response.run);
        this.appendLog("Gather Run cancelled.", "error");
      } else if (response.outcome === "failed") {
        this.appendLog(response.message, "error");
      }
    } catch (error) {
      this.appendLog(`Could not cancel Gather Run: ${formatError(toError(error))}`, "error");
    }
  }

  private async handleRetryFailed(): Promise<void> {
    if (this.state.running || !this.state.lastRun.canRetry || this.state.lastRun.retryImages.length === 0) {
      return;
    }

    const target = this.retryTarget;
    if (!target) {
      this.appendLog("No retryable Gather Run was found.", "error");
      return;
    }

    // The executor reloads this same handle by the run's site, so confirm access to that folder
    // rather than the active tab's — the two differ whenever you retry from another tab.
    const scopeLabel = getGatherSource(target.siteKey)?.label ?? target.siteKey;
    const directoryHandle = await this.directories.loadDirectoryHandle(
      target.siteKey,
      this.state.settings.useGlobalFolder
    );
    if (!directoryHandle) {
      this.appendLog(`Choose a folder for ${scopeLabel} before retrying.`, "error");
      return;
    }
    const permission = await this.directories.ensureDirectoryPermission(directoryHandle, true);
    if (permission === "requires-user-activation") {
      this.appendLog("Folder access needs confirmation. Click Retry Failed again.", "error");
      return;
    }
    if (permission !== "granted") {
      this.appendLog(`Folder for ${scopeLabel} is no longer writable. Choose it again.`, "error");
      return;
    }
    const response = await chrome.runtime.sendMessage<
      { type: typeof RETRY_GATHER_RUN_REQUEST; target: "background"; runId: string },
      GatherRunResponse
    >({ type: RETRY_GATHER_RUN_REQUEST, target: "background", runId: target.runId });
    if (response.outcome === "started" || response.outcome === "queued") {
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
      this.appendLog(`Could not copy error report: ${formatError(toError(error))}`, "error");
      setLogExpanded(this.elements, true);
    }
  }

  private async restoreSavedDirectoryHandle(): Promise<void> {
    const scopeLabel = this.directories.getDirectoryScopeLabel(this.state.settings.useGlobalFolder);
    this.state.directoryHandle = null;

    if (!this.state.siteKey && !this.state.settings.useGlobalFolder) {
      setFolder(this.elements, "No folder selected", `Choose a writable folder for ${scopeLabel}.`);
      return;
    }

    try {
      const directoryHandle = await this.directories.loadDirectoryHandle(
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
      this.elements.folderDetail.textContent = `Could not restore folder: ${formatError(toError(error))}`;
    }
  }

  private async setDirectoryHandle(directoryHandle: FileSystemDirectoryHandle): Promise<void> {
    this.state.directoryHandle = directoryHandle;
    this.elements.folderName.textContent = directoryHandle.name;

    try {
      await this.directories.saveDirectoryHandle(
        this.state.siteKey,
        directoryHandle,
        this.state.settings.useGlobalFolder
      );
    } catch (error) {
      this.appendLog(`Folder could not be persisted: ${formatError(toError(error))}`, "error");
      this.elements.folderDetail.textContent = "Works for this session only.";
    }
  }

  private isSupportedTab(): boolean {
    return Boolean(this.state.activeTab?.url && isSupportedUrl(this.state.activeTab.url));
  }

  private syncPopupActions(): void {
    const hasActiveJob = Boolean(this.state.activeRunId);
    const runInFlight =
      hasActiveJob &&
      (this.state.status === "collecting" ||
        this.state.status === "queued" ||
        this.state.status === "downloading");
    syncActions(
      this.elements,
      this.isSupportedTab() && Boolean(this.state.directoryHandle) && !this.state.running,
      this.state.running,
      Boolean(this.state.directoryHandle),
      this.state.lastRun.canRetry && this.state.lastRun.retryImages.length > 0,
      this.state.lastRun.failedItems.length > 0,
      hasActiveJob
    );
    this.elements.downloadButton.textContent = runInFlight ? "Add to Queue" : "Download Content";
  }

  private setStatus(status: PopupStatus): void {
    this.state.status = status;
    setBadge(this.elements, status);

    if (status === "error") {
      setLogExpanded(this.elements, true);
    }
  }

  private applyGatherRun(run: GatherRunState): void {
    this.state.activeRunId = isTerminalGatherRunPhase(run.phase) ? null : run.id;
    const status: PopupStatus =
      run.phase === "complete"
        ? "complete"
        : run.phase === "failed" ||
            run.phase === "interrupted" ||
            run.phase === "cancelled" ||
            run.phase === "permission-required"
          ? "error"
          : run.phase === "queued"
            ? "queued"
            : run.phase === "writing" || run.phase === "cancelling"
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
    if (run.phase === "complete") {
      flashDownloadComplete(this.elements);
    }
    this.syncPopupActions();
  }

  private applyGatherQueue(queue: GatherQueueState): void {
    const displayed = getGatherQueueDisplayRun(queue);
    const latest = getLatestGatherQueueResult(queue);
    const retryable = getRetryableGatherQueueResult(queue);

    if (displayed) {
      this.applyGatherRun(displayed);
    } else if (latest) {
      this.applyGatherRun(latest);
    }

    const actionResult = retryable ?? latest;
    if (actionResult) {
      this.state.lastRun = lastRunFromGatherResult(actionResult);
      this.retryTarget = retryable ? { runId: retryable.id, siteKey: retryable.siteKey } : null;
    } else {
      this.retryTarget = null;
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

function lastRunFromGatherResult(run: GatherRunState): LastRunState {
  return {
    timestamp: run.updatedAt,
    siteKey: run.siteKey,
    tabUrl: run.tabUrl,
    destinationPreview: run.destinationPreview,
    log: run.log,
    failedItems: run.failedItems,
    retryImages: run.retryImages,
    canRetry: run.retryImages.length > 0
  };
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
