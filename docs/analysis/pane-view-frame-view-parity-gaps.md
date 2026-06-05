# Pane View ↔ Frame View Parity Gaps

Last updated: 2026-06-05

This document lists **features and behaviours that Pane View (`apps/pane-view`) is still missing compared to Frame View (`apps/frame-view`)**. It is the working checklist for Phase 7 feature parity work.

Frame View is the Windows-first Electron desktop gallery. Pane View is the authenticated web viewer over the synced archive. Some desktop-only behaviours need web-adapted equivalents rather than literal ports.

---

## Summary

| Area | Frame View | Pane View today |
| --- | --- | --- |
| Core gallery (grid, sort, recursive, comic grouping) | ✅ | ✅ Mostly aligned |
| Fullscreen viewer + video controls | ✅ | ✅ Mostly aligned |
| Preferences / settings UI | ✅ Tabbed drawer | ❌ Not implemented |
| Thumbnail grid behaviour | ✅ Hover autoplay, priority queue | ❌ Static images only |
| Folder navigation polish | ✅ Header controls, ceiling, overlay | ⚠️ Partial |
| Comic reading UX | ✅ Vertical scroll reader | ❌ Paginated viewer only |
| Metadata enrichment | ✅ ffprobe, codec, lazy probe | ❌ DB fields only |
| Resume / viewer state | N/A (local files) | ⚠️ Server API exists, UI not wired |
| Desktop shell integration | ✅ Menus, drag-drop, reveal | N/A (web) |
| Diagnostics / cache maintenance | ✅ Debug tab | ❌ Not implemented |

---

## Already at parity (or close)

These Frame View behaviours are present in Pane View and are **not** gap items:

- Path-first archive browsing with sidebar, breadcrumbs, and folder cards in the grid
- Recursive mode toggle and comic grouping mode
- Sort modes: name A–Z / Z–A, date newest / oldest, random + shuffle
- Virtualized thumbnail grid (`useVirtualGridMetrics`, row windowing)
- Double-click / Enter / `F` to open the viewer; `WASD` grid navigation; `Shift+W/A/S/D` folder shortcuts
- Fullscreen viewer with previous/next, seek bar, volume (persisted in `localStorage`), speed control, ±5s skip, hold-`4` for 2× speed
- Detail panel with selected-media preview and basic metadata (name, path, type)
- Last path, sort mode, recursive/comic mode, and detail-panel visibility persisted in `localStorage`
- Path search via `?q=` query param (Pane View addition; Frame View has no equivalent text search)

**Pane View ahead of Frame View (not gaps):**

- Authenticated remote archive over HTTP/CDN (by design)
- PDF/story viewing in the fullscreen viewer via iframe
- Deep-linking selected media via `?media=` search param

---

## 1. Preferences and settings

Frame View has a tabbed **Preferences** drawer (Usability, Local Storage, Hotkeys, Debug). Pane View has no settings surface at all.

### Missing

| Feature | Frame View behaviour | Pane View gap |
| --- | --- | --- |
| Settings UI | `Ctrl/Cmd+,`, toolbar button, native menu | No settings route or drawer |
| Theme | System / light / dark | No user theme preference (relies on app CSS defaults) |
| Thumbnail size | Slider 140–340 px, persisted | Hardcoded `220` in `BrowserGrid` / `useVirtualGridMetrics` |
| Remember last folder default | Toggle for boot behaviour | Only implicit via `lastPath` restore |
| Recursive default | `recursiveDefault` setting | Defaults to `true` in `useGalleryState`; not user-configurable |
| Autoplay video on hover | Toggle; grid tiles play muted video on hover | `Poster` renders static `<img>` only; no hover video preview |
| Preview audio on hover | Toggle for muted vs audio-enabled hover previews | Not available |
| Autoplay videos in viewer | Toggle | Viewer videos do not autoplay on open |
| Loop videos in viewer | Toggle | No `loop` attribute or end-of-video replay |
| Loop viewer navigation | Wrap at first/last item when stepping | Gallery adjacent-media wraps; viewer `step()` clamps at ends |
| Show images / show videos | Per-type visibility filters; triggers rescan | No type filters in UI |
| Custom file extensions | `filters.imageExtensions` / `filters.videoExtensions` | Uses shared `media-domain` rules only; no UI to customize |
| Per-root gallery preferences | Remembers comic mode and excluded root children per opened folder | Comic/recursive are global persisted state only |
| Hotkey reference | Documented in Settings → Hotkeys | No in-app shortcut reference |
| Debug / diagnostics settings | Toggles for debug logging and perf monitoring | Not available |

### Suggested Pane View approach

- Add a `/settings` route or sheet drawer mirroring Frame View's Usability tab first.
- Persist web settings in `localStorage` (or user profile row later) using the same field names as `AppSettings` where practical.
- Skip desktop-only storage tabs until there is a meaningful web equivalent.

---

## 2. Gallery grid and thumbnails

### Missing

| Feature | Frame View behaviour | Pane View gap |
| --- | --- | --- |
| Video hover autoplay | `<video>` in `MediaTile` plays on mouse enter, pauses and resets on leave | `Poster` shows thumbnail image or placeholder only |
| Video badge + live preview | VIDEO pill overlay; optional looping hover clip | Static VIDEO styling in `MediaCard` only when type is video |
| Thumbnail priority scheduling | `thumbPriority` 0/1/2 based on viewport row; recency-prioritized worker queue | CDN/API thumbnails requested at fixed size; no viewport priority |
| Thumbnail request scale | `2×` size for retina fidelity | Single snapped ladder size from API |
| On-demand thumbnail pipeline UX | Instant disk/memory cache via `frameview-media://thumb` | First request may return `503` + `Retry-After` while `derivative-service` generates; no in-grid progress hint |
| Thumbnail cache maintenance | Clear cache button + stats in Settings | No user-facing cache controls (CDN/server-side only) |
| Configurable grid density | Driven by `settings.thumbnailSize` | Fixed 220 px card width |
| Scan / load progress | Header pills: scanning pulse, item counts, selection `N/M` | No top status bar; refresh reloads entire route loader snapshot |
| Incremental gallery population | Streams scan batches; can open viewer on partial results | Full library snapshot per navigation; no streaming load |
| Gallery keyboard wrap | `W/A/S/D` wraps at grid edges (row jump wraps vertically) | `moveGridFocus` stops at boundaries; no wrap |
| GIF as animated tile | Treated as image with thumbnail pipeline | Falls back to original URL in `readMediaPreviewUrl`; no animated thumb strategy |

### Related docs

- [pane-view-thumbnails.md](./runbooks/pane-view-thumbnails.md) — on-demand generation and CDN delivery
- Frame View `ThumbnailBrokerService`, `MediaTile`, `GalleryGrid`

---

## 3. Folder navigation and browsing

### Missing

| Feature | Frame View behaviour | Pane View gap |
| --- | --- | --- |
| Gallery header status bar | Folder label, path, folder/comic/item counts, selection index, scan status | Breadcrumbs only; no aggregate counts or selection position |
| Parent / sibling folder buttons | Top-bar `^` `←` `→` with enabled/disabled states | Keyboard shortcuts exist; no visible header buttons |
| Navigation ceiling | Parent navigation capped to originally opened root for the session | Parent nav walks to archive root without a session ceiling |
| Folder grid overlay | Modal folder browser from toolbar; browse tree under opened root | Sidebar lists ancestors + immediate children only |
| Exclude root child from recursive scan | Per-root `excludedRootChildPaths` toggles in folder overlay | Not applicable to DB model yet; no UI |
| Open folder / pick root | Native folder picker, drag-drop, `open-file`, second-instance path forwarding | Archive root is fixed to synced library; no picker |
| Refresh semantics | Re-scans active folder from disk | `router.invalidate()` re-fetches DB snapshot (adequate but no progress UX) |
| File watcher auto-refresh | Planned in Frame View v1.1 | No push/poll when remote library changes during session |
| Recent folders / pinned roots | Planned in Frame View v1.1 | Not implemented |

### Partial parity

- Non-recursive mode shows child folder tiles before media (shared `buildBrowserEntries` in `media-domain`).
- Sibling folder keyboard nav (`Shift+A` / `Shift+D`) works against immediate folder siblings.

---

## 4. Viewer and media playback

### Missing

| Feature | Frame View behaviour | Pane View gap |
| --- | --- | --- |
| Viewer autoplay preference | Respects `autoplayVideos` | Video always starts paused |
| Video loop preference | Respects `loopVideos` | No loop on end |
| Loop navigation preference | `loopViewerNavigation` wraps prev/next at ends | `MediaViewerModal.step()` clamps; detail-panel prev/next wraps |
| Reveal in folder | Opens Explorer/Finder at file path | No equivalent (could offer **copy path** or download) |
| Codec in metadata overlay | ffprobe-enriched `codec` in viewer details | Detail panel and viewer show size, dimensions, duration only |
| Video ended → advance | Optional behaviour tied to loop/nav settings | Ends paused at last frame |
| Queued rapid step | `requestAnimationFrame` coalesces rapid `Q/E` presses | Direct index updates |
| Viewer state / resume | Local playback position (desktop) | `getViewerState` / `saveViewerState` server functions and `viewer_state` table exist but **are not called from any UI component** |
| Read/viewed indicators | N/A locally | DB support exists; not shown in detail panel |

### Partial parity

- Volume persisted under `pane-view.viewer.volume` (matches Frame View pattern).
- Fullscreen, seek, speed, ±5s, and keyboard shortcuts match Frame View's viewer set.

---

## 5. Comic mode

| Feature | Frame View behaviour | Pane View gap |
| --- | --- | --- |
| Comic reader surface | Dedicated `ComicReader`: vertical scroll, all pages stacked, scroll-synced page indicator | Opens `MediaViewerModal` with comic pages as a horizontal paginated list |
| Comic page navigation | Scroll or `Q/E` moves between pages in vertical layout | Left/right arrows step one page at a time in modal |
| Reveal / Top actions | Reveal cover in folder; scroll-to-top | Not present |
| Lazy page loading | Per-page `loading="lazy"` in scroll column | Single active item in modal |

Pane View should port or adapt `ComicReader` for comic activation instead of reusing the generic viewer.

---

## 6. Keyboard shortcuts and app commands

### Missing

| Feature | Frame View behaviour | Pane View gap |
| --- | --- | --- |
| Native menu shortcuts | `Ctrl+O` open folder, `F5`/`Ctrl+R` refresh, `Ctrl+,` settings | No application menu; refresh only via toolbar |
| App command bridge | `app:command` IPC for menu actions | N/A on web |
| Settings-open guard | Gallery shortcuts disabled while settings open | N/A (no settings) |
| Folder overlay guard | Gallery shortcuts disabled while overlay open | N/A (no overlay) |
| In-app hotkey help | Settings → Hotkeys tab | Not implemented |

### Partial parity

Gallery and viewer shortcut sets (`WASD`, `Shift+WASD`, `Q/E`, `1/2/3/4`, `Escape`, `F`) are implemented in `routes/index.tsx` and `MediaViewerModal.tsx`.

---

## 7. Metadata enrichment

| Feature | Frame View behaviour | Pane View gap |
| --- | --- | --- |
| ffprobe video metadata | Lazy queue probes visible video tiles; patches `durationMs`, `width`, `height`, `codec` | Relies on DB columns populated at sync time; no client-side probe |
| Media tools status | Settings shows ffmpeg/ffprobe availability | Server has `ffmpeg-static` for derivatives; no UI surfacing |
| Rich detail panel | Resolution, duration, codec, mtime, file size | Name, path, type only in `DetailPanel` |
| Metadata side panel in viewer | Planned Frame View v1.1 | Not implemented |

---

## 8. Performance, indexing, and maintenance

Frame View is built around local scan/index/cache subsystems. Pane View uses Postgres + object storage. The **user-visible behaviours** below are still gaps.

| Feature | Frame View behaviour | Pane View gap |
| --- | --- | --- |
| SQLite media index | Persistent index with stats and clear action | Postgres library is the index; no stats/clear UX |
| Thumbnail disk cache | WebP derivatives in OS cache path; prune by cap | Server/CDN caching only |
| Scan cancel | Cancel in-flight catalog scan | N/A (no client-side scan) |
| Diagnostics snapshot | Copyable JSON for bug reports in Debug tab | Not implemented |
| Clear thumbnail cache / index | Settings actions with confirm | Not implemented |
| Large-gallery scroll optimizations | Abort-aware thumbnail queue, rAF-batched scan events | Virtualized grid only; no abort-aware thumb prioritization on fast scroll |

---

## 9. Mobile and touch (Pane View–specific parity target)

`docs/ARCHITECTURE_PLAN.md` calls for mobile ergonomics beyond Frame View's desktop scope. These are still open relative to the combined UX target:

| Feature | Target behaviour | Pane View gap |
| --- | --- | --- |
| Touch-friendly viewer | Large controls, tap to show/hide chrome | Desktop-oriented viewer layout |
| Swipe previous/next in viewer | Horizontal swipe between items | Not implemented |
| Mobile detail panel | Collapsible / sheet-based preview | Detail panel hidden on mobile (`useIsMobile`) with no replacement |
| Mobile search | Path search | Search input hidden below `md` breakpoint |
| PWA / installable shell | Optional | Not documented or optimized |

---

## 10. Frame View v1.1 items (not in either app yet)

These are on Frame View's roadmap (`apps/frame-view/docs/plans/frame-view-v1.1-plan.md`). Pane View should track them if parity remains the north star:

- Recent folders and pinned roots
- Metadata side panel in viewer (copy path, full technical details)
- File-watcher auto-refresh
- Slideshow mode
- Saved filter presets and extension editor UX
- Context menu actions (reveal, copy path, open externally)
- Confirm dialogs for destructive maintenance actions
- Keyboard shortcut overlay

---

## 11. Intentional non-goals (not parity gaps)

Do not treat these as missing Frame View features — they are platform or product differences:

| Frame View capability | Why it is not a Pane View gap |
| --- | --- |
| Local folder picker / drag-drop open | Pane View reads the synced remote archive, not local disks |
| `frameview-media://` custom protocol + byte-range FS streaming | Web uses `/api/media/...` and CDN URLs |
| `revealInFolder` / shell open | No local filesystem path on the client |
| Electron window bounds persistence | Browser window management is outside app control |
| Native application menu | Web app uses in-page toolbar |
| IPC / `window.frameView` bridge | Replaced by server functions and API routes |

---

## Suggested implementation order

Aligned with `docs/PROGRESS.md` Phase 7 and Frame View v1.1 priorities:

1. **Wire viewer state** — connect `MediaViewerModal` and detail panel to `getViewerState` / `saveViewerState` (video position, last page).
2. **Settings drawer** — theme, thumbnail size, autoplay/loop toggles, type filters.
3. **Gallery thumbnails** — hover video preview, viewport-priority loading, better pending/thumbnail placeholder UX.
4. **Comic reader** — port vertical `ComicReader` for comic activation.
5. **Gallery polish** — header status bar, keyboard wrap, parent/sibling toolbar buttons.
6. **Metadata** — enrich detail panel and viewer overlay (dimensions, duration, codec, read state).
7. **Mobile pass** — swipe viewer, mobile search, sheet detail panel.
8. **Pre-warm thumbnails on sync** — optional Lockstep post-upload hook (see thumbnail runbook).

---

## Source references

| Topic | Location |
| --- | --- |
| Frame View settings defaults | `apps/frame-view/src/shared/types.ts` (`DEFAULT_SETTINGS`) |
| Frame View feature spec | `apps/frame-view/docs/feature-specification.md` |
| Frame View AI / behaviour notes | `apps/frame-view/docs/ai-notes.md` |
| Pane View main UI | `apps/pane-view/src/routes/index.tsx` |
| Pane View viewer | `apps/pane-view/src/features/gallery/MediaViewerModal.tsx` |
| Pane View persisted UI state | `apps/pane-view/src/features/gallery/useGalleryState.ts` |
| Shared browser entry model | `packages/media-domain/src/browser-entries.ts` |
| Architecture UX plan | `docs/ARCHITECTURE_PLAN.md` §16 |
| Phase 7 progress | `docs/PROGRESS.md` |
