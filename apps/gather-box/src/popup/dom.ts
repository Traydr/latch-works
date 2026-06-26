import type { PopupStatus } from "./status";
import { getStatusLabel } from "./status";
import {
  buildInferredPathPreview,
  getSiteSaveProfile,
  SITE_SAVE_PROFILES,
  type SiteSaveProfile
} from "../shared/site-save-profiles";
import type { SiteKey } from "../shared/sites";

export type LogTone = "error" | "success";

export interface PopupElements {
  badge: HTMLElement;
  pageStatus: HTMLElement;
  pageDetail: HTMLElement;
  folderName: HTMLElement;
  folderDetail: HTMLElement;
  chooseFolder: HTMLButtonElement;
  clearFolder: HTMLButtonElement;
  downloadButton: HTMLButtonElement;
  retryButton: HTMLButtonElement;
  copyErrorsButton: HTMLButtonElement;
  openSidePanelButton: HTMLButtonElement | null;
  destinationPreview: HTMLElement;
  progressBar: HTMLProgressElement;
  progressText: HTMLElement;
  resultLog: HTMLElement;
  logDetails: HTMLDetailsElement;
  siteContext: HTMLElement;
  siteLabel: HTMLElement;
  siteOutput: HTMLElement;
  siteSaveRule: HTMLElement;
  sitePathPattern: HTMLElement;
  sitePathExample: HTMLElement;
  siteFilePattern: HTMLElement;
  siteCredentialsNote: HTMLElement;
  siteAtlas: HTMLElement;
  siteAtlasRows: HTMLElement;
}

export interface PopupElementOptions {
  includeOpenSidePanel?: boolean;
}

const BADGE_STATUS_CLASSES = [
  "badge-idle",
  "badge-pickingFolder",
  "badge-collecting",
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
    pageStatus: requireElement(document, "pageStatus-mini", HTMLElement),
    pageDetail: requireElement(document, "pageDetail-mini", HTMLElement),
    folderName: requireElement(document, "folderName-mini", HTMLElement),
    folderDetail: requireElement(document, "folderDetail-mini", HTMLElement),
    chooseFolder: requireElement(document, "chooseFolder-mini", HTMLButtonElement),
    clearFolder: requireElement(document, "clearFolder-mini", HTMLButtonElement),
    downloadButton: requireElement(document, "downloadBtn-mini", HTMLButtonElement),
    retryButton: requireElement(document, "retryBtn-mini", HTMLButtonElement),
    copyErrorsButton: requireElement(document, "copyErrorsBtn-mini", HTMLButtonElement),
    openSidePanelButton: options.includeOpenSidePanel
      ? requireElement(document, "openSidePanel-mini", HTMLButtonElement)
      : null,
    destinationPreview: requireElement(document, "destinationPreview-mini", HTMLElement),
    progressBar: requireElement(document, "progressBar-mini", HTMLProgressElement),
    progressText: requireElement(document, "progressText-mini", HTMLElement),
    resultLog: requireElement(document, "resultLog-mini", HTMLElement),
    logDetails: requireElement(document, "logDetails-mini", HTMLDetailsElement),
    siteContext: requireElement(document, "siteContext-mini", HTMLElement),
    siteLabel: requireElement(document, "siteLabel-mini", HTMLElement),
    siteOutput: requireElement(document, "siteOutput-mini", HTMLElement),
    siteSaveRule: requireElement(document, "siteSaveRule-mini", HTMLElement),
    sitePathPattern: requireElement(document, "sitePathPattern-mini", HTMLElement),
    sitePathExample: requireElement(document, "sitePathExample-mini", HTMLElement),
    siteFilePattern: requireElement(document, "siteFilePattern-mini", HTMLElement),
    siteCredentialsNote: requireElement(document, "siteCredentialsNote-mini", HTMLElement),
    siteAtlas: requireElement(document, "siteAtlas-mini", HTMLElement),
    siteAtlasRows: requireElement(document, "siteAtlasRows-mini", HTMLElement)
  };
}

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
  hasErrors: boolean
): void {
  elements.downloadButton.disabled = !canDownload;
  elements.chooseFolder.disabled = running;
  elements.clearFolder.disabled = running || !hasDirectoryHandle;
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

export function renderSiteContext(elements: PopupElements, siteKey: SiteKey | null): void {
  if (!siteKey) {
    elements.siteContext.hidden = true;
    highlightSiteAtlasRow(elements, null);
    return;
  }

  const profile = getSiteSaveProfile(siteKey);
  populateSiteContextFields(elements, profile);
  elements.siteContext.hidden = false;
  highlightSiteAtlasRow(elements, siteKey);
}

function populateSiteContextFields(elements: PopupElements, profile: SiteSaveProfile): void {
  elements.siteLabel.textContent = profile.label;
  elements.siteOutput.textContent = profile.outputLabel;
  elements.siteSaveRule.textContent = profile.saveRuleSummary;
  elements.sitePathPattern.textContent = profile.folderPattern;
  elements.sitePathExample.textContent = profile.folderExample;
  elements.siteFilePattern.textContent = profile.filePattern;

  if (profile.credentialsNote) {
    elements.siteCredentialsNote.textContent = profile.credentialsNote;
    elements.siteCredentialsNote.hidden = false;
  } else {
    elements.siteCredentialsNote.textContent = "";
    elements.siteCredentialsNote.hidden = true;
  }
}

export function renderSiteAtlas(elements: PopupElements): void {
  elements.siteAtlasRows.innerHTML = "";

  for (const profile of SITE_SAVE_PROFILES) {
    const row = document.createElement("article");
    row.className = "site-atlas-row";
    row.dataset.siteKey = profile.key;
    row.setAttribute("role", "listitem");

    row.innerHTML = `
      <div class="site-atlas-row-head">
        <span class="site-atlas-row-label">${escapeHtml(profile.label)}</span>
        <span class="site-atlas-row-output">${escapeHtml(profile.outputLabel)}</span>
      </div>
      <p class="site-atlas-row-pattern mono">${escapeHtml(profile.folderPattern)}</p>
      <p class="site-atlas-row-example">${escapeHtml(profile.folderExample)}</p>
    `;

    elements.siteAtlasRows.appendChild(row);
  }
}

export function highlightSiteAtlasRow(elements: PopupElements, siteKey: SiteKey | null): void {
  for (const row of elements.siteAtlasRows.querySelectorAll<HTMLElement>(".site-atlas-row")) {
    row.classList.toggle("site-atlas-row-active", siteKey !== null && row.dataset.siteKey === siteKey);
  }
}

export function setInferredPathPreview(
  elements: PopupElements,
  rootName: string | null,
  siteKey: SiteKey | null
): void {
  if (!rootName || !siteKey) {
    return;
  }

  const profile = getSiteSaveProfile(siteKey);
  const preview = buildInferredPathPreview(rootName, profile);
  setDestinationPreview(elements, preview);
  elements.progressText.textContent = "Ready to download.";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
