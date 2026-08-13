/**
 * Trial studio layout set. Temporary comparison scaffolding — every layout must
 * contain each REQUIRED_ELEMENT_IDS entry exactly once so the shared
 * GatherController can bind to whichever layout is active.
 */

export interface TrialLayout {
  name: string;
  tagline: string;
  html: string;
}

export const REQUIRED_ELEMENT_IDS = [
  "badge-mini",
  "unsupportedBanner-mini",
  "folderName-mini",
  "folderDetail-mini",
  "chooseFolder-mini",
  "clearFolder-mini",
  "downloadBtn-mini",
  "cancelBtn-mini",
  "retryBtn-mini",
  "copyErrorsBtn-mini",
  "destinationPreview-mini",
  "progressBar-mini",
  "progressText-mini",
  "resultLog-mini",
  "logDetails-mini",
  "saveBlock-mini",
  "savePattern-mini",
  "savePath-mini",
  "saveSummary-mini",
  "saveFile-mini"
] as const;

const LEDGER_HTML = `
<div class="l1">
  <header class="l1-masthead">
    <h1 class="l1-title">Gather Box</h1>
    <span id="badge-mini" class="badge badge-idle l1-stamp">IDLE</span>
  </header>

  <div id="unsupportedBanner-mini" class="l1-note" hidden></div>

  <dl class="l1-ledger">
    <div class="l1-row">
      <dt class="l1-dt">Folder</dt>
      <dd class="l1-dd">
        <div class="l1-cell">
          <span id="folderName-mini" class="l1-value truncate">No folder selected</span>
          <button id="chooseFolder-mini" class="l1-textbtn" type="button">Choose</button>
          <button id="clearFolder-mini" class="l1-textbtn" type="button" disabled>Clear</button>
        </div>
        <p id="folderDetail-mini" class="l1-detail">Choose a writable folder for this run.</p>
      </dd>
    </div>
    <div class="l1-row" id="saveBlock-mini" hidden>
      <dt class="l1-dt">Saves to</dt>
      <dd class="l1-dd">
        <div class="l1-cell">
          <span id="savePattern-mini" class="l1-tag" hidden></span>
          <code id="savePath-mini" class="l1-path truncate"></code>
        </div>
        <p id="saveSummary-mini" class="l1-detail"></p>
        <p id="saveFile-mini" class="l1-detail l1-mono" hidden></p>
      </dd>
    </div>
    <div class="l1-row">
      <dt class="l1-dt">Run</dt>
      <dd class="l1-dd">
        <p id="destinationPreview-mini" class="l1-detail l1-mono l1-dest" hidden></p>
        <progress id="progressBar-mini" class="l1-progress" max="1" value="0"></progress>
        <p id="progressText-mini" class="l1-detail">Waiting for a supported page and folder.</p>
      </dd>
    </div>
  </dl>

  <button id="downloadBtn-mini" class="l1-primary" type="button" disabled>Download Content</button>

  <div class="l1-actions">
    <button id="cancelBtn-mini" class="l1-textbtn" type="button" disabled>Cancel run</button>
    <button id="retryBtn-mini" class="l1-textbtn" type="button" disabled>Retry failed</button>
    <button id="copyErrorsBtn-mini" class="l1-textbtn" type="button" disabled>Copy errors</button>
    <a class="l1-textbtn l1-settings" href="../options/options.html" target="_blank" rel="noreferrer">Settings</a>
  </div>

  <details id="logDetails-mini" class="l1-log" open>
    <summary class="l1-logsummary">Activity</summary>
    <div id="resultLog-mini" class="l1-logbody" role="log" aria-live="polite">
      <p class="log-empty">No activity yet.</p>
    </div>
  </details>
</div>
`;

const CONSOLE_HTML = `
<div class="l2">
  <header class="l2-statusline">
    <span class="l2-sig">gather-box</span>
    <span id="badge-mini" class="badge badge-idle l2-badge">IDLE</span>
    <a class="l2-key l2-settings" href="../options/options.html" target="_blank" rel="noreferrer">cfg</a>
  </header>

  <div id="unsupportedBanner-mini" class="l2-warn" hidden></div>

  <div class="l2-kv">
    <div class="l2-line">
      <span class="l2-k">dest</span>
      <span id="folderName-mini" class="l2-v truncate">No folder selected</span>
      <button id="chooseFolder-mini" class="l2-key" type="button">choose</button>
      <button id="clearFolder-mini" class="l2-key" type="button" disabled>clear</button>
    </div>
    <p id="folderDetail-mini" class="l2-dim">Choose a writable folder for this run.</p>
    <div id="saveBlock-mini" class="l2-save" hidden>
      <div class="l2-line">
        <span class="l2-k">save</span>
        <span id="savePattern-mini" class="l2-tag" hidden></span>
        <code id="savePath-mini" class="l2-v l2-path truncate"></code>
      </div>
      <p id="saveSummary-mini" class="l2-dim"></p>
      <p id="saveFile-mini" class="l2-dim" hidden></p>
    </div>
  </div>

  <details id="logDetails-mini" class="l2-scrollback" open>
    <summary>log</summary>
    <div id="resultLog-mini" class="l2-log" role="log" aria-live="polite">
      <p class="log-empty">No activity yet.</p>
    </div>
  </details>

  <div class="l2-runline">
    <p id="destinationPreview-mini" class="l2-dim l2-dest" hidden></p>
    <progress id="progressBar-mini" class="l2-progress" max="1" value="0"></progress>
    <p id="progressText-mini" class="l2-dim l2-status">Waiting for a supported page and folder.</p>
  </div>

  <div class="l2-cmdbar">
    <button id="downloadBtn-mini" class="l2-prompt" type="button" disabled>Download Content</button>
    <div class="l2-cmdkeys">
      <button id="cancelBtn-mini" class="l2-key" type="button" disabled>cancel</button>
      <button id="retryBtn-mini" class="l2-key" type="button" disabled>retry</button>
      <button id="copyErrorsBtn-mini" class="l2-key" type="button" disabled>copy errs</button>
    </div>
  </div>
</div>
`;

const PIPELINE_HTML = `
<div class="l3">
  <header class="l3-head">
    <div class="l3-brand">
      <span class="l3-mark" aria-hidden="true"></span>
      <h1 class="l3-title">Gather Box</h1>
    </div>
    <div class="l3-headside">
      <a class="l3-ghost" href="../options/options.html" target="_blank" rel="noreferrer">Settings</a>
      <span id="badge-mini" class="badge badge-idle">IDLE</span>
    </div>
  </header>

  <ol class="l3-stages">
    <li class="l3-stage">
      <span class="l3-node" aria-hidden="true">1</span>
      <div class="l3-body">
        <h2 class="l3-stagename">Source</h2>
        <p class="l3-hint">The active tab decides what gets collected.</p>
        <div id="unsupportedBanner-mini" class="l3-warn" hidden></div>
      </div>
    </li>
    <li class="l3-stage">
      <span class="l3-node" aria-hidden="true">2</span>
      <div class="l3-body">
        <h2 class="l3-stagename">Folder</h2>
        <div class="l3-folder">
          <span id="folderName-mini" class="l3-value truncate">No folder selected</span>
          <button id="chooseFolder-mini" class="l3-ghost" type="button">Choose</button>
          <button id="clearFolder-mini" class="l3-ghost" type="button" disabled>Clear</button>
        </div>
        <p id="folderDetail-mini" class="l3-hint">Choose a writable folder for this run.</p>
      </div>
    </li>
    <li class="l3-stage">
      <span class="l3-node" aria-hidden="true">3</span>
      <div class="l3-body">
        <h2 class="l3-stagename">Destination</h2>
        <div id="saveBlock-mini" class="l3-save" hidden>
          <div class="l3-savepill">
            <span id="savePattern-mini" class="l3-tag" hidden></span>
            <code id="savePath-mini" class="l3-path truncate"></code>
          </div>
          <p id="saveSummary-mini" class="l3-hint"></p>
          <p id="saveFile-mini" class="l3-hint l3-mono" hidden></p>
        </div>
        <p id="destinationPreview-mini" class="l3-hint l3-mono l3-dest" hidden></p>
      </div>
    </li>
    <li class="l3-stage l3-stage-last">
      <span class="l3-node" aria-hidden="true">4</span>
      <div class="l3-body">
        <h2 class="l3-stagename">Run</h2>
        <button id="downloadBtn-mini" class="l3-primary" type="button" disabled>Download Content</button>
        <progress id="progressBar-mini" class="l3-progress" max="1" value="0"></progress>
        <p id="progressText-mini" class="l3-hint">Waiting for a supported page and folder.</p>
        <div class="l3-runactions">
          <button id="cancelBtn-mini" class="l3-ghost" type="button" disabled>Cancel run</button>
          <button id="retryBtn-mini" class="l3-ghost" type="button" disabled>Retry failed</button>
          <button id="copyErrorsBtn-mini" class="l3-ghost" type="button" disabled>Copy errors</button>
        </div>
      </div>
    </li>
  </ol>

  <details id="logDetails-mini" class="l3-log">
    <summary class="l3-logsummary">Run log</summary>
    <div id="resultLog-mini" class="l3-logbody" role="log" aria-live="polite">
      <p class="log-empty">No activity yet.</p>
    </div>
  </details>
</div>
`;

const DESK_HTML = `
<div class="l4">
  <section class="l4-hero">
    <header class="l4-toprow">
      <span class="l4-brand">GATHER BOX</span>
      <a class="l4-toolbtn" href="../options/options.html" target="_blank" rel="noreferrer">Settings</a>
      <span id="badge-mini" class="badge badge-idle">IDLE</span>
    </header>

    <div id="unsupportedBanner-mini" class="l4-warn" hidden></div>

    <div id="saveBlock-mini" class="l4-savehero" hidden>
      <span id="savePattern-mini" class="l4-tag" hidden></span>
      <code id="savePath-mini" class="l4-heropath"></code>
      <p id="saveSummary-mini" class="l4-dim"></p>
      <p id="saveFile-mini" class="l4-dim l4-mono" hidden></p>
    </div>

    <div class="l4-folderline">
      <span class="l4-lab">Root</span>
      <span id="folderName-mini" class="l4-value truncate">No folder selected</span>
      <button id="chooseFolder-mini" class="l4-toolbtn" type="button">Choose</button>
      <button id="clearFolder-mini" class="l4-toolbtn" type="button" disabled>Clear</button>
    </div>
    <p id="folderDetail-mini" class="l4-dim">Choose a writable folder for this run.</p>

    <button id="downloadBtn-mini" class="l4-primary" type="button" disabled>Download Content</button>
  </section>

  <section class="l4-history">
    <header class="l4-histhead">
      <span class="l4-lab">Run log</span>
      <div class="l4-tools">
        <button id="cancelBtn-mini" class="l4-toolbtn" type="button" disabled>Cancel</button>
        <button id="retryBtn-mini" class="l4-toolbtn" type="button" disabled>Retry</button>
        <button id="copyErrorsBtn-mini" class="l4-toolbtn" type="button" disabled>Copy errors</button>
      </div>
    </header>
    <div class="l4-progressrow">
      <progress id="progressBar-mini" class="l4-progress" max="1" value="0"></progress>
      <p id="progressText-mini" class="l4-dim l4-status">Waiting for a supported page and folder.</p>
      <p id="destinationPreview-mini" class="l4-dim l4-mono l4-dest" hidden></p>
    </div>
    <details id="logDetails-mini" class="l4-logwrap" open>
      <summary>entries</summary>
      <div id="resultLog-mini" class="l4-log" role="log" aria-live="polite">
        <p class="log-empty">No activity yet.</p>
      </div>
    </details>
  </section>
</div>
`;

const HUD_HTML = `
<div class="l5">
  <header class="l5-top">
    <span class="l5-brand"><span class="l5-dot" aria-hidden="true"></span>Gather Box</span>
    <a class="l5-mini l5-settings" href="../options/options.html" target="_blank" rel="noreferrer">Settings</a>
    <span id="badge-mini" class="badge badge-idle">IDLE</span>
  </header>

  <div class="l5-slab">
    <button id="downloadBtn-mini" class="l5-action" type="button" disabled>Download Content</button>
    <progress id="progressBar-mini" class="l5-progress" max="1" value="0"></progress>
  </div>
  <p id="progressText-mini" class="l5-status">Waiting for a supported page and folder.</p>

  <div id="unsupportedBanner-mini" class="l5-warn" hidden></div>

  <ul class="l5-facts">
    <li class="l5-fact">
      <span class="l5-lab">Folder</span>
      <span id="folderName-mini" class="l5-val truncate">No folder selected</span>
      <button id="chooseFolder-mini" class="l5-mini" type="button">Choose</button>
      <button id="clearFolder-mini" class="l5-mini" type="button" disabled>Clear</button>
    </li>
    <li class="l5-factnote">
      <p id="folderDetail-mini" class="l5-dim">Choose a writable folder for this run.</p>
    </li>
    <li class="l5-fact l5-factcol" id="saveBlock-mini" hidden>
      <div class="l5-factline">
        <span class="l5-lab">Saves to</span>
        <span id="savePattern-mini" class="l5-tag" hidden></span>
        <code id="savePath-mini" class="l5-val l5-mono truncate"></code>
      </div>
      <p id="saveSummary-mini" class="l5-dim"></p>
      <p id="saveFile-mini" class="l5-dim l5-mono" hidden></p>
    </li>
    <li class="l5-factnote">
      <p id="destinationPreview-mini" class="l5-dim l5-mono" hidden></p>
    </li>
  </ul>

  <details id="logDetails-mini" class="l5-log">
    <summary class="l5-logsummary">Activity</summary>
    <div class="l5-logtools">
      <button id="cancelBtn-mini" class="l5-mini" type="button" disabled>Cancel run</button>
      <button id="retryBtn-mini" class="l5-mini" type="button" disabled>Retry failed</button>
      <button id="copyErrorsBtn-mini" class="l5-mini" type="button" disabled>Copy errors</button>
    </div>
    <div id="resultLog-mini" class="l5-logbody" role="log" aria-live="polite">
      <p class="log-empty">No activity yet.</p>
    </div>
  </details>
</div>
`;

export const TRIAL_LAYOUTS: TrialLayout[] = [
  { name: "Ledger", tagline: "Archival register, serif masthead, always-on activity tail", html: LEDGER_HTML },
  { name: "Console", tagline: "Monospace collector console with scrollback and command bar", html: CONSOLE_HTML },
  { name: "Pipeline", tagline: "Four-stage rail: source, folder, destination, run", html: PIPELINE_HTML },
  { name: "Capture desk", tagline: "Destination-first hero over a dense run-log table", html: DESK_HTML },
  { name: "HUD", tagline: "One giant gather slab, facts and log tucked below", html: HUD_HTML }
];

export const TRIAL_CSS = `
/* ===== Trial studio chrome (temporary) ===== */

@font-face {
  font-family: "Gather Serif";
  src: url("../assets/fonts/NotoSerif-Regular.ttf") format("truetype");
  font-weight: 400;
  font-style: normal;
}

@font-face {
  font-family: "Gather Serif";
  src: url("../assets/fonts/NotoSerif-Bold.ttf") format("truetype");
  font-weight: 700;
  font-style: normal;
}

@font-face {
  font-family: "Gather Serif";
  src: url("../assets/fonts/NotoSerif-Italic.ttf") format("truetype");
  font-weight: 400;
  font-style: italic;
}

.trial-switcher {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 7px 10px;
  background: rgba(9, 9, 11, 0.94);
  border-top: 1px solid rgba(63, 63, 70, 0.6);
  backdrop-filter: blur(6px);
  font-family: var(--sans);
}

.trial-switcher-btn {
  width: 26px;
  height: 24px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: #8b8b94;
  font: 600 11px var(--mono);
  cursor: pointer;
}

.trial-switcher-btn:hover {
  color: #e4e4e7;
}

.trial-switcher-btn[aria-pressed="true"] {
  border-color: rgba(139, 92, 246, 0.6);
  background: rgba(139, 92, 246, 0.2);
  color: #ede9fe;
}

.trial-switcher-btn:focus-visible {
  outline: 2px solid rgba(167, 139, 250, 0.4);
  outline-offset: 1px;
}

.trial-switcher-name {
  margin-left: auto;
  font-size: 10px;
  color: #71717a;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

body[data-trial-layout] {
  padding-bottom: 54px;
}

/* ===== 1 · Ledger ===== */

body[data-trial-layout="1"] {
  background: #12100c;
  color: #eae4d8;
  padding: 16px 16px 54px;
}

.l1 {
  display: flex;
  flex-direction: column;
}

.l1-masthead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-bottom: 10px;
  border-bottom: 3px double rgba(234, 228, 216, 0.55);
}

.l1-title {
  margin: 0;
  font: 700 19px/1.2 "Gather Serif", Georgia, serif;
  letter-spacing: 0.01em;
}

body[data-trial-layout="1"] .l1-stamp {
  background: transparent;
  border: 1.5px solid currentcolor;
  border-radius: 3px;
  font-family: "Gather Serif", Georgia, serif;
  font-size: 10px;
  letter-spacing: 0.14em;
  padding: 3px 8px;
  transform: rotate(-2deg);
}

.l1-note {
  margin-top: 12px;
  padding: 9px 12px;
  border: 1px solid rgba(224, 108, 85, 0.5);
  border-radius: 3px;
  color: #e8b3a6;
  font-size: 12px;
  line-height: 1.45;
}

.l1-ledger {
  margin: 0;
  display: flex;
  flex-direction: column;
}

.l1-row {
  display: grid;
  grid-template-columns: 80px minmax(0, 1fr);
  gap: 10px;
  padding: 11px 0;
  border-bottom: 1px solid rgba(234, 228, 216, 0.13);
}

.l1-dt {
  font: 400 11px/1.6 "Gather Serif", Georgia, serif;
  font-variant: small-caps;
  letter-spacing: 0.09em;
  color: #a89e8c;
}

.l1-dd {
  margin: 0;
  min-width: 0;
}

.l1-cell {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.l1-value {
  font-size: 13px;
}

.l1-detail {
  margin: 4px 0 0;
  font-size: 11px;
  line-height: 1.45;
  color: #9a917f;
}

.l1-mono {
  font-family: var(--mono);
}

.l1-dest {
  color: #c9a45c;
  margin-bottom: 6px;
  word-break: break-all;
  white-space: normal;
}

.l1-tag {
  flex-shrink: 0;
  font: 700 9px/1 var(--mono);
  letter-spacing: 0.06em;
  padding: 3px 6px;
  border: 1px solid var(--p-border, rgba(201, 164, 92, 0.5));
  border-radius: 2px;
  color: var(--p-color, #c9a45c);
  background: transparent;
}

.l1-path {
  font-family: var(--mono);
  font-size: 11px;
  color: #d9c9a5;
}

.l1-progress {
  width: 100%;
  height: 4px;
  border: 0;
  border-radius: 2px;
  overflow: hidden;
  background: rgba(234, 228, 216, 0.14);
  display: block;
}

.l1-progress::-webkit-progress-bar {
  background: rgba(234, 228, 216, 0.14);
}

.l1-progress::-webkit-progress-value {
  background: #c9a45c;
  transition: width 0.15s ease;
}

.l1-progress::-moz-progress-bar {
  background: #c9a45c;
}

.l1-primary {
  margin-top: 14px;
  width: 100%;
  padding: 11px 16px;
  border: 1px solid #c9a45c;
  border-radius: 3px;
  background: #c9a45c;
  color: #1a1408;
  font: 700 14px "Gather Serif", Georgia, serif;
  letter-spacing: 0.02em;
  cursor: pointer;
  transition: background 0.12s, opacity 0.12s;
}

.l1-primary:hover:not(:disabled) {
  background: #dcb96f;
  border-color: #dcb96f;
}

.l1-primary:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.l1-primary:focus-visible,
.l1-textbtn:focus-visible {
  outline: 2px solid rgba(201, 164, 92, 0.55);
  outline-offset: 1px;
}

.l1-actions {
  display: flex;
  gap: 14px;
  margin-top: 8px;
  padding: 6px 0 10px;
  border-bottom: 1px solid rgba(234, 228, 216, 0.13);
}

.l1-textbtn {
  border: 0;
  background: transparent;
  padding: 2px 0;
  color: #c9a45c;
  font: 500 11px var(--sans);
  cursor: pointer;
  text-decoration: none;
}

.l1-textbtn:hover:not(:disabled) {
  text-decoration: underline;
}

.l1-textbtn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.l1-settings {
  margin-left: auto;
  color: #a89e8c;
}

.l1-log {
  margin-top: 2px;
}

.l1-logsummary {
  padding: 9px 0 4px;
  font: 400 11px "Gather Serif", Georgia, serif;
  font-variant: small-caps;
  letter-spacing: 0.09em;
  color: #a89e8c;
  cursor: pointer;
  user-select: none;
}

.l1-logbody {
  max-height: 220px;
  overflow-y: auto;
  font-size: 11px;
  line-height: 1.5;
}

body[data-trial-layout="1"] .log-entry {
  border: 0;
  margin: 0;
  padding: 3px 0;
  border-bottom: 1px dotted rgba(234, 228, 216, 0.16);
  color: #b4aa97;
}

body[data-trial-layout="1"] .log-entry.error {
  color: #e08a75;
}

body[data-trial-layout="1"] .log-entry.success {
  color: #b5c98f;
}

body[data-trial-layout="1"] .log-empty {
  color: #7d7462;
  font-style: italic;
  font-family: "Gather Serif", Georgia, serif;
}

/* ===== 2 · Console ===== */

body[data-trial-layout="2"] {
  background: #0a0e0f;
  color: #c8d6d1;
  padding: 0 0 42px;
}

.l2 {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 42px);
  font-family: var(--mono);
  font-size: 12px;
}

.l2-statusline {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  background: #0e1416;
  border-bottom: 1px solid #1c2b2c;
}

.l2-sig {
  color: #5eead4;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.l2-sig::before {
  content: "▊ ";
  color: #fbbf24;
}

body[data-trial-layout="2"] .l2-badge {
  border-radius: 0;
  font-family: var(--mono);
  letter-spacing: 0.08em;
}

.l2-settings {
  margin-left: auto;
  text-decoration: none;
}

.l2-warn {
  margin: 10px 10px 0;
  padding: 8px 10px;
  border: 1px solid rgba(251, 191, 36, 0.4);
  color: #fbd38d;
  font-size: 11px;
  line-height: 1.5;
}

.l2-kv {
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  border-bottom: 1px solid #1c2b2c;
}

.l2-save {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-top: 3px;
}

.l2-line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.l2-k {
  flex-shrink: 0;
  width: 48px;
  white-space: nowrap;
  color: #64807a;
}

.l2-k::after {
  content: " =";
  color: #3d5450;
}

.l2-v {
  color: #d8e6e1;
}

.l2-path {
  color: #7dd3c0;
  font-size: 11px;
}

.l2-dim {
  margin: 0 0 0 56px;
  font-size: 11px;
  line-height: 1.5;
  color: #64807a;
}

.l2-tag {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.05em;
  padding: 1px 5px;
  border: 1px solid var(--p-border, #23393a);
  color: var(--p-color, #5eead4);
  background: transparent;
}

.l2-key {
  flex-shrink: 0;
  border: 0;
  background: transparent;
  color: #5eead4;
  font: 500 11px var(--mono);
  padding: 2px 2px;
  cursor: pointer;
  text-decoration: none;
}

.l2-key::before {
  content: "[";
  color: #3d5450;
}

.l2-key::after {
  content: "]";
  color: #3d5450;
}

.l2-key:hover:not(:disabled) {
  color: #a7f3e3;
}

.l2-key:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.l2-key:focus-visible,
.l2-prompt:focus-visible {
  outline: 2px solid rgba(94, 234, 212, 0.45);
  outline-offset: 1px;
}

.l2-scrollback {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 8px 10px;
  overflow: hidden;
}

.l2-scrollback > summary {
  display: none;
}

.l2-log {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  font-size: 11px;
  line-height: 1.55;
}

body[data-trial-layout="2"] .log-entry {
  border: 0;
  margin: 0;
  padding: 1px 0;
  color: #8fa8a1;
}

body[data-trial-layout="2"] .log-entry::before {
  content: "· ";
  color: #3d5450;
}

body[data-trial-layout="2"] .log-entry.error {
  color: #f19d8f;
}

body[data-trial-layout="2"] .log-entry.error::before {
  content: "✗ ";
  color: #f19d8f;
}

body[data-trial-layout="2"] .log-entry.success {
  color: #86dcc8;
}

body[data-trial-layout="2"] .log-entry.success::before {
  content: "✓ ";
  color: #5eead4;
}

body[data-trial-layout="2"] .log-empty {
  color: #4a625d;
}

.l2-runline {
  border-top: 1px solid #1c2b2c;
  padding: 8px 10px 6px;
}

.l2-dest {
  margin: 0 0 6px;
  word-break: break-all;
  color: #7dd3c0;
}

.l2-status {
  margin: 5px 0 0;
}

.l2-progress {
  width: 100%;
  height: 8px;
  border: 0;
  border-radius: 0;
  overflow: hidden;
  background: #14201f;
  display: block;
}

.l2-progress::-webkit-progress-bar {
  background: #14201f;
}

.l2-progress::-webkit-progress-value {
  background: #5eead4;
  transition: width 0.15s ease;
}

.l2-progress::-moz-progress-bar {
  background: #5eead4;
}

.l2-cmdbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  background: #0e1416;
  border-top: 1px solid #1c2b2c;
}

.l2-prompt {
  flex: 1;
  min-width: 0;
  text-align: left;
  background: #102019;
  border: 1px solid #2b4f47;
  border-radius: 0;
  color: #a7f3e3;
  font: 700 13px var(--mono);
  padding: 10px 12px;
  cursor: pointer;
  transition: background 0.12s, opacity 0.12s;
}

.l2-prompt::before {
  content: "❯ ";
  color: #5eead4;
}

.l2-prompt:not(:disabled)::after {
  content: "▌";
  margin-left: 5px;
  color: #5eead4;
  animation: l2-caret 1.2s steps(1) infinite;
}

.l2-prompt:hover:not(:disabled) {
  background: #143229;
}

.l2-prompt:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.l2-cmdkeys {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
}

@keyframes l2-caret {
  50% {
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .l2-prompt:not(:disabled)::after {
    animation: none;
  }
}

/* ===== 3 · Pipeline ===== */

body[data-trial-layout="3"] {
  background: #09090b;
  color: #f4f4f5;
  padding: 14px 14px 54px;
}

.l3 {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.l3-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.l3-brand {
  display: flex;
  align-items: center;
  gap: 8px;
}

.l3-mark {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #fbbf24;
  box-shadow: 0 0 10px rgba(251, 191, 36, 0.45);
}

.l3-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.l3-headside {
  display: flex;
  align-items: center;
  gap: 8px;
}

.l3-stages {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.l3-stage {
  position: relative;
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  gap: 10px;
  padding-bottom: 16px;
}

.l3-stage::before {
  content: "";
  position: absolute;
  left: 11px;
  top: 24px;
  bottom: 0;
  width: 2px;
  background: rgba(139, 92, 246, 0.25);
}

.l3-stage-last {
  padding-bottom: 4px;
}

.l3-stage-last::before {
  display: none;
}

.l3-node {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  border: 1px solid rgba(139, 92, 246, 0.6);
  background: rgba(24, 24, 27, 0.9);
  color: #a78bfa;
  font: 600 11px var(--mono);
}

.l3-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 3px;
}

.l3-stagename {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #71717a;
}

.l3-hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.45;
  color: #a1a1aa;
}

.l3-mono {
  font-family: var(--mono);
}

.l3-dest {
  color: #a78bfa;
  word-break: break-all;
}

.l3-warn {
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid rgba(251, 191, 36, 0.35);
  background: rgba(251, 191, 36, 0.08);
  color: #fcd34d;
  font-size: 11px;
  line-height: 1.45;
}

.l3-folder {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.l3-value {
  font-size: 13px;
}

.l3-ghost {
  flex-shrink: 0;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: #a78bfa;
  font: 500 11px var(--sans);
  padding: 4px 9px;
  cursor: pointer;
  text-decoration: none;
  transition: background 0.12s, border-color 0.12s;
}

.l3-ghost:hover:not(:disabled) {
  background: rgba(139, 92, 246, 0.2);
  border-color: rgba(139, 92, 246, 0.6);
}

.l3-ghost:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.l3-ghost:focus-visible,
.l3-primary:focus-visible {
  outline: 2px solid rgba(167, 139, 250, 0.4);
  outline-offset: 1px;
}

.l3-save {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.l3-savepill {
  display: flex;
  align-items: center;
  border-radius: 999px;
  border: 1px solid rgba(63, 63, 70, 0.8);
  background: rgba(24, 24, 27, 0.7);
  overflow: hidden;
}

.l3-tag {
  flex-shrink: 0;
  font: 700 10px var(--mono);
  letter-spacing: 0.04em;
  padding: 4px 10px;
  border-right: 1px solid rgba(63, 63, 70, 0.8);
  background: var(--p-bg, transparent);
  color: var(--p-color, #a1a1aa);
  white-space: nowrap;
}

.l3-path {
  font-family: var(--mono);
  font-size: 11px;
  color: #a78bfa;
  padding: 4px 10px;
}

.l3-primary {
  width: 100%;
  padding: 12px 16px;
  border: 1px solid rgba(139, 92, 246, 0.6);
  border-radius: 10px;
  background: #8b5cf6;
  color: #ede9fe;
  font: 600 14px var(--sans);
  cursor: pointer;
  transition: background 0.12s, opacity 0.12s;
}

.l3-primary:hover:not(:disabled) {
  background: #a78bfa;
}

.l3-primary:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.l3-progress {
  width: 100%;
  height: 6px;
  border: 0;
  border-radius: 999px;
  overflow: hidden;
  background: rgba(63, 63, 70, 0.8);
  display: block;
}

.l3-progress::-webkit-progress-bar {
  background: rgba(63, 63, 70, 0.8);
  border-radius: 999px;
}

.l3-progress::-webkit-progress-value {
  background: #8b5cf6;
  border-radius: 999px;
  transition: width 0.15s ease;
}

.l3-progress::-moz-progress-bar {
  background: #8b5cf6;
  border-radius: 999px;
}

.l3-runactions {
  display: flex;
  gap: 6px;
}

.l3-log {
  border: 1px solid rgba(63, 63, 70, 0.8);
  border-radius: 10px;
  background: rgba(24, 24, 27, 0.9);
  padding: 6px 12px;
}

.l3-logsummary {
  font-size: 11px;
  font-weight: 600;
  color: #71717a;
  cursor: pointer;
  padding: 4px 0;
  user-select: none;
}

.l3-logsummary::marker {
  color: #a78bfa;
}

.l3-logbody {
  max-height: 180px;
  overflow-y: auto;
  font-size: 11px;
  line-height: 1.45;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid rgba(63, 63, 70, 0.8);
}

/* ===== 4 · Capture desk ===== */

body[data-trial-layout="4"] {
  background: #0b0b0d;
  color: #fafafa;
  padding: 12px 12px 54px;
}

.l4 {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: calc(100vh - 66px);
}

.l4-hero {
  border: 1px solid #27272a;
  border-radius: 6px;
  background: #131316;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.l4-toprow {
  display: flex;
  align-items: center;
  gap: 8px;
}

.l4-brand {
  font: 700 11px var(--sans);
  letter-spacing: 0.14em;
  color: #d4d4d8;
  margin-right: auto;
}

body[data-trial-layout="4"] .badge {
  border-radius: 4px;
}

.l4-warn {
  padding: 8px 10px;
  border-radius: 4px;
  border: 1px solid rgba(251, 191, 36, 0.35);
  background: rgba(251, 191, 36, 0.07);
  color: #fcd34d;
  font-size: 11px;
  line-height: 1.5;
}

.l4-savehero {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px;
  border-radius: 4px;
  background: #0b0b0d;
  border: 1px solid #27272a;
}

.l4-tag {
  align-self: flex-start;
  font: 700 9px var(--mono);
  letter-spacing: 0.08em;
  padding: 2px 6px;
  border-radius: 3px;
  border: 1px solid var(--p-border, #3f3f46);
  background: var(--p-bg, transparent);
  color: var(--p-color, #a1a1aa);
}

.l4-heropath {
  font-family: var(--mono);
  font-size: 14px;
  line-height: 1.4;
  color: #fafafa;
  word-break: break-all;
  white-space: normal;
}

.l4-dim {
  margin: 0;
  font-size: 11px;
  line-height: 1.45;
  color: #8b8b94;
}

.l4-mono {
  font-family: var(--mono);
}

.l4-folderline {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.l4-lab {
  flex-shrink: 0;
  font: 600 10px var(--sans);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: #71717a;
}

.l4-value {
  font-size: 13px;
}

.l4-toolbtn {
  flex-shrink: 0;
  border: 1px solid #3f3f46;
  border-radius: 4px;
  background: #1c1c21;
  color: #d4d4d8;
  font: 500 11px var(--sans);
  padding: 4px 10px;
  cursor: pointer;
  text-decoration: none;
  transition: background 0.12s, opacity 0.12s;
}

.l4-toolbtn:hover:not(:disabled) {
  background: #2a2a31;
}

.l4-toolbtn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.l4-toolbtn:focus-visible,
.l4-primary:focus-visible {
  outline: 2px solid rgba(167, 139, 250, 0.4);
  outline-offset: 1px;
}

.l4-primary {
  width: 100%;
  padding: 12px 16px;
  border: 0;
  border-radius: 4px;
  background: #7c3aed;
  color: #f5f3ff;
  font: 600 14px var(--sans);
  cursor: pointer;
  transition: background 0.12s, opacity 0.12s;
}

.l4-primary:hover:not(:disabled) {
  background: #8b5cf6;
}

.l4-primary:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.l4-history {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.l4-histhead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.l4-tools {
  display: flex;
  gap: 6px;
}

.l4-progressrow {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.l4-status {
  font-variant-numeric: tabular-nums;
}

.l4-dest {
  word-break: break-all;
  color: #a78bfa;
}

.l4-progress {
  width: 100%;
  height: 5px;
  border: 0;
  border-radius: 3px;
  overflow: hidden;
  background: #27272a;
  display: block;
}

.l4-progress::-webkit-progress-bar {
  background: #27272a;
}

.l4-progress::-webkit-progress-value {
  background: #7c3aed;
  transition: width 0.15s ease;
}

.l4-progress::-moz-progress-bar {
  background: #7c3aed;
}

.l4-logwrap {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid #27272a;
  border-radius: 6px;
  background: #131316;
  overflow: hidden;
}

.l4-logwrap > summary {
  display: none;
}

.l4-log {
  flex: 1;
  min-height: 120px;
  overflow-y: auto;
  font-size: 11px;
  line-height: 1.5;
}

body[data-trial-layout="4"] .log-entry {
  border: 0;
  margin: 0;
  padding: 5px 10px;
  color: #a1a1aa;
  font-variant-numeric: tabular-nums;
}

body[data-trial-layout="4"] .log-entry:nth-child(odd) {
  background: rgba(255, 255, 255, 0.025);
}

body[data-trial-layout="4"] .log-entry.error {
  color: #fca5a5;
}

body[data-trial-layout="4"] .log-entry.success {
  color: #6ee7b7;
}

body[data-trial-layout="4"] .log-empty {
  color: #71717a;
  padding: 8px 10px;
}

/* ===== 5 · HUD ===== */

body[data-trial-layout="5"] {
  background: #0b0a14;
  color: #ece9f8;
  padding: 12px 14px 54px;
}

.l5 {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.l5-top {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 2px;
}

.l5-brand {
  display: flex;
  align-items: center;
  gap: 7px;
  font: 600 12px var(--sans);
  letter-spacing: -0.01em;
  margin-right: auto;
}

.l5-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: #fbbf24;
  box-shadow: 0 0 8px rgba(251, 191, 36, 0.5);
}

.l5-slab {
  display: flex;
  flex-direction: column;
  margin-top: 2px;
}

.l5-action {
  width: 100%;
  min-height: 108px;
  border: 0;
  border-radius: 14px 14px 4px 4px;
  background: linear-gradient(180deg, #7c3aed, #6023c9);
  color: #f5f3ff;
  font: 800 21px/1.15 var(--sans);
  letter-spacing: -0.02em;
  cursor: pointer;
  transition: filter 0.12s, background 0.2s, color 0.2s;
}

.l5-action:hover:not(:disabled) {
  filter: brightness(1.12);
}

.l5-action:disabled {
  background: #16142a;
  color: #4f4a6e;
  cursor: not-allowed;
}

.l5-action:focus-visible {
  outline: 2px solid rgba(167, 139, 250, 0.55);
  outline-offset: 2px;
}

.l5-progress {
  width: 100%;
  height: 6px;
  margin-top: 3px;
  border: 0;
  border-radius: 4px 4px 8px 8px;
  overflow: hidden;
  background: #1b1830;
  display: block;
}

.l5-progress::-webkit-progress-bar {
  background: #1b1830;
}

.l5-progress::-webkit-progress-value {
  background: #fbbf24;
  transition: width 0.15s ease;
}

.l5-progress::-moz-progress-bar {
  background: #fbbf24;
}

.l5-status {
  margin: 0;
  text-align: center;
  font: 500 11px var(--mono);
  color: #8d87ad;
  font-variant-numeric: tabular-nums;
}

.l5-warn {
  padding: 9px 11px;
  border-radius: 8px;
  border: 1px solid rgba(251, 191, 36, 0.35);
  background: rgba(251, 191, 36, 0.07);
  color: #fcd34d;
  font-size: 11px;
  line-height: 1.5;
}

.l5-facts {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.l5-fact {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 8px 2px;
  border-top: 1px solid rgba(236, 233, 248, 0.09);
}

.l5-factcol {
  flex-direction: column;
  align-items: stretch;
  gap: 3px;
}

.l5-factline {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.l5-factnote {
  padding: 0 2px 6px;
}

.l5-lab {
  flex-shrink: 0;
  width: 56px;
  font: 600 9px var(--sans);
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: #6d668f;
}

.l5-val {
  font-size: 12px;
}

.l5-mono {
  font-family: var(--mono);
  font-size: 11px;
}

.l5-dim {
  margin: 0;
  font-size: 11px;
  line-height: 1.45;
  color: #8d87ad;
}

.l5-dim.l5-mono {
  word-break: break-all;
}

.l5-tag {
  flex-shrink: 0;
  font: 700 9px var(--mono);
  letter-spacing: 0.06em;
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid var(--p-border, rgba(236, 233, 248, 0.2));
  background: var(--p-bg, transparent);
  color: var(--p-color, #8d87ad);
}

.l5-mini {
  flex-shrink: 0;
  border: 1px solid rgba(236, 233, 248, 0.14);
  border-radius: 6px;
  background: rgba(236, 233, 248, 0.05);
  color: #c7c2dd;
  font: 500 11px var(--sans);
  padding: 3px 9px;
  cursor: pointer;
  text-decoration: none;
  transition: background 0.12s, opacity 0.12s;
}

.l5-mini:hover:not(:disabled) {
  background: rgba(236, 233, 248, 0.12);
}

.l5-mini:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.l5-mini:focus-visible {
  outline: 2px solid rgba(167, 139, 250, 0.45);
  outline-offset: 1px;
}

.l5-log {
  border-top: 1px solid rgba(236, 233, 248, 0.09);
  padding-top: 6px;
}

.l5-logsummary {
  font: 600 9px var(--sans);
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: #6d668f;
  cursor: pointer;
  padding: 4px 2px;
  user-select: none;
}

.l5-logtools {
  display: flex;
  gap: 6px;
  padding: 6px 2px;
}

.l5-logbody {
  max-height: 180px;
  overflow-y: auto;
  font-size: 11px;
  line-height: 1.5;
  padding: 2px;
}

body[data-trial-layout="5"] .log-entry {
  border: 0;
  margin: 0;
  padding: 2px 0;
  color: #a49ec4;
}

body[data-trial-layout="5"] .log-entry.error {
  color: #fca5a5;
}

body[data-trial-layout="5"] .log-entry.success {
  color: #6ee7b7;
}

body[data-trial-layout="5"] .log-empty {
  color: #6d668f;
}
`;
