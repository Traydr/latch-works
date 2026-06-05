# Pane View Problem Inventory

This document captures the current usability and performance problems in Pane View. It is
intended as a planning aid for future work, not a replacement for the architecture plan or
thumbnail/CDN runbooks.

## Scope

Pane View is the authenticated web and mobile viewer for the synced media archive. The current
implementation has the right high-level pieces: folder navigation, virtualized grid rendering,
thumbnail delivery, signed original delivery, comic grouping, keyboard navigation, and a modal
viewer. The remaining problems mostly come from two tensions:

- The UI still behaves like a desktop gallery adapted to the browser, rather than a touch-first
  mobile viewer.
- The browser grid is virtualized, but the data model and loader still send and process large
  library snapshots at once.

## UI and UX Usability Problems

### Mobile Navigation Is Not Touch First

The main gallery interaction is built around single-click selection, double-click activation, and
keyboard shortcuts. That works on desktop, but mobile users do not get a clear or reliable path from
tap to view. A tap selects an item, while activation depends on a double-click-style event or hidden
state elsewhere. Folder entry and media opening need explicit touch behavior.

Needed improvements:

- Open media on a normal tap, or provide an obvious secondary action that is visible on touch.
- Make folder cards enter folders with a single tap.
- Add mobile-native previous/next gestures in the viewer.
- Keep keyboard shortcuts as desktop acceleration, not as the primary discoverable interaction.

### Important Controls Disappear on Mobile

The header search form is hidden below the `md` breakpoint. The detail panel is hidden on mobile.
The floating toolbar hides labels below the `sm` breakpoint. This leaves mobile with icon-only
controls, limited context, and no obvious search entry point.

Needed improvements:

- Provide a mobile search action, likely as an icon button that opens a sheet or command panel.
- Expose selected media details through a bottom sheet or viewer info panel.
- Add accessible labels/tooltips for icon-only controls and keep the most common actions visually
  recognizable.
- Review whether refresh and logout belong in the same bottom toolbar as browsing modes on small
  screens.

### Hover-Only Metadata Is Lost on Touch Devices

Media names, sizes, and dimensions are revealed through hover overlays on media cards. Touch devices
do not have a stable hover state, so many entries appear as unlabeled thumbnails. This is especially
hard in personal archives where adjacent images can look similar.

Needed improvements:

- Show at least the filename or short title by default on mobile.
- Consider density modes: compact thumbnail grid, labeled grid, and detail list.
- Preserve hover overlays on desktop, but avoid making hover the only way to identify an item.

### Modal Viewer Chrome Is Cramped on Small Screens

The viewer uses fixed top and bottom bars, side arrow buttons, and large padding around the media.
On phones, those controls compete with the media itself. Video controls can wrap into multiple rows,
and the top metadata bar can consume valuable vertical space. The side arrows also sit over content
near the thumb edges.

Needed improvements:

- Use mobile-specific viewer layout with edge-safe controls.
- Collapse metadata behind an info button on narrow viewports.
- Replace side arrow buttons with swipe gestures plus small optional controls.
- Reduce fixed padding and account for safe-area insets.
- Let controls auto-hide while viewing images and videos.

### PDF and Long-Form Reading Need a Mobile Experience

PDFs currently load in an iframe pointed at the original media route. This is simple, but it gives
little control over mobile reading behavior, page position, or large document performance. It also
does not provide the planned story/PDF parity described elsewhere in the docs.

Needed improvements:

- Use a real PDF reader surface with responsive page layout.
- Persist reading position.
- Add mobile vertical reading mode.
- Add page thumbnails or page jump controls later.

### Breadcrumbs and Folder Context Are Fragile on Narrow Viewports

The header breadcrumb truncates aggressively and competes with the sidebar trigger and header
actions. On mobile, deep paths can become hard to understand, and users may lose confidence about
where they are in the archive.

Needed improvements:

- Show current folder name prominently on mobile.
- Move full path/breadcrumb navigation into a sheet or folder picker.
- Provide clear parent-folder navigation without requiring keyboard shortcuts.

### Sidebar Behavior Needs Mobile Review

The archive sidebar uses the shared sidebar/sheet behavior, which is a good starting point, but the
information architecture is still desktop-oriented. Ancestors and child folders are rendered as a
tree list with small row targets and truncation. Deep archives need stronger mobile ergonomics.

Needed improvements:

- Increase touch targets for folder rows on mobile.
- Add quick root/current/parent affordances.
- Consider a mobile folder browser with search and recent paths.
- Make active path context visible after the sidebar closes.

### Toolbar Priority Is Unclear

The floating toolbar includes recursive mode, comic mode, sort, shuffle, refresh, and logout. On
mobile this becomes a compact row of icons at the bottom of the screen. These actions have very
different frequency and risk profiles, but they receive similar visual weight.

Needed improvements:

- Separate browsing modes from account/session actions.
- Put sort and mode controls in a bottom sheet or segmented panel.
- Move logout to an account/menu location.
- Keep the primary bottom area available for navigation or viewer actions.

### Accessibility and Discoverability Need Work

The UI has many aria labels and native controls, but the current experience still relies on hidden
knowledge: double-click to open, keyboard shortcuts, hover overlays, icon-only buttons, and custom
modal behavior. The viewer modal also needs stronger focus management and accessible button labels
for previous/next controls.

Needed improvements:

- Add explicit accessible names to previous/next viewer buttons.
- Trap focus in the viewer and restore focus on close.
- Make activation behavior obvious without keyboard knowledge.
- Confirm color contrast for overlays and selected/focused states.
- Provide reduced-motion-friendly transitions.

## Performance Problems

### The Route Loader Sends Too Much Media Data

The gallery route loads a full library snapshot for the current path/search state. For the archive
root, the current query can return all non-deleted media entries. For nested paths without a search,
the query fetches all descendant media under the current path, then the client filters down to direct
children when recursive mode is off. This means a non-recursive folder view can still pay recursive
data costs.

Impact:

- Slow initial page loads for large archives.
- Large server responses and hydration payloads.
- Extra client memory and CPU for data that may not be visible.
- Higher cost when returning to common parent folders.

Needed improvements:

- Query direct children only when recursive mode is off.
- Make recursive mode part of the loader input instead of only client state.
- Add pagination or cursor-based loading for media rows.
- Return count summaries separately from full item records.

### DOM Virtualization Does Not Solve Data-Scale Costs

`BrowserGrid` only renders a window of cards, which helps DOM and image work. However, sorting,
filtering, comic grouping, selection, and thumbnail URL handling still operate on the full media
array delivered to the client. Large folders will still get expensive even if only a few cards are in
the DOM.

Impact:

- Recursive folders and search results can cause expensive client-side array work.
- Comic grouping over many images can block the main thread.
- Random sort and repeated mode toggles recalculate large lists.
- Mobile devices pay this cost with less CPU and memory headroom.

Needed improvements:

- Push filtering and ordering into server queries where possible.
- Cache or precompute comic groups for stable folders.
- Use server-driven windows for very large folders.
- Consider a web worker for heavy client-side grouping if grouping must remain local.

### Search Is Broad and Unpaginated

Search uses case-insensitive path and filename matching and returns matching folders and media in a
single snapshot. There is no limit, ranking, paging, or type filter. On large archives, broad queries
can produce very large responses and poor mobile interactions.

Impact:

- Common terms can return too much data.
- Search can be slow at the database and browser layers.
- Results are difficult to scan on mobile without labels or a list mode.

Needed improvements:

- Add result limits and pagination.
- Add indexes suitable for the chosen search behavior.
- Consider a dedicated search endpoint with ranked results.
- Provide filters for media type and folder scope.

### Thumbnail Generation Can Cause Cold-Scroll Spikes

Pane View generates thumbnails and video posters on demand. This is operationally simple and cache
friendly once derivatives exist, but first visits to large folders can trigger many thumbnail
requests at once. While concurrency is guarded in the thumbnail table, the user can still see many
pending or failed previews during cold browsing.

Impact:

- Slow perceived load during first browse after sync.
- Server CPU and object-storage pressure from bursts of image/video derivative work.
- More visible pain on mobile networks.
- Video poster generation is especially expensive because it involves ffmpeg work.

Needed improvements:

- Pre-warm common thumbnail sizes during or after sync.
- Limit concurrent derivative work per process and per account/library.
- Prioritize visible rows before overscan rows.
- Add better pending/error states in the grid.
- Track thumbnail generation latency and failure rate.

### Image Loading Strategy Is Basic

Posters use native lazy loading, which is useful, but there is no explicit responsive image sizing,
fetch priority strategy, or prefetching of likely next items. The grid always asks for the 320px
thumbnail route when a ready URL is not in the snapshot, regardless of actual card size or device
pixel ratio.

Impact:

- Some mobile screens may download more image data than needed.
- Larger displays may show soft thumbnails or trigger avoidable original loads if thumbnails are not
  ready.
- Adjacent viewer navigation can feel slower because originals are not prefetched.

Needed improvements:

- Choose thumbnail size based on rendered card width and device pixel ratio.
- Use `srcset` or explicit size selection for ready derivatives.
- Prefetch adjacent viewer originals cautiously, especially on Wi-Fi.
- Avoid falling back to originals for grid previews except as an intentional degraded mode.

### Video Viewer Preloads Aggressively

The modal video element uses `preload="auto"`. That can improve playback start, but it is expensive
for mobile data and can be wasteful when a user is paging quickly through videos.

Impact:

- High bandwidth use on mobile.
- Potentially slower navigation when large videos start loading immediately.
- More pressure on signed original delivery and object storage.

Needed improvements:

- Use mobile-aware preload behavior, such as `metadata` by default.
- Allow user preference for eager video loading.
- Add poster-first video loading when previews are ready.
- Preserve range-request-friendly original delivery.

### Large Original Images Load Directly in the Viewer

The image viewer points directly at the original media route. That preserves fidelity, but very large
images can be expensive on mobile, both in transfer size and decode memory.

Impact:

- Slow first display for high-resolution images.
- Browser memory pressure and potential tab reloads on mobile.
- Poor experience when paging quickly through large originals.

Needed improvements:

- Add web-sized preview derivatives separate from grid thumbnails.
- Load a preview first, then allow full original on demand.
- Limit concurrent original image loads when stepping through items.
- Consider zoom controls that request the original only when needed.

### Database Queries Need Scaling Review

The library snapshot reads folders, media rows joined to media objects and thumbnails, root folders,
and all folders on each load. This is straightforward and maintainable, but it may not hold up for a
large archive without stronger indexes, limits, and cache strategy.

Impact:

- Repeated navigation can run multiple broad queries.
- `allFolders` is fetched even when most views only need a subset.
- Folder counts and tree state may become stale or expensive to compute if maintained poorly.

Needed improvements:

- Audit indexes for `parentPath`, `logicalPath`, `deletedAt`, `filename`, and thumbnail lookup.
- Cache stable folder trees or fetch them independently from media windows.
- Avoid fetching `allFolders` for views that do not need comic grouping.
- Add metrics for query timing and result size.

### Client State Persistence Is Local-Only

Viewer and gallery state use local storage for preferences such as volume, last path, mode, sort, and
selected item. This is fast, but it does not support cross-device continuity and can become awkward
on mobile where the same archive is used across phone, tablet, and desktop.

Impact:

- Mobile users lose context when switching devices.
- Local storage writes can fail silently in private or constrained browser modes.
- There is no server-side source for resume state despite planned reading/video resume features.

Needed improvements:

- Store important resume state server-side by user/device.
- Keep local storage as an optimistic cache.
- Add explicit handling for unavailable storage.

## Cross-Cutting Measurement Gaps

The current code has implementation-level tests and operational runbooks, but the product problems
above need measurement to avoid guessing.

Recommended measurements:

- Route loader response size and timing by path, query, and recursive mode.
- Database query timing and row counts.
- Client hydration time and memory for large folders.
- Scroll FPS and long tasks on mobile viewports.
- Thumbnail request count, generation latency, and failure rate.
- Original media transfer size in viewer sessions.
- Mobile task completion checks for search, folder navigation, opening media, and closing the
  viewer.

## Suggested Priority

1. Fix mobile activation, search access, visible labels, and viewer controls. These directly affect
   whether Pane View is usable on the devices it exists to serve.
2. Move recursive/direct filtering into the loader and add paging or server-windowing for large
   folders. This addresses the biggest performance mismatch.
3. Add thumbnail pre-warming and better pending/error states. This improves first-browse perception
   after sync.
4. Add preview derivatives for large originals and mobile-aware video preload. This lowers mobile
   bandwidth and memory pressure.
5. Add instrumentation before deeper optimization. Performance work should be guided by real archive
   sizes, row counts, device profiles, and network behavior.
