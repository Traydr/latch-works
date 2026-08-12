import type { SiteKey } from "../shared/sites";
import { getSaveBehavior, type SaveBehavior } from "../shared/save-behavior";
import type { PopupStatus } from "./status";
import { getStatusLabel } from "./status";

export type LogTone = "error" | "success";

export interface PopupElements {
  badge: HTMLElement;
  unsupportedBanner: HTMLElement;
  folderName: HTMLElement;
  folderDetail: HTMLElement;
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
    folderName: requireElement(document, "folderName-mini", HTMLElement),
    folderDetail: requireElement(document, "folderDetail-mini", HTMLElement),
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

export function setFolder(elements: PopupElements, name: string, detail: string): void {
  elements.folderName.textContent = name;
  elements.folderDetail.textContent = detail;
}

export function setDestinationPreview(elements: PopupElements, preview: string): void {
  elements.destinationPreview.textContent = preview;
  elements.destinationPreview.hidden = preview.length === 0;
}

export function resetProgress(elements: PopupElements): void {
  elements.progressBar.max = 1;
  elements.progressBar.value = 0;
  elements.progressText.textContent = "Waiting for a supported page and folder.";
  setDestinationPreview(elements, "");
}

export function setProgress(elements: PopupElements, value: number, max: number, text: string): void {
  elements.progressBar.max = max || 1;
  elements.progressBar.value = value;
  elements.progressText.textContent = text;
}

export function clearLog(elements: PopupElements): void {
  elements.resultLog.innerHTML = "";
}

export function restoreLog(
  elements: PopupElements,
  entries: Array<{ message: string; tone?: LogTone }>
): void {
  clearLog(elements);

  if (entries.length === 0) {
    elements.resultLog.innerHTML = '<p class="log-empty">No activity yet.</p>';
    return;
  }

  for (const entry of entries) {
    addLog(elements, entry.message, entry.tone, false);
  }
}

export function addLog(
  elements: PopupElements,
  message: string,
  tone?: LogTone,
  scroll = true
): void {
  if (elements.resultLog.querySelector(".log-empty")) {
    elements.resultLog.innerHTML = "";
  }

  const entry = document.createElement("p");
  entry.className = tone ? `log-entry ${tone}` : "log-entry";
  entry.textContent = message;
  elements.resultLog.appendChild(entry);

  if (scroll) {
    elements.resultLog.scrollTop = elements.resultLog.scrollHeight;
  }
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

export function updateSaveBehavior(siteKey: SiteKey | null): void {
  const behavior = getSaveBehavior(siteKey);
  const block = document.getElementById("saveBlock-mini");
  const pattern = document.getElementById("savePattern-mini");
  const summary = document.getElementById("saveSummary-mini");
  const path = document.getElementById("savePath-mini");
  const file = document.getElementById("saveFile-mini");

  if (!behavior) {
    if (block) block.hidden = true;
    if (pattern) {
      pattern.textContent = "";
      pattern.removeAttribute("data-pattern");
      pattern.hidden = true;
    }
    if (summary) summary.textContent = "";
    if (path) path.textContent = "";
    if (file) file.hidden = true;
    return;
  }

  if (block) block.hidden = false;
  if (pattern) {
    pattern.textContent = behavior.tag;
    pattern.dataset.pattern = behavior.pattern;
    pattern.hidden = false;
  }
  if (summary) summary.textContent = behavior.summary;
  if (path) renderPathInline(path, behavior);
  if (file) {
    file.textContent = behavior.filePattern;
    file.hidden = false;
  }
}

function renderPathInline(el: HTMLElement, behavior: SaveBehavior): void {
  const segments = behavior.pathTemplate.split("/").filter(Boolean);
  let text = segments.join(" / ");

  if (behavior.pattern === "direct-file") {
    const fileName = behavior.filePattern.split("(")[0].trim();
    text += ` / ${fileName}`;
  }

  el.textContent = text;
}

function requireElement<T extends HTMLElement>(
  document: Document,
  id: string,
  constructor: new () => T
): T {
  const element = document.getElementById(id);
  if (!(element instanceof constructor)) {
    throw new Error(`Missing required popup element: ${id}`);
  }

  return element;
}
