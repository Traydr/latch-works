# Plan 040: Validate and specify Frame View PDF reading

> **Executor instructions**: This is a time-boxed direction spike, not authorization to advertise or
> ship an incomplete reader. Preserve Electron sandboxing and delete throwaway prototype code unless
> every retention gate passes. Run every gate and update the plan index.
>
> **Drift check (run first)**: `git diff --stat 06b5005..HEAD -- apps/frame-view packages/media-domain docs apps/showcase/src/content/docs/frame-view`

## Status

- **Status**: TODO — wanted; Steps 2–3 need the product owner at a desktop (re-audited 2026-08-17)
- **Priority**: P2 — the product owner confirmed on 2026-08-17 that Frame PDF reading is wanted and
  that Frame View and Pane View should broadly match in features; direction is to port Pane View's
  windowed `PdfViewer` (Plan 034) rather than design from scratch
- **Effort**: M (spike only; implementation to be re-estimated)
- **Risk**: MED
- **Depends on**: Plan 033, Plan 034
- **Category**: product direction / architecture spike
- **Planned at**: commit `06b5005`, 2026-07-13 (refreshed after Plans 033 and 034)
- **Original direction**: 1

## Why this matters

Gather Box produces story PDFs, Pane View reads PDFs, and the Showcase currently claims Frame View
does too. Frame's actual catalog, IPC contracts, thumbnails, and modal support only image/video. A
bounded spike should determine the secure Electron delivery boundary, PDF.js packaging model, and
reader performance contract before this promise becomes a broad cross-process implementation.

## Direction (2026-08-17)

The product owner wants this feature and wants Frame View to match Pane View. So the spike should
start from Pane's `PdfViewer` (Plan 034: stable geometry, visible-window rendering, overscan, ≤8 live
canvases) and ask "what does it take to run this inside Frame's sandboxed Electron renderer with a
constrained media protocol?" rather than open the design space. Steps 1, 4, and 5 are agent desk
work; Steps 2 and 3 need the product owner to run the packaged app and record the numbers. Plan the
work as: agent drafts the design and prototype, product owner runs the packaged smoke, agent
finishes.

## Blocker analysis (audit 2026-07-28)

**What is blocking**: Steps 2 and 3 require `pnpm --filter @latch-works/frame-view package` / `make`
and then opening the resulting desktop distributable to measure packaged worker resolution,
first-page latency, and bounded canvas behavior. An agent cannot launch a packaged Electron app, so
these gates are user-only. Steps 1, 4, and 5 are desk work and are not blocked.

**Is it still blocked**: yes, and nothing has started. The earlier attempt left a provisional design
record on `codex/040-frame-view-pdf-spike` at `b74d7b8`; that branch no longer exists on `origin` or
locally and the commit is unreachable from any ref. Do not try to continue from it. It contained a
design draft only — no prototype, measurements, or worker-resolution evidence — so nothing of
substance is lost. `docs/frame-view-pdf-reader-design.md` does not exist on `main`.

**Urgency has dropped**: the reason this was P2 was that the Showcase advertised a Frame PDF reader
that does not exist. Plan 039 fixed that — `frame-view/index.mdx`, `comics-and-stories.mdx`, and
`troubleshooting.mdx` now all state that PDF reading is planned and not shipped. Code and docs agree.

**How to resolve**: either (a) a human runs Steps 2–3 interactively on a supported desktop OS and
records the measurements, after which an agent can finish Steps 4–5; or (b) mark this deferred until
Frame PDF reading is actually wanted. Nothing depends on this plan.

## Current state

- `apps/frame-view/src/shared/contracts.ts` models only image/video media, and `apps/frame-view` has
  no `pdfjs-dist` dependency.
- Frame catalog discovery, thumbnailing, and `ViewerModal` branch on image/video and do not index or
  open PDF files.
- The Showcase no longer overclaims: Plan 039 corrected `comics-and-stories.mdx`, `index.mdx`, and
  `troubleshooting.mdx` to state that Frame PDF reading is planned and not shipped. Keep it that way
  until production done criteria are met.
- Pane's `PdfViewer` now provides the bounded Plan 034 windowing contract: stable geometry,
  visible-page rendering, overscan, obsolete-task cancellation, and at most eight retained canvases.
- Plan 033 moved Frame's catalog path and media classification semantics toward
  `@latch-works/media-domain`; extend that shared model rather than restoring local duplicates.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Frame tests | `pnpm --filter @latch-works/frame-view test` | all supported-platform tests pass |
| Frame check | `pnpm --filter @latch-works/frame-view check` | exit 0 |
| Frame make | `pnpm --filter @latch-works/frame-view make` | distributable build succeeds |
| Package smoke | `pnpm --filter @latch-works/frame-view package` | packaged app opens synthetic PDF on a supported desktop |

## Scope

**In scope**: a decision/design document; synthetic PDF fixture; a minimal vertical prototype for
discovery -> secure protocol -> PDF.js worker -> one virtualized page window; package-size and worker
resolution measurements; thumbnail/resume/accessibility design; follow-up implementation slices.

**Out of scope**: production release; annotations/editing/forms; OCR; encrypted-password UX; cloud
PDF fetching; changing Pane's reader; unrestricted `file://` access; exposing Node APIs to renderer;
indexing arbitrary files outside selected roots.

## Git workflow

- Branch: `codex/040-frame-view-pdf-spike`
- Commit message: `Specify Frame View PDF reading`

## Steps

### Step 1: Define the product and security contract

Create `docs/frame-view-pdf-reader-design.md` with explicit answers for supported PDFs, catalog
visibility, mixed image/PDF folders, open/close and keyboard behavior, resume state, corrupt and
password-protected files, maximum tested size/page count, accessibility, and offline-only behavior.

Model the data flow through the existing main/preload/renderer split. Prefer the constrained custom
media protocol over raw file URLs, validate all paths remain under selected roots, and expose no raw
filesystem or Node surface to the renderer.

**Verify**: threat-model tests are named for traversal, unselected-root access, malformed PDFs, and
protocol MIME/range behavior; design review has no unresolved trust-boundary decision.

### Step 2: Prove PDF.js in development and packaged Electron

Using only a repository-owned synthetic fixture, prototype loading one document through the chosen
protocol and rendering a page with `pdfjs-dist`. Prove the worker asset resolves in dev and packaged
builds under the existing bundler, CSP, sandbox, and context isolation. Record added unpacked and
compressed package size plus first-page latency on a named test machine.

Do not disable Electron security controls to make the worker run. Keep dependency versions aligned
with Pane unless the design records a concrete incompatibility.

**Verify**: dev and packaged smoke tests open the fixture offline; no console worker fallback, CSP
violation, network request, or direct filesystem access occurs.

### Step 3: Prove the bounded rendering model

Adapt the windowing contract established by Plan 034: stable page-height placeholders, visible-page
rendering with small overscan, cancellation of obsolete PDF.js render tasks, and a fixed upper bound
on live canvases. Exercise a synthetic long document and resize/rapid navigation behavior. Do not
copy Pane's old eager all-pages loop.

**Verify**: an automated harness observes bounded live canvases/render tasks as page count grows and
confirms navigation reaches first/last pages without blank or reordered pages.

### Step 4: Design catalog, thumbnail, and resume integration

After Plan 033, specify the shared-domain changes needed for PDF classification without weakening
image/video/comic semantics. Trace exact Frame files and migrations for:

- PDF discovery and media contracts;
- first-page thumbnail generation/cache invalidation;
- a dedicated modal/reader route and keyboard focus ownership;
- page count and last-read page persistence;
- errors, diagnostics, and settings copy.

Choose whether thumbnail rasterization belongs in the existing worker pool or a separate bounded PDF
worker based on measured memory/failure isolation. Do not store source-derived data beside the source.

**Verify**: the design contains a schema/IPC compatibility table, migration/rollback story, test
matrix, and measured recommendation for worker ownership.

### Step 5: Turn evidence into implementation slices

Update the design record with the prototype results, accepted/rejected alternatives, dependency and
license review, exact production file list, fixtures, rollout gates, and estimates. Split production
work into independently reviewable follow-up plans: domain/catalog, secure delivery, thumbnailing,
reader/resume, and docs/release.

Retain prototype code only if it meets normal source quality, test, dependency, and packaging gates;
otherwise keep measurements/design and remove it before merging. Plan 039 must continue to describe
Frame PDF as planned until the production done criteria are met.

**Verify**: another agent can execute the follow-up slices without rediscovering a security,
packaging, persistence, or rendering decision.

## Test plan

Use small, long, malformed, traversal-attempt, and password-protected synthetic fixtures that are
safe to commit. Cover MIME/range protocol responses, root authorization, worker loading, render-task
cancellation, bounded canvases, resize, keyboard/focus behavior, and resume compatibility. Smoke the
packaged app on at least one target OS; record other OS coverage as an explicit rollout gate.

## Done criteria

- [ ] A reviewed design record resolves product, security, packaging, data, and performance choices.
- [ ] Development and packaged Electron load a synthetic PDF without weakened security controls.
- [ ] The prototype demonstrates bounded rendering independent of page count.
- [ ] Package-size, latency, memory, and worker-resolution evidence is recorded.
- [ ] Production work is split into precise, estimated follow-up plans.
- [ ] Showcase still labels Frame PDF as planned until the production feature ships.

## STOP conditions

- PDF.js requires disabling sandbox, context isolation, CSP, or path authorization.
- The selected protocol can expose arbitrary local files or selected-root boundaries are ambiguous.
- The worker cannot resolve reliably in packaged builds on a supported platform.
- Rendering remains proportional to total page count after applying the Plan 034 model.
- A dependency has an unacceptable license, unresolved native packaging burden, or material supply-chain concern.

## Maintenance notes

Re-run worker-resolution and package-size smoke tests on Electron/bundler/PDF.js upgrades. Treat PDF
rendering as hostile-document processing: keep dependencies current, workers bounded, and the
renderer isolated from filesystem authority.
