# ADR 0001: Give Gather Runs one owner and one control surface

- **Status**: Accepted
- **Date**: 2026-07-15
- **Decision owners**: Latch Works maintainers
- **Implementation plans**: 041–045

## Context

Gather Box currently executes collection, remote fetches, filesystem writes, retry handling, and
story PDF generation inside either the action popup or the side panel. Both surfaces construct an
independent `GatherController`. Shortcut delivery broadcasts to whichever extension pages happen to
exist and supplements that broadcast with one unscoped session boolean.

This makes UI lifetime define execution lifetime. Chrome closes an action popup as soon as focus
moves outside it. A persistent side panel avoids that specific behavior but can still be closed, can
hold stale active-tab state, and must not be the owner of archive writes. Multiple open extension
pages can accept the same runtime message and start duplicate work.

The same misplaced seam also shapes the build: the popup and side panel each statically bundle the
complete Gather implementation. The uncommon generated-story path pulls the PDF dependency graph
into both 2.2 MB UI bundles. Gather Source knowledge is separately repeated in the manifest,
context-menu patterns, runtime URL matching, collector dispatch, credential policy, download policy,
and save behavior.

## Decision

### One Gather Run owner

The extension service worker coordinates at most one active Gather Run per browser profile. A run
has a stable identifier, exact `tabId` and `windowId`, source URL, creation time, phase, progress, and
terminal outcome. That state is persisted so service-worker termination or UI reconnection does not
silently lose the run.

An offscreen extension document performs long-lived web work: remote fetches, collision-safe
filesystem writes, Blob handling, DOM parsing, and generated story PDFs. This choice is gated by a
vertical proof that the offscreen document can load the saved directory handle from extension-origin
IndexedDB and write through a permission already granted from visible UI. If that proof fails, this
ADR must be revisited rather than moving execution back into the side panel.

Visible UI owns user-gesture requirements only. Folder selection and renewed filesystem permission
remain explicit side-panel actions. A shortcut may begin a run immediately when permission is
already granted; otherwise it opens the side panel in a permission-required state.

### One full Gather Box control surface

The side panel is the only full Gather Box UI. The action popup and the `primaryUi` setting are
removed. The toolbar action and toggle command address the same side panel. Closing the panel
detaches the view but does not cancel a running Gather Run; reopening it attaches to current state.

The side panel observes, starts, cancels, and retries runs through the run owner. It does not fetch
source files, write the archive, generate PDFs, or keep authoritative run state.

### Deterministic command routing

Chrome commands, page shortcuts, the context menu, and side-panel controls are input adapters over
one command module. Each gather intent retains the initiating tab and window. The service worker
derives sender identity from Chrome rather than trusting tab identity supplied in a content message.

The global pending boolean, runtime broadcast to arbitrary extension pages, and open/close races are
removed. Receipt is not treated as success: command outcomes distinguish started, already running,
permission required, unsupported source, and failed.

The setting for page shortcuts controls only the page-key adapter. Native Chrome commands remain
controlled by `chrome://extensions/shortcuts` and are not silently disabled by that setting.

Gather Box declares a minimum Chrome version that supports the chosen side-panel open, close, and
visibility events with consistent global-panel behavior. The implementation plans use Chrome 145 as
the baseline unless a drift check demonstrates a newer requirement.

### Real Gather Output adapters

Source-file batches and generated story PDFs are two real adapters behind one Gather Output seam.
The story PDF implementation and its dependencies load only for the generated-story output kind and
only in the execution document. Popup or side-panel startup must not load PDF code.

The build is organized by Chrome execution context, emits local ESM chunks where supported, minifies
release artifacts, copies only declared assets, emits an esbuild metafile, and enforces artifact size
budgets in `check`.

### Authoritative Gather Source catalog

One deep Gather Source catalog owns each source's identity, eligible URLs, Chrome match patterns,
download origins, collector adapter, credential default, and archive save behavior. Build and runtime
adapters derive manifest artifacts, context-menu eligibility, dispatch, and presentation from that
catalog. Per-source collectors retain their own extraction depth.

The always-on content script contains only the small page-key adapter. A Gather Run injects only the
collector adapter selected for its exact source. The current bundle containing every collector no
longer runs at `document_start`.

## Consequences

### Positive

- Gather Run lifetime no longer depends on popup or side-panel lifetime.
- One run lock prevents duplicate archive writes across windows and UI instances.
- Exact target identity removes stale-tab and global-pending behavior.
- The side panel can reconnect to progress after closing or navigating.
- PDF implementation cost leaves the ordinary UI and image-gather paths.
- Source additions have locality and manifest/policy drift becomes testable.
- Shortcut, run, output, source, and build seams become direct test surfaces.

### Costs

- The extension adds the `offscreen` permission and an offscreen entry document.
- Run state and progress need a versioned persisted representation and recovery behavior.
- UI, service worker, content adapters, and execution document require explicit message validation.
- The minimum Chrome version rises substantially from the implicit current baseline.
- Removing the popup means the toolbar action always opens or toggles the side panel.

## Alternatives rejected

### Keep the full popup

Rejected because Chrome destroys it on outside focus and retaining a second full UI preserves state
synchronization, command-routing, test-matrix, and bundle duplication without a distinct use case.

### Keep the popup as a launcher

Rejected because it makes toolbar activation a two-step path while commands address the side panel
directly. It would be a second adapter with little leverage.

### Execute inside the side panel

Rejected because a control surface can still close, navigate, or reload. Side-panel persistence is
useful for observation, not a reliable execution contract.

### Execute everything in the service worker

Rejected because extension service workers terminate, do not expose the DOM, and are a poor host for
long Blob/PDF work. The service worker coordinates and persists; the offscreen document executes.

### Use `chrome.downloads`

Rejected because it writes relative to the browser's Downloads directory and cannot preserve Gather
Box's user-selected archive root and File System Access behavior.

### Keep one always-on collector bundle

Rejected because every eligible page pays for all source collectors merely to install two page-key
shortcuts. A small page-key adapter and selected on-demand collector have distinct lifetimes and a
real seam.

## Validation requirements

- Prove offscreen IndexedDB directory-handle access and collision-safe writing before migration.
- Prove filesystem permission-required behavior cannot be misreported as a started run.
- Prove popup/side-panel duplication and the global pending flag are absent from the packaged build.
- Prove only the selected collector enters an eligible page.
- Enforce manifest/catalog consistency and artifact budgets in automated checks.
- Exercise commands, panel close/reopen, tab changes, duplicate intent, and interrupted recovery in a
  browser-level test harness.
