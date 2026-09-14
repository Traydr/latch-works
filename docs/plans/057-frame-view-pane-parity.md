# Plan 057: bring Pane View's UX improvements to Frame View

> **Executor instructions**: Product decisions below were settled with the owner on 2026-09-14;
> do not re-ask them. Land as four stacked PRs (`agent/057-1-toolbar` → `agent/057-2-settings` →
> `agent/057-3-video-player` → `agent/057-4-chrome-parity`), commit per step, run every gate, and
> update the plan index in the last landing commit. The full plan with the survey evidence is
> published at <https://vellum.traydr.dev/01a09d18-5626-7468-bb24-3f9a4e1a0e24> (30-day link);
> this file is the durable summary.
>
> **Drift check (run first)**: `git diff --stat 96b22fb..HEAD -- apps/frame-view/src/renderer
> apps/pane-view/src/features/gallery e2e/tests/frame-view`. If `GalleryToolbar.tsx`,
> `SettingsDrawer.tsx`, `ViewerModal.tsx` or Pane's `video-player/` moved, re-verify every file
> reference before starting.

## Status

- **Status**: IN REVIEW (stack `agent/057-1-toolbar` → `agent/057-2-settings` → `agent/057-3-video-player` → `agent/057-4-chrome-parity`, implemented 2026-09-14)
- **Priority**: P2 — owner-requested parity
- **Effort**: M overall (S · S · L · S)
- **Risk**: LOW — renderer-only, no IPC or schema changes
- **Depends on**: nothing open
- **Category**: feature / UX parity
- **Planned at**: commit `96b22fb`, 2026-09-14

## Why this matters

Since July Pane View took 129 commits and Frame View 47, nearly all of them packaging, native
dependencies and test infrastructure. Pane View landed a floating toolbar with icons and states, the
capsule video player (PR #113, #114), a stable shuffle seed and folder excludes (plan 054). Frame
View still has text-only toolbar buttons, a settings modal that resizes and jumps between tabs,
hand-drawn SVG glyphs, and a video player built from bare range inputs and a native select.

## Settled decisions (2026-09-14, do not re-ask)

1. **Toolbar order.** Open and Folders stay on the left, then Recursive · Comic · Sort ·
   (Shuffle) · Refresh, with Refresh after the sort group exactly as Pane orders it. Settings stays
   at the far right because Frame View has no sidebar to hold it.
2. **Excludes stay inside the Folders overlay.** Pane's Exclude button and lean dialog are not
   ported; the two apps are meant to differ here.
3. **Settings dialog is anchored to the top centre with a fixed height**, so it neither resizes
   nor moves between tabs.
4. **The capsule video player is ported**, including hold-to-boost, ±10 s skips, mute, the
   six-step speed menu and the fullscreen fallback chain.
5. **Copy, do not extract a shared package.** No React package exists in `packages/`; the two
   apps disagree on quote style, module resolution and Tailwind integration; the shared surface is
   ~430 lines behind one model interface.
6. **Labels stay visible at every width** in Frame View (an Electron window is never phone-narrow
   and the e2e selects buttons by name).
7. **One "Next item" and one "Previous item" button.** No mobile tap zones;
   `e2e/tests/frame-view/gallery.spec.ts` selects those names in strict mode.
8. **Keep Frame View's conventions**: single quotes, `prism-*` utility classes, zustand store.
   New player files use inline Tailwind like Pane's because they have no `prism-*` equivalents.
9. **Recursive is per session.** The toolbar toggle no longer writes `recursiveDefault`; the
   Usability tab's "Enable recursive mode by default" is the only writer (Pane's plan 048 rule).
10. **Folders shows a dot** while the opened root has excluded children (Pane plan 054 decision 5).
11. **Remember video position** is a separate optional follow-up (PR 5), not part of this plan.

## Root causes the plan fixes

- **Settings jumps** because `SettingsDrawer.tsx` is `items-center` with `max-h-[78vh]` and no
  floor: every tab has a different natural height so the top edge moves by half the delta. The
  shared scroll node also keeps `scrollTop` across tabs, Debug grows again once diagnostics load,
  and the theme dropdown is clipped by `overflow-hidden`.
- **Comic looks enabled with no folder open** but is a no-op (`App.tsx`); Refresh has no busy
  state; the sort chevron is a filled wedge (open path with `fill="currentColor"`).
- **The video player** is `ViewerVideoControls.tsx`: range inputs, a native `<select>`, ±5 s text
  buttons and a raw-seconds clock; no mute, no fullscreen state, no `toggleChrome`.

## PR 1: bottom bar (S)

Files: `layouts/components/GalleryToolbar.tsx`, `layouts/components/SortMenu.tsx`,
`layouts/PrismLayout.tsx`, `App.tsx`, `index.css`.

- Reorder to Open · Folders · | · Recursive · Comic · Sort · (Shuffle) · | · Refresh · | · Settings.
- Lucide icon before every label (`FolderOpen`, `Folders`, `ListTree`, `ImageIcon`, `ArrowUpDown`,
  `Shuffle`, `RefreshCcw`, `Settings`); `title` on every button; `aria-pressed` on the toggles.
- `SortMenu`: `ChevronUp` rotating 180° when open, `Check` for the selected row. The sort trigger
  stays the only `aria-haspopup="menu"` in the gallery (`e2e/src/frame-view.ts` selects it).
- Recursive and Comic disabled with a tooltip until a folder is open; Refresh spins, reads
  "Refreshing" and is disabled while `scanState === 'loading'`.
- `.prism-btn` gains `disabled:` styling (no `pointer-events-none`, so tooltips still show).
- Decision 9: drop the `updateSettings({ recursiveDefault })` call from `onToggleRecursive`.

## PR 2: settings dialog (S)

Files: `components/SettingsDrawer.tsx`, `components/settings/UsabilityTab.tsx`, `App.tsx`.

- Wrapper `items-start pt-[7vh]`; aside `h-[min(78vh,760px)]` instead of `max-h`.
- Reset the body's `scrollTop` when the active tab changes.
- Escape closes; focus moves to Close on open and restores on unmount.
- Theme becomes three native radios styled as a segmented control, removing the only absolutely
  positioned menu inside the scroll body.
- Keep the scrim button "Close settings"; the e2e clicks it at (4,4).

## PR 3: video player (L)

New: `components/viewer/video-player/VideoPlayerChrome.tsx`,
`components/viewer/video-player/video-player-controls.tsx`, `hooks/useViewerVideoModel.ts`,
`hooks/useCoarsePointer.ts`, `utils/videoPlayback.ts`. Changed: `ViewerModal.tsx`,
`viewer/ViewerChrome.tsx`, `hooks/useViewerChromeIdle.ts`, `hooks/useViewerKeyboardControls.ts`,
`settings/HotkeysTab.tsx`, `index.css`. Deleted: `viewer/ViewerVideoControls.tsx`.

- One `ViewerVideoModel` hook holding the video state and actions Pane's
  `MediaViewerSessionModel` exposes, minus the Pane seams: media URL via `toFileUrl`, no server
  resume (`scheduleSave`/`flushSave` removed from `useSeek`), skip seconds from
  `utils/videoPlayback.ts` (10; the hotkeys read it instead of the literal 5), no PDF branches,
  `isTextInputTarget` from `utils/hotkeys.ts`, volume and mute persisted under
  `frameview.viewer.volume`.
- Keep Frame View's `key={item.id}` remount, rAF-coalesced `queueStep`, manual loop-on-ended and
  the codec detail. Port Pane's fullscreen chain and `fullscreenchange` listener so the icon flips.
- Copy the two player files verbatim, then adjust the imports and run the Frame View formatter.
- `useViewerChromeIdle` gains `toggleChrome`; mouse click on a video toggles play/pause, coarse
  pointer toggles chrome; `ChromeRegion` stops capsule clicks from reaching the picture.
- `ViewerChrome`: Copy path · Reveal in folder · Fullscreen · Close; chevron pill arrows
  (`h-[25dvh] min-h-11 w-12`), one per side.
- Hotkeys: seek keys move 10 s, `m` mutes, `4` boosts through the model; update the Hotkeys tab.
- E2E: one test on `videos/clip-a.mp4` pinning the seek slider, `3` advancing ~10 s, Mute, and
  Play/Pause, asserting on the `<video>` element like Pane's `viewer.spec.ts` does.

## PR 4: chrome parity (S)

Files: `components/FolderGridOverlay.tsx`, `layouts/components/GalleryHeader.tsx`,
`layouts/components/FolderTile.tsx`, `layouts/components/GalleryToolbar.tsx`,
`components/ComicReader.tsx`.

- Folder overlay: Escape closes; lucide `Folder`, `X`, `ChevronLeft`, `FolderOpen` replace the
  hand-drawn SVG and text glyphs. Included/Excluded labels and the card `title` stay verbatim.
- Decision 10: `size-2` violet dot on the Folders button while excludes are active.
- Header Parent / Prev Folder / Next Folder get `ArrowUp`, `ChevronLeft`, `ChevronRight`;
  `FolderTile` uses lucide `Folder`.

## Deliberately not in this plan

Search, sidebar and a header breadcrumb trail (the overlay already has breadcrumbs); Pane's
Exclude dialog (decision 2); a shared video-player package (decision 5); toasts and skeletons
(neither app has them); converting settings and the overlay to `<dialog>`; remembering video
position (optional PR 5, decision 11).

## Verification

Per PR: `pnpm --filter @latch-works/frame-view typecheck`, `pnpm --filter @latch-works/frame-view
lint`, `pnpm e2e:frame`. Top of the stack also runs `pnpm check:all` and `pnpm knip`. The
`preview:showcase` script boots the real renderer in a browser for the settings-tab check.

## Done criteria

1. Toolbar order and icons as in decision 1; Comic disabled with no folder; Refresh spins.
2. Cycling every Preferences tab leaves the header, tab strip and Close button in place; Escape
   closes Preferences.
3. Videos open in the capsule with ±10 s skips, `m:ss` clocks, a keyboard-operable seek slider,
   mute, a six-step speed menu, hold-`4` boost and a fullscreen icon that flips;
   `ViewerVideoControls.tsx` is gone and knip reports nothing new.
4. One chevron pill per side in the viewer; the Frame View e2e passes.
5. Folder overlay closes on Escape; Folders shows the exclude dot.
6. No hand-drawn SVG or text glyph (`<`, `>`, `✕`, `•`) remains in `apps/frame-view/src/renderer`.
7. The plan index lists 057 with the landing commits and decisions 9–11 recorded.
