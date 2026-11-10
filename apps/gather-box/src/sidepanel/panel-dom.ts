import type { HandBackItem } from "../shared/gather-queue";
import {
  type GatherRunState,
  isTerminalGatherRunPhase,
  isWritingPhase,
  type RunLogEntry,
} from "../shared/gather-run";
import type { GatherProfilesState } from "../shared/profiles";
import { requireElement } from "../shared/require-element";
import type { SourceSaveBehavior } from "../shared/source-catalog";

export type LogTone = NonNullable<RunLogEntry["tone"]>;

const PANEL_STATUSES = [
  "idle",
  "pickingFolder",
  "collecting",
  "queued",
  "downloading",
  "complete",
  "error",
] as const;

export type PanelStatus = (typeof PANEL_STATUSES)[number];

/** The length of the `download-complete-glow` animation in sidepanel.css. */
const COMPLETE_GLOW_MS = 2000;

/** How close to the bottom, in pixels, still counts as following the log. */
const LOG_FOLLOW_SLACK_PX = 8;

export interface PanelElements {
  badge: HTMLElement;
  unsupportedBanner: HTMLElement;
  profileSelect: HTMLSelectElement;
  manageProfiles: HTMLButtonElement;
  folderName: HTMLElement;
  folderDetail: HTMLElement;
  saveBlock: HTMLElement;
  savePath: HTMLElement;
  saveNote: HTMLElement;
  chooseFolder: HTMLButtonElement;
  clearFolder: HTMLButtonElement;
  downloadButton: HTMLButtonElement;
  cancelButton: HTMLButtonElement;
  retryButton: HTMLButtonElement;
  copyErrorsButton: HTMLButtonElement;
  destinationPreview: HTMLElement;
  progressBar: HTMLProgressElement;
  progressText: HTMLElement;
  queueCount: HTMLElement;
  batch: HTMLElement;
  batchSummary: HTMLElement;
  batchRuns: HTMLElement;
  handBack: HTMLElement;
  handBackItems: HTMLElement;
  handBackFile: HTMLInputElement;
  resultLog: HTMLElement;
  logDetails: HTMLDetailsElement;
}

export function getPanelElements(document: Document): PanelElements {
  return {
    badge: requireElement(document, "badge", HTMLElement),
    unsupportedBanner: requireElement(document, "unsupportedBanner", HTMLElement),
    profileSelect: requireElement(document, "profileSelect", HTMLSelectElement),
    manageProfiles: requireElement(document, "manageProfiles", HTMLButtonElement),
    folderName: requireElement(document, "folderName", HTMLElement),
    folderDetail: requireElement(document, "folderDetail", HTMLElement),
    saveBlock: requireElement(document, "saveBlock", HTMLElement),
    savePath: requireElement(document, "savePath", HTMLElement),
    saveNote: requireElement(document, "saveNote", HTMLElement),
    chooseFolder: requireElement(document, "chooseFolder", HTMLButtonElement),
    clearFolder: requireElement(document, "clearFolder", HTMLButtonElement),
    downloadButton: requireElement(document, "downloadBtn", HTMLButtonElement),
    cancelButton: requireElement(document, "cancelBtn", HTMLButtonElement),
    retryButton: requireElement(document, "retryBtn", HTMLButtonElement),
    copyErrorsButton: requireElement(document, "copyErrorsBtn", HTMLButtonElement),
    destinationPreview: requireElement(document, "destinationPreview", HTMLElement),
    progressBar: requireElement(document, "progressBar", HTMLProgressElement),
    progressText: requireElement(document, "progressText", HTMLElement),
    queueCount: requireElement(document, "queueCount", HTMLElement),
    batch: requireElement(document, "batch", HTMLElement),
    batchSummary: requireElement(document, "batchSummary", HTMLElement),
    batchRuns: requireElement(document, "batchRuns", HTMLElement),
    handBack: requireElement(document, "handBack", HTMLElement),
    handBackItems: requireElement(document, "handBackItems", HTMLElement),
    handBackFile: requireElement(document, "handBackFile", HTMLInputElement),
    resultLog: requireElement(document, "resultLog", HTMLElement),
    logDetails: requireElement(document, "logDetails", HTMLDetailsElement),
  };
}

export function setBadge(elements: PanelElements, status: PanelStatus): void {
  elements.badge.textContent = status === "pickingFolder" ? "PICKING FOLDER" : status.toUpperCase();
  elements.badge.classList.remove(...PANEL_STATUSES.map((name) => `badge-${name}`));
  elements.badge.classList.add(`badge-${status}`);
}

export function setPageState(elements: PanelElements, supported: boolean, message?: string): void {
  elements.unsupportedBanner.hidden = supported;

  if (!supported && message) {
    elements.unsupportedBanner.textContent = message;
  }
}

/**
 * One option per profile, with the active one selected. Options are updated in place while the
 * same profiles are listed, so an open or focused dropdown is left alone.
 */
export function renderProfiles(
  elements: PanelElements,
  state: GatherProfilesState,
  disabled: boolean,
): void {
  const select = elements.profileSelect;

  const sameProfiles =
    select.options.length === state.profiles.length &&
    state.profiles.every((profile, index) => select.options.item(index)?.value === profile.id);

  if (!sameProfiles) {
    select.replaceChildren(...state.profiles.map((profile) => new Option("", profile.id)));
  }

  state.profiles.forEach((profile, index) => {
    const option = select.options.item(index);

    if (option) {
      option.textContent = profile.name;
    }
  });

  select.value = state.activeProfileId;
  select.title = select.selectedOptions[0]?.textContent ?? "";
  select.disabled = disabled;
}

export function setFolder(elements: PanelElements, name: string, detail: string): void {
  elements.folderName.textContent = name;
  elements.folderDetail.textContent = detail;
}

/**
 * The line keeps its height while empty, and long paths are cut from the front, so the status
 * area stays still as runs move through the queue.
 */
export function setDestinationPreview(elements: PanelElements, preview: string): void {
  const text = elements.destinationPreview.firstElementChild ?? elements.destinationPreview;
  text.textContent = preview;
  elements.destinationPreview.title = preview;
}

export function setProgress(
  elements: PanelElements,
  value: number,
  max: number,
  text: string,
): void {
  elements.progressBar.max = max || 1;
  elements.progressBar.value = value;
  elements.progressText.textContent = text;
  elements.progressText.title = text;
}

export function setQueuedCount(elements: PanelElements, count: number): void {
  elements.queueCount.textContent = `${count} queued`;
  elements.queueCount.hidden = count === 0;
}

export interface BatchView {
  /** The run in progress, if any, then the most recent finished runs, newest first. */
  runs: GatherRunState[];
  /** The run whose log is shown. */
  selectedRunId: string | null;
  /** Counts across every finished run in the batch, including ones no longer listed. */
  pages: number;
  saved: number;
  skipped: number;
  failed: number;
}

/**
 * Lists the latest runs that went through the queue together, with the whole batch's counts.
 * Rows are updated in place while the same runs are listed, so a focused row keeps its focus.
 */
export function renderBatch(elements: PanelElements, view: BatchView | null): void {
  elements.batch.hidden = view === null;

  if (!view) {
    elements.batchRuns.replaceChildren();

    return;
  }

  const summary = [
    `${view.pages} ${view.pages === 1 ? "page" : "pages"} done`,
    `${view.saved} saved`,
    `${view.skipped} skipped`,
    ...(view.failed > 0 ? [`${view.failed} failed`] : []),
  ].join(" · ");

  elements.batchSummary.textContent = summary;
  elements.batchSummary.title = summary;

  const existing = new Map<string, HTMLElement>();

  for (const row of elements.batchRuns.children) {
    if (row instanceof HTMLElement && row.dataset.runId) {
      existing.set(row.dataset.runId, row);
    }
  }

  const rows = view.runs.map((run) => {
    const row = existing.get(run.id) ?? createBatchRow(run.id);
    updateBatchRow(row, run, run.id === view.selectedRunId);

    return row;
  });

  const sameOrder =
    rows.length === elements.batchRuns.children.length &&
    rows.every((row, index) => elements.batchRuns.children[index] === row);

  if (!sameOrder) {
    elements.batchRuns.replaceChildren(...rows);
  }
}

export type HandBackAction = "open" | "add";

/**
 * Lists the files a site check blocked, each with a button to open its link and one to add the file
 * you downloaded. The list is only rebuilt when the files change, so a focused button keeps focus.
 */
export function renderHandBack(elements: PanelElements, items: HandBackItem[]): void {
  elements.handBack.hidden = items.length === 0;

  const key = JSON.stringify(items.map((item) => [item.runId, item.fileName]));

  if (elements.handBackItems.dataset.key === key) {
    return;
  }

  elements.handBackItems.dataset.key = key;
  elements.handBackItems.replaceChildren(...items.map(createHandBackRow));
}

function createHandBackRow(item: HandBackItem, index: number): HTMLElement {
  const row = document.createElement("li");
  row.className = "hand-back-item";
  row.dataset.index = String(index);

  const name = document.createElement("span");
  name.className = "hand-back-name truncate";
  name.textContent = item.fileName;
  name.title = item.fileName;

  row.append(
    name,
    createHandBackButton("open", "Open", `Open ${item.fileName} in a new tab`),
    createHandBackButton("add", "Add file", `Add the ${item.fileName} you downloaded`),
  );

  return row;
}

function createHandBackButton(action: HandBackAction, label: string, title: string): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tool-btn";
  button.dataset.action = action;
  button.textContent = label;
  button.title = title;

  return button;
}

function createBatchRow(runId: string): HTMLElement {
  const item = document.createElement("li");
  item.dataset.runId = runId;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "batch-run";

  const title = document.createElement("span");
  title.className = "batch-run-title truncate";

  const result = document.createElement("span");
  result.className = "batch-run-result";

  button.append(title, result);
  item.append(button);

  return item;
}

function updateBatchRow(row: HTMLElement, run: GatherRunState, selected: boolean): void {
  const button = row.firstElementChild;

  if (!(button instanceof HTMLButtonElement)) {
    return;
  }

  const [title, result] = button.children;

  if (!title || !result) {
    return;
  }

  const label = run.title ?? getPageLabel(run.tabUrl);
  title.textContent = label;
  button.title = label;
  result.textContent = getRunResult(run);
  button.dataset.tone = getRunTone(run);
  button.setAttribute("aria-pressed", String(selected));
}

function getRunResult(run: GatherRunState): string {
  const { completed, total, saved, skipped, failed } = run.progress;

  if (!isTerminalGatherRunPhase(run.phase)) {
    return isWritingPhase(run.phase) ? `${completed} of ${total}` : "Starting";
  }

  if (run.phase === "cancelled") {
    return "Cancelled";
  }

  if (run.phase === "interrupted") {
    return "Interrupted";
  }

  if (run.phase === "failed" && failed === 0) {
    return "Failed";
  }

  return [
    `${saved} saved`,
    ...(skipped > 0 ? [`${skipped} skipped`] : []),
    ...(failed > 0 ? [`${failed} failed`] : []),
  ].join(" · ");
}

function getRunTone(run: GatherRunState): string {
  if (!isTerminalGatherRunPhase(run.phase)) {
    return "active";
  }

  return run.phase === "complete" ? "success" : "error";
}

function getPageLabel(url: string): string {
  try {
    const { hostname, pathname } = new URL(url);

    return `${hostname.replace(/^www\./, "")}${pathname}`;
  } catch {
    return url;
  }
}

/**
 * Shows a run's log. New entries of the run already shown are appended, and the log stays pinned
 * to the bottom only while it was scrolled there, so reading older entries is not interrupted.
 */
export function showRunLog(
  elements: PanelElements,
  runId: string | null,
  entries: RunLogEntry[],
): void {
  const log = elements.resultLog;
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < LOG_FOLLOW_SLACK_PX;
  const shown = log.querySelectorAll(".log-entry").length;

  // The log remembers whose entries it holds, so a growing run appends instead of re-rendering.
  const sameRun =
    runId !== null &&
    runId === log.dataset.runId &&
    entries.length >= shown &&
    !log.querySelector(".log-empty");

  if (!sameRun) {
    clearLog(elements);
  }

  log.dataset.runId = runId ?? "";

  if (entries.length === 0) {
    log.innerHTML = '<p class="log-empty">No activity yet.</p>';

    return;
  }

  for (const entry of entries.slice(sameRun ? shown : 0)) {
    appendLogEntry(log, entry.message, entry.tone);
  }

  if (!sameRun || atBottom) {
    log.scrollTop = log.scrollHeight;
  }
}

function clearLog(elements: PanelElements): void {
  elements.resultLog.innerHTML = "";
}

/** Adds a message of the panel's own, which no run's log holds. */
export function addLog(elements: PanelElements, message: string, tone?: LogTone): void {
  const log = elements.resultLog;

  if (log.querySelector(".log-empty")) {
    log.innerHTML = "";
  }

  // The next run update re-renders, so its entries are not mistaken for ones already shown.
  delete log.dataset.runId;
  appendLogEntry(log, message, tone);
  log.scrollTop = log.scrollHeight;
}

function appendLogEntry(log: HTMLElement, message: string, tone?: LogTone): void {
  const entry = document.createElement("p");
  entry.className = tone ? `log-entry ${tone}` : "log-entry";
  entry.textContent = message;
  log.appendChild(entry);
}

export function setLogExpanded(elements: PanelElements, expanded: boolean): void {
  elements.logDetails.open = expanded;
}

export function syncActions(
  elements: PanelElements,
  canDownload: boolean,
  running: boolean,
  hasDirectoryHandle: boolean,
  canRetry: boolean,
  hasErrors: boolean,
  canCancel = false,
): void {
  elements.downloadButton.disabled = !canDownload;
  elements.chooseFolder.disabled = running;
  elements.clearFolder.disabled = running || !hasDirectoryHandle;
  elements.cancelButton.disabled = !canCancel;
  elements.retryButton.disabled = running || !canRetry;
  elements.copyErrorsButton.disabled = running || !hasErrors;

  if (!hasDirectoryHandle && !running) {
    elements.folderName.textContent = "No folder selected";
  }
}

export function flashDownloadComplete(elements: PanelElements): void {
  elements.downloadButton.classList.remove("download-complete-glow");
  void elements.downloadButton.offsetWidth;
  elements.downloadButton.classList.add("download-complete-glow");

  window.setTimeout(() => {
    elements.downloadButton.classList.remove("download-complete-glow");
  }, COMPLETE_GLOW_MS);
}

/**
 * Where a gather from this site saves, written from the chosen folder down, plus a note when the
 * files are renamed on the way.
 */
export function setSaveBehavior(
  elements: PanelElements,
  behavior: SourceSaveBehavior | null,
  folderName: string | null,
): void {
  elements.saveBlock.hidden = behavior === null;

  if (!behavior) {
    return;
  }

  const root = document.createElement("span");
  root.className = "save-root";
  root.textContent = folderName ?? "<folder>";
  elements.savePath.replaceChildren(root, behavior.pathTemplate.replace(/^<root>/, ""));
  elements.saveNote.textContent = behavior.fileNote ?? "";
  elements.saveNote.hidden = !behavior.fileNote;
}
