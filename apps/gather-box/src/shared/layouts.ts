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
    name: "Command Deck",
    tagline: "Dense monospace status terminal",
    html: commandDeckHtml
  },
  {
    id: 2,
    name: "Path-First",
    tagline: "Destination breadcrumb as the hero",
    html: pathFirstHtml
  },
  {
    id: 3,
    name: "Compact",
    tagline: "Minimal density, inline behavior pill",
    html: compactHtml
  },
  {
    id: 4,
    name: "Reference Rail",
    tagline: "Two-pane with all-site behavior sidebar",
    html: twoPaneHtml
  },
  {
    id: 5,
    name: "Card Stack",
    tagline: "Iconographic save-flow diagram",
    html: cardStackHtml
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

  highlightSiteRail(siteKey);

  const isHero = block?.dataset.hero === "true";

  if (!behavior) {
    if (!isHero && block) {
      block.hidden = true;
    }
    if (pattern) {
      pattern.textContent = isHero ? "—" : "";
      pattern.removeAttribute("data-pattern");
      if (!isHero) {
        pattern.hidden = true;
      }
    }
    if (summary) {
      summary.textContent = isHero ? "Waiting for a supported page" : "";
    }
    if (path) {
      if (path.dataset.pathMode === "crumbs") {
        path.innerHTML = `<span class="crumb crumb-root">root</span>`;
      } else {
        path.textContent = isHero ? "Open a supported page to see where files land." : "";
      }
    }
    if (detail) {
      detail.textContent = "";
    }
    if (file) {
      file.hidden = true;
    }
    return;
  }

  if (block) {
    block.hidden = false;
  }
  if (pattern) {
    pattern.textContent = behavior.tag;
    pattern.dataset.pattern = behavior.pattern;
    pattern.hidden = false;
  }
  if (summary) {
    summary.textContent = behavior.summary;
  }
  if (path) {
    if (path.dataset.pathMode === "crumbs") {
      renderPathCrumbs(path, behavior);
    } else {
      path.textContent = behavior.pathTemplate;
    }
  }
  if (detail) {
    detail.textContent = behavior.detail;
  }
  if (file) {
    file.textContent = behavior.filePattern;
    file.hidden = false;
  }
}

function highlightSiteRail(siteKey: SiteKey | null): void {
  const rail = document.getElementById("siteRef-mini");
  if (!rail) {
    return;
  }

  for (const row of rail.querySelectorAll<HTMLElement>(".tp-rail-row")) {
    const isActive = row.dataset.site === siteKey;
    row.classList.toggle("active", isActive);
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

function sidePanelButton(include: boolean): string {
  return include
    ? '<button id="openSidePanel-mini" class="btn btn-ghost btn-tiny" type="button">Side panel</button>'
    : "";
}

function commandDeckHtml(opts: { includeOpenSidePanel: boolean }): string {
  return `<div class="layout layout-command">
    <header class="header">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"></span>
        <h1>Gather Box</h1>
      </div>
      <div class="header-actions">
        <a class="btn btn-ghost btn-tiny header-link" href="../options/options.html" target="_blank" rel="noreferrer">Settings</a>
        ${sidePanelButton(opts.includeOpenSidePanel)}
        <span id="badge-mini" class="badge badge-idle">IDLE</span>
      </div>
    </header>

    <div class="cmd-line">
      <span class="cmd-prompt">page</span>
      <span id="pageStatus-mini" class="cmd-value">Checking...</span>
      <span id="savePattern-mini" class="cmd-tag" hidden></span>
    </div>
    <p id="pageDetail-mini" class="cmd-detail">The active tab is checked when the popup opens.</p>

    <section class="cmd-save" id="saveBlock-mini" hidden>
      <div class="cmd-line">
        <span class="cmd-prompt">save</span>
        <span id="saveSummary-mini" class="cmd-value"></span>
      </div>
      <code id="savePath-mini" class="cmd-path"></code>
      <p id="saveDetail-mini" class="cmd-detail"></p>
      <p id="saveFile-mini" class="cmd-detail cmd-mono"></p>
    </section>

    <button id="downloadBtn-mini" class="btn btn-primary btn-huge btn-full" type="button" disabled>Download Content</button>

    <div class="action-row">
      <button id="retryBtn-mini" class="btn btn-ghost btn-tiny" type="button" disabled>Retry failed</button>
      <button id="copyErrorsBtn-mini" class="btn btn-ghost btn-tiny" type="button" disabled>Copy errors</button>
    </div>

    <section class="surface cmd-folder">
      <div class="folder-row">
        <span class="label">Folder</span>
        <span id="folderName-mini" class="value truncate">No folder selected</span>
        <button id="chooseFolder-mini" class="btn btn-ghost btn-tiny" type="button">Choose</button>
        <button id="clearFolder-mini" class="btn btn-ghost btn-tiny" type="button" disabled>Clear</button>
      </div>
      <p id="folderDetail-mini" class="sub">Choose a writable folder for this run.</p>
    </section>

    <section class="surface progress-block">
      <p id="destinationPreview-mini" class="destination-preview" hidden></p>
      <progress id="progressBar-mini" class="progress" max="1" value="0"></progress>
      <p id="progressText-mini" class="sub center">Waiting for a supported page and folder.</p>
    </section>

    <details id="logDetails-mini" class="log-details surface">
      <summary>Results</summary>
      <div id="resultLog-mini" class="log" role="log" aria-live="polite">
        <p class="log-empty">No activity yet.</p>
      </div>
    </details>
  </div>`;
}

function pathFirstHtml(opts: { includeOpenSidePanel: boolean }): string {
  return `<div class="layout layout-path">
    <header class="header">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"></span>
        <h1>Gather Box</h1>
      </div>
      <div class="header-actions">
        <a class="btn btn-ghost btn-tiny header-link" href="../options/options.html" target="_blank" rel="noreferrer">Settings</a>
        ${sidePanelButton(opts.includeOpenSidePanel)}
        <span id="badge-mini" class="badge badge-idle">IDLE</span>
      </div>
    </header>

    <section class="path-hero" id="saveBlock-mini" data-hero="true">
      <div class="path-hero-top">
        <span id="savePattern-mini" class="path-tag">—</span>
        <span id="saveSummary-mini" class="path-summary">Waiting for a supported page</span>
      </div>
      <div id="savePath-mini" class="path-breadcrumb" data-path-mode="crumbs">
        <span class="crumb crumb-root">root</span>
      </div>
      <p id="saveDetail-mini" class="sub">Open a supported page to preview the destination structure.</p>
    </section>

    <button id="downloadBtn-mini" class="btn btn-primary btn-huge btn-full" type="button" disabled>Download Content</button>

    <div class="action-row">
      <button id="retryBtn-mini" class="btn btn-ghost btn-tiny" type="button" disabled>Retry failed</button>
      <button id="copyErrorsBtn-mini" class="btn btn-ghost btn-tiny" type="button" disabled>Copy errors</button>
    </div>

    <section class="surface">
      <div class="folder-row">
        <span class="label">Folder</span>
        <span id="folderName-mini" class="value truncate">No folder selected</span>
        <button id="chooseFolder-mini" class="btn btn-ghost btn-tiny" type="button">Choose</button>
        <button id="clearFolder-mini" class="btn btn-ghost btn-tiny" type="button" disabled>Clear</button>
      </div>
      <p id="folderDetail-mini" class="sub">Choose a writable folder for this run.</p>
      <p id="saveFile-mini" class="sub path-file" hidden></p>
    </section>

    <section class="surface progress-block">
      <div class="path-page-row">
        <span class="label">Page</span>
        <span id="pageStatus-mini" class="value truncate">Checking...</span>
      </div>
      <p id="pageDetail-mini" class="sub">The active tab is checked when the popup opens.</p>
      <p id="destinationPreview-mini" class="destination-preview" hidden></p>
      <progress id="progressBar-mini" class="progress" max="1" value="0"></progress>
      <p id="progressText-mini" class="sub center">Waiting for a supported page and folder.</p>
    </section>

    <details id="logDetails-mini" class="log-details surface">
      <summary>Results</summary>
      <div id="resultLog-mini" class="log" role="log" aria-live="polite">
        <p class="log-empty">No activity yet.</p>
      </div>
    </details>
  </div>`;
}

function compactHtml(opts: { includeOpenSidePanel: boolean }): string {
  return `<div class="layout layout-compact">
    <header class="header">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"></span>
        <h1>Gather Box</h1>
      </div>
      <div class="header-actions">
        <a class="btn btn-ghost btn-tiny header-link" href="../options/options.html" target="_blank" rel="noreferrer">Settings</a>
        ${sidePanelButton(opts.includeOpenSidePanel)}
        <span id="badge-mini" class="badge badge-idle">IDLE</span>
      </div>
    </header>

    <div class="cmp-row">
      <span id="pageStatus-mini" class="value truncate">Checking...</span>
      <span id="savePattern-mini" class="cmp-pill" hidden></span>
    </div>
    <p id="pageDetail-mini" class="sub cmp-detail">The active tab is checked when the popup opens.</p>

    <div class="cmp-save" id="saveBlock-mini" hidden>
      <span id="saveSummary-mini" class="cmp-save-summary"></span>
      <code id="savePath-mini" class="cmp-save-path"></code>
    </div>

    <button id="downloadBtn-mini" class="btn btn-primary btn-huge btn-full" type="button" disabled>Download Content</button>

    <div class="action-row">
      <button id="retryBtn-mini" class="btn btn-ghost btn-tiny" type="button" disabled>Retry failed</button>
      <button id="copyErrorsBtn-mini" class="btn btn-ghost btn-tiny" type="button" disabled>Copy errors</button>
    </div>

    <section class="surface cmp-folder">
      <div class="folder-row">
        <span id="folderName-mini" class="value truncate">No folder selected</span>
        <button id="chooseFolder-mini" class="btn btn-ghost btn-tiny" type="button">Choose</button>
        <button id="clearFolder-mini" class="btn btn-ghost btn-tiny" type="button" disabled>Clear</button>
      </div>
      <p id="folderDetail-mini" class="sub">Choose a writable folder for this run.</p>
    </section>

    <section class="surface progress-block">
      <p id="destinationPreview-mini" class="destination-preview" hidden></p>
      <progress id="progressBar-mini" class="progress" max="1" value="0"></progress>
      <p id="progressText-mini" class="sub center">Waiting for a supported page and folder.</p>
    </section>

    <details id="logDetails-mini" class="log-details surface">
      <summary>Results</summary>
      <div id="resultLog-mini" class="log" role="log" aria-live="polite">
        <p class="log-empty">No activity yet.</p>
      </div>
    </details>
  </div>`;
}

function twoPaneHtml(opts: { includeOpenSidePanel: boolean }): string {
  return `<div class="layout layout-twopane">
    <header class="header">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"></span>
        <h1>Gather Box</h1>
      </div>
      <div class="header-actions">
        <a class="btn btn-ghost btn-tiny header-link" href="../options/options.html" target="_blank" rel="noreferrer">Settings</a>
        ${sidePanelButton(opts.includeOpenSidePanel)}
        <span id="badge-mini" class="badge badge-idle">IDLE</span>
      </div>
    </header>

    <div class="tp-body">
      <aside class="tp-rail" id="siteRef-mini" aria-label="Site saving behavior reference">
        <div class="tp-rail-title">Sites</div>
        <div class="tp-rail-row" data-site="myhentaigallery"><span class="tp-rail-name">MHG</span><span class="tp-rail-code" data-pattern="single-folder">F1</span></div>
        <div class="tp-rail-row" data-site="kemono"><span class="tp-rail-name">Kemono</span><span class="tp-rail-code" data-pattern="nested">N3</span></div>
        <div class="tp-rail-row" data-site="fanbox"><span class="tp-rail-name">FANBOX</span><span class="tp-rail-code" data-pattern="nested">N2</span></div>
        <div class="tp-rail-row" data-site="archiveofourown"><span class="tp-rail-name">AO3</span><span class="tp-rail-code" data-pattern="direct-file">D</span></div>
        <div class="tp-rail-row" data-site="hentaifoundry-stories"><span class="tp-rail-name">HF</span><span class="tp-rail-code" data-pattern="direct-file">D</span></div>
        <div class="tp-rail-row" data-site="fanfiction-net"><span class="tp-rail-name">FFN</span><span class="tp-rail-code" data-pattern="direct-file">D</span></div>
        <div class="tp-rail-legend">
          <span><b>F1</b> 1 folder</span>
          <span><b>N#</b> nested</span>
          <span><b>D</b> direct</span>
        </div>
      </aside>

      <div class="tp-main">
        <div class="tp-page">
          <span class="label">Page</span>
          <span id="pageStatus-mini" class="value truncate">Checking...</span>
        </div>
        <p id="pageDetail-mini" class="sub">The active tab is checked when the popup opens.</p>

        <div class="tp-save" id="saveBlock-mini" hidden>
          <div class="tp-save-top">
            <span id="savePattern-mini" class="tp-tag"></span>
            <span id="saveSummary-mini" class="tp-save-summary"></span>
          </div>
          <code id="savePath-mini" class="tp-save-path"></code>
          <p id="saveDetail-mini" class="sub"></p>
        </div>

        <button id="downloadBtn-mini" class="btn btn-primary btn-huge btn-full" type="button" disabled>Download Content</button>

        <div class="action-row">
          <button id="retryBtn-mini" class="btn btn-ghost btn-tiny" type="button" disabled>Retry failed</button>
          <button id="copyErrorsBtn-mini" class="btn btn-ghost btn-tiny" type="button" disabled>Copy errors</button>
        </div>

        <section class="surface">
          <div class="folder-row">
            <span id="folderName-mini" class="value truncate">No folder selected</span>
            <button id="chooseFolder-mini" class="btn btn-ghost btn-tiny" type="button">Choose</button>
            <button id="clearFolder-mini" class="btn btn-ghost btn-tiny" type="button" disabled>Clear</button>
          </div>
          <p id="folderDetail-mini" class="sub">Choose a writable folder for this run.</p>
        </section>

        <section class="surface progress-block">
          <p id="destinationPreview-mini" class="destination-preview" hidden></p>
          <progress id="progressBar-mini" class="progress" max="1" value="0"></progress>
          <p id="progressText-mini" class="sub center">Waiting for a supported page and folder.</p>
        </section>

        <details id="logDetails-mini" class="log-details surface">
          <summary>Results</summary>
          <div id="resultLog-mini" class="log" role="log" aria-live="polite">
            <p class="log-empty">No activity yet.</p>
          </div>
        </details>
      </div>
    </div>
  </div>`;
}

function cardStackHtml(opts: { includeOpenSidePanel: boolean }): string {
  return `<div class="layout layout-cards">
    <header class="header">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"></span>
        <h1>Gather Box</h1>
      </div>
      <div class="header-actions">
        <a class="btn btn-ghost btn-tiny header-link" href="../options/options.html" target="_blank" rel="noreferrer">Settings</a>
        ${sidePanelButton(opts.includeOpenSidePanel)}
        <span id="badge-mini" class="badge badge-idle">IDLE</span>
      </div>
    </header>

    <section class="card save-card" id="saveBlock-mini" data-hero="true">
      <div class="card-head">
        <span class="card-icon save-icon" aria-hidden="true"></span>
        <span class="card-title">Save behavior</span>
        <span id="savePattern-mini" class="card-tag">—</span>
      </div>
      <div class="save-flow">
        <span class="flow-node flow-root">Root</span>
        <span class="flow-arrow" aria-hidden="true">›</span>
        <span class="flow-node flow-folder" id="saveSummary-mini">Waiting</span>
        <span class="flow-arrow flow-arrow-file" aria-hidden="true">›</span>
        <span class="flow-node flow-file">Files</span>
      </div>
      <code id="savePath-mini" class="save-flow-path">Open a supported page to see where files land.</code>
      <p id="saveDetail-mini" class="sub"></p>
    </section>

    <section class="card">
      <div class="card-head">
        <span class="card-title">Page</span>
        <span id="pageStatus-mini" class="value truncate">Checking...</span>
      </div>
      <p id="pageDetail-mini" class="sub">The active tab is checked when the popup opens.</p>
    </section>

    <button id="downloadBtn-mini" class="btn btn-primary btn-huge btn-full" type="button" disabled>Download Content</button>

    <div class="action-row">
      <button id="retryBtn-mini" class="btn btn-ghost btn-tiny" type="button" disabled>Retry failed</button>
      <button id="copyErrorsBtn-mini" class="btn btn-ghost btn-tiny" type="button" disabled>Copy errors</button>
    </div>

    <section class="card">
      <div class="card-head">
        <span class="card-title">Destination</span>
      </div>
      <div class="folder-row">
        <span id="folderName-mini" class="value truncate">No folder selected</span>
        <button id="chooseFolder-mini" class="btn btn-ghost btn-tiny" type="button">Choose</button>
        <button id="clearFolder-mini" class="btn btn-ghost btn-tiny" type="button" disabled>Clear</button>
      </div>
      <p id="folderDetail-mini" class="sub">Choose a writable folder for this run.</p>
      <p id="saveFile-mini" class="sub" hidden></p>
    </section>

    <section class="card progress-block">
      <p id="destinationPreview-mini" class="destination-preview" hidden></p>
      <progress id="progressBar-mini" class="progress" max="1" value="0"></progress>
      <p id="progressText-mini" class="sub center">Waiting for a supported page and folder.</p>
    </section>

    <details id="logDetails-mini" class="log-details card">
      <summary>Results</summary>
      <div id="resultLog-mini" class="log" role="log" aria-live="polite">
        <p class="log-empty">No activity yet.</p>
      </div>
    </details>
  </div>`;
}
