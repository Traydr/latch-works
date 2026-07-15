# Plan 042: Make Gather commands deterministic and side-panel-only

> **Executor instructions**: Plan 041 must provide the single Gather Run interface before removing
> legacy broadcast delivery. Preserve both user actions: toggle Gather Box and gather the exact
> active tab. Run every gate and update the plan index.
>
> **Drift check (run first)**: `git diff --stat 92b98cb..HEAD -- apps/gather-box docs/adr/0001-gather-box-run-architecture.md docs/plans/041-own-gather-runs-outside-ui.md`

## Status

- **Status**: DONE
- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plan 041
- **Category**: architecture / reliability / UX
- **Planned at**: commit `92b98cb`, 2026-07-15
- **Architecture decision**: ADR 0001

## Why this matters

Gather Box currently maps native commands, page keys, context-menu clicks, popup keys, and
side-panel keys through different paths. Download routing races a global pending boolean, a runtime
broadcast, and UI opening. Toggle routing races a close broadcast against opening the same UI. The
message that starts a download contains no target identity and a UI acknowledges before proving that
the run started.

The action popup and side panel also present two full Gather Box surfaces. Removing the popup makes
the toolbar action, toggle command, progress, permission, cancellation, and retry behavior converge
on one visible surface.

## Current state

- `manifest.json` declares both `action.default_popup` and `side_panel.default_path`.
- `src/shared/settings.ts` stores `primaryUi`; options expose popup/side-panel selection.
- `src/background/index.ts` contains command routing, the pending boolean, broadcast delivery, and
  concurrent open/close behavior.
- `src/shared/runtime-messages.ts` contains six overlapping message variants with no request ID.
- `src/shared/ui-mode.ts` switches action behavior and falls back across version-specific features.
- `src/content/page-shortcuts.ts` embeds potentially stale UI-mode settings in every command.
- `shortcutsEnabled` currently disables native Chrome commands even though options labels it as page
  shortcuts.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Tests | `pnpm --filter @latch-works/gather-box test` | command and UI tests pass |
| Check | `pnpm --filter @latch-works/gather-box check` | exit 0 |
| Manual shortcuts | Load `apps/gather-box/dist` in Chrome 145+ | toggle and gather behave consistently |

## Scope

**In scope**: one command module; exact intent identity; explicit outcomes; side-panel-only full UI;
popup removal; toolbar and toggle behavior; filesystem-permission handoff; page/native shortcut
setting separation; minimum Chrome version; command and browser tests; documentation updates.

**Out of scope**: changing shortcut defaults without conflict evidence; deleting page shortcuts
(Plan 045 keeps a small adapter); output/build isolation (Plan 043); Gather Source consolidation
(Plan 044); multiple simultaneous runs; silently granting filesystem permission.

## Git workflow

- Branch: `codex/042-make-gather-commands-deterministic`
- Commit message: `Make Gather Box commands deterministic`

## Steps

### Step 1: Deepen one command module

Define semantic commands for toggling the side panel and starting a Gather Run. Chrome commands,
page shortcuts, context menu, and side-panel controls become adapters that supply Chrome-owned sender
context and call this module.

For start, derive the exact tab/window from `commands.onCommand`, `contextMenus.onClicked`, the
content-message sender, or the current side-panel action. Never accept a caller-provided tab ID from
content as authority. Assign an intent/run ID before asynchronous routing.

Return explicit outcomes: started, already running, permission required, unsupported source, target
gone/navigated, and failed. A message response means that outcome—not merely that some listener saw
the message.

**Verify**: table-driven tests exercise every input adapter and prove equivalent semantic commands,
exact target identity, untrusted content payload rejection, and every outcome.

### Step 2: Remove broadcast and pending-state routing

Delete `PENDING_DOWNLOAD_SESSION_KEY`, direct runtime broadcasts to arbitrary extension pages, and
the accepted-before-ready handshake. No start path may depend on a UI document initializing quickly
enough to consume a boolean.

Use directed messages or run-state observation only. Include target markers on internal runtime
messages so service worker, offscreen document, and side panel ignore messages for other contexts.

**Verify**: tests mount multiple listeners/contexts and prove one command creates one Gather Run;
stale intents cannot execute on a later tab or window; no global pending key is read or written.

### Step 3: Make the side panel the only full UI

Remove the popup entry, HTML/CSS, build output, manifest `default_popup`, popup-specific controller
adapter, and `primaryUi` setting/options. Migrate any shared UI code out of `src/popup` into names
that reflect side-panel or Gather Run responsibilities; do not leave misleading popup paths.

Configure the toolbar action to open/toggle the side panel through Chrome's native panel behavior.
Use side-panel opened/closed events to maintain visibility state for the keyboard toggle. Declare
`minimum_chrome_version: "145"` so close behavior and visibility events have the required semantics.
If the drift check shows Chrome has changed the relevant contract, update the ADR and plan before
choosing another baseline.

Closing the side panel only detaches observation. Cancellation remains a distinct explicit command.

**Verify**: the packaged extension contains no popup files or popup bundle; toolbar click and toggle
command open/close the same panel; closing during a run leaves execution active; reopening shows the
same run.

### Step 4: Preserve user-gesture timing

Calls that require a user action, especially `sidePanel.open()`, must occur directly in the Chrome
command/context-menu/page-key event turn before unrelated storage reads. Pass captured identity into
later asynchronous work rather than querying again.

Filesystem permission in `prompt` state becomes a permission-required run phase. Open the side
panel and show an explicit confirmation control. Only that visible control calls
`requestPermission()`/`ensureDirectoryPermission(..., true)`, then resumes the same run ID.

**Verify**: browser tests cover a granted shortcut start and a prompt-state shortcut that opens the
panel without falsely reporting a started download; denying permission leaves no executing run.

### Step 5: Separate page and native shortcut policy

Rename settings/UI copy so `shortcutsEnabled` clearly controls only the Right Shift page shortcuts,
or migrate it to an explicit `pageShortcutsEnabled` field with backward-compatible normalization.
Native Chrome commands remain active whenever assigned; their assignment is owned by
`chrome://extensions/shortcuts` and displayed in options.

Continue to tolerate OS/Chrome shortcut conflicts by rendering `Not assigned` and linking or
instructing the user to remap. Do not swallow a stale content-script failure while indefinitely
intercepting the page key: after extension reload, the page adapter should stop preventing default or
surface that the page must reload.

**Verify**: settings migration tests preserve existing preferences; disabling page shortcuts does
not disable native commands; unassigned commands display accurately; stale-context keys do not look
successfully handled.

### Step 6: Add end-to-end command coverage

Extend the Plan 041 browser harness to invoke toolbar, native toggle, native gather, page toggle,
page gather, context menu, and side-panel buttons. Cover supported/unsupported pages, two windows,
tab switching, panel open/closed, permission granted/prompt/denied, and a run already active.

**Verify**: every adapter produces the same run state for the same semantic gather command and never
creates duplicate writes.

## Test plan

Cover semantic command mapping, sender validation, exact target capture, panel visibility state,
user-gesture call ordering, explicit outcomes, permission handoff, multiple listeners, multiple
windows, stale page adapters, settings migration, popup artifact absence, and Chrome 145 minimum
manifest validation.

## Done criteria

- [ ] Side panel is the only full Gather Box UI and no popup artifact ships.
- [ ] Toolbar action and toggle shortcut address the same panel.
- [ ] Every gather adapter submits one exact, identified intent.
- [ ] Global pending state, arbitrary broadcast delivery, and accepted-before-ready behavior are gone.
- [ ] Permission-required is explicit and resumable through visible UI.
- [ ] Page-shortcut preference no longer disables native commands.
- [ ] Command unit/integration tests, browser harness, and Gather check pass.

## STOP conditions

- The supported Chrome baseline cannot provide deterministic global side-panel close/visibility state.
- A required user-gesture call cannot be made before asynchronous work without losing target identity.
- Removing the popup would eliminate a user workflow not represented in the approved side panel.
- Settings migration would silently reset existing folder, credentials, or shortcut preferences.

## Maintenance notes

New command origins must adapt to the semantic command module; they must not add a new runtime
broadcast or independent start path. Treat delivery and execution as separate outcomes.
