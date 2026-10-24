# Frame View v1 Plan (Electron + Vite + TypeScript + Tailwind)

## Summary
Build a Windows-first, cross-platform-ready desktop gallery app with a native feel using Electron Forge + Vite, React renderer, Zustand state, Tailwind styling, lazy folder scanning, and persistent cache/indexing.
Milestone 1 delivers the core flow end-to-end: open folder, lazy sidebar tree, mixed media grid, in-window viewer modal, playback controls, preferences persistence, and baseline caching behavior.

## Locked Decisions
1. UI stack: React + TypeScript.
2. OS target: Windows polished first; macOS/Linux functional stubs.
3. Data strategy: Lazy incremental scan + persistent cache.
4. State management: Zustand.
5. Grid video behavior: Autoplay on hover only.
6. Cache backend goal: SQLite + file thumbnail cache (implemented incrementally).
7. Window chrome: Native OS title bar.
8. Media backend goal: FFmpeg/ffprobe sidecar (implemented incrementally).
9. Milestone shape: End-to-end core flow.
10. Viewer mode: In-window modal viewer with fullscreen toggle.
11. Initial formats: Images `jpg/jpeg/png/webp/gif/bmp`, videos `mp4/webm/mov/mkv`.
12. Folder tree: Lazy-expand nodes.

## Architecture and Data Flow
1. Main process owns filesystem access, scanning, settings persistence, and scan event emission.
2. Preload exposes typed APIs to renderer via context bridge (`contextIsolation: true`, `nodeIntegration: false`).
3. Renderer owns UI state and presentation only.
4. Scan flow:
   1. Renderer calls folder picker and starts scan.
   2. Main scans in batches and emits incremental media results.
   3. Renderer updates grid progressively.
5. Viewer flow:
   1. Renderer opens modal at selected index.
   2. Keyboard navigation and media controls work within viewer context.

## Public Interfaces and Types
1. `window.frameView.openFolderDialog()`
2. `window.frameView.startScan(options)` / `window.frameView.cancelScan()`
3. `window.frameView.listFolderChildren(folderPath)`
4. `window.frameView.getSettings()` / `window.frameView.updateSettings(patch)`
5. `window.frameView.onScanEvent(listener)`
6. Shared types: `MediaItem`, `ScanOptions`, `ScanEvent`, `AppSettings`, `FolderNode`, `FileFilterSettings`.

## Milestone 1 Implementation Plan
1. Foundation: React renderer, Tailwind config, Zustand store, typed preload API.
2. Native layout: header, sidebar, toolbar actions, grid, empty/loading/error states.
3. Folder handling: open folder dialog, recursive toggle, lazy tree expansion, refresh.
4. Media display: mixed image/video grid, hover autoplay for videos.
5. Viewer: modal carousel, keyboard navigation, video controls (seek/play/pause/volume/speed/fullscreen).
6. Persistence: remember last folder, theme, thumbnail size, autoplay/loop settings, window bounds.
7. Performance baseline: incremental scanning and batched UI updates.

## Testing and Acceptance Criteria
1. Folder open + restore works across restart when enabled.
2. Recursive toggle changes scan scope correctly.
3. Large folders render progressively without freezing UI.
4. Viewer navigation and video controls function for mixed media.
5. Theme/settings persist between sessions.
6. Error states for unreadable folders are surfaced safely.

## Assumptions
1. English-only UI for v1.
2. Personal use; no cloud sync/tagging/destructive file operations in v1.
3. SQLite + ffmpeg sidecar are planned, but may be phased after baseline flow is stable.

---

## Progress Tracker

### Completed
- [x] Captured and finalized v1 architecture and implementation plan.
- [x] Added React + Tailwind + Zustand-based renderer foundation.
- [x] Added typed Electron preload API and IPC contract for folder/open/scan/settings/tree.
- [x] Implemented baseline folder scanning with incremental batched events.
- [x] Implemented gallery grid with mixed image/video rendering and hover autoplay.
- [x] Implemented in-window viewer modal with keyboard and video controls.
- [x] Implemented settings persistence and last-folder restore behavior.
- [x] Validation pass: `bun run lint` and `bunx tsc --noEmit` both pass.
- [x] Fixed media rendering pipeline by serving image/video paths through a custom Electron protocol (`frameview-media://`) so gallery and viewer media load reliably.
- [x] Fixed sidebar behavior so selecting a sub-folder updates the gallery contents without replacing the opened folder as the tree root.
- [x] Added image thumbnail serving via custom protocol to reduce gallery decode cost for large source images.
- [x] Added viewer playback fixes: seek bar stability, safe skip (+/-5s), and loop handling fallback on ended videos.
- [x] Added preferences toggle for preview audio on hover videos.
- [x] Added preferences toggles for showing/hiding image or video media types with automatic rescan.
- [x] Implemented byte-range aware media streaming in the custom protocol to stabilize repeated seeking and skip operations in the video viewer.
- [x] Hardened viewer seek interactions with explicit seek commit logic for rapid scrubbing.
- [x] Simplified sidebar child discovery to avoid expensive per-folder fan-out and prevent failures on folders with many sub-directories.
- [x] Fixed sidebar overflow containment so large folder trees scroll inside the sidebar pane instead of stretching the app viewport.
- [x] Persisted viewer volume between videos (and between sessions) so audio level no longer resets on navigation.
- [x] Added gallery keyboard navigation: Arrow Left/Right to change selection, Enter to open viewer.
- [x] Hardened scan cancellation using active-run identity guards to prevent stale events from cancelled/replaced scans.
- [x] Implemented persistent disk thumbnail cache keyed by media metadata (path + mtime + size + thumb size), with startup pruning.
- [x] Added thumbnail cache maintenance control in Settings (`Clear thumbnail cache`) wired through IPC.
- [x] Implemented SQLite-backed media index (`media-index.sqlite`) with scan run tracking, batched upsert, and stale-entry cleanup per root folder scan.
- [x] Added media index maintenance controls in Settings (`Clear media index`) and surfaced index stats (indexed items + root count).
- [x] Added thumbnail disk cache maintenance behavior (metadata-key invalidation + startup pruning + manual clear control).
- [x] Integrated ffmpeg/ffprobe sidecar tooling and surfaced availability status in Settings.
- [x] Added ffprobe-backed video metadata enrichment during scan (duration, resolution, codec) and persisted values into SQLite index.
- [x] Added ffmpeg-backed video thumbnail generation for protocol thumbnail requests, with fallback to native image thumbnails.
- [x] Added native application menu integration with keyboard shortcuts for open/refresh/preferences and platform-aware menu roles.
- [x] Added cross-platform app command routing (`app:command`) so main-process menu/OS events trigger renderer actions safely.
- [x] Added launch/open-path handling (`open-file`, second-instance path forwarding) for better desktop shell parity.
- [x] Completed focused Windows-native UI polish pass for header/footer status presentation and command discoverability.
- [x] Completed manual runtime smoke pass in Electron UI (user-confirmed).

### In Progress
- [ ] None.

### Not Finished / Follow-ups
- [ ] Cross-platform parity polish (macOS/Linux behavior tuning).

### Notes
- Progress tracker should be updated after every major implementation step.
- If any acceptance test fails, add a tracker note describing impact and mitigation.
- Runtime smoke test has been completed outside the headless session (user-confirmed).
- After protocol updates, a full app restart (not only hot reload) is required for media routing changes to apply.
