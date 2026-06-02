# Frame View v1.1 Plan

## Summary
v1.1 focuses on shipping a stable follow-up release after v1 core completion. Priority is cross-platform readiness hardening (without local macOS/Linux hardware), then high-value workflow upgrades for daily browsing.

## Current Status Inputs
1. Windows smoke test for v1 is complete (user-confirmed).
2. Cross-platform parity testing is still pending due to unavailable local macOS/Linux runtime validation.
3. Core v1 architecture and major feature goals are implemented.

## Goals
1. Reduce cross-platform risk before broader packaging and external testing.
2. Improve everyday usability for repeated folder browsing and media inspection.
3. Keep v1.1 scope focused enough to ship quickly.

## Non-Goals
1. Cloud sync, collaboration, or account features.
2. Destructive media editing workflows.
3. Large schema/product pivots that block short-cycle releases.

## Cross-Platform Parity Plan (No Local Mac/Linux Hardware)

### 1) Storage and folder-path policy
1. Keep settings and media index in `app.getPath('userData')`.
2. Move thumbnail cache storage to `app.getPath('cache')` (currently under `userData`) to align with OS cache conventions.
3. Add one-time migration/cleanup behavior so existing users do not lose stability after path changes.

### 2) Config/cache path expectations to verify
1. Windows:
   - userData: `%APPDATA%/<appName>`
   - cache: `%LOCALAPPDATA%/<appName>/Cache`
2. macOS:
   - userData: `~/Library/Application Support/<appName>`
   - cache: `~/Library/Caches/<appName>`
3. Linux:
   - userData: `${XDG_CONFIG_HOME:-~/.config}/<appName>`
   - cache: `${XDG_CACHE_HOME:-~/.cache}/<appName>`

### 3) Path-handling hardening
1. Re-verify canonicalization and root-authorization logic for mixed case-sensitive/case-insensitive filesystems.
2. Re-check normalization assumptions in renderer path display and folder-label logic.
3. Add targeted regression cases for path separators, casing, and symlink-like canonical path behaviors.

### 4) Platform command and shell behavior
1. Validate menu accelerator behavior across platforms.
2. Re-validate open-path flows (`open-file`, second-instance forwarding, launch args).
3. Confirm behavior for reveal/open interactions where desktop shell behavior differs by OS.

### 5) Packaging and sidecar verification
1. Re-verify ffmpeg/ffprobe unpack behavior in packaged builds.
2. Add startup diagnostics for missing/non-executable sidecar binaries.
3. Confirm expected runtime paths for sidecars in packaged app layouts.

### 6) External validation strategy
1. Create a parity checklist for external macOS/Linux test runs.
2. Include expected outcomes for open folder, drag/drop, seek/scrub, shortcuts, cache/index maintenance, and relaunch restore.
3. Require checklist completion before declaring parity for each OS.

## v1.1 Roadmap

### Milestone A - Stability and parity gate
1. Execute the cross-platform parity plan above.
2. Sync docs to remove stale follow-ups and reflect completed v1 smoke status.
3. Add a release checklist for package-time and runtime validation.

### Milestone B - Workflow upgrades (highest value)
1. Recent folders list and pinned roots.
2. Metadata side panel in viewer (resolution, duration, codec, mtime, full path with copy actions).
3. File-watcher auto-refresh for the active folder.

### Milestone C - Viewer and library quality
1. Slideshow mode (interval, sequential/random, pause on interaction).
2. Saved filter presets and extension-editor UX.
3. Context menu actions (reveal, copy path, open externally).

### Milestone D - Safety and polish
1. Confirm dialogs for maintenance/destructive actions (clear cache/index).
2. Better long-operation progress and failure messaging.
3. Keyboard shortcut reference overlay.

## Scope Cut for v1.1
1. In scope:
   - parity hardening
   - recent folders/pins
   - metadata panel
   - file watcher
   - confirm dialogs
2. Conditional if schedule allows:
   - slideshow mode
   - saved filter presets
3. Out of scope (defer to v1.2+):
   - tagging/rating systems
   - advanced search/index experiences beyond current metadata

## Suggested Release Slices
1. v1.1.0:
   - Milestone A
   - Recent folders/pins
   - Metadata panel
   - Confirm dialogs
2. v1.1.1:
   - File watcher improvements
   - Slideshow and/or filter presets if not completed in v1.1.0

## Acceptance Criteria
1. Windows remains stable under current smoke checklist.
2. Path/storage behavior is documented and validated for each target OS via checklist evidence.
3. New workflow features are covered by manual verification steps and do not regress scan/viewer reliability.
4. v1.1 scope remains controlled and shippable without blocking on net-new platform-specific rewrites.
