import type { SiteKey } from "./sites";
import { getSaveBehavior, type SaveBehavior } from "./save-behavior";

export interface LayoutDef {
  id: number;
  name: string;
  tagline: string;
  html: (opts: { includeOpenSidePanel: boolean }) => string;
}

const LAYOUT_STORAGE_KEY = "gather-box-layout";
export const DEFAULT_LAYOUT = 1;

export const LAYOUTS: LayoutDef[] = [
  {
    id: 1,
    name: "Compact Chips",
    tagline: "Flat rows, colored breadcrumb chips",
    html: compactChipsHtml
  },
  {
    id: 2,
    name: "Compact Mono",
    tagline: "Terminal-style monospace prompts",
    html: compactMonoHtml
  },
  {
    id: 3,
    name: "Compact Pill",
    tagline: "Save behavior in a single rounded pill bar",
    html: compactPillHtml
  },
  {
    id: 4,
    name: "Compact Flow",
    tagline: "Tight flow nodes: Root › folder › Files",
    html: compactFlowHtml
  },
  {
    id: 5,
    name: "Compact Grid",
    tagline: "Monospace key/value mini-table",
    html: compactGridHtml
  }
];

export async function getSelectedLayout(): Promise<number> {
  const stored = await chrome.storage.local.get(LAYOUT_STORAGE_KEY);
  const value = Number(stored[LAYOUT_STORAGE_KEY]);
  const layout = LAYOUTS.find((candidate) => candidate.id === value);
  return layout ? layout.id : DEFAULT_LAYOUT;
}

export async function setSelectedLayout(id: number): Promise<void> {
  await chrome.storage.local.set({ [LAYOUT_STORAGE_KEY]: id });
}

export function renderLayoutInto(
  id: number,
  root: HTMLElement,
  opts: { includeOpenSidePanel: boolean }
): void {
  const layout = LAYOUTS.find((candidate) => candidate.id === id) ?? LAYOUTS[0];
  root.innerHTML = layout.html(opts);
  root.dataset.layoutId = String(layout.id);

  for (const button of document.querySelectorAll<HTMLButtonElement>(".switch-btn")) {
    const isActive = Number(button.dataset.layout) === layout.id;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  }

  const nameEl = document.getElementById("layoutName");
  if (nameEl) {
    nameEl.textContent = `${layout.id}. ${layout.name}`;
  }
}

export function initSwitcher(onSwitch: (id: number) => void): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(".switch-btn")) {
    button.addEventListener("click", () => {
      const id = Number(button.dataset.layout);
      if (!Number.isFinite(id)) {
        return;
      }
      void setSelectedLayout(id);
      onSwitch(id);
    });
  }
}

export function updateSaveBehavior(siteKey: SiteKey | null): void {
  const behavior = getSaveBehavior(siteKey);
  const block = document.getElementById("saveBlock-mini");
  const pattern = document.getElementById("savePattern-mini");
  const summary = document.getElementById("saveSummary-mini");
  const path = document.getElementById("savePath-mini");
  const detail = document.getElementById("saveDetail-mini");
  const file = document.getElementById("saveFile-mini");

  if (!behavior) {
    if (block) block.hidden = true;
    if (pattern) {
      pattern.textContent = "";
      pattern.removeAttribute("data-pattern");
      pattern.hidden = true;
    }
    if (summary) summary.textContent = "";
    if (path) {
      path.innerHTML = "";
      path.textContent = "";
    }
    if (detail) detail.textContent = "";
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
  if (path) {
    if (path.dataset.pathMode === "crumbs") {
      renderPathCrumbs(path, behavior);
    } else if (path.dataset.pathMode === "flow") {
      renderPathFlow(path, behavior);
    } else if (path.dataset.pathMode === "inline") {
      renderPathInline(path, behavior);
    } else {
      path.textContent = behavior.pathTemplate;
    }
  }
  if (detail) detail.textContent = behavior.detail;
  if (file) {
    file.textContent = behavior.filePattern;
    file.hidden = false;
  }
}

function renderPathCrumbs(el: HTMLElement, behavior: SaveBehavior): void {
  const segments = behavior.pathTemplate.split("/").filter(Boolean);
  let html = "";

  segments.forEach((segment, index) => {
    const isRoot = index === 0;
    const cls = isRoot ? "crumb crumb-root" : "crumb";
    html += `<span class="${cls}">${escapeHtml(segment)}</span>`;
    html += `<span class="crumb-sep" aria-hidden="true">/</span>`;
  });

  if (behavior.pattern === "direct-file") {
    const fileName = behavior.filePattern.split("(")[0].trim();
    html += `<span class="crumb crumb-file">${escapeHtml(fileName)}</span>`;
  }

  el.innerHTML = html;
}

function renderPathFlow(el: HTMLElement, behavior: SaveBehavior): void {
  const segments = behavior.pathTemplate.split("/").filter(Boolean);
  let html = `<span class="flow-node flow-root">Root</span>`;

  if (behavior.pattern === "direct-file") {
    const fileName = behavior.filePattern.split("(")[0].trim();
    html += `<span class="flow-sep">›</span><span class="flow-node flow-file">${escapeHtml(fileName)}</span>`;
  } else {
    for (let i = 1; i < segments.length; i++) {
      html += `<span class="flow-sep">›</span><span class="flow-node flow-folder">${escapeHtml(segments[i])}</span>`;
    }
    html += `<span class="flow-sep">›</span><span class="flow-node flow-file">Files</span>`;
  }

  el.innerHTML = html;
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return char;
    }
  });
}

/* ===== Shared HTML blocks ===== */

function headerHtml(opts: { includeOpenSidePanel: boolean }): string {
  return `<header class="header">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true"></span>
      <h1>Gather Box</h1>
    </div>
    <div class="header-actions">
      <a class="btn btn-ghost btn-tiny header-link" href="../options/options.html" target="_blank" rel="noreferrer">Settings</a>
      ${opts.includeOpenSidePanel ? '<button id="openSidePanel-mini" class="btn btn-ghost btn-tiny" type="button">Side panel</button>' : ""}
      <span id="badge-mini" class="badge badge-idle">IDLE</span>
    </div>
  </header>`;
}

const DOWNLOAD_BTN =
  '<button id="downloadBtn-mini" class="btn btn-primary btn-huge btn-full" type="button" disabled>Download Content</button>';

const UNSUPPORTED_BANNER =
  '<div id="unsupportedBanner-mini" class="unsupported-banner" hidden></div>';

const MORE_SECTION =
  '<details id="logDetails-mini" class="more-section"><summary>More</summary><div class="more-body"><div class="action-row"><button id="retryBtn-mini" class="btn btn-ghost btn-tiny" type="button" disabled>Retry failed</button><button id="copyErrorsBtn-mini" class="btn btn-ghost btn-tiny" type="button" disabled>Copy errors</button></div><div id="resultLog-mini" class="log" role="log" aria-live="polite"><p class="log-empty">No activity yet.</p></div></div></details>';

const PROGRESS_BLOCK =
  '<div class="progress-block"><p id="destinationPreview-mini" class="destination-preview" hidden></p><progress id="progressBar-mini" class="progress" max="1" value="0"></progress><p id="progressText-mini" class="sub center">Waiting for a supported page and folder.</p></div>';

function folderRow(extraClass: string = ""): string {
  return `<div class="folder-row ${extraClass}">
    <span id="folderName-mini" class="value truncate">No folder selected</span>
    <button id="chooseFolder-mini" class="btn btn-ghost btn-folder" type="button">Choose</button>
    <button id="clearFolder-mini" class="btn btn-ghost btn-folder" type="button" disabled>Clear</button>
  </div>`;
}

/* ===== Layout 1 — Compact Chips ===== */
function compactChipsHtml(opts: { includeOpenSidePanel: boolean }): string {
  return `<div class="layout lf1">
    ${headerHtml(opts)}
    ${DOWNLOAD_BTN}
    ${UNSUPPORTED_BANNER}
    ${folderRow()}
    <p id="folderDetail-mini" class="sub lf-sub">Choose a writable folder for this run.</p>
    <div class="lf1-save" id="saveBlock-mini" hidden>
      <div class="lf1-save-top">
        <span id="savePattern-mini" class="lf-tag" hidden></span>
        <span id="saveSummary-mini" class="lf1-summary"></span>
      </div>
      <div id="savePath-mini" class="lf1-crumbs" data-path-mode="crumbs"></div>
      <p id="saveFile-mini" class="sub lf-sub lf-mono"></p>
    </div>
    <span id="saveDetail-mini" class="lf-hidden"></span>
    ${PROGRESS_BLOCK}
    ${MORE_SECTION}
  </div>`;
}

/* ===== Layout 2 — Compact Mono ===== */
function compactMonoHtml(opts: { includeOpenSidePanel: boolean }): string {
  return `<div class="layout lf2">
    ${headerHtml(opts)}
    ${DOWNLOAD_BTN}
    ${UNSUPPORTED_BANNER}
    ${folderRow()}
    <p id="folderDetail-mini" class="sub lf-sub">Choose a writable folder for this run.</p>
    <div class="lf2-save" id="saveBlock-mini" hidden>
      <div class="lf2-line">
        <span class="lf2-prompt">save</span>
        <span id="savePattern-mini" class="lf-tag" hidden></span>
        <code id="savePath-mini" class="lf2-path" data-path-mode="inline"></code>
      </div>
      <p id="saveFile-mini" class="sub lf-sub lf-mono"></p>
    </div>
    <span id="saveSummary-mini" class="lf-hidden"></span>
    <span id="saveDetail-mini" class="lf-hidden"></span>
    ${PROGRESS_BLOCK}
    ${MORE_SECTION}
  </div>`;
}

/* ===== Layout 3 — Compact Pill ===== */
function compactPillHtml(opts: { includeOpenSidePanel: boolean }): string {
  return `<div class="layout lf3">
    ${headerHtml(opts)}
    ${DOWNLOAD_BTN}
    ${UNSUPPORTED_BANNER}
    ${folderRow()}
    <p id="folderDetail-mini" class="sub lf-sub">Choose a writable folder for this run.</p>
    <div class="lf3-save" id="saveBlock-mini" hidden>
      <div class="lf3-pill">
        <span id="savePattern-mini" class="lf3-pill-tag" hidden></span>
        <code id="savePath-mini" class="lf3-pill-path" data-path-mode="inline"></code>
      </div>
      <p id="saveSummary-mini" class="sub lf-sub lf3-summary"></p>
      <p id="saveFile-mini" class="sub lf-sub lf-mono"></p>
    </div>
    <span id="saveDetail-mini" class="lf-hidden"></span>
    ${PROGRESS_BLOCK}
    ${MORE_SECTION}
  </div>`;
}

/* ===== Layout 4 — Compact Flow ===== */
function compactFlowHtml(opts: { includeOpenSidePanel: boolean }): string {
  return `<div class="layout lf4">
    ${headerHtml(opts)}
    ${DOWNLOAD_BTN}
    ${UNSUPPORTED_BANNER}
    ${folderRow()}
    <p id="folderDetail-mini" class="sub lf-sub">Choose a writable folder for this run.</p>
    <div class="lf4-save" id="saveBlock-mini" hidden>
      <div class="lf4-save-top">
        <span id="savePattern-mini" class="lf-tag" hidden></span>
        <span id="saveSummary-mini" class="lf4-summary"></span>
      </div>
      <div id="savePath-mini" class="lf4-flow" data-path-mode="flow"></div>
      <p id="saveFile-mini" class="sub lf-sub lf-mono"></p>
    </div>
    <span id="saveDetail-mini" class="lf-hidden"></span>
    ${PROGRESS_BLOCK}
    ${MORE_SECTION}
  </div>`;
}

/* ===== Layout 5 — Compact Grid ===== */
function compactGridHtml(opts: { includeOpenSidePanel: boolean }): string {
  return `<div class="layout lf5">
    ${headerHtml(opts)}
    ${DOWNLOAD_BTN}
    ${UNSUPPORTED_BANNER}
    <div class="lf5-table">
      <div class="lf5-row">
        <span class="lf5-key">folder</span>
        <span class="lf5-val">
          <span id="folderName-mini" class="lf5-folder truncate">No folder selected</span>
          <button id="chooseFolder-mini" class="btn btn-ghost btn-folder" type="button">Choose</button>
          <button id="clearFolder-mini" class="btn btn-ghost btn-folder" type="button" disabled>Clear</button>
        </span>
      </div>
    </div>
    <p id="folderDetail-mini" class="sub lf5-sub">Choose a writable folder for this run.</p>
    <div class="lf5-table">
      <div class="lf5-row" id="saveBlock-mini" hidden>
        <span class="lf5-key">save</span>
        <span class="lf5-val">
          <span id="savePattern-mini" class="lf-tag" hidden></span>
          <code id="savePath-mini" class="lf5-path" data-path-mode="inline"></code>
        </span>
      </div>
      <div class="lf5-row">
        <span class="lf5-key">files</span>
        <span class="lf5-val"><span id="saveFile-mini" class="lf5-filetext" hidden></span></span>
      </div>
    </div>
    <span id="saveSummary-mini" class="lf-hidden"></span>
    <span id="saveDetail-mini" class="lf-hidden"></span>
    <div class="lf5-table">
      <div class="lf5-row">
        <span class="lf5-key">progress</span>
        <span class="lf5-val lf5-progress-val">
          <p id="destinationPreview-mini" class="destination-preview" hidden></p>
          <progress id="progressBar-mini" class="progress" max="1" value="0"></progress>
          <span id="progressText-mini" class="lf5-progress-text">Waiting…</span>
        </span>
      </div>
    </div>
    ${MORE_SECTION}
  </div>`;
}
