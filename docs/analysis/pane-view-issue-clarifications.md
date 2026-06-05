# Pane View Issue Clarifications

Last updated: 2026-06-05

Expanded explanations for items flagged **Modify** or “need more detail” in [pane-view-issue-feedback.md](./pane-view-issue-feedback.md). Use this when implementing or re-prioritizing.

Related: [pane-view-approved-backlog.md](../plans/pane-view-approved-backlog.md) · [pane-view-issue-analysis.md](./pane-view-issue-analysis.md)

---

## M-07 — Breadcrumbs fragile on narrow viewports

### What is wrong today

On mobile the header packs: sidebar trigger, truncated breadcrumb trail, search (hidden below `md`), detail-panel toggle, and other actions. Deep paths like `sfw/patreon/2024/album-name` collapse into ellipsis quickly. Users cannot see where they are without opening the sidebar.

### Proposed changes (P2)

**Mobile header (below `md`):**

```
┌─────────────────────────────────────────┐
│ [≡]  Album Name                    [···] │
│      sfw › patreon › 2024   (optional) │
└─────────────────────────────────────────┘
```

1. **Primary line:** current folder `name` only (from the folder node at `currentPath`), large and truncates with ellipsis at the end.
2. **Secondary line (optional):** one-line parent context, e.g. immediate parent name or shortened `parent › current`.
3. **Tap current folder title** → opens a **path sheet** listing ancestors from root to current (same data as breadcrumb, larger touch targets).
4. **Parent control:** chevron-up or “Parent” next to the title (overlaps N-01); disabled at archive root.
5. **Desktop (`md+`):** keep existing breadcrumb; optionally cap visible crumbs with a `…` menu for middle segments.

**Out of scope for this item:** changing how paths are stored or fetched; this is layout/IA only.

**Acceptance:** On a 390px-wide viewport, the current folder name is always readable without hover; user can reach any ancestor in ≤2 taps.

---

## P-07 — Fixed 320px thumbnail requests

### What is wrong today

- Grid cards are laid out at **~220px** width (`BrowserGrid` / `useVirtualGridMetrics`).
- The loader joins thumbnails at **size 320** only (`repository.ts`).
- `Poster` always uses that URL; there is no `srcset` or DPR scaling.

### Why it matters

| Scenario | Effect |
| --- | --- |
| Phone, 220px card, 2× DPR | Display needs ~440px of image data; 320px thumb looks soft |
| Phone, 220px card, 1× DPR | Downloads 320px when ~220px would suffice (wasted bytes) |
| Large desktop card (if S-03 adds slider) | Still capped at 320px → soft on big grids |

### Proposed fix (P1)

1. Compute `requestedSize = round(cardWidth × devicePixelRatio)` and snap to the API’s allowed ladder (e.g. 160, 320, 640 — match `derivative-service`).
2. Pass `size` query param on `/api/media/:id/thumbnail?size=…`.
3. Optionally store multiple ready sizes in DB and use `srcset` when ≥2 sizes exist.
4. Thread **S-03** thumbnail slider through the same sizing helper so card width and request size stay in sync.

**Not in scope:** generating new derivative sizes server-side beyond what the pipeline already supports.

**Acceptance:** On a 2× mobile display, grid thumbs look sharp without loading originals; byte size is not more than ~1.25× the ideal for the rendered pixel width.

---

## P-10 — Original images in the fullscreen viewer

### What is wrong today

`MediaViewerModal` sets `<img src={originalMediaUrl}>` for images. Every open pulls the full file from object storage — slow and memory-heavy for large photos, especially on mobile when paging quickly.

### Proposed behaviour (approved pattern)

```
Open image in viewer
        │
        ▼
Load preview derivative (web-sized JPEG/WebP, already in storage pipeline)
        │
        ▼
Show preview at fit/contain ──► user taps "View original" / zoom / long-press
        │
        ▼
Load signed original URL (optional progressive upgrade)
```

1. **Default:** `preview` route or thumbnail at max preview size (e.g. 1920px long edge — align with `previewObjectKey` in `media-storage`).
2. **Upgrade:** explicit control (“Full resolution”) or pinch-zoom past preview limits triggers original fetch.
3. **Indicator:** subtle badge when viewing preview vs original.
4. **Videos/PDFs:** unchanged; this item is images only.

**Acceptance:** Opening a 24MP photo shows a sharp-enough preview within 1–2s on typical Wi‑Fi; original loads only after explicit action.

---

## S-10 — Loop viewer navigation

### What it means

When stepping **previous/next** in the fullscreen viewer (buttons, Q/E, or tap zones):

| Setting | At first item + Previous | At last item + Next |
| --- | --- | --- |
| **Loop off** (Pane View today) | Stays on first item | Stays on last item |
| **Loop on** (Frame View default) | Jumps to last item | Jumps to first item |

The **detail panel** prev/next already wraps; the **modal viewer** `step()` clamps:

```77:82:apps/pane-view/src/features/gallery/MediaViewerModal.tsx
  const step = useCallback(
    (delta: number) => {
      const nextIndex = Math.max(0, Math.min(items.length - 1, index + delta));
      setIndex(nextIndex);
    },
```

### Recommendation

Add toggle in settings (default **on** to match Frame View, or **off** if you prefer bounded browsing). Low effort once S-01 exists.

**Related:** V-04 (video ended → advance) is separate — auto-advance to next video when one finishes; you marked that Skip.

---

## S-12 — Custom file extensions

### What it means

Frame View settings include `filters.imageExtensions` and `filters.videoExtensions` so users can treat e.g. `.heic`, `.avif`, or `.m4v` as gallery media without code changes.

Pane View uses shared rules in `packages/media-domain` (fixed extension lists). Unsupported extensions are invisible in the grid.

### When you need it

- Synced archive contains types not in the default lists.
- You want to **hide** certain extensions without deleting files.

### Proposed scope (if pursued)

1. Settings UI: two comma-separated or chip lists (images, videos).
2. Persist in `localStorage` (per-device; aligns with your S-13 note).
3. Client-side filter on loader results short-term; optional server filter later.

**Recommendation:** **Backlog** unless you hit a concrete unsupported extension. Ingest/sync already knows `mediaType` from Lockstep; extension UI is a display filter, not a sync change.

---

## N-02 — Navigation ceiling

### What it means

In Frame View, when you open folder `D:\Photos\Vacation2024`, “go up” stops at `Vacation2024` for that session — you cannot accidentally navigate to `D:\` or other drives without opening a new root.

Pane View has a single synced archive; “up” always walks to empty `parentPath` (archive root). **Ceiling** would mean: after you navigate into `sfw/patreon/foo`, Up is disabled at `sfw/patreon` even though `sfw` exists.

### Why Frame View has it

Desktop app opens arbitrary folders; ceiling marks the **session root**.

### Recommendation for Pane View

**Skip** — low value for a fixed archive. Your **N-04** modification (no recursion at archive root) addresses a different, more important constraint.

If you ever want a lightweight variant: “session root” = path on first load after login, cap Up there — still optional.

---

## N-04 — Recursion only below archive root (your modification)

### Original analysis item

Frame View can exclude specific child folders from recursive scans per opened root (`excludedRootChildPaths`).

### Your direction

**Recursion must not be enabled at archive root** (empty `currentPath`). Recursive mode is only meaningful inside a subfolder where “show all descendants” is bounded.

### Proposed implementation

1. When `currentPath === ""` and user toggles recursive **on** → ignore or show toast: “Open a folder first” / force recursive off.
2. When navigating to archive root → auto-set `recursive: false` (or keep off visually disabled).
3. Align with **S-05**: default `recursive: false` everywhere; user enables per folder when needed.
4. Loader: when `recursive: false`, query **direct children only** (P-01).

**Acceptance:** At archive root, recursive toggle is disabled or off; enabling recursive inside `sfw/patreon` loads descendants under that path only.

---

## V-01 — Wire viewer state (resume)

### What it means

Server table `viewer_state` + `getViewerState` / `saveViewerState` store per-user:

- **Video:** `positionMs` (last playback time)
- **Comic/PDF:** `page` (last page index)

On reopen, viewer seeks to saved position.

### Your decision

**Skip for now** — videos are short; resume not worth the complexity yet.

### What stays in codebase

API and schema can remain; no UI wiring until you want PDF page resume (pairs with **M-10**). No conflict with skipping **X-01** (same feature, server-backed).

---

## V-05 — rAF coalesced rapid Q/E stepping

### What it means

If the user presses **Q** or **E** many times per second, Pane View updates `index` on every keydown → each step may remount video, abort loads, and stutter.

Frame View batches rapid steps to **one index change per animation frame** using `requestAnimationFrame`.

### Example

Ten Q presses in 50ms → one or two index changes instead of ten.

### Recommendation

**Skip / P2 polish** — desktop-only micro-optimization. Only revisit if you notice stutter when keyboard-stepping through video folders.

---

## T-08 — Animated GIF tiles (WebP question)

### Today

GIFs may use static WebP thumbnails from the derivative pipeline (first frame) or fall back to the original GIF URL in the grid — heavy if animated.

### Can we use WebP for animated GIFs?

**Yes, in principle:**

1. **ffmpeg** can produce **animated WebP** from GIF (`-loop 0` for infinite loop).
2. Store as a separate derivative purpose (e.g. `animated_preview`) or replace static thumb for `gif` only.
3. Grid `<img>` or `<video autoplay muted loop>` for short loops; cap file size / duration in pipeline.

**Tradeoffs:**

| Approach | Pros | Cons |
| --- | --- | --- |
| Static WebP thumb | Cheap, already works | No animation in grid |
| Animated WebP | Smaller than GIF, animates | Encode cost, not all browsers identical |
| Original GIF in grid | Full fidelity | Large, slow scroll |

**Recommendation:** P2 spike — generate animated WebP for GIFs under a size threshold during thumbnail generation; grid uses it when present, else static thumb.

---

## S-02 — `next-themes` with TanStack Start

**Yes, it works.** `next-themes` is not Next.js-specific; it manages a `class` or `data-theme` on `<html>` and avoids flash-of-wrong-theme with a small inline blocking script.

TanStack Start (React SSR):

1. Add `ThemeProvider` from `next-themes` in root layout with `attribute="class"`.
2. Inline script in `<head>` (documented in next-themes README) for SSR hydration match.
3. Persist choice in `localStorage`; map values to existing Tailwind `dark:` tokens in `styles.css`.

No architectural blocker; ship with P1 settings tab.

---

## Items with approved direction (no further clarification needed)

| ID | Resolution |
| --- | --- |
| **P-06** | Skip pre-warm / per-account caps; **do** ship T-04 pulsing placeholder |
| **M-04 / M-05** | Remove visible side arrows; full-height invisible left/right tap zones (50% width each) for prev/next; swipe optional enhancement |
| **M-09** | Move logout (and account) to sidebar; keep browse modes in center toolbar |
| **M-10** | Evaluate PDF.js or similar for minimal mobile reader; iframe fallback unacceptable long-term |
| **S-05** | `recursiveDefault: false` in `useGalleryState` + settings exposure; critical with P-01 |
