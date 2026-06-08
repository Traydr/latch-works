import type { PopupStatus } from "./status";
import { getStatusLabel } from "./status";

export type LogTone = "error" | "success";

export interface PopupElements {
  badge: HTMLElement;
  pageStatus: HTMLElement;
  pageDetail: HTMLElement;
  folderName: HTMLElement;
  folderDetail: HTMLElement;
  chooseFolder: HTMLButtonElement;
  downloadButton: HTMLButtonElement;
  progressBar: HTMLProgressElement;
  progressText: HTMLElement;
  resultLog: HTMLElement;
}

export function getPopupElements(document: Document): PopupElements {
  return {
    badge: requireElement(document, "badge-mini", HTMLElement),
    pageStatus: requireElement(document, "pageStatus-mini", HTMLElement),
    pageDetail: requireElement(document, "pageDetail-mini", HTMLElement),
    folderName: requireElement(document, "folderName-mini", HTMLElement),
    folderDetail: requireElement(document, "folderDetail-mini", HTMLElement),
    chooseFolder: requireElement(document, "chooseFolder-mini", HTMLButtonElement),
    downloadButton: requireElement(document, "downloadBtn-mini", HTMLButtonElement),
    progressBar: requireElement(document, "progressBar-mini", HTMLProgressElement),
    progressText: requireElement(document, "progressText-mini", HTMLElement),
    resultLog: requireElement(document, "resultLog-mini", HTMLElement)
  };
}

const BADGE_STATUS_CLASSES = [
  "badge-idle",
  "badge-pickingFolder",
  "badge-collecting",
  "badge-downloading",
  "badge-complete",
  "badge-error"
] as const;

export function setBadge(elements: PopupElements, status: PopupStatus): void {
  elements.badge.textContent = getStatusLabel(status);
  elements.badge.classList.remove(...BADGE_STATUS_CLASSES);
  elements.badge.classList.add(`badge-${status}`);
}

export function updatePageStatus(elements: PopupElements, status: string, detail: string): void {
  elements.pageStatus.textContent = status;
  elements.pageDetail.textContent = detail;
}

export function setFolder(elements: PopupElements, name: string, detail: string): void {
  elements.folderName.textContent = name;
  elements.folderDetail.textContent = detail;
}

export function resetProgress(elements: PopupElements): void {
  elements.progressBar.max = 1;
  elements.progressBar.value = 0;
  elements.progressText.textContent = "Waiting for a supported page and folder.";
}

export function setProgress(elements: PopupElements, value: number, max: number, text: string): void {
  elements.progressBar.max = max || 1;
  elements.progressBar.value = value;
  elements.progressText.textContent = text;
}

export function clearLog(elements: PopupElements): void {
  elements.resultLog.innerHTML = "";
}

export function addLog(elements: PopupElements, message: string, tone?: LogTone): void {
  if (elements.resultLog.querySelector(".log-empty")) {
    elements.resultLog.innerHTML = "";
  }

  const entry = document.createElement("p");
  entry.className = tone ? `log-entry ${tone}` : "log-entry";
  entry.textContent = message;
  elements.resultLog.appendChild(entry);
  elements.resultLog.scrollTop = elements.resultLog.scrollHeight;
}

export function syncActions(
  elements: PopupElements,
  canDownload: boolean,
  running: boolean,
  hasDirectoryHandle: boolean
): void {
  elements.downloadButton.disabled = !canDownload;
  elements.chooseFolder.disabled = running;

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
