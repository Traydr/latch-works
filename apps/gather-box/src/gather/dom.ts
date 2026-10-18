import { isTerminalGatherRunPhase, type GatherRunState } from "../shared/gather-run";
import type { GatherProfilesState } from "../shared/profiles";
import type { SaveBehavior } from "../shared/save-behavior";
import type { PopupStatus } from "./status";
import { getStatusLabel } from "./status";

export type LogTone = "error" | "success";

export interface PopupElements {
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
  openSidePanelButton: HTMLButtonElement | null;
  destinationPreview: HTMLElement;
  progressBar: HTMLProgressElement;
  progressText: HTMLElement;
  queueCount: HTMLElement;
  batch: HTMLElement;
  batchSummary: HTMLElement;
  batchRuns: HTMLElement;
  resultLog: HTMLElement;
  logDetails: HTMLDetailsElement;
}

export interface PopupElementOptions {
  includeOpenSidePanel?: boolean;
}

const BADGE_STATUS_CLASSES = [
  "badge-idle",
  "badge-pickingFolder",
  "badge-collecting",
  "badge-queued",
  "badge-downloading",
  "badge-complete",
  "badge-error"
] as const;

export function getPopupElements(
  document: Document,
  options: PopupElementOptions = {}
): PopupElements {
  return {
    badge: requireElement(document, "badge-mini", HTMLElement),
    unsupportedBanner: requireElement(document, "unsupportedBanner-mini", HTMLElement),
    profileSelect: requireElement(document, "profileSelect-mini", HTMLSelectElement),
    manageProfiles: requireElement(document, "manageProfiles-mini", HTMLButtonElement),
    folderName: requireElement(document, "folderName-mini", HTMLElement),
    folderDetail: requireElement(document, "folderDetail-mini", HTMLElement),
    saveBlock: requireElement(document, "saveBlock-mini", HTMLElement),
    savePath: requireElement(document, "savePath-mini", HTMLElement),
    saveNote: requireElement(document, "saveNote-mini", HTMLElement),
    chooseFolder: requireElement(document, "chooseFolder-mini", HTMLButtonElement),
    clearFolder: requireElement(document, "clearFolder-mini", HTMLButtonElement),
    downloadButton: requireElement(document, "downloadBtn-mini", HTMLButtonElement),
    cancelButton: requireElement(document, "cancelBtn-mini", HTMLButtonElement),
    retryButton: requireElement(document, "retryBtn-mini", HTMLButtonElement),
    copyErrorsButton: requireElement(document, "copyErrorsBtn-mini", HTMLButtonElement),
    openSidePanelButton: options.includeOpenSidePanel
      ? requireElement(document, "openSidePanel-mini", HTMLButtonElement)
      : null,
    destinationPreview: requireElement(document, "destinationPreview-mini", HTMLElement),
    progressBar: requireElement(document, "progressBar-mini", HTMLProgressElement),
    progressText: requireElement(document, "progressText-mini", HTMLElement),
    queueCount: requireElement(document, "queueCount-mini", HTMLElement),
    batch: requireElement(document, "batch-mini", HTMLElement),
    batchSummary: requireElement(document, "batchSummary-mini", HTMLElement),
    batchRuns: requireElement(document, "batchRuns-mini", HTMLElement),
    resultLog: requireElement(document, "resultLog-mini", HTMLElement),
    logDetails: requireElement(document, "logDetails-mini", HTMLDetailsElement)
  };
}

export function setBadge(elements: PopupElements, status: PopupStatus): void {
  elements.badge.textContent = getStatusLabel(status);
  elements.badge.classList.remove(...BADGE_STATUS_CLASSES);
  elements.badge.classList.add(`badge-${status}`);
}

export function setPageState(
  elements: PopupElements,
  supported: boolean,
  message?: string
): void {
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
  elements: PopupElements,
  state: GatherProfilesState,
  disabled: boolean
): void {
  const select = elements.profileSelect;

  const sameProfiles =
    select.options.length === state.profiles.length &&
    state.profiles.every((profile, index) => select.options[index].value === profile.id);

  if (!sameProfiles) {
    select.replaceChildren(...state.profiles.map((profile) => new Option("", profile.id)));
  }

  state.profiles.forEach((profile, index) => {
    select.options[index].textContent = profile.name;
  });

  select.value = state.activeProfileId;
  select.title = select.selectedOptions[0]?.textContent ?? "";
  select.disabled = disabled;
}

export function setFolder(elements: PopupElements, name: string, detail: string): void {
  elements.folderName.textContent = name;
  elements.folderDetail.textContent = detail;
}

/**
 * The line keeps its height while empty, and long paths are cut from the front, so the status
 * area stays still as runs move through the queue.
 */
export function setDestinationPreview(elements: PopupElements, preview: string): void {
  const text = elements.destinationPreview.firstElementChild ?? elements.destinationPreview;
  text.textContent = preview;
  elements.destinationPreview.title = preview;
}

export function setProgress(elements: PopupElements, value: number, max: number, text: string): void {
  elements.progressBar.max = max || 1;
  elements.progressBar.value = value;
  elements.progressText.textContent = text;
  elements.progressText.title = text;
}

export function setQueuedCount(elements: PopupElements, count: number): void {
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
export function renderBatch(elements: PopupElements, view: BatchView | null): void {
  elements.batch.hidden = view === null;

  if (!view) {
    elements.batchRuns.replaceChildren();

    return;
  }

  const summary = [
    `${view.pages} ${view.pages === 1 ? "page" : "pages"} done`,
    `${view.saved} saved`,
    `${view.skipped} skipped`,
    ...(view.failed > 0 ? [`${view.failed} failed`] : [])
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
    return run.phase === "writing" || run.phase === "cancelling"
      ? `${completed} of ${total}`
      : "Starting";
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
    ...(failed > 0 ? [`${failed} failed`] : [])
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
  elements: PopupElements,
  runId: string | null,
  entries: Array<{ message: string; tone?: LogTone }>
): void {
  const log = elements.resultLog;
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 8;
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

function clearLog(elements: PopupElements): void {
  elements.resultLog.innerHTML = "";
}

/** Adds a message of the panel's own, which no run's log holds. */
export function addLog(elements: PopupElements, message: string, tone?: LogTone): void {
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

export function setLogExpanded(elements: PopupElements, expanded: boolean): void {
  elements.logDetails.open = expanded;
}

export function syncActions(
  elements: PopupElements,
  canDownload: boolean,
  running: boolean,
  hasDirectoryHandle: boolean,
  canRetry: boolean,
  hasErrors: boolean,
  canCancel = false
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

export function flashDownloadComplete(elements: PopupElements): void {
  elements.downloadButton.classList.remove("download-complete-glow");
  void elements.downloadButton.offsetWidth;
  elements.downloadButton.classList.add("download-complete-glow");

  window.setTimeout(() => {
    elements.downloadButton.classList.remove("download-complete-glow");
  }, 2000);
}

/**
 * Where a gather from this site saves, written from the chosen folder down, plus a note when the
 * files are renamed on the way.
 */
export function setSaveBehavior(
  elements: PopupElements,
  behavior: SaveBehavior | null,
  folderName: string | null
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

export function requireElement<T extends HTMLElement>(
  document: Document,
  id: string,
  constructor: new () => T
): T {
  const element = document.getElementById(id);

  if (!(element instanceof constructor)) {
    throw new Error(`Missing required element: ${id}`);
  }

  return element;
}
