/**
 * Trial studio layout set. Temporary comparison scaffolding — every layout must
 * contain each REQUIRED_ELEMENT_IDS entry exactly once so the shared
 * GatherController can bind to whichever layout is active.
 *
 * Round 2 constraints (accumulated from feedback on round 1):
 * - Original zinc/violet palette only; no bronze, no teal, no amber brand dot.
 * - Download button is always the first thing in the panel.
 * - No in-panel title or brand mark (Chrome's side panel header already names
 *   the extension); Settings lives at the bottom.
 * - Status badge stays quiet — plain colored text, no pill chrome.
 * - No terminal styling (brackets, equals signs, prompt glyphs).
 * - No cards inside cards; at most one raised surface per layout.
 * - Save paths wrap fully instead of truncating.
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

const MONOLITH_HTML = `
<div class="m1">
  <div class="m1-slab">
    <button id="downloadBtn-mini" class="m1-action" type="button" disabled>Download Content</button>
    <progress id="progressBar-mini" class="m1-progress" max="1" value="0"></progress>
  </div>
  <p class="m1-statusline">
    <span id="badge-mini" class="badge badge-idle">IDLE</span>
    <span id="progressText-mini" class="m1-status">Waiting for a supported page and folder.</span>
  </p>

  <div id="unsupportedBanner-mini" class="m1-warn" hidden></div>

  <div class="m1-facts">
    <div class="m1-row">
      <span class="m1-lab">Folder</span>
      <span id="folderName-mini" class="m1-val truncate">No folder selected</span>
      <button id="chooseFolder-mini" class="m1-btn" type="button">Choose</button>
      <button id="clearFolder-mini" class="m1-btn" type="button" disabled>Clear</button>
    </div>
    <p id="folderDetail-mini" class="m1-dim">Choose a writable folder for this run.</p>
    <div id="saveBlock-mini" class="m1-saverow" hidden>
      <div class="m1-row m1-rowtop">
        <span class="m1-lab">Saves to</span>
        <span id="savePattern-mini" class="m1-tag" hidden></span>
      </div>
      <code id="savePath-mini" class="m1-path"></code>
      <p id="saveSummary-mini" class="m1-dim"></p>
      <p id="saveFile-mini" class="m1-dim m1-mono" hidden></p>
    </div>
    <p id="destinationPreview-mini" class="m1-dim m1-mono m1-dest" hidden></p>
  </div>

  <div class="m1-logtools">
    <button id="cancelBtn-mini" class="m1-btn" type="button" disabled>Cancel run</button>
    <button id="retryBtn-mini" class="m1-btn" type="button" disabled>Retry failed</button>
    <button id="copyErrorsBtn-mini" class="m1-btn" type="button" disabled>Copy errors</button>
  </div>
  <details id="logDetails-mini" class="m1-logwrap" open>
    <summary>Activity</summary>
    <div id="resultLog-mini" class="m1-log" role="log" aria-live="polite">
      <p class="log-empty">No activity yet.</p>
    </div>
  </details>

  <a class="m1-settings" href="../options/options.html" target="_blank" rel="noreferrer">Settings</a>
</div>
`;

const DESK_HTML = `
<div class="d2">
  <button id="downloadBtn-mini" class="d2-action" type="button" disabled>Download Content</button>

  <div id="unsupportedBanner-mini" class="d2-warn" hidden></div>

  <div class="d2-folderline">
    <span class="d2-lab">Folder</span>
    <span id="folderName-mini" class="d2-val truncate">No folder selected</span>
    <button id="chooseFolder-mini" class="d2-btn" type="button">Choose</button>
    <button id="clearFolder-mini" class="d2-btn" type="button" disabled>Clear</button>
  </div>
  <p id="folderDetail-mini" class="d2-dim">Choose a writable folder for this run.</p>

  <div id="saveBlock-mini" class="d2-save" hidden>
    <div class="d2-saverow">
      <span class="d2-lab">Saves to</span>
      <span id="savePattern-mini" class="d2-tag" hidden></span>
    </div>
    <code id="savePath-mini" class="d2-path"></code>
    <p id="saveSummary-mini" class="d2-dim"></p>
    <p id="saveFile-mini" class="d2-dim d2-mono" hidden></p>
  </div>

  <section class="d2-history">
    <header class="d2-histhead">
      <span class="d2-lab">Run log</span>
      <div class="d2-tools">
        <button id="cancelBtn-mini" class="d2-btn" type="button" disabled>Cancel</button>
        <button id="retryBtn-mini" class="d2-btn" type="button" disabled>Retry</button>
        <button id="copyErrorsBtn-mini" class="d2-btn" type="button" disabled>Copy errors</button>
      </div>
    </header>
    <div class="d2-progressrow">
      <progress id="progressBar-mini" class="d2-progress" max="1" value="0"></progress>
      <p class="d2-statusline">
        <span id="badge-mini" class="badge badge-idle">IDLE</span>
        <span id="progressText-mini" class="d2-status">Waiting for a supported page and folder.</span>
      </p>
      <p id="destinationPreview-mini" class="d2-dim d2-mono d2-dest" hidden></p>
    </div>
    <details id="logDetails-mini" class="d2-logwrap" open>
      <summary>entries</summary>
      <div id="resultLog-mini" class="d2-log" role="log" aria-live="polite">
        <p class="log-empty">No activity yet.</p>
      </div>
    </details>
  </section>

  <a class="d2-settings" href="../options/options.html" target="_blank" rel="noreferrer">Settings</a>
</div>
`;

const CHECKLIST_HTML = `
<div class="c3">
  <button id="downloadBtn-mini" class="c3-action" type="button" disabled>Download Content</button>

  <div id="unsupportedBanner-mini" class="c3-warn" hidden></div>

  <ol class="c3-stages">
    <li class="c3-stage">
      <span class="c3-node" aria-hidden="true"></span>
      <div class="c3-body">
        <h2 class="c3-stagename">Folder</h2>
        <div class="c3-folder">
          <span id="folderName-mini" class="c3-val truncate">No folder selected</span>
          <button id="chooseFolder-mini" class="c3-btn" type="button">Choose</button>
          <button id="clearFolder-mini" class="c3-btn" type="button" disabled>Clear</button>
        </div>
        <p id="folderDetail-mini" class="c3-dim">Choose a writable folder for this run.</p>
      </div>
    </li>
    <li class="c3-stage">
      <span class="c3-node" aria-hidden="true"></span>
      <div class="c3-body">
        <h2 class="c3-stagename">Saves to</h2>
        <div id="saveBlock-mini" class="c3-save" hidden>
          <span id="savePattern-mini" class="c3-tag" hidden></span>
          <code id="savePath-mini" class="c3-path"></code>
          <p id="saveSummary-mini" class="c3-dim"></p>
          <p id="saveFile-mini" class="c3-dim c3-mono" hidden></p>
        </div>
      </div>
    </li>
    <li class="c3-stage c3-stage-last">
      <span class="c3-node" aria-hidden="true"></span>
      <div class="c3-body">
        <h2 class="c3-stagename">Activity</h2>
        <progress id="progressBar-mini" class="c3-progress" max="1" value="0"></progress>
        <p class="c3-statusline">
          <span id="badge-mini" class="badge badge-idle">IDLE</span>
          <span id="progressText-mini" class="c3-status">Waiting for a supported page and folder.</span>
        </p>
        <p id="destinationPreview-mini" class="c3-dim c3-mono c3-dest" hidden></p>
        <div class="c3-tools">
          <button id="cancelBtn-mini" class="c3-btn" type="button" disabled>Cancel run</button>
          <button id="retryBtn-mini" class="c3-btn" type="button" disabled>Retry failed</button>
          <button id="copyErrorsBtn-mini" class="c3-btn" type="button" disabled>Copy errors</button>
        </div>
        <details id="logDetails-mini" class="c3-logwrap" open>
          <summary>entries</summary>
          <div id="resultLog-mini" class="c3-log" role="log" aria-live="polite">
            <p class="log-empty">No activity yet.</p>
          </div>
        </details>
      </div>
    </li>
  </ol>

  <a class="c3-settings" href="../options/options.html" target="_blank" rel="noreferrer">Settings</a>
</div>
`;

const STAGE_HTML = `
<div class="p4">
  <button id="downloadBtn-mini" class="p4-action" type="button" disabled>Download Content</button>
  <progress id="progressBar-mini" class="p4-progress" max="1" value="0"></progress>
  <p class="p4-statusline">
    <span id="badge-mini" class="badge badge-idle">IDLE</span>
    <span id="progressText-mini" class="p4-status">Waiting for a supported page and folder.</span>
  </p>

  <div id="unsupportedBanner-mini" class="p4-warn" hidden></div>

  <section class="p4-dest">
    <div id="saveBlock-mini" class="p4-save" hidden>
      <span id="savePattern-mini" class="p4-tag" hidden></span>
      <code id="savePath-mini" class="p4-path"></code>
      <p id="saveSummary-mini" class="p4-dim"></p>
      <p id="saveFile-mini" class="p4-dim p4-mono" hidden></p>
    </div>
    <p id="destinationPreview-mini" class="p4-dim p4-mono p4-destpreview" hidden></p>
    <div class="p4-folderline">
      <span id="folderName-mini" class="p4-val truncate">No folder selected</span>
      <button id="chooseFolder-mini" class="p4-btn" type="button">Choose</button>
      <button id="clearFolder-mini" class="p4-btn" type="button" disabled>Clear</button>
    </div>
    <p id="folderDetail-mini" class="p4-dim">Choose a writable folder for this run.</p>
  </section>

  <details id="logDetails-mini" class="p4-logwrap">
    <summary class="p4-logsummary">Activity</summary>
    <div class="p4-tools">
      <button id="cancelBtn-mini" class="p4-btn" type="button" disabled>Cancel run</button>
      <button id="retryBtn-mini" class="p4-btn" type="button" disabled>Retry failed</button>
      <button id="copyErrorsBtn-mini" class="p4-btn" type="button" disabled>Copy errors</button>
    </div>
    <div id="resultLog-mini" class="p4-log" role="log" aria-live="polite">
      <p class="log-empty">No activity yet.</p>
    </div>
  </details>

  <a class="p4-settings" href="../options/options.html" target="_blank" rel="noreferrer">Settings</a>
</div>
`;

const QUIET_ROWS_HTML = `
<div class="q5">
  <button id="downloadBtn-mini" class="q5-action" type="button" disabled>Download Content</button>

  <div id="unsupportedBanner-mini" class="q5-warn" hidden></div>

  <dl class="q5-rows">
    <div class="q5-row">
      <dt class="q5-dt">Folder</dt>
      <dd class="q5-dd">
        <div class="q5-cell">
          <span id="folderName-mini" class="q5-val truncate">No folder selected</span>
          <button id="chooseFolder-mini" class="q5-btn" type="button">Choose</button>
          <button id="clearFolder-mini" class="q5-btn" type="button" disabled>Clear</button>
        </div>
        <p id="folderDetail-mini" class="q5-dim">Choose a writable folder for this run.</p>
      </dd>
    </div>
    <div class="q5-row" id="saveBlock-mini" hidden>
      <dt class="q5-dt">Saves to</dt>
      <dd class="q5-dd">
        <span id="savePattern-mini" class="q5-tag" hidden></span>
        <code id="savePath-mini" class="q5-path"></code>
        <p id="saveSummary-mini" class="q5-dim"></p>
        <p id="saveFile-mini" class="q5-dim q5-mono" hidden></p>
      </dd>
    </div>
    <div class="q5-row">
      <dt class="q5-dt">Run</dt>
      <dd class="q5-dd">
        <p id="destinationPreview-mini" class="q5-dim q5-mono q5-dest" hidden></p>
        <progress id="progressBar-mini" class="q5-progress" max="1" value="0"></progress>
        <p class="q5-statusline">
          <span id="badge-mini" class="badge badge-idle">IDLE</span>
          <span id="progressText-mini" class="q5-status">Waiting for a supported page and folder.</span>
        </p>
      </dd>
    </div>
  </dl>

  <details id="logDetails-mini" class="q5-logwrap" open>
    <summary>Activity</summary>
    <div id="resultLog-mini" class="q5-log" role="log" aria-live="polite">
      <p class="log-empty">No activity yet.</p>
    </div>
  </details>

  <div class="q5-foot">
    <button id="cancelBtn-mini" class="q5-textbtn" type="button" disabled>Cancel run</button>
    <button id="retryBtn-mini" class="q5-textbtn" type="button" disabled>Retry failed</button>
    <button id="copyErrorsBtn-mini" class="q5-textbtn" type="button" disabled>Copy errors</button>
    <a class="q5-textbtn q5-settings" href="../options/options.html" target="_blank" rel="noreferrer">Settings</a>
  </div>
</div>
`;

export const TRIAL_LAYOUTS: TrialLayout[] = [
  { name: "Monolith", tagline: "Giant gather slab, fact rows, always-on striped log", html: MONOLITH_HTML },
  { name: "Desk", tagline: "Flat action zone over a single run-log surface with toolbar", html: DESK_HTML },
  { name: "Checklist", tagline: "Download first, then a quiet rail: folder, saves-to, activity", html: CHECKLIST_HTML },
  { name: "Stage", tagline: "Destination as the headline, log tucked away", html: STAGE_HTML },
  { name: "Quiet rows", tagline: "Ruled label rows under a full-width action", html: QUIET_ROWS_HTML }
];

export const TRIAL_CSS = `
/* ===== Trial studio chrome (temporary) ===== */

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

/* Quiet status badge shared by all round-2 layouts: plain colored text. */
body[data-trial-layout] .badge {
  border: 0;
  background: transparent;
  padding: 0;
  border-radius: 0;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  flex-shrink: 0;
}

/* ===== 1 · Monolith ===== */

body[data-trial-layout="1"] {
  padding: 12px 14px 54px;
}

.m1 {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: calc(100vh - 66px);
}

.m1-slab {
  display: flex;
  flex-direction: column;
}

.m1-action {
  width: 100%;
  min-height: 96px;
  border: 0;
  border-radius: 14px 14px 4px 4px;
  background: linear-gradient(180deg, #8b5cf6, #6d28d9);
  color: #f5f3ff;
  font: 700 19px/1.15 var(--sans);
  letter-spacing: -0.02em;
  cursor: pointer;
  transition: filter 0.12s, background 0.2s, color 0.2s;
}

.m1-action:hover:not(:disabled) {
  filter: brightness(1.1);
}

.m1-action:disabled {
  background: #18181b;
  color: #52525b;
  cursor: not-allowed;
}

.m1-action:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
}

.m1-progress {
  width: 100%;
  height: 6px;
  margin-top: 3px;
  border: 0;
  border-radius: 4px 4px 8px 8px;
  overflow: hidden;
  background: rgba(63, 63, 70, 0.8);
  display: block;
}

.m1-progress::-webkit-progress-bar {
  background: rgba(63, 63, 70, 0.8);
}

.m1-progress::-webkit-progress-value {
  background: var(--accent);
  transition: width 0.15s ease;
}

.m1-progress::-moz-progress-bar {
  background: var(--accent);
}

.m1-statusline {
  margin: 0;
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 8px;
  min-width: 0;
}

.m1-status {
  font-size: 11px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}

.m1-warn {
  padding: 9px 11px;
  border-radius: 8px;
  border: 1px solid rgba(251, 191, 36, 0.35);
  background: rgba(251, 191, 36, 0.07);
  color: #fcd34d;
  font-size: 11px;
  line-height: 1.5;
}

.m1-facts {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 2px 2px 0;
}

.m1-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.m1-rowtop {
  margin-top: 8px;
}

.m1-lab {
  flex-shrink: 0;
  width: 56px;
  font: 600 10px var(--sans);
  text-transform: uppercase;
  letter-spacing: 0.09em;
  color: var(--label);
}

.m1-val {
  font-size: 13px;
  flex: 1;
}

.m1-dim {
  margin: 0 0 0 64px;
  font-size: 11px;
  line-height: 1.45;
  color: var(--muted-foreground);
}

.m1-mono {
  font-family: var(--mono);
}

.m1-dest {
  color: var(--accent-hover);
  word-break: break-all;
}

.m1-saverow {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.m1-tag {
  font: 700 9px var(--mono);
  letter-spacing: 0.06em;
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid var(--p-border, var(--surface-border));
  background: var(--p-bg, transparent);
  color: var(--p-color, var(--muted-foreground));
}

.m1-path {
  margin-left: 64px;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.5;
  color: var(--foreground);
  white-space: normal;
  word-break: break-all;
}

.m1-btn {
  flex-shrink: 0;
  border: 1px solid var(--input-border);
  border-radius: 8px;
  background: var(--input-bg);
  color: var(--foreground);
  font: 500 11px var(--sans);
  padding: 4px 10px;
  cursor: pointer;
  transition: background 0.12s, opacity 0.12s;
}

.m1-btn:hover:not(:disabled) {
  background: rgba(63, 63, 70, 0.7);
}

.m1-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.m1-btn:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 1px;
}

.m1-logtools {
  display: flex;
  gap: 6px;
  margin-top: 2px;
}

.m1-logwrap {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--surface-border);
  border-radius: 10px;
  background: var(--surface);
  overflow: hidden;
}

.m1-logwrap > summary {
  display: none;
}

.m1-log {
  flex: 1;
  min-height: 120px;
  overflow-y: auto;
  font-size: 11px;
  line-height: 1.5;
}

body[data-trial-layout="1"] .log-entry {
  border: 0;
  margin: 0;
  padding: 5px 10px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}

body[data-trial-layout="1"] .log-entry:nth-child(odd) {
  background: rgba(255, 255, 255, 0.025);
}

body[data-trial-layout="1"] .log-entry.error {
  color: var(--destructive);
}

body[data-trial-layout="1"] .log-entry.success {
  color: var(--success);
}

body[data-trial-layout="1"] .log-empty {
  color: var(--label);
  padding: 8px 10px;
}

.m1-settings {
  align-self: center;
  color: var(--label);
  font-size: 11px;
  text-decoration: none;
  padding: 2px 6px;
}

.m1-settings:hover {
  color: var(--muted-foreground);
  text-decoration: underline;
}

/* ===== 2 · Desk ===== */

body[data-trial-layout="2"] {
  padding: 12px 14px 54px;
}

.d2 {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: calc(100vh - 66px);
}

.d2-action {
  width: 100%;
  padding: 14px 16px;
  border: 0;
  border-radius: 10px;
  background: var(--accent);
  color: var(--accent-foreground);
  font: 600 15px var(--sans);
  cursor: pointer;
  transition: background 0.12s, opacity 0.12s;
}

.d2-action:hover:not(:disabled) {
  background: var(--accent-hover);
}

.d2-action:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.d2-action:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
}

.d2-warn {
  padding: 9px 11px;
  border-radius: 8px;
  border: 1px solid rgba(251, 191, 36, 0.35);
  background: rgba(251, 191, 36, 0.07);
  color: #fcd34d;
  font-size: 11px;
  line-height: 1.5;
}

.d2-folderline {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 0 2px;
}

.d2-saverow {
  display: flex;
  align-items: center;
  gap: 8px;
}

.d2-lab {
  flex-shrink: 0;
  font: 600 10px var(--sans);
  text-transform: uppercase;
  letter-spacing: 0.09em;
  color: var(--label);
}

.d2-val {
  font-size: 13px;
  flex: 1;
}

.d2-dim {
  margin: 0;
  padding: 0 2px;
  font-size: 11px;
  line-height: 1.45;
  color: var(--muted-foreground);
}

.d2-mono {
  font-family: var(--mono);
}

.d2-save {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0 2px;
}

.d2-tag {
  font: 700 9px var(--mono);
  letter-spacing: 0.06em;
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid var(--p-border, var(--surface-border));
  background: var(--p-bg, transparent);
  color: var(--p-color, var(--muted-foreground));
}

.d2-path {
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.5;
  color: var(--foreground);
  white-space: normal;
  word-break: break-all;
}

.d2-btn {
  flex-shrink: 0;
  border: 1px solid var(--input-border);
  border-radius: 6px;
  background: #1c1c21;
  color: #d4d4d8;
  font: 500 11px var(--sans);
  padding: 5px 11px;
  cursor: pointer;
  transition: background 0.12s, opacity 0.12s;
}

.d2-btn:hover:not(:disabled) {
  background: #2a2a31;
}

.d2-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.d2-btn:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 1px;
}

.d2-history {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--surface-border);
  border-radius: 10px;
  background: var(--surface);
  padding: 10px;
}

.d2-histhead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.d2-tools {
  display: flex;
  gap: 6px;
}

.d2-progressrow {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.d2-statusline {
  margin: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.d2-status {
  font-size: 11px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}

.d2-dest {
  padding: 0;
  color: var(--accent-hover);
  word-break: break-all;
}

.d2-progress {
  width: 100%;
  height: 5px;
  border: 0;
  border-radius: 3px;
  overflow: hidden;
  background: rgba(63, 63, 70, 0.8);
  display: block;
}

.d2-progress::-webkit-progress-bar {
  background: rgba(63, 63, 70, 0.8);
}

.d2-progress::-webkit-progress-value {
  background: var(--accent);
  transition: width 0.15s ease;
}

.d2-progress::-moz-progress-bar {
  background: var(--accent);
}

.d2-logwrap {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  margin: 0 -10px -10px;
  border-top: 1px solid var(--surface-border);
}

.d2-logwrap > summary {
  display: none;
}

.d2-log {
  flex: 1;
  min-height: 110px;
  overflow-y: auto;
  font-size: 11px;
  line-height: 1.5;
}

body[data-trial-layout="2"] .log-entry {
  border: 0;
  margin: 0;
  padding: 5px 10px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}

body[data-trial-layout="2"] .log-entry:nth-child(odd) {
  background: rgba(255, 255, 255, 0.025);
}

body[data-trial-layout="2"] .log-entry.error {
  color: var(--destructive);
}

body[data-trial-layout="2"] .log-entry.success {
  color: var(--success);
}

body[data-trial-layout="2"] .log-empty {
  color: var(--label);
  padding: 8px 10px;
}

.d2-settings {
  align-self: center;
  color: var(--label);
  font-size: 11px;
  text-decoration: none;
  padding: 2px 6px;
}

.d2-settings:hover {
  color: var(--muted-foreground);
  text-decoration: underline;
}

/* ===== 3 · Checklist ===== */

body[data-trial-layout="3"] {
  padding: 12px 14px 54px;
}

.c3 {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.c3-action {
  width: 100%;
  padding: 14px 16px;
  border: 1px solid var(--accent-border);
  border-radius: 12px;
  background: var(--accent);
  color: var(--accent-foreground);
  font: 600 15px var(--sans);
  cursor: pointer;
  transition: background 0.12s, opacity 0.12s;
}

.c3-action:hover:not(:disabled) {
  background: var(--accent-hover);
}

.c3-action:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.c3-action:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
}

.c3-warn {
  padding: 9px 11px;
  border-radius: 8px;
  border: 1px solid rgba(251, 191, 36, 0.35);
  background: rgba(251, 191, 36, 0.07);
  color: #fcd34d;
  font-size: 11px;
  line-height: 1.5;
}

.c3-stages {
  list-style: none;
  margin: 0;
  padding: 0 2px;
  display: flex;
  flex-direction: column;
}

.c3-stage {
  position: relative;
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  gap: 10px;
  padding-bottom: 16px;
}

.c3-stage::before {
  content: "";
  position: absolute;
  left: 8px;
  top: 16px;
  bottom: 0;
  width: 2px;
  background: rgba(139, 92, 246, 0.25);
}

.c3-stage-last {
  padding-bottom: 4px;
}

.c3-stage-last::before {
  display: none;
}

.c3-node {
  width: 10px;
  height: 10px;
  margin: 4px;
  border-radius: 999px;
  border: 2px solid var(--accent-border);
  background: var(--background);
}

.c3-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.c3-stagename {
  margin: 0;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.09em;
  color: var(--label);
}

.c3-dim {
  margin: 0;
  font-size: 11px;
  line-height: 1.45;
  color: var(--muted-foreground);
}

.c3-mono {
  font-family: var(--mono);
}

.c3-dest {
  color: var(--accent-hover);
  word-break: break-all;
}

.c3-folder {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.c3-val {
  font-size: 13px;
  flex: 1;
}

.c3-save {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.c3-tag {
  align-self: flex-start;
  font: 700 9px var(--mono);
  letter-spacing: 0.06em;
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid var(--p-border, var(--surface-border));
  background: var(--p-bg, transparent);
  color: var(--p-color, var(--muted-foreground));
}

.c3-path {
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.5;
  color: var(--foreground);
  white-space: normal;
  word-break: break-all;
}

.c3-btn {
  flex-shrink: 0;
  border: 1px solid var(--input-border);
  border-radius: 6px;
  background: #1c1c21;
  color: #d4d4d8;
  font: 500 11px var(--sans);
  padding: 4px 10px;
  cursor: pointer;
  transition: background 0.12s, opacity 0.12s;
}

.c3-btn:hover:not(:disabled) {
  background: #2a2a31;
}

.c3-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.c3-btn:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 1px;
}

.c3-statusline {
  margin: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.c3-status {
  font-size: 11px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}

.c3-progress {
  width: 100%;
  height: 5px;
  border: 0;
  border-radius: 3px;
  overflow: hidden;
  background: rgba(63, 63, 70, 0.8);
  display: block;
}

.c3-progress::-webkit-progress-bar {
  background: rgba(63, 63, 70, 0.8);
}

.c3-progress::-webkit-progress-value {
  background: var(--accent);
  transition: width 0.15s ease;
}

.c3-progress::-moz-progress-bar {
  background: var(--accent);
}

.c3-tools {
  display: flex;
  gap: 6px;
}

.c3-logwrap {
  margin-top: 2px;
}

.c3-logwrap > summary {
  display: none;
}

.c3-log {
  max-height: 190px;
  overflow-y: auto;
  border-radius: 8px;
  border: 1px solid var(--surface-border);
  font-size: 11px;
  line-height: 1.5;
}

body[data-trial-layout="3"] .log-entry {
  border: 0;
  margin: 0;
  padding: 5px 10px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}

body[data-trial-layout="3"] .log-entry:nth-child(odd) {
  background: rgba(255, 255, 255, 0.025);
}

body[data-trial-layout="3"] .log-entry.error {
  color: var(--destructive);
}

body[data-trial-layout="3"] .log-entry.success {
  color: var(--success);
}

body[data-trial-layout="3"] .log-empty {
  color: var(--label);
  padding: 8px 10px;
}

.c3-settings {
  align-self: center;
  color: var(--label);
  font-size: 11px;
  text-decoration: none;
  padding: 2px 6px;
}

.c3-settings:hover {
  color: var(--muted-foreground);
  text-decoration: underline;
}

/* ===== 4 · Stage ===== */

body[data-trial-layout="4"] {
  padding: 14px 16px 54px;
}

.p4 {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.p4-action {
  width: 100%;
  padding: 16px;
  border: 0;
  border-radius: 12px;
  background: var(--accent);
  color: var(--accent-foreground);
  font: 700 16px var(--sans);
  letter-spacing: -0.01em;
  cursor: pointer;
  transition: background 0.12s, opacity 0.12s;
}

.p4-action:hover:not(:disabled) {
  background: var(--accent-hover);
}

.p4-action:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.p4-action:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
}

.p4-progress {
  width: 100%;
  height: 4px;
  margin-top: -6px;
  border: 0;
  border-radius: 2px;
  overflow: hidden;
  background: rgba(63, 63, 70, 0.8);
  display: block;
}

.p4-progress::-webkit-progress-bar {
  background: rgba(63, 63, 70, 0.8);
}

.p4-progress::-webkit-progress-value {
  background: var(--accent-hover);
  transition: width 0.15s ease;
}

.p4-progress::-moz-progress-bar {
  background: var(--accent-hover);
}

.p4-statusline {
  margin: -4px 0 0;
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 8px;
  min-width: 0;
}

.p4-status {
  font-size: 11px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}

.p4-warn {
  padding: 9px 11px;
  border-radius: 8px;
  border: 1px solid rgba(251, 191, 36, 0.35);
  background: rgba(251, 191, 36, 0.07);
  color: #fcd34d;
  font-size: 11px;
  line-height: 1.5;
}

.p4-dest {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px 2px 0;
}

.p4-save {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.p4-tag {
  align-self: flex-start;
  font: 700 9px var(--mono);
  letter-spacing: 0.08em;
  padding: 2px 7px;
  border-radius: 4px;
  border: 1px solid var(--p-border, var(--surface-border));
  background: var(--p-bg, transparent);
  color: var(--p-color, var(--muted-foreground));
}

.p4-path {
  font-family: var(--mono);
  font-size: 15px;
  line-height: 1.5;
  color: var(--foreground);
  white-space: normal;
  word-break: break-all;
}

.p4-dim {
  margin: 0;
  font-size: 11px;
  line-height: 1.45;
  color: var(--muted-foreground);
}

.p4-mono {
  font-family: var(--mono);
}

.p4-destpreview {
  color: var(--accent-hover);
  word-break: break-all;
}

.p4-folderline {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin-top: 10px;
  padding-top: 12px;
  border-top: 1px solid rgba(63, 63, 70, 0.5);
}

.p4-val {
  font-size: 13px;
  flex: 1;
}

.p4-btn {
  flex-shrink: 0;
  border: 1px solid var(--input-border);
  border-radius: 6px;
  background: #1c1c21;
  color: #d4d4d8;
  font: 500 11px var(--sans);
  padding: 4px 10px;
  cursor: pointer;
  transition: background 0.12s, opacity 0.12s;
}

.p4-btn:hover:not(:disabled) {
  background: #2a2a31;
}

.p4-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.p4-btn:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 1px;
}

.p4-logwrap {
  margin-top: 4px;
  border-top: 1px solid rgba(63, 63, 70, 0.5);
  padding: 8px 2px 0;
}

.p4-logsummary {
  font: 600 10px var(--sans);
  text-transform: uppercase;
  letter-spacing: 0.09em;
  color: var(--label);
  cursor: pointer;
  padding: 2px 0;
  user-select: none;
}

.p4-logsummary::marker {
  color: var(--accent-hover);
}

.p4-tools {
  display: flex;
  gap: 6px;
  padding: 8px 0 6px;
}

.p4-log {
  max-height: 200px;
  overflow-y: auto;
  font-size: 11px;
  line-height: 1.5;
}

body[data-trial-layout="4"] .log-entry {
  border: 0;
  margin: 0;
  padding: 4px 0;
  border-bottom: 1px solid rgba(63, 63, 70, 0.35);
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}

body[data-trial-layout="4"] .log-entry.error {
  color: var(--destructive);
}

body[data-trial-layout="4"] .log-entry.success {
  color: var(--success);
}

body[data-trial-layout="4"] .log-empty {
  color: var(--label);
}

.p4-settings {
  align-self: center;
  color: var(--label);
  font-size: 11px;
  text-decoration: none;
  padding: 2px 6px;
}

.p4-settings:hover {
  color: var(--muted-foreground);
  text-decoration: underline;
}

/* ===== 5 · Quiet rows ===== */

body[data-trial-layout="5"] {
  padding: 14px 16px 54px;
}

.q5 {
  display: flex;
  flex-direction: column;
}

.q5-action {
  width: 100%;
  padding: 13px 16px;
  border: 1px solid var(--accent-border);
  border-radius: 10px;
  background: var(--accent);
  color: var(--accent-foreground);
  font: 600 15px var(--sans);
  cursor: pointer;
  transition: background 0.12s, opacity 0.12s;
}

.q5-action:hover:not(:disabled) {
  background: var(--accent-hover);
}

.q5-action:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.q5-action:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
}

.q5-warn {
  margin-top: 10px;
  padding: 9px 11px;
  border-radius: 8px;
  border: 1px solid rgba(251, 191, 36, 0.35);
  background: rgba(251, 191, 36, 0.07);
  color: #fcd34d;
  font-size: 11px;
  line-height: 1.5;
}

.q5-rows {
  margin: 6px 0 0;
  display: flex;
  flex-direction: column;
}

.q5-row {
  display: grid;
  grid-template-columns: 70px minmax(0, 1fr);
  gap: 10px;
  padding: 11px 2px;
  border-bottom: 1px solid rgba(63, 63, 70, 0.5);
}

.q5-dt {
  font: 600 10px/1.7 var(--sans);
  text-transform: uppercase;
  letter-spacing: 0.09em;
  color: var(--label);
}

.q5-dd {
  margin: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.q5-cell {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.q5-val {
  font-size: 13px;
  flex: 1;
}

.q5-dim {
  margin: 0;
  font-size: 11px;
  line-height: 1.45;
  color: var(--muted-foreground);
}

.q5-mono {
  font-family: var(--mono);
}

.q5-dest {
  color: var(--accent-hover);
  word-break: break-all;
}

.q5-tag {
  align-self: flex-start;
  font: 700 9px var(--mono);
  letter-spacing: 0.06em;
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid var(--p-border, var(--surface-border));
  background: var(--p-bg, transparent);
  color: var(--p-color, var(--muted-foreground));
}

.q5-path {
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.5;
  color: var(--foreground);
  white-space: normal;
  word-break: break-all;
}

.q5-btn {
  flex-shrink: 0;
  border: 1px solid var(--input-border);
  border-radius: 6px;
  background: #1c1c21;
  color: #d4d4d8;
  font: 500 11px var(--sans);
  padding: 4px 10px;
  cursor: pointer;
  transition: background 0.12s, opacity 0.12s;
}

.q5-btn:hover:not(:disabled) {
  background: #2a2a31;
}

.q5-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.q5-btn:focus-visible,
.q5-textbtn:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 1px;
}

.q5-statusline {
  margin: 2px 0 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.q5-status {
  font-size: 11px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}

.q5-progress {
  width: 100%;
  height: 4px;
  border: 0;
  border-radius: 2px;
  overflow: hidden;
  background: rgba(63, 63, 70, 0.8);
  display: block;
}

.q5-progress::-webkit-progress-bar {
  background: rgba(63, 63, 70, 0.8);
}

.q5-progress::-webkit-progress-value {
  background: var(--accent);
  transition: width 0.15s ease;
}

.q5-progress::-moz-progress-bar {
  background: var(--accent);
}

.q5-logwrap {
  padding: 2px;
}

.q5-logwrap > summary {
  padding: 9px 0 4px;
  font: 600 10px var(--sans);
  text-transform: uppercase;
  letter-spacing: 0.09em;
  color: var(--label);
  cursor: pointer;
  user-select: none;
}

.q5-logwrap > summary::marker {
  color: var(--accent-hover);
}

.q5-log {
  max-height: 210px;
  overflow-y: auto;
  font-size: 11px;
  line-height: 1.5;
}

body[data-trial-layout="5"] .log-entry {
  border: 0;
  margin: 0;
  padding: 3px 0;
  border-bottom: 1px dotted rgba(63, 63, 70, 0.7);
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}

body[data-trial-layout="5"] .log-entry.error {
  color: var(--destructive);
}

body[data-trial-layout="5"] .log-entry.success {
  color: var(--success);
}

body[data-trial-layout="5"] .log-empty {
  color: var(--label);
}

.q5-foot {
  display: flex;
  gap: 14px;
  margin-top: 8px;
  padding: 8px 2px 0;
  border-top: 1px solid rgba(63, 63, 70, 0.5);
}

.q5-textbtn {
  border: 0;
  background: transparent;
  padding: 2px 0;
  color: var(--accent-hover);
  font: 500 11px var(--sans);
  cursor: pointer;
  text-decoration: none;
}

.q5-textbtn:hover:not(:disabled) {
  text-decoration: underline;
}

.q5-textbtn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.q5-settings {
  margin-left: auto;
  color: var(--label);
}
`;
