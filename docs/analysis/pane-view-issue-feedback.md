# Pane View Issue Feedback

Companion to [pane-view-issue-analysis.md](./pane-view-issue-analysis.md). Use this doc to record your decisions on each item — agree with the analysis, override priority, defer, or skip.

**Downstream:** [pane-view-issue-clarifications.md](./pane-view-issue-clarifications.md) · [pane-view-approved-backlog.md](../plans/pane-view-approved-backlog.md)

**Reviewer:** <!-- your name -->  
**Date started:** <!-- YYYY-MM-DD -->  
**Last updated:** <!-- YYYY-MM-DD -->

---

## How to use

For each item below, fill in the table cells. Leave analysis ratings as reference; your columns drive planning.

| Column | Options / guidance |
| --- | --- |
| **Decision** | `Agree` · `Modify` · `Defer` · `Skip` · `Won't fix` |
| **Priority** | `P0` (now) · `P1` (next) · `P2` (later) · `Backlog` · `—` (if skipping) |
| **Necessity (yours)** | Optional override: `Critical` · `High` · `Medium` · `Low` · `N/A` |
| **Notes** | Constraints, alternative approach, "why", links, questions for agents |

**Quick pass:** Search for `<!--` to jump to unfilled fields.

### Overall notes

<!-- Cross-cutting product direction, things missing from the analysis, archive size assumptions, mobile vs desktop priority, etc. -->

---

## Summary (fill when done)

| Decision | Count |
| --- | ---: |
| Agree | |
| Modify | |
| Defer | |
| Skip / Won't fix | |

**Top P0 picks (my call):** <!-- e.g. M-01, P-01, V-01 -->
Im not gonna add the specific P0 picks, but anything related to the perf of loading folders, recursive, etc.

**Explicitly not doing:** <!-- e.g. S-06, T-01, N-02 -->

---

## 1. Mobile and touch UX

### M-01 — Single-tap opens media / folders

*Analysis: Critical · M · Agree to fix*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | P0 | High | None |

### M-02 — Mobile search hidden

*Analysis: Critical · S*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | P2 | Low | Definetely needs to open a dialog on mobile devices |

### M-03 — No mobile detail panel

*Analysis: Critical · M*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Defer | Backlog | Low | Probably will need to be some sort of dialog |

### M-04 — Viewer chrome cramped on phones

*Analysis: High · M*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | P0 | High | Mostly agree with the changes, although regarding the side arrows can be removed and replaced with invisible buttons on either side of the image that cover the area top to bottom or something similar |

### M-05 — Swipe prev/next in viewer

*Analysis: High · M*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | P0 | High | Like mentioned in the previous item the arrows can be turned into invisible buttons that cover the left half adnd right half of the image, that navigate left and right |

### M-06 — Hover-only card labels

*Analysis: High · S–M*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Defer | Backlog | Low | None |

### M-07 — Breadcrumbs fragile on narrow viewports

*Analysis: High · M*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Modify | P2 | Low | Need to see much more detailed description of proposed changes |

### M-08 — Sidebar touch targets and IA

*Analysis: Medium · M*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | P1 | Medium | Also need to have buttons highligh on hover |

### M-09 — Toolbar priority unclear

*Analysis: Medium · M*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | P1 | Medium | Account contrls should be located in the left sidebar, keep browse controls in the middle |

### M-10 — PDF mobile reading

*Analysis: Medium · L*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | P0 | High | We definetley need some sort of minial viewer for these PDFs, we need to add pdf viewing in the mobile app and investigate if there are any customizations we can do to make the pdf viewer minimal or see if there are other libs we can evaluate  |

### M-11 — PWA / installable shell

*Analysis: Low · M*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Defer | Backlog | Low | Definetely something im interested in the future but do not need right now |

---

## 2. Performance and data scale

### P-01 — Loader over-fetches media

*Analysis: Critical · M*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | P0 | High | This is probably in the same areas as the following loading perf items |

### P-02 — Full snapshot client processing

*Analysis: High · L*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | P0 | High | Definetley need faster server side processing, which will require adding loading states to the client so it feels more responsive |

### P-03 — Search unpaginated

*Analysis: High · M*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | P1 | Low | None |

### P-04 — `allFolders` on every load

*Analysis: Medium · M*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agreee | P0 | Medium | None |

### P-05 — DB index audit

*Analysis: Medium · S–M*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | P0 | Medium | None |

### P-06 — Cold thumbnail burst

*Analysis: High · L*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Skip | - | N/A | Thumbnails are made fast enough already, and this website is only for me to use, so it doesn't need per account anything. Although the image visible pending state while thumbnail is loading is necessary (something like pulsing grey background) |

### P-07 — Fixed 320px thumbs

*Analysis: Medium · M*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Modify | P1 | N/A | Need more information on this item, I don't understand what this item is trying to do |

### P-08 — No viewport thumb priority

*Analysis: Medium · M*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | P1 | Medium | None |

### P-09 — Video `preload="auto"` in viewer

*Analysis: Medium · S*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Defer | Backlog | N/A | To be decided later |

### P-10 — Original images in viewer

*Analysis: High · L*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Modify | P1 | N/A | Need more info on this item, what is it asking. If I understand then on fullscreen we load a higher res preview and then only on clicking on the image then we load original, then I am in favor of this item. |

### P-11 — No adjacent prefetch

*Analysis: Low · M*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | P1 | Medium | Definetely nice to have but not critical |

### P-12 — Instrumentation gap

*Analysis: High · M*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Defer | Backlog | Low | This can be added later when focusing more on performance. |

---

## 3. Settings and preferences

### S-01 — Settings UI shell

*Analysis: High · M*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | P0 | Medium | None |

### S-02 — Theme (system/light/dark)

*Analysis: Medium · S*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | P1 | N/A | Does next-themes work with tanstack-start? |

### S-03 — Thumbnail size slider

*Analysis: Medium · M*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | P2 | N/A | None |

### S-04 — Remember last folder toggle

*Analysis: Low · S*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | Backlog | N/A | None |

### S-05 — Recursive default

*Analysis: Medium · S*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Modiyf | P0 | Critical | Recusrive needs to be off by default, this can be exposed in settings. Reason for this is because large collections will take a very long time to load. |

### S-06 — Autoplay video on hover (grid)

*Analysis: Low · M · suggested skip*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | Backlog | Low | None |

### S-07 — Preview audio on hover

*Analysis: Low · M · suggested skip*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | Backlog | Low | None |

### S-08 — Autoplay videos in viewer

*Analysis: Medium · S*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | P1 | High | None |

### S-09 — Loop videos in viewer

*Analysis: Medium · S*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | P1 | High | None |

### S-10 — Loop viewer navigation

*Analysis: Medium · S*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Modify | - | N/A | I need more details on this item, I don't understand what its trying to do |

### S-11 — Show images / show videos filters

*Analysis: Medium · M*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | P1 | High | None |

### S-12 — Custom file extensions

*Analysis: Low · M*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Modify | - | N/A | Need more details on this item |

### S-13 — Per-root gallery preferences

*Analysis: Low · L*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | P1 | Medium | Probably only needs to be per device setting |

### S-14 — Hotkey reference tab

*Analysis: Medium · S*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | P1 | Medium | None |

### S-15 — Debug logging / perf toggles

*Analysis: Low · S*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | Backlog | Low | Same as other perf logging item |

### S-16 — Local storage tab

*Analysis: N/A · intentional non-goal*

| Decision | Priority | Notes |
| --- | --- | --- |
| Non-Goal | — | <!-- only if you disagree --> |

### S-17 — Clear thumbnail cache (user)

*Analysis: N/A · intentional non-goal*

| Decision | Priority | Notes |
| --- | --- | --- |
| Non-Goal | — | <!-- only if you disagree --> |

---

## 4. Gallery grid and thumbnails

### T-01 — Video hover autoplay in grid

*Analysis: Low · M · suggested skip*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | <!-- --> | <!-- --> | <!-- --> |

### T-02 — VIDEO badge + live preview

*Analysis: Low · S*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | <!-- --> | <!-- --> | <!-- --> |

### T-03 — 2× retina thumb requests

*Analysis: Medium · S*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Skip | <!-- --> | <!-- --> | <!-- --> |

### T-04 — Pending/error thumb UX

*Analysis: High · M*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | <!-- --> | <!-- --> | <!-- --> |

### T-05 — Header status bar

*Analysis: Medium · M*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Skip | <!-- --> | <!-- --> | <!-- --> |

### T-06 — Incremental gallery population

*Analysis: Optional · XL · prefer paging instead*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Skip | <!-- --> | <!-- --> | <!-- --> |

### T-07 — Gallery keyboard wrap

*Analysis: Low · S*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | <!-- --> | <!-- --> | <!-- --> |

### T-08 — Animated GIF tiles

*Analysis: Low · M*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | <!-- --> | <!-- --> | can we use webp for animated gifs |

### T-09 — Density modes (compact / labeled / list)

*Analysis: Medium · L*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Skip | <!-- --> | <!-- --> | I always want to see a gallery vew |

---

## 5. Folder navigation

### N-01 — Parent/sibling header buttons

*Analysis: Medium · S*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | <!-- --> | <!-- --> | Should probably at the top of the gallery |

### N-02 — Navigation ceiling

*Analysis: Low · M · suggested skip*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Modify | <!-- --> | <!-- --> | Dont understand item, need more detail |

### N-03 — Folder grid overlay

*Analysis: Low · L · suggested skip*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Skip | <!-- --> | <!-- --> | <!-- --> |

### N-04 — Exclude root child from recursive scan

*Analysis: Low · L*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Modify | <!-- --> | <!-- --> | Only archive root should not be allowed to have recursion enabled |

### N-05 — Refresh progress UX

*Analysis: Low · S*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | <!-- --> | <!-- --> | <!-- --> |

### N-06 — File watcher auto-refresh

*Analysis: Optional · L*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Defer | <!-- --> | <!-- --> | <!-- --> |

### N-07 — Recent / pinned folders

*Analysis: Low · M*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Defer | <!-- --> | <!-- --> | <!-- --> |

### N-08 — Open folder / pick root

*Analysis: N/A · intentional non-goal*

| Decision | Priority | Notes |
| --- | --- | --- |
| Non-Goal | — | <!-- only if you disagree --> |

### N-09 — Non-recursive folder tiles first

*Already at parity — no action unless you see a gap*

| Notes |
| --- |
| <!-- --> |

---

## 6. Viewer and playback

### V-01 — Wire viewer state (resume)

*Analysis: High · S–M*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Modify | <!-- --> | <!-- --> | Don't understand what the item is trying to do, don't need to resume vides, they aren't that long. I don't think resume is necessary for now |

### V-02 — Read/viewed indicators

*Analysis: Medium · M*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Skip | <!-- --> | <!-- --> | <!-- --> |

### V-03 — Codec in metadata

*Analysis: Low · M · suggested skip*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Skip | <!-- --> | <!-- --> | <!-- --> |

### V-04 — Video ended → advance

*Analysis: Medium · S*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Skip | <!-- --> | <!-- --> | <!-- --> |

### V-05 — rAF coalesced rapid Q/E

*Analysis: Low · S*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Modify | <!-- --> | <!-- --> | Need to understand this item more |

### V-06 — Reveal in folder

*Analysis: N/A · web substitute: copy path (V-07)*

| Decision | Priority | Notes |
| --- | --- | --- |
| Skip | — | <!-- only if you disagree --> |

### V-07 — Copy path / download actions

*Analysis: Medium · S*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | <!-- --> | <!-- --> | <!-- --> |

### V-08 — Volume persistence

*Done — confirm or note regressions*

| Notes |
| --- |
| <!-- --> |

### V-09 — Viewer focus trap + a11y labels

*Analysis: High · M*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | <!-- --> | <!-- --> | <!-- --> |

---

## 7. Comic mode

### C-01 — Vertical scroll comic reader

*Analysis: High · L*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | <!-- --> | <!-- --> | <!-- --> |

### C-02 — Scroll-synced page indicator

*Analysis: Medium · M · part of C-01*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | <!-- --> | <!-- --> | <!-- --> |

### C-03 — Lazy per-page loading

*Analysis: Medium · M · part of C-01*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | <!-- --> | <!-- --> | <!-- --> |

### C-04 — Reveal cover / scroll-to-top

*Analysis: Low · S*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | <!-- --> | <!-- --> | <!-- --> |

---

## 8. Metadata and detail panel

### D-01 — Rich detail panel

*Analysis: High · S*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | <!-- --> | <!-- --> | <!-- --> |

### D-02 — ffprobe lazy enrichment

*Analysis: N/A on web · enrich at ingest instead*

| Decision | Priority | Notes |
| --- | --- | --- |
| Skip | — | <!-- only if you disagree --> |

### D-03 — Media tools status in settings

*Analysis: Low · S*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Skip | <!-- --> | <!-- --> | <!-- --> |

### D-04 — Metadata side panel in viewer

*Analysis: Medium · M*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Skip | <!-- --> | <!-- --> | <!-- --> |

---

## 9. Keyboard, commands, and discoverability

### K-01 — Gallery/viewer shortcuts

*Mostly done — note any gaps*

| Notes |
| --- |
| <!-- --> |

### K-02 — Native menu shortcuts

*Analysis: N/A on web*

| Decision | Priority | Notes |
| --- | --- | --- |
| Agree N/A | — | <!-- only if you disagree --> |

### K-03 — Settings/overlay shortcut guards

*Analysis: Low · S*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | <!-- --> | <!-- --> | <!-- --> |

### K-04 — In-app hotkey overlay

*Analysis: Medium · S–M*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | <!-- --> | <!-- --> | <!-- --> |

### K-05 — Activation discoverability

*Analysis: High · M*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Skip | <!-- --> | <!-- --> | <!-- --> |

### K-06 — Reduced-motion support

*Analysis: Medium · S*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Skip | <!-- --> | <!-- --> | <!-- --> |

---

## 10. Diagnostics, maintenance, and ops

### O-01 — Diagnostics JSON snapshot

*Analysis: Low · M*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | <!-- --> | <!-- --> | <!-- --> |

### O-02 — Clear index / thumb cache (user)

*Analysis: N/A*

| Decision | Priority | Notes |
| --- | --- | --- |
| Agree N/A | — | <!-- only if you disagree --> |

### O-03 — Scan cancel

*Analysis: N/A*

| Decision | Priority | Notes |
| --- | --- | --- |
| Agree N/A | — | <!-- only if you disagree --> |

### O-04 — Abort-aware thumb queue on fast scroll

*Analysis: Medium · M*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | <!-- --> | <!-- --> | <!-- --> |

### O-05 — Confirm dialogs for destructive ops

*Analysis: Low · S*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | <!-- --> | <!-- --> | <!-- --> |

---

## 11. State persistence and cross-device

### X-01 — Server-side resume state

*Analysis: High · M · overlaps V-01*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Skip | <!-- --> | <!-- --> | <!-- --> |

### X-02 — Cross-device gallery prefs

*Analysis: Medium · L*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Skip | <!-- --> | <!-- --> | <!-- --> |

### X-03 — localStorage failure handling

*Analysis: Low · S*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Skip | <!-- --> | <!-- --> | <!-- --> |

---

## 12. Frame View v1.1 roadmap

### R-01 — Recent / pinned folders

*Analysis: Low · M · see N-07*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Skip | <!-- --> | <!-- --> | <!-- --> |

### R-02 — Metadata side panel in viewer

*Analysis: Medium · M · see D-04*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Skip | <!-- --> | <!-- --> | <!-- --> |

### R-03 — File-watcher auto-refresh

*Analysis: Optional · L · see N-06*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Skip | <!-- --> | <!-- --> | <!-- --> |

### R-04 — Slideshow mode

*Analysis: Low · M*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Skip | <!-- --> | <!-- --> | <!-- --> |

### R-05 — Saved filter presets + extension editor

*Analysis: Low · L · see S-11, S-12*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Skip | <!-- --> | <!-- --> | <!-- --> |

### R-06 — Context menu (reveal, copy, open)

*Analysis: Medium · M*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Skip | <!-- --> | <!-- --> | <!-- --> |

### R-07 — Keyboard shortcut overlay

*Analysis: Medium · S · see K-04*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Agree | <!-- --> | <!-- --> | <!-- --> |

### R-08 — Confirm dialogs for maintenance

*Analysis: Low · S · see O-05*

| Decision | Priority | Necessity (yours) | Notes |
| --- | --- | --- | --- |
| Skip | <!-- --> | <!-- --> | <!-- --> |

---

## 13. Intentional non-goals

*Skip per-item feedback unless you want to revisit platform assumptions.*

| Capability | Agree N/A? | Notes |
| --- | --- | --- |
| Local folder picker, drag-drop | Yes | <!-- --> |
| `frameview-media://` protocol | Yes | <!-- --> |
| `revealInFolder` / shell open | Yes | <!-- --> |
| Electron window bounds | Yes | <!-- --> |
| Native application menu | Yes | <!-- --> |
| IPC / `window.frameView` | Yes | <!-- --> |
| SQLite index stats / clear | Yes | <!-- --> |
| User-facing thumbnail disk cache | Yes | <!-- --> |
| Scan cancel | Yes | <!-- --> |

---

## 14. Items not in the analysis (add your own)

| ID | Issue | Decision | Priority | Notes |
| --- | --- | --- | --- | --- |
| NEW-01 | <!-- --> | <!-- --> | <!-- --> | <!-- --> |
| NEW-02 | <!-- --> | <!-- --> | <!-- --> | <!-- --> |

---

## 15. Final stack rank (optional)

After filling sections above, paste your ordered backlog here:

1. <!-- -->
2. <!-- -->
3. <!-- -->
4. <!-- -->
5. <!-- -->
