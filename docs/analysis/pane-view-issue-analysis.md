# Pane View Issue Analysis

Last updated: 2026-06-05

This document analyzes every issue raised in [pane-view-frame-view-parity-gaps.md](./pane-view-frame-view-parity-gaps.md) and [pane-view-problem-inventory.md](./pane-view-problem-inventory.md). It is intended for Phase 7 planning: what to fix, what to defer, and what is not worth pursuing.

**Methodology:** Each item was checked against the current `apps/pane-view` implementation (route loader, gallery UI, viewer, server functions, and schema). Ratings reflect *Pane View as a web/mobile archive viewer*, not literal Frame View porting. Desktop-only behaviours are scored on whether a web-adapted equivalent is product-valuable.

---

## Rating legend

| Dimension | Values |
| --- | --- |
| **Feasibility** | **High** — infrastructure exists or change is localized. **Medium** — requires new UI, API, or pipeline work but no architectural blockers. **Low** — depends on large new systems, unclear product fit, or platform limits. |
| **Effort** | **S** (&lt;1 day), **M** (1–3 days), **L** (1–2 weeks), **XL** (&gt;2 weeks) |
| **Necessity** | **Critical** — blocks core product goals. **High** — strong UX/performance impact. **Medium** — meaningful polish or parity. **Low** — nice-to-have. **Optional** — defer until measured need. **N/A** — intentional non-goal or platform difference. |

---

## Executive summary

| Tier | Count | Themes |
| --- | ---: | --- |
| Critical | 6 | Mobile tap-to-open, mobile search/details, loader over-fetching, viewer resume wiring |
| High | 18 | Settings shell, comic reader, thumbnail UX, touch viewer, data paging, detail metadata |
| Medium | 22 | Grid polish, navigation chrome, image sizing, preload tuning, accessibility |
| Low / Optional | 14 | Desktop parity niceties, v1.1 roadmap, debug tabs, PWA |
| N/A | 11 | Local FS, IPC, disk cache controls, scan cancel, etc. |

**Recommended order (ROI):**

1. **Mobile usability blockers** — single-tap activation, search sheet, mobile detail/viewer chrome (Critical, mostly M effort).
2. **Loader and query shaping** — direct-children query when non-recursive, paginate search, stop fetching `allFolders` when unused (Critical/High, L effort).
3. **Wire viewer state** — `getViewerState` / `saveViewerState` already exist; connect modal (High, S–M).
4. **Settings drawer (Usability tab)** — unlocks theme, thumb size, autoplay/loop, type filters (High, M–L).
5. **Thumbnail perception** — pending states, viewport priority, pre-warm on sync (High, M–L).
6. **Comic reader port** — vertical scroll reader from Frame View (High for comic users, L).
7. **Everything else** — grouped by theme below.

---

## 1. Mobile and touch UX

Pane View is explicitly a web **and mobile** viewer (`ARCHITECTURE_PLAN.md`). These items from the problem inventory are the highest product risk.

| ID | Issue | Source | Feasibility | Effort | Necessity | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| M-01 | **Single-tap opens media / folders** — today `BrowserEntryCard` selects on click and activates on double-click only | Inventory §UI | High | M | **Critical** | Split behaviour: `onClick` activates on mobile (`useIsMobile`), keeps double-click on desktop. Folder cards same pattern. |
| M-02 | **Mobile search hidden** — search form is `hidden … md:flex` in header | Inventory, Parity §9 | High | S | **Critical** | Icon button → sheet/dialog with existing search param logic. Reuse `BrowserHeader` submit handler. |
| M-03 | **No mobile detail panel** — `DetailPanel` is `lg:block` only; selection context lost | Inventory, Parity §9 | High | M | **Critical** | Bottom sheet or viewer info affordance. Data already in `selected` state. |
| M-04 | **Viewer chrome cramped on phones** — fixed bars, side arrows, multi-row video controls | Inventory | High | M | **High** | Collapse metadata, safe-area padding, auto-hide chrome, smaller hit targets at edges. No new backend. |
| M-05 | **Swipe prev/next in viewer** | Parity §9 | Medium | M | **High** | Touch handlers on modal; optional pointer-events on side arrows. Standard pattern. |
| M-06 | **Hover-only card labels** — metadata in `group-hover:opacity-100` overlay | Inventory | High | S–M | **High** | Always show truncated filename on mobile; optional “labeled grid” density mode later. |
| M-07 | **Breadcrumbs fragile on narrow viewports** | Inventory | High | M | **High** | Prominent current-folder title; full path in sheet. Parent button (see N-02) helps. |
| M-08 | **Sidebar touch targets and IA** | Inventory | High | M | **Medium** | Increase row padding on mobile; quick parent/root buttons. Sheet behaviour already exists. |
| M-09 | **Toolbar priority unclear** — modes, refresh, logout same visual weight | Inventory | High | M | **Medium** | Split account/menu from browse controls; bottom sheet for sort/modes. |
| M-10 | **PDF mobile reading** — iframe to original route | Inventory | Medium | L | **Medium** | Real PDF.js (or similar) surface with position persist ties to M-19. Defer full page-thumb strip. |
| M-11 | **PWA / installable shell** | Parity §9 | Medium | M | **Low** | Manifest + icons + service worker scope. Optional until mobile traffic is measured. |

---

## 2. Performance and data scale

These are the largest architectural gaps relative to virtualized DOM rendering.

| ID | Issue | Source | Feasibility | Effort | Necessity | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| P-01 | **Loader over-fetches media** — non-recursive views still query all descendants under `currentPath` (`repository.ts` `ilike … /%`) | Inventory | High | M | **Critical** | Add `recursive` to loader deps; when false, filter `parentPath = currentPath`. Biggest perf win for nested folders. |
| P-02 | **Full snapshot client processing** — sort, comic grouping, selection on entire `media[]` | Inventory | Medium | L | **High** | Follows P-01; further wins need server-side sort/group or windowed API. |
| P-03 | **Search unpaginated** — `%query%` on path/filename, no limit | Inventory | High | M | **High** | `LIMIT` + cursor; index on `logical_path`, `filename`. Rank/path-prefix bonus optional. |
| P-04 | **`allFolders` on every load** — full folder table for comic/sidebar | Inventory, repo | High | M | **Medium** | Fetch only when comic mode on or sidebar needs tree; else ancestors + children only. |
| P-05 | **DB index audit** | Inventory | High | S–M | **Medium** | Verify indexes on `parentPath`, `logicalPath`, `deletedAt`, thumbnail join. Low cost, do with P-01/P-03. |
| P-06 | **Cold thumbnail burst** — many concurrent 503/`Retry-After` on first browse | Inventory, Parity §2 | Medium | L | **High** | Pre-warm on sync (runbook), per-account concurrency caps, visible pending state (T-04). |
| P-07 | **Fixed 320px thumbs** — ignores card width and DPR | Inventory, Parity §2 | High | M | **Medium** | Size ladder exists in API; pass rendered width × DPR from grid. `srcset` if multiple ready sizes stored. |
| P-08 | **No viewport thumb priority** | Parity §2 | Medium | M | **Medium** | IntersectionObserver + fetch priority for visible rows; Frame View pattern adaptable. |
| P-09 | **Video `preload="auto"`** in viewer | Inventory | High | S | **Medium** | `metadata` on mobile; setting when settings exist (S-08). |
| P-10 | **Original images in viewer** — full-res `original` route always | Inventory | Medium | L | **High** | Preview derivative pipeline exists (`previewObjectKey`); wire viewer to preview-first, original on zoom. |
| P-11 | **No adjacent prefetch** | Inventory | Medium | M | **Low** | Prefetch next/prev thumb or preview; cautious on mobile data. |
| P-12 | **Instrumentation gap** | Inventory | High | M | **High** | Add loader timing/size metrics before deeper optimization. Prerequisite for prioritization. |

---

## 3. Settings and preferences

Frame View’s `AppSettings` is the reference; Pane View has only `useGalleryState` localStorage (path, sort, modes, detail panel).

| ID | Issue | Source | Feasibility | Effort | Necessity | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| S-01 | **Settings UI shell** — no route/drawer, no `Ctrl+,` | Parity §1, §6 | High | M | **High** | Sheet or `/settings`; Usability tab first. Unblocks many toggles. |
| S-02 | **Theme (system/light/dark)** | Parity §1 | High | S | **Medium** | Likely `next-themes` or class on `html`; match Frame View field names. |
| S-03 | **Thumbnail size slider (140–340)** | Parity §1, §2 | High | M | **Medium** | Today hardcoded `220` in `BrowserGrid`; thread into `useVirtualGridMetrics`. |
| S-04 | **Remember last folder toggle** | Parity §1 | High | S | **Low** | `lastPath` already persisted; toggle only changes boot behaviour. |
| S-05 | **Recursive default** | Parity §1 | High | S | **Medium** | Default is `true` in `useGalleryState`; expose in settings. Align with P-01 loader input. |
| S-06 | **Autoplay video on hover (grid)** | Parity §1, §2 | Medium | M | **Low** | Desktop-only; `<video>` in tile. Less valuable once M-01 improves mobile. |
| S-07 | **Preview audio on hover** | Parity §1 | Medium | M | **Low** | Desktop niche; muted default is fine for web. |
| S-08 | **Autoplay videos in viewer** | Parity §1, §4 | High | S | **Medium** | Respect setting in `MediaViewerModal` when S-01 exists. |
| S-09 | **Loop videos in viewer** | Parity §1, §4 | High | S | **Medium** | Add `loop` attribute when enabled. |
| S-10 | **Loop viewer navigation** | Parity §1, §4 | High | S | **Medium** | `step()` clamps today; detail panel already wraps. Small consistency fix. |
| S-11 | **Show images / show videos filters** | Parity §1 | High | M | **Medium** | Client filter on loaded data short-term; server filter with P-01. |
| S-12 | **Custom file extensions** | Parity §1 | Medium | M | **Low** | Shared `media-domain` rules suffice for MVP; UI editor is power-user. |
| S-13 | **Per-root gallery preferences** | Parity §1 | Medium | L | **Low** | Comic/excluded children per root; needs persisted map like Frame View. |
| S-14 | **Hotkey reference tab** | Parity §1, §6 | High | S | **Medium** | Static content in settings; pairs with A-04. |
| S-15 | **Debug logging / perf toggles** | Parity §1, §8 | High | S | **Low** | Dev-oriented; defer unless supporting remote users. |
| S-16 | **Local storage tab** | Parity §1 | N/A | — | **N/A** | No local index on web. |
| S-17 | **Clear thumbnail cache (user)** | Parity §2, §8 | Low | — | **N/A** | CDN/server-side; admin ops only. |

---

## 4. Gallery grid and thumbnails

| ID | Issue | Source | Feasibility | Effort | Necessity | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| T-01 | **Video hover autoplay in grid** | Parity §2 | Medium | M | **Low** | Same as S-06; `Poster` is static `<img>` only. |
| T-02 | **VIDEO badge + live preview** | Parity §2 | High | S | **Low** | Badge partially exists in `MediaCard`; live preview needs T-01. |
| T-03 | **2× retina thumb requests** | Parity §2 | High | S | **Medium** | Part of P-07 sizing work. |
| T-04 | **Pending/error thumb UX** | Parity §2 | High | M | **High** | Handle 503 with retry UI; skeleton/spinner in `Poster`. |
| T-05 | **Header status bar** — counts, selection N/M, scan pulse | Parity §3 | High | M | **Medium** | No scan on web; show folder/media counts and selection index. |
| T-06 | **Incremental gallery population** | Parity §2 | Low | XL | **Optional** | Frame View streams disk scan; web should use paging (P-01/P-02) instead of literal port. |
| T-07 | **Gallery keyboard wrap** | Parity §2 | High | S | **Low** | `moveGridFocus` stops at bounds; wrap is desktop polish. |
| T-08 | **Animated GIF tiles** | Parity §2 | Medium | M | **Low** | Thumb pipeline may flatten GIFs; original URL fallback is costly. |
| T-09 | **Density modes (compact / labeled / list)** | Inventory | Medium | L | **Medium** | Overlaps M-06; list mode helps search results on mobile. |

---

## 5. Folder navigation

| ID | Issue | Source | Feasibility | Effort | Necessity | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| N-01 | **Parent/sibling header buttons** | Parity §3 | High | S | **Medium** | Keyboard shortcuts exist (`Shift+A/D`, `W`); visible buttons help mobile (M-07). |
| N-02 | **Navigation ceiling** | Parity §3 | High | M | **Low** | Session-scoped root cap; niche for fixed archive roots. |
| N-03 | **Folder grid overlay** | Parity §3 | Medium | L | **Low** | Sidebar + mobile sheet may suffice; full overlay is Frame View desktop pattern. |
| N-04 | **Exclude root child from recursive scan** | Parity §3 | Medium | L | **Low** | Needs per-root prefs (S-13) and loader support. |
| N-05 | **Refresh progress UX** | Parity §3 | High | S | **Low** | `router.invalidate()` is adequate; add loading indicator only. |
| N-06 | **File watcher auto-refresh** | Parity §3, §10 | Medium | L | **Optional** | Poll or SSE after sync; no local watcher on web. Track with v1.1. |
| N-07 | **Recent / pinned folders** | Parity §3, §10 | Medium | M | **Low** | localStorage or server prefs; v1.1 roadmap. |
| N-08 | **Open folder / pick root** | Parity §3 | N/A | — | **N/A** | Archive root is synced library by design. |
| N-09 | **Non-recursive folder tiles first** | Parity §3 | — | — | — | **Already partial parity** via `buildBrowserEntries`. No action. |

---

## 6. Viewer and playback

| ID | Issue | Source | Feasibility | Effort | Necessity | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| V-01 | **Wire viewer state (resume)** | Parity §4 | High | S–M | **High** | API + `viewer_state` table exist; zero UI callers today. Video position + comic/PDF page. |
| V-02 | **Read/viewed indicators** | Parity §4 | Medium | M | **Medium** | Schema support planned; not wired. Needs write on view + detail UI. |
| V-03 | **Codec in metadata** | Parity §4, §7 | Medium | M | **Low** | DB has dimensions/duration from sync; codec needs ingest enrichment or client probe (impractical on web). |
| V-04 | **Video ended → advance** | Parity §4 | High | S | **Medium** | `onEnded` handler; respect S-09/S-10 loop settings. |
| V-05 | **rAF coalesced rapid Q/E** | Parity §4 | High | S | **Low** | Micro-optimization for fast key repeat. |
| V-06 | **Reveal in folder** | Parity §4 | N/A | — | **N/A** | No local FS. **Web alternative:** copy path / deep link (Medium, S) if users ask. |
| V-07 | **Copy path / download actions** | Parity §10 | High | S | **Medium** | Reasonable web substitute for reveal; clipboard API. |
| V-08 | **Volume persistence** | Parity §4 | — | — | — | **Done** (`pane-view.viewer.volume`). |
| V-09 | **Viewer focus trap + a11y labels** | Inventory | High | M | **High** | Prev/next buttons need explicit `aria-label`; trap focus on open, restore on close. |

---

## 7. Comic mode

| ID | Issue | Source | Feasibility | Effort | Necessity | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| C-01 | **Vertical scroll comic reader** | Parity §5 | High | L | **High** | Port `apps/frame-view/.../ComicReader.tsx`; today comics open paginated `MediaViewerModal`. |
| C-02 | **Scroll-synced page indicator** | Parity §5 | High | M | **Medium** | Part of C-01 port. |
| C-03 | **Lazy per-page loading** | Parity §5 | High | M | **Medium** | `loading="lazy"` in scroll column vs single modal item. |
| C-04 | **Reveal cover / scroll-to-top** | Parity §5 | High | S | **Low** | Web: navigate to cover’s folder path or scroll top button. |

---

## 8. Metadata and detail panel

| ID | Issue | Source | Feasibility | Effort | Necessity | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| D-01 | **Rich detail panel** — size, dimensions, duration, mtime | Parity §7, Inventory | High | S | **High** | `LibraryMediaItem` already carries fields; `DetailPanel` only shows name/path/type. |
| D-02 | **ffprobe lazy enrichment** | Parity §7 | Low | — | **N/A** | Web client cannot ffprobe; enrich at sync/ingest instead. |
| D-03 | **Media tools status in settings** | Parity §7 | High | S | **Low** | Server health/doctor endpoint for admins. |
| D-04 | **Metadata side panel in viewer** | Parity §7, §10 | High | M | **Medium** | Collapsible info in modal; overlaps M-04 and D-01. |

---

## 9. Keyboard, commands, and discoverability

| ID | Issue | Source | Feasibility | Effort | Necessity | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| K-01 | **Gallery/viewer shortcuts** | Parity §6 | — | — | — | **Mostly done** (WASD, Q/E, F, etc.). |
| K-02 | **Native menu shortcuts** (`Ctrl+O`, `F5`) | Parity §6 | N/A | — | **N/A** | Web toolbar; optional `Ctrl+,` when S-01 exists. |
| K-03 | **Settings/overlay shortcut guards** | Parity §6 | High | S | **Low** | Implement when S-01 / N-03 exist. |
| K-04 | **In-app hotkey overlay** | Parity §6, §10 | High | S–M | **Medium** | `?` key cheat sheet; complements S-14. |
| K-05 | **Activation discoverability** | Inventory | High | M | **High** | Overlaps M-01; add visible “Open” in detail sheet and long-press hint optional. |
| K-06 | **Reduced-motion support** | Inventory | High | S | **Medium** | `prefers-reduced-motion` for hover transitions and modal animations. |

---

## 10. Diagnostics, maintenance, and ops

| ID | Issue | Source | Feasibility | Effort | Necessity | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| O-01 | **Diagnostics JSON snapshot** | Parity §8 | High | M | **Low** | Useful for support; client + server version, loader stats. |
| O-02 | **Clear index / thumb cache (user)** | Parity §8 | N/A | — | **N/A** | Postgres + CDN are server-side. |
| O-03 | **Scan cancel** | Parity §8 | N/A | — | **N/A** | No client-side scan. |
| O-04 | **Abort-aware thumb queue on fast scroll** | Parity §8 | Medium | M | **Medium** | Pair with P-08; avoid wasted fetches. |
| O-05 | **Confirm dialogs for destructive ops** | Parity §10 | High | S | **Low** | When admin maintenance UI exists. |

---

## 11. State persistence and cross-device

| ID | Issue | Source | Feasibility | Effort | Necessity | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| X-01 | **Server-side resume state** | Inventory | High | M | **High** | Overlaps V-01; extend to gallery prefs later. |
| X-02 | **Cross-device gallery prefs** | Inventory | Medium | L | **Medium** | User profile row or settings API; localStorage as cache. |
| X-03 | **localStorage failure handling** | Inventory | High | S | **Low** | Try/catch exists; surface subtle warning if storage unavailable. |

---

## 12. Frame View v1.1 roadmap (neither app shipped)

Track for parity north star; none are blocking Pane View MVP.

| ID | Issue | Feasibility | Effort | Necessity | Notes |
| --- | --- | --- | --- | --- | --- |
| R-01 | Recent / pinned folders | Medium | M | Low | See N-07 |
| R-02 | Metadata side panel in viewer | High | M | Medium | See D-04 |
| R-03 | File-watcher auto-refresh | Medium | L | Optional | See N-06 |
| R-04 | Slideshow mode | High | M | Low | Viewer timer + autoplay |
| R-05 | Saved filter presets + extension editor | Medium | L | Low | See S-11, S-12 |
| R-06 | Context menu (reveal, copy, open) | High | M | Medium | Web: copy path, open in new tab |
| R-07 | Keyboard shortcut overlay | High | S | Medium | See K-04 |
| R-08 | Confirm dialogs for maintenance | High | S | Low | See O-05 |

---

## 13. Intentional non-goals (do not schedule)

| Frame View capability | Why N/A for Pane View |
| --- | --- |
| Local folder picker, drag-drop open | Fixed synced archive |
| `frameview-media://` protocol | HTTP/CDN + signed URLs |
| `revealInFolder` / shell open | No client filesystem |
| Electron window bounds | Browser chrome |
| Native application menu | In-page toolbar |
| IPC / `window.frameView` | Server functions + API routes |
| SQLite index stats / clear | Postgres is source of truth |
| User-facing thumbnail disk cache | Server/CDN caching |
| Scan cancel | No client scan |

---

## 14. Consolidated priority matrix

Issues that appear in both source docs are merged above. This matrix sorts **actionable** items by recommended schedule.

### Now (Critical + High feasibility)

| ID | Issue | Effort |
| --- | --- | --- |
| M-01 | Single-tap activation | M |
| M-02 | Mobile search sheet | S |
| M-03 | Mobile detail sheet | M |
| P-01 | Loader direct-children query | M |
| V-01 | Wire viewer state | S–M |
| D-01 | Enrich detail panel from existing fields | S |
| V-09 | Viewer a11y (focus trap, labels) | M |

### Next (High impact)

| ID | Issue | Effort |
| --- | --- | --- |
| S-01 | Settings drawer shell | M |
| P-03 | Paginated search | M |
| T-04 | Thumbnail pending/error states | M |
| C-01 | Comic reader port | L |
| M-04, M-05 | Mobile viewer layout + swipe | M |
| M-06 | Visible labels on mobile grid | S–M |
| P-06, P-10 | Thumb pre-warm + preview derivatives | L |
| P-12 | Instrumentation | M |
| X-01 | Server resume (with V-01) | M |

### Later (Medium / polish)

| ID | Issue | Effort |
| --- | --- | --- |
| S-02–S-11 | Individual settings toggles | S–M each |
| T-05, N-01, M-07 | Navigation chrome | M |
| P-04, P-07, P-08 | Query + image optimizations | M |
| K-04, S-14 | Hotkey help | S |
| M-08, M-09 | Sidebar + toolbar IA | M |

### Defer / optional

| ID | Issue | Reason |
| --- | --- | --- |
| S-06, S-07, T-01 | Hover video/audio preview | Desktop-only nicety |
| T-06 | Streaming gallery load | Prefer paging over Frame View scan model |
| N-02, N-03, S-13 | Ceiling, overlay, per-root prefs | Low demand |
| M-11 | PWA | Until mobile usage proven |
| O-01, S-15 | Debug/diagnostics UI | Support tooling |
| R-04 | Slideshow | v1.1 |

---

## 15. Suggested fix vs skip summary

| Verdict | Items |
| --- | --- |
| **Fix (necessary)** | M-01–M-07, M-09, P-01, P-03, P-06, P-10, P-12, S-01, S-05, S-08–S-11, T-04, T-05, V-01, V-02, V-04, V-09, D-01, C-01, K-05, X-01, N-01 |
| **Fix (valuable but deferrable)** | M-08, M-10, M-05, P-02, P-04, P-07, P-08, P-09, S-02, S-03, S-14, T-03, T-07, T-09, D-04, K-04, K-06, V-07, O-04, X-02 |
| **Skip or web-substitute** | S-06, S-07, T-01, T-08, N-02, N-03, N-04, V-03, D-02, T-06 |
| **Do not schedule (N/A)** | S-16, S-17, N-08, V-06, O-02, O-03, K-02, all §13 non-goals |

---

## Follow-up docs

| Doc | Purpose |
| --- | --- |
| [pane-view-issue-feedback.md](./pane-view-issue-feedback.md) | Product decisions per item |
| [pane-view-issue-clarifications.md](./pane-view-issue-clarifications.md) | Expanded specs for unclear items |
| [pane-view-approved-backlog.md](../plans/pane-view-approved-backlog.md) | Finalized implementation backlog |

---

## Source references

| Topic | Location |
| --- | --- |
| Library loader over-fetch | `apps/pane-view/src/server/library/repository.ts` |
| Viewer state (unwired) | `apps/pane-view/src/features/viewer/viewer-state-service.ts` |
| Double-click activation | `apps/pane-view/src/features/gallery/BrowserEntryCard.tsx` |
| Hardcoded thumb size | `apps/pane-view/src/features/gallery/BrowserGrid.tsx` |
| Static grid posters | `apps/pane-view/src/features/gallery/Poster.tsx` |
| Sparse detail panel | `apps/pane-view/src/features/gallery/DetailPanel.tsx` |
| Frame View settings defaults | `apps/frame-view/src/shared/types.ts` |
| Comic reader reference | `apps/frame-view/src/renderer/components/ComicReader.tsx` |
| Phase 7 context | `docs/PROGRESS.md` |
