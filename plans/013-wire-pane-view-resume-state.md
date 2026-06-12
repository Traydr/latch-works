# Plan 013: Wire Pane View Resume State Into The Viewer

> **Executor instructions**: Follow this plan step by step. Run every verification
> command and confirm the expected result before moving to the next step. If any
> STOP condition occurs, stop and report instead of improvising. When done,
> update this plan's row in `plans/README.md` unless a reviewer says they own the
> index.
>
> **Drift check (run first)**:
> `git diff --stat 326110f..HEAD -- apps/pane-view/src/features/viewer apps/pane-view/src/features/gallery/MediaViewerModal.tsx apps/pane-view/src/server/viewer-state apps/pane-view/src/server/db/schema.ts apps/pane-view/src/features/viewer/*.test.tsx apps/pane-view/src/features/gallery/*.test.tsx`
> If any in-scope file changed, compare the excerpts below with the live code
> before proceeding. A mismatch is a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `326110f`, 2026-06-12

## Why this matters

Pane View already has a `viewer_state` table and server functions for resume
position, but the modal does not use them. Resume state is explicitly documented
as planned, and it is a high-leverage private-archive feature for long videos and
PDFs. This plan wires existing server support into the viewer without changing
the archive schema or adding favorites.

## Current state

- `apps/pane-view/src/features/viewer/viewer-state-service.ts` exposes
  `getViewerState` and `saveViewerState`.
- `apps/pane-view/src/server/viewer-state/repository.ts` reads/upserts
  `positionMs` and `page`.
- `apps/pane-view/src/server/db/schema.ts` defines `viewer_state`.
- `apps/pane-view/src/features/gallery/MediaViewerModal.tsx` tracks video
  `position` in local React state only.
- `apps/pane-view/src/features/viewer/PdfViewer.tsx` renders all pages into a
  scroll container and does not expose current page/resume hooks.

Relevant excerpts at `326110f`:

```ts
// apps/pane-view/src/features/viewer/viewer-state-service.ts:21-40
export const getViewerState = createServerFn({ method: "GET" })
  .inputValidator(viewerStateSubjectSchema)
  .handler(async ({ data }): Promise<ViewerStateSnapshot | null> => { ... });

export const saveViewerState = createServerFn({ method: "POST" })
  .inputValidator(viewerStateWriteSchema)
```

```ts
// apps/pane-view/src/server/viewer-state/repository.ts:44-69
export async function upsertViewerState({ state, userId }: ...): Promise<ViewerStateSnapshot | null> {
  const [saved] = await db
    .insert(viewerState)
    .values({
      page: state.page ?? null,
      positionMs: state.positionMs ?? null,
      subjectId: state.subjectId,
      subjectType: state.subjectType,
      updatedAt: new Date(),
      userId,
    })
    .onConflictDoUpdate({ ... })
    .returning();
```

```ts
// apps/pane-view/src/features/gallery/MediaViewerModal.tsx:85-89
const [playing, setPlaying] = useState(false);
const [duration, setDuration] = useState(0);
const [position, setPosition] = useState(0);
const [volume, setVolume] = useState(() => readPersistedVolume());
const [speed, setSpeed] = useState(1);
```

```ts
// apps/pane-view/src/features/gallery/MediaViewerModal.tsx:541-545
onTimeUpdate={(event) => {
  if (!isScrubbingRef.current) {
    setPosition(event.currentTarget.currentTime || 0);
  }
}}
```

```ts
// docs/end-to-end-request-flow.md:294
Viewer state (resume position) has server functions getViewerState / saveViewerState
and a viewer_state table, but modal wiring is still incomplete.
```

Repo conventions to match:

- Use existing TanStack Start server functions rather than raw fetch calls.
- Keep viewer controls compact and avoid visible instructional text.
- Do not expose raw Node APIs in renderer/client code.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Viewer tests | `pnpm --filter @latch-works/pane-view test -- src/features/viewer src/features/gallery` | exit 0, focused tests pass |
| Pane typecheck | `pnpm --filter @latch-works/pane-view typecheck` | exit 0, no TypeScript errors |
| Pane tests | `pnpm --filter @latch-works/pane-view test` | exit 0, all Pane View tests pass |

## Scope

**In scope**:

- `apps/pane-view/src/features/gallery/MediaViewerModal.tsx`
- `apps/pane-view/src/features/viewer/PdfViewer.tsx`
- `apps/pane-view/src/features/viewer/viewer-state-service.ts`, only if a small
  type/export adjustment is needed
- Focused viewer/gallery tests
- `plans/README.md`, status row only

**Out of scope**:

- Schema changes to `viewer_state`.
- Favorites.
- Multi-user sharing semantics.
- Persisting image zoom/pan state.

## Git workflow

- Branch: `codex/013-wire-pane-view-resume-state`
- Commit style: short imperative summary, for example
  `Wire Pane View resume state.`
- Do not push or open a PR unless the operator asks.

## Steps

### Step 1: Add a small client hook for viewer state

Create a hook near `apps/pane-view/src/features/viewer` that wraps
`getViewerState` and `saveViewerState` for `subjectType: "library_entry"`.

Requirements:

- Load state when the selected `item.id` changes.
- Debounce saves so video `timeupdate` does not call the server many times per
  second. A 2-5 second debounce is acceptable.
- Flush on modal close, item change, and video pause if practical.
- Ignore unauthenticated `null` results without noisy UI.

**Verify**:
`pnpm --filter @latch-works/pane-view typecheck` -> exit 0.

### Step 2: Restore and save video position

In `MediaViewerModal.tsx`, when a video item loads metadata and viewer state has
a finite `positionMs`, seek to that position if it is inside the video duration.
Convert seconds to milliseconds when saving.

Avoid fighting user scrubbing:

- Do not save while `isScrubbingRef.current` is true.
- Clamp restored position to `duration - 1` second if duration is known.
- Do not auto-play solely because a position was restored.

**Verify**:
`pnpm --filter @latch-works/pane-view typecheck` -> exit 0.

### Step 3: Add minimal PDF page resume

Update `PdfViewer` so it can accept an optional initial page and report current
page changes. Because it renders all pages in a scroll container, use
`IntersectionObserver` or scroll position calculation to estimate the current
page.

Requirements:

- After pages render, scroll the initial page into view if provided.
- Report page changes through a debounced callback.
- Keep existing rendering and resize behavior.

If page detection becomes fragile, STOP and report. Shipping video-only resume is
better than adding unreliable PDF resume.

**Verify**:
`pnpm --filter @latch-works/pane-view typecheck` -> exit 0.

### Step 4: Add tests

Add focused tests for the hook and viewer components.

Cover at least:

- Existing video state seeks the video after metadata loads.
- Video time updates are debounced before `saveViewerState`.
- Close/item change flushes the latest position.
- PDF initial page scroll callback is invoked after render, if testable without
  real `pdfjs`.

Mock server functions and browser media APIs. Do not require a real database.

**Verify**:
`pnpm --filter @latch-works/pane-view test -- src/features/viewer src/features/gallery`
-> exit 0.

## Test plan

- Hook unit tests with fake timers.
- Component tests with mocked `HTMLVideoElement` properties/events.
- PDF tests can mock rendered page elements rather than loading a real PDF.

## Done criteria

- [ ] Video viewer restores saved `positionMs` for the selected library entry.
- [ ] Video viewer saves position with debouncing and flushes on close/item
      change/pause.
- [ ] PDF viewer supports saved/restored `page`, or the plan is explicitly
      stopped before shipping unreliable PDF support.
- [ ] No schema migration is added.
- [ ] Focused viewer tests and Pane View typecheck pass.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

Stop and report if:

- Server functions are not callable from this client route under TanStack Start.
- Browser media tests require a real video decoder.
- Reliable PDF page detection requires a larger viewer redesign.
- Current route/auth behavior returns unauthorized errors that need a separate
  session handling plan.

## Maintenance notes

Future viewer-state fields, such as zoom or image pan, should extend the same
hook rather than adding separate save paths. Reviewers should look for excessive
server calls from video progress events.
