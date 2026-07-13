# Plan 034: Virtualize Pane View PDF rendering

> **Executor instructions**: Preserve resume-page reporting and initial-page restoration. Run every
> gate and update `docs/plans/README.md` when complete.
>
> **Drift check (run first)**: `git diff --stat fd5693d..HEAD -- apps/pane-view/src/features/viewer/PdfViewer.tsx apps/pane-view/src/features/viewer/PdfViewer.test.ts`

## Status

- **Status**: DONE (`a996635`, independently verified 2026-07-13)
- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `fd5693d`, 2026-07-13
- **Original finding**: 13

## Why this matters

Opening a PDF currently renders every full-resolution page canvas sequentially and retains them all.
Long documents delay first interaction, consume large backing stores, and repaint completely after a
width change. The viewer should create cheap page geometry immediately and render only the visible
window plus bounded overscan.

## Current state

- `PdfViewer.tsx:144-220` loads the document, then loops `1..numPages` and awaits every canvas.
- `PdfViewer.tsx:223-230` calls the full `paintPages` operation after width changes.
- `initialPage`, `scrollToPdfPage`, and `onPageChange` implement persisted resume behavior.
- Existing tests use jsdom and cover visible-page selection and initial scroll helpers.
- `CONTEXT.md` calls the delivered representation a Rendition; keep that vocabulary in comments/docs.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused tests | `pnpm --filter @latch-works/pane-view test -- src/features/viewer/PdfViewer.test.ts` | all pass |
| Pane check | `pnpm --filter @latch-works/pane-view check` | exit 0 |

## Scope

**In scope**: `PdfViewer.tsx`, its test, and optionally a colocated pure page-window helper/test.

**Out of scope**: changing original delivery URLs; offline PDF caching; annotations/search; Shutter PDF
previews; viewer-state schema; adopting a new PDF library.

## Git workflow

- Branch: `codex/034-virtualize-pdf-pages`
- Commit message: `Virtualize PDF page rendering`

## Steps

### Step 1: Separate page geometry from page painting

After loading, obtain each page's scale-1 dimensions without creating full-resolution canvases.
Create stable placeholders for all page numbers so scrolling and `initialPage` work before painting.
Cache geometry only; cap any retained `PDFPageProxy` set.

**Verify**: test a 300-page fake document and assert 300 lightweight placeholders but no eager 300
render calls.

### Step 2: Render a bounded visible window

Use IntersectionObserver or scroll-range math to maintain visible pages plus 2 pages of overscan on
each side. Start render tasks only for that set; cancel tasks that leave it; replace canvases outside
the window with geometry-preserving placeholders. Bound retained canvases (recommended maximum 8).

**Verify**: fake-observer tests assert first open renders only the initial window, scrolling renders
the next window, and retained canvases never exceed the bound.

### Step 3: Re-render only the active window on resize

On meaningful width change, update placeholder geometry and repaint only currently active pages.
Cancel obsolete width render tasks and prevent stale completion from replacing a newer canvas.

**Verify**: resize test asserts offscreen pages are not rendered and stale tasks are ignored.

### Step 4: Preserve resume semantics and cleanup

Apply `initialPage` once placeholders exist. Continue debounced visible-page reporting. On unmount or
media change, cancel loading/render tasks, observers, and timers.

**Verify**: initial page, page reporting, media switch, and unmount cancellation tests pass.

## Test plan

Mock `pdfjs-dist`, render tasks, ResizeObserver, and IntersectionObserver. Cover 1 page, 300 pages,
initial page near the end, rapid scroll, rapid resize, render rejection, media change, and unmount.

## Done criteria

- [ ] Initial render work is bounded by viewport + overscan, not total pages.
- [ ] Retained full canvases are bounded.
- [ ] Resize repaints only active pages.
- [ ] Initial-page restoration and debounced resume reporting remain correct.
- [ ] Focused tests and Pane check pass.

## STOP conditions

- PDF.js cannot provide page geometry without retaining/rendering every page proxy.
- Virtualization breaks stable scroll geometry for mixed page sizes.
- Fix requires changing viewer-state persistence or media delivery.

## Maintenance notes

Reviewer focus: cancelled PDF.js tasks, stale async completions, canvas memory bounds, and scroll
position stability across resize.
