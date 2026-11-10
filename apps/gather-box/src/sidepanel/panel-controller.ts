import {
  GATHER_QUEUE_STATE_KEY,
  OPTIONS_PAGE_PATH,
  PROFILES_KEY,
  SETTINGS_KEY,
} from "../shared/constants";
import {
  clearDirectoryHandle,
  ensureDirectoryPermission,
  loadDirectoryHandle,
  saveDirectoryHandle,
} from "../shared/directory-store";
import { isAllowedDownloadUrl } from "../shared/download-policy";
import { isAbortError, toError } from "../shared/errors";
import {
  EMPTY_GATHER_QUEUE,
  type GatherQueueState,
  GatherQueueStateSchema,
  getGatherQueueBatch,
  getGatherQueueDisplayRun,
  getGatherQueueHandBackItems,
  getLatestGatherQueueResult,
  getRetryableGatherQueueResult,
  type HandBackItem,
  loadGatherQueue,
} from "../shared/gather-queue";
import {
  folderScope,
  type GatherRunPhase,
  type GatherRunState,
  isTerminalGatherRunPhase,
  RUN_CANCELLED_MESSAGE,
} from "../shared/gather-run";
import {
  DEFAULT_PROFILES,
  type GatherProfilesState,
  getDistinguishingProfileName,
  loadProfiles,
  setActiveProfile,
  updateProfiles,
} from "../shared/profiles";
import {
  CANCEL_GATHER_RUN_REQUEST,
  HAND_BACK_GATHER_FILE_REQUEST,
  RETRY_GATHER_RUN_REQUEST,
  START_GATHER_RUN_REQUEST,
  sendPanelRequest,
} from "../shared/protocol/panel";
import { DEFAULT_SETTINGS, type GatherBoxSettings, loadSettings } from "../shared/settings";
import { installShortcutKeyListener } from "../shared/shortcut-keys";
import {
  getGatherSource,
  LISTED_GATHER_SOURCES,
  matchGatherSource,
  type SiteKey,
} from "../shared/source-catalog";
import { describeSaveBehavior } from "../shared/source-policies";
import { getExtension, saveHandedBackFile } from "./hand-back";
import {
  addLog,
  flashDownloadComplete,
  getPanelElements,
  type HandBackAction,
  type LogTone,
  type PanelElements,
  type PanelStatus,
  renderBatch,
  renderHandBack,
  renderProfiles,
  setBadge,
  setDestinationPreview,
  setFolder,
  setLogExpanded,
  setPageState,
  setProgress,
  setQueuedCount,
  setSaveBehavior,
  showRunLog,
  syncActions,
} from "./panel-dom";

/** Names the catalog's listed sources, so the hint follows sources being listed or unlisted. */
const LISTED_SOURCE_NAMES = new Intl.ListFormat("en", { type: "disjunction" }).format(
  LISTED_GATHER_SOURCES.map((source) => source.label),
);

const UNSUPPORTED_PAGE_MESSAGE = `This isn't a supported page. Open a post or story page from ${LISTED_SOURCE_NAMES}.`;

const PANEL_STATUS_BY_PHASE = {
  collecting: "collecting",
  preparing: "collecting",
  queued: "queued",
  "permission-required": "error",
  writing: "downloading",
  cancelling: "downloading",
  complete: "complete",
  failed: "error",
  cancelled: "error",
  interrupted: "error",
} as const satisfies Record<GatherRunPhase, PanelStatus>;

interface PanelState {
  activeTab: chrome.tabs.Tab | null;
  siteKey: SiteKey | null;
  directoryHandle: FileSystemDirectoryHandle | null;
  status: PanelStatus;
  running: boolean;
  activeRunId: string | null;
  settings: GatherBoxSettings;
  profiles: GatherProfilesState;
  /** The run Retry and Copy errors act on: the latest retryable one, else the latest one. */
  actionResult: GatherRunState | null;
}

interface DirectoryPickerWindow extends Window {
  showDirectoryPicker?: (options?: {
    mode?: "read" | "readwrite";
  }) => Promise<FileSystemDirectoryHandle>;
}

/** A file you picked to hand back, held while its folder waits for you to confirm access. */
interface PendingHandBack {
  item: HandBackItem;
  file: File;
  directory: FileSystemDirectoryHandle;
}

export class PanelController {
  private readonly state: PanelState = {
    activeTab: null,
    siteKey: null,
    directoryHandle: null,
    status: "idle",
    running: false,
    activeRunId: null,
    settings: { ...DEFAULT_SETTINGS },
    profiles: DEFAULT_PROFILES,
    actionResult: null,
  };

  private elements!: PanelElements;
  /** Retry writes under the failed run's site, not whichever tab is active now. */
  private retryTarget: { runId: string; siteKey: SiteKey } | null = null;
  private queue: GatherQueueState = EMPTY_GATHER_QUEUE;
  /** The finished run whose log is shown; null follows the run in progress. */
  private viewedRunId: string | null = null;
  private handBackItems: HandBackItem[] = [];
  /** The blocked file whose file picker is open. */
  private handBackTarget: HandBackItem | null = null;
  private pendingHandBack: PendingHandBack | null = null;
  /** Bumped on every folder restore, so a slower earlier restore cannot overwrite a newer one. */
  private folderRestoreToken = 0;

  constructor(private readonly onToggleShortcut: () => void) {}

  async init(document: Document): Promise<void> {
    this.elements = getPanelElements(document);

    this.elements.chooseFolder.addEventListener("click", () => {
      void this.handleChooseFolder();
    });
    this.elements.clearFolder.addEventListener("click", () => {
      void this.handleClearFolder();
    });
    this.elements.downloadButton.addEventListener("click", () => {
      void this.handleDownload();
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
    this.elements.profileSelect.addEventListener("change", () => {
      void this.handleSelectProfile(this.elements.profileSelect.value);
    });
    this.elements.manageProfiles.addEventListener("click", () => {
      void chrome.tabs.create({ url: chrome.runtime.getURL(`${OPTIONS_PAGE_PATH}#profiles`) });
    });
    this.elements.batchRuns.addEventListener("click", (event) => {
      const row = event.target instanceof Element ? event.target.closest("li") : null;

      if (row instanceof HTMLElement && row.dataset.runId) {
        this.handleViewRun(row.dataset.runId);
      }
    });
    this.elements.handBackItems.addEventListener("click", (event) => {
      const button = event.target instanceof Element ? event.target.closest("button") : null;
      const row = button?.closest("li");

      const item =
        row instanceof HTMLElement ? this.handBackItems[Number(row.dataset.index)] : undefined;

      const action = button?.dataset.action;

      if (item && (action === "open" || action === "add")) {
        void this.handleHandBackAction(action, item);
      }
    });
    this.elements.handBackFile.addEventListener("change", () => {
      void this.handleHandBackFile();
    });

    document.addEventListener("keydown", (event) => {
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
      void this.handleDownload();
    });

    installShortcutKeyListener(
      document,
      () => this.state.settings.pageShortcutsEnabled,
      (action) => {
        if (action === "toggle") {
          this.onToggleShortcut();

          return;
        }

        void this.handleDownload();
      },
    );

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "sync" && changes[SETTINGS_KEY]) {
        void this.refreshSettings();
      }

      if (areaName === "sync" && changes[PROFILES_KEY]) {
        void this.refreshProfiles();
      }

      if (areaName === "local" && changes[GATHER_QUEUE_STATE_KEY]?.newValue) {
        this.applyGatherQueue(
          GatherQueueStateSchema.parse(changes[GATHER_QUEUE_STATE_KEY].newValue),
        );
      }
    });

    chrome.tabs.onActivated.addListener(() => {
      void this.detectActiveTab();
    });

    chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
      if (changeInfo.status === "complete" || changeInfo.url) {
        void this.detectActiveTab();
      }
    });

    this.state.settings = await loadSettings();
    this.state.profiles = await loadProfiles();

    this.setStatus("idle");
    resetProgress(this.elements);
    showRunLog(this.elements, null, []);

    await this.detectActiveTab();
    await this.restoreSavedDirectoryHandle();
    this.applyGatherQueue(await loadGatherQueue());
    this.syncPanelActions();
  }

  private async refreshSettings(): Promise<void> {
    this.state.settings = await loadSettings();
    await this.restoreSavedDirectoryHandle();
    this.syncPanelActions();
  }

  private async refreshProfiles(): Promise<void> {
    await this.applyProfiles(await loadProfiles());
  }

  private async detectActiveTab(): Promise<void> {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      this.state.activeTab = tab ?? null;

      if (!tab || tab.id === undefined || !tab.url) {
        this.state.siteKey = null;
        setPageState(
          this.elements,
          false,
          "No active page detected. Open a supported post page, then reopen Gather Box.",
        );
      } else {
        this.state.siteKey = matchGatherSource(tab.url)?.source.key ?? null;
        setPageState(this.elements, this.state.siteKey !== null, UNSUPPORTED_PAGE_MESSAGE);
      }

      await this.restoreSavedDirectoryHandle();
      this.syncPanelActions();
    } catch (error) {
      this.state.siteKey = null;
      this.state.directoryHandle = null;
      setPageState(this.elements, false, toError(error).message);
      this.syncPanelActions();
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
        mode: "readwrite",
      });

      await this.setDirectoryHandle(directoryHandle);
      this.elements.folderDetail.textContent = this.state.siteKey
        ? ""
        : "Available for this session.";
      this.appendLog(`Folder selected: ${directoryHandle.name}`, "success");
      this.setStatus("idle");
    } catch (error) {
      if (isAbortError(toError(error))) {
        this.setStatus("idle");
        this.appendLog("Folder selection canceled.", "error");
      } else {
        this.setStatus("error");
        this.appendLog(`Failed to choose folder: ${toError(error).message}`, "error");
      }
    } finally {
      this.syncPanelActions();
    }
  }

  private async handleSelectProfile(profileId: string): Promise<void> {
    if (this.state.running || profileId === this.state.profiles.activeProfileId) {
      return;
    }

    try {
      await this.applyProfiles(await updateProfiles((state) => setActiveProfile(state, profileId)));
    } catch (error) {
      this.appendLog(`Could not switch profile: ${toError(error).message}`, "error");
      this.syncPanelActions();
    }
  }

  /**
   * Any change can alter the Folder line: switching profiles picks another folder, and adding or
   * deleting one changes whether the hint names the profile.
   */
  private async applyProfiles(profiles: GatherProfilesState): Promise<void> {
    this.state.profiles = profiles;
    await this.restoreSavedDirectoryHandle();
    this.syncPanelActions();
  }

  private async handleClearFolder(): Promise<void> {
    if (this.state.running) {
      return;
    }

    try {
      const scope = this.getFolderScope();

      if (scope) {
        await clearDirectoryHandle(scope, this.state.profiles.activeProfileId);
      }

      this.state.directoryHandle = null;
      setFolder(
        this.elements,
        "No folder selected",
        `Choose a writable folder for ${this.getScopeLabel()}.`,
      );
      this.appendLog("Cleared remembered folder.", "success");
      this.setStatus("idle");
    } catch (error) {
      this.setStatus("error");
      this.appendLog(`Failed to clear folder: ${toError(error).message}`, "error");
    } finally {
      this.syncPanelActions();
    }
  }

  private async handleDownload(): Promise<void> {
    if (this.state.running) {
      return;
    }

    await this.detectActiveTab();

    if (!this.isSupportedTab()) {
      this.appendLog("Active tab is not a supported content page.", "error");
      this.syncPanelActions();

      return;
    }

    // The folder and its profile are read together, before the permission prompt can wait on
    // the user, so a profile switched in the meantime cannot pair one with the other.
    const { directoryHandle } = this.state;
    const profileId = this.state.profiles.activeProfileId;

    if (!directoryHandle) {
      this.appendLog("Choose a folder before downloading.", "error");
      this.syncPanelActions();

      return;
    }

    const permission = await ensureDirectoryPermission(directoryHandle, true);

    if (permission === "requires-user-activation") {
      this.appendLog("Folder access needs confirmation. Click Download Content again.", "error");
      this.syncPanelActions();

      return;
    }

    if (permission !== "granted") {
      this.appendLog("Folder is no longer writable. Choose it again.", "error");
      this.syncPanelActions();

      return;
    }

    const tabId = this.state.activeTab?.id;

    if (tabId === undefined) {
      this.appendLog("No active source tab is available.", "error");

      return;
    }

    this.state.running = true;
    this.setStatus("collecting");
    this.syncPanelActions();

    try {
      const response = await sendPanelRequest({
        type: START_GATHER_RUN_REQUEST,
        target: "background",
        tabId,
        profileId,
      });

      if (response.outcome === "started" || response.outcome === "queued") {
        this.viewedRunId = null;
        this.applyGatherRun(response.run);

        if (response.outcome === "queued") {
          this.appendLog(`Added to queue at position ${response.position}.`, "success");
        }
      } else if (response.outcome === "unsupported-source") {
        this.appendLog("Active tab is not a supported Gather Source.", "error");
      } else if (response.outcome === "target-unavailable") {
        this.appendLog("The source tab is no longer available.", "error");
      } else {
        this.appendLog(`Could not start Gather Run: ${response.message}`, "error");
      }
    } finally {
      this.state.running = false;
      this.syncPanelActions();
    }
  }

  private async handleCancel(): Promise<void> {
    const runId = this.state.activeRunId;

    if (!runId) {
      return;
    }

    const response = await sendPanelRequest({
      type: CANCEL_GATHER_RUN_REQUEST,
      target: "background",
      runId,
    });

    if (response.outcome === "cancelled") {
      this.applyGatherRun(response.run);
      this.appendLog(RUN_CANCELLED_MESSAGE, "error");
    } else if (response.outcome === "failed") {
      this.appendLog(`Could not cancel Gather Run: ${response.message}`, "error");
    }
  }

  private async handleRetryFailed(): Promise<void> {
    if (this.state.running) {
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
    const profileId = this.state.profiles.activeProfileId;

    const directoryHandle = await loadDirectoryHandle(
      folderScope(target.siteKey, this.state.settings.useGlobalFolder),
      profileId,
    );

    if (!directoryHandle) {
      this.appendLog(`Choose a folder for ${scopeLabel} before retrying.`, "error");

      return;
    }

    const permission = await ensureDirectoryPermission(directoryHandle, true);

    if (permission === "requires-user-activation") {
      this.appendLog("Folder access needs confirmation. Click Retry Failed again.", "error");

      return;
    }

    if (permission !== "granted") {
      this.appendLog(`Folder for ${scopeLabel} is no longer writable. Choose it again.`, "error");

      return;
    }

    const response = await sendPanelRequest({
      type: RETRY_GATHER_RUN_REQUEST,
      target: "background",
      runId: target.runId,
      profileId,
    });

    if (response.outcome === "started" || response.outcome === "queued") {
      this.viewedRunId = null;
      this.applyGatherRun(response.run);
    } else if (response.outcome === "failed") {
      this.appendLog(`Could not retry: ${response.message}`, "error");
    }
  }

  private async handleCopyErrors(): Promise<void> {
    const result = this.state.actionResult;

    if (!result || result.failedItems.length === 0) {
      return;
    }

    const report = buildErrorReport(result);

    try {
      await navigator.clipboard.writeText(report);
      this.appendLog("Copied error report to clipboard.", "success");
    } catch (error) {
      this.appendLog(`Could not copy error report: ${toError(error).message}`, "error");
      setLogExpanded(this.elements, true);
    }
  }

  private async handleHandBackAction(action: HandBackAction, item: HandBackItem): Promise<void> {
    if (action === "open") {
      // The link is opened as an ordinary page visit, so any check the site shows is yours to pass.
      if (!isAllowedDownloadUrl(item.siteKey, item.originalUrl)) {
        this.appendLog(`Could not open ${item.fileName}: its link is not allowed.`, "error");

        return;
      }

      await chrome.tabs.create({ url: item.originalUrl, active: true });

      return;
    }

    const pending = this.pendingHandBack;

    if (pending && isSameHandBackItem(pending.item, item)) {
      // The file was already picked; this click is the user activation the folder prompt needs,
      // so the request comes before anything else is awaited.
      const permission = await ensureDirectoryPermission(pending.directory, true);

      if (permission !== "granted") {
        this.appendLog("Folder is no longer writable. Choose it again.", "error");

        return;
      }

      this.pendingHandBack = null;
      await this.saveHandBack(pending);

      return;
    }

    // The picker needs this click's activation, so it opens before anything is awaited.
    this.handBackTarget = item;
    const input = this.elements.handBackFile;
    input.accept = getExtension(item.fileName);
    input.value = "";
    input.click();
  }

  private async handleHandBackFile(): Promise<void> {
    const item = this.handBackTarget;
    const file = this.elements.handBackFile.files?.[0];
    this.handBackTarget = null;

    if (!item || !file) {
      return;
    }

    // Like Retry, the file goes to the folder remembered now for the run's source, in the
    // profile chosen now.
    const scopeLabel = getGatherSource(item.siteKey)?.label ?? item.siteKey;

    try {
      const directory = await loadDirectoryHandle(
        folderScope(item.siteKey, this.state.settings.useGlobalFolder),
        this.state.profiles.activeProfileId,
      );

      if (!directory) {
        this.appendLog(`Choose a folder for ${scopeLabel} before adding files.`, "error");

        return;
      }

      const permission = await ensureDirectoryPermission(directory, false);

      if (permission === "requires-user-activation") {
        this.pendingHandBack = { item, file, directory };
        this.appendLog(
          `Folder access needs confirmation. Click Add file for ${item.fileName} again.`,
          "error",
        );

        return;
      }

      if (permission !== "granted") {
        this.appendLog(`Folder for ${scopeLabel} is no longer writable. Choose it again.`, "error");

        return;
      }

      await this.saveHandBack({ item, file, directory });
    } catch (error) {
      this.appendLog(`Could not add ${file.name}: ${toError(error).message}`, "error");
    }
  }

  private async saveHandBack(handBack: PendingHandBack): Promise<void> {
    const { item, file, directory } = handBack;

    try {
      const saved = await saveHandedBackFile({
        item,
        file,
        rootDirectory: directory,
        settings: this.state.settings,
      });

      const response = await sendPanelRequest({
        type: HAND_BACK_GATHER_FILE_REQUEST,
        target: "background",
        runId: item.runId,
        fileName: item.fileName,
        savedFileName: saved.fileName,
      });

      // A recorded file shows up in the run's own log once the queue updates.
      if (response.outcome === "not-listed") {
        this.appendLog(
          `Saved ${saved.fileName}. Its run no longer lists it as blocked.`,
          "success",
        );
      } else if (response.outcome === "failed") {
        this.appendLog(
          `Saved ${saved.fileName}, but could not record it: ${response.message}`,
          "error",
        );
      }
    } catch (error) {
      this.appendLog(`Could not add ${file.name}: ${toError(error).message}`, "error");
    }
  }

  private async restoreSavedDirectoryHandle(): Promise<void> {
    const scopeLabel = this.getScopeLabel();
    const token = ++this.folderRestoreToken;
    this.state.directoryHandle = null;

    const scope = this.getFolderScope();

    if (!scope) {
      setFolder(this.elements, "No folder selected", `Choose a writable folder for ${scopeLabel}.`);

      return;
    }

    try {
      const directoryHandle = await loadDirectoryHandle(scope, this.state.profiles.activeProfileId);

      if (token !== this.folderRestoreToken) {
        return;
      }

      if (!directoryHandle) {
        setFolder(
          this.elements,
          "No folder selected",
          `Choose a writable folder for ${scopeLabel}.`,
        );

        return;
      }

      this.state.directoryHandle = directoryHandle;
      setFolder(this.elements, directoryHandle.name, "");
    } catch (error) {
      if (token === this.folderRestoreToken) {
        this.elements.folderDetail.textContent = `Could not restore folder: ${toError(error).message}`;
      }
    }
  }

  /** The remembered folder the active tab writes to; null without a site in per-site mode. */
  private getFolderScope() {
    return folderScope(this.state.siteKey, this.state.settings.useGlobalFolder);
  }

  /** Where a remembered folder applies, naming the profile once there is more than one. */
  private getScopeLabel(): string {
    const scope = this.state.settings.useGlobalFolder ? "all sites" : "this site";
    const { profiles } = this.state;
    const profileName = getDistinguishingProfileName(profiles, profiles.activeProfileId);

    return profileName ? `${scope} in "${profileName}"` : scope;
  }

  private async setDirectoryHandle(directoryHandle: FileSystemDirectoryHandle): Promise<void> {
    this.state.directoryHandle = directoryHandle;
    this.elements.folderName.textContent = directoryHandle.name;

    const scope = this.getFolderScope();

    try {
      if (!scope) {
        throw new Error("Open a supported page to remember a folder for its site.");
      }

      await saveDirectoryHandle(scope, directoryHandle, this.state.profiles.activeProfileId);
    } catch (error) {
      this.appendLog(`Folder could not be persisted: ${toError(error).message}`, "error");
      this.elements.folderDetail.textContent = "Works for this session only.";
    }
  }

  private isSupportedTab(): boolean {
    return this.state.siteKey !== null;
  }

  private syncPanelActions(): void {
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
      this.retryTarget !== null,
      (this.state.actionResult?.failedItems.length ?? 0) > 0,
      hasActiveJob,
    );
    this.elements.downloadButton.textContent = runInFlight ? "Add to Queue" : "Download Content";
    renderProfiles(this.elements, this.state.profiles, this.state.running);
    setSaveBehavior(
      this.elements,
      describeSaveBehavior(this.state.siteKey, this.state.settings),
      this.state.directoryHandle?.name ?? null,
    );
  }

  private setStatus(status: PanelStatus): void {
    this.state.status = status;
    setBadge(this.elements, status);

    if (status === "error") {
      setLogExpanded(this.elements, true);
    }
  }

  private applyGatherRun(run: GatherRunState): void {
    this.state.activeRunId = isTerminalGatherRunPhase(run.phase) ? null : run.id;

    this.setStatus(PANEL_STATUS_BY_PHASE[run.phase]);
    setProgress(
      this.elements,
      run.progress.completed,
      run.progress.total || 1,
      run.progress.message,
    );

    if (run.destinationPreview) {
      setDestinationPreview(this.elements, run.destinationPreview);
    }

    if (this.viewedRunId === null) {
      showRunLog(this.elements, run.id, run.log);
    }

    if (run.phase === "complete") {
      flashDownloadComplete(this.elements);
    }

    this.syncPanelActions();
  }

  private applyGatherQueue(queue: GatherQueueState): void {
    this.queue = queue;
    const displayed = getGatherQueueDisplayRun(queue);
    const latest = getLatestGatherQueueResult(queue);
    const retryable = getRetryableGatherQueueResult(queue);
    const batch = getGatherQueueBatch(queue);
    const batchRuns = displayed ? [displayed, ...batch.recent] : batch.recent;
    const viewed = batchRuns.find((run) => run.id === this.viewedRunId) ?? null;

    // A run that left the batch can no longer be picked, so the log goes back to the current one.
    this.viewedRunId = viewed?.id ?? null;

    if (displayed) {
      this.applyGatherRun(displayed);
    } else if (latest) {
      this.applyGatherRun(latest);
    }

    if (viewed) {
      showRunLog(this.elements, viewed.id, viewed.log);
    }

    setQueuedCount(this.elements, displayed?.queuedCount ?? 0);
    renderBatch(
      this.elements,
      batchRuns.length > 1
        ? {
            runs: batchRuns,
            selectedRunId: viewed?.id ?? batchRuns[0]?.id ?? null,
            pages: batch.pages,
            saved: batch.saved,
            skipped: batch.skipped,
            failed: batch.failed,
          }
        : null,
    );

    this.handBackItems = getGatherQueueHandBackItems(queue);
    renderHandBack(this.elements, this.handBackItems);

    const pending = this.pendingHandBack;

    if (pending && !this.handBackItems.some((item) => isSameHandBackItem(item, pending.item))) {
      this.pendingHandBack = null;
    }

    this.state.actionResult = retryable ?? latest;
    this.retryTarget = retryable ? { runId: retryable.id, siteKey: retryable.siteKey } : null;

    this.syncPanelActions();
  }

  /** Picking the newest run, or the one already shown, returns the log to following the queue. */
  private handleViewRun(runId: string): void {
    const current = getGatherQueueDisplayRun(this.queue) ?? getLatestGatherQueueResult(this.queue);
    this.viewedRunId = runId === current?.id || runId === this.viewedRunId ? null : runId;
    this.applyGatherQueue(this.queue);
  }

  /** Panel messages are shown in the log but never stored; a run's own log is in the queue. */
  private appendLog(message: string, tone?: LogTone): void {
    addLog(this.elements, message, tone);
  }
}

function isSameHandBackItem(left: HandBackItem, right: HandBackItem): boolean {
  return left.runId === right.runId && left.fileName === right.fileName;
}

function resetProgress(elements: PanelElements): void {
  elements.progressBar.max = 1;
  elements.progressBar.value = 0;
  elements.progressText.textContent = "Waiting for a supported page and folder.";
  setDestinationPreview(elements, "");
}

function buildErrorReport(run: GatherRunState): string {
  const lines = [
    "Gather Box error report",
    `Generated: ${new Date().toISOString()}`,
    `Site: ${run.siteKey}`,
    `Page: ${run.tabUrl}`,
    `Destination: ${run.destinationPreview ?? "unknown"}`,
    "",
    ...run.failedItems.map((item) => {
      const url = item.originalUrl ? `\n  URL: ${item.originalUrl}` : "";

      return `- ${item.fileName}: ${item.reason}${url}`;
    }),
  ];

  return lines.join("\n");
}
