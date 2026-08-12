# ADR 0002: Queue collected Gather Outputs

- **Status**: Accepted
- **Date**: 2026-08-12
- **Decision owners**: Latch Works maintainers

## Context

ADR 0001 moved Gather execution out of the side panel, but retained a profile-wide lock that
rejected a new gather intent while any output was being written. Local AVIF conversion can take
several seconds per image, forcing browsing to pause even though the current source page is no
longer needed after collection returns its URLs and archive metadata.

The extension service worker can also be suspended, so an in-memory promise chain is not sufficient
queue state. Running multiple output jobs concurrently would increase memory and CPU pressure and
could allow expensive AVIF encodes to compete.

## Decision

Gather Box stores collected outputs in a versioned, profile-local FIFO queue. A gather intent first
captures the exact source tab. When capture succeeds, Gather Box persists the complete Gather
Output and the execution settings that apply to it, acknowledges the queue position, and no longer
depends on the source tab.

The offscreen document executes one output at a time. Downloads retain their existing bounded
per-file fetch concurrency, while media conversions and filesystem commits remain serialized.
Queue state and the currently displayed run are separate persisted views: the queue is
authoritative for scheduling, and the displayed run is an adapter for the side panel's existing
progress interface.

If Chrome restarts without an active offscreen executor, fully collected jobs that were preparing or
writing return to the front of the queue. Collision-safe writes make replay safe. A job interrupted
while its collector still depended on page DOM is marked interrupted because it has no complete
Gather Output to replay.

Folder permission remains a visible-user responsibility. A permission-required job pauses the FIFO
queue until access is confirmed or the job is cancelled.

## Consequences

- People can continue browsing as soon as Gather Box reports that a page is queued.
- A queue can contain up to 100 collected outputs; the cap keeps `chrome.storage.local` use bounded.
- AVIF work remains resource-bounded because only one Gather Output executes at a time.
- Cancelling an executing job aborts it promptly; the offscreen executor does not start the next
  dispatched job until the cancelled work has unwound.
- Settings are snapshotted per collected output, so later settings changes affect new queue entries.
- Queue recovery can repeat a partially written output, relying on existing identical-file and
  converted-target checks to avoid clobbering archive files.

## Alternatives rejected

### Run every gather intent concurrently

Rejected because CPU-heavy conversion, large blobs, and filesystem work would compete and make
performance less predictable.

### Queue only source tab identifiers

Rejected because tabs can navigate or close before their job reaches the front. The replayable thing
is the collected Gather Output, not the page identity.

### Use `chrome.downloads`

Rejected for the reason recorded in ADR 0001: it cannot preserve Gather Box's selected archive root
and File System Access behavior.
