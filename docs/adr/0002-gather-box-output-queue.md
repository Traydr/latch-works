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
per-file fetch concurrency, while media conversions and filesystem commits remain serialized. A run
reports itself finished only after its execution slot is released, because the background dispatches
the next output while handling that report and would otherwise be told the executor is still busy. One
persisted queue snapshot owns pending jobs and bounded terminal results. The side panel derives its
active progress, error report, and retry actions from that snapshot rather than persisting a second
run view.

If Chrome restarts without an active offscreen executor, fully collected jobs that were preparing or
writing return to the front of the queue. Collision-safe writes make replay safe. A job interrupted
while its collector still depended on page DOM is marked interrupted because it has no complete
Gather Output to replay.

Folder permission remains a visible-user responsibility. A permission-required job pauses the FIFO
queue until access is confirmed or the job is cancelled. Confirmation resumes the job by its saved
global or site-scoped destination, so the original source tab does not need to remain open.

Because only a gather intent carries the user activation that confirms folder access, confirmation
is a side effect of gathering some other page. That page is still collected and queued on its own —
resuming a paused job never consumes the intent for the tab in hand. A paused job reports which page
can confirm it, since a site-scoped destination can only be confirmed from that job's own site.

## Consequences

- People can continue browsing as soon as Gather Box reports that a page is queued.
- A queue can contain up to 100 collected outputs; the cap keeps `chrome.storage.local` use bounded.
- AVIF work remains resource-bounded because only one Gather Output executes at a time.
- Cancelling an executing job aborts it promptly; the offscreen executor does not start the next
  dispatched job until the cancelled work has unwound.
- Settings are snapshotted per collected output, so later settings changes affect new queue entries.
- Confirming folder access can start two jobs at once: the resumed one and the page it was confirmed
  from. Only one still executes at a time.
- Queue recovery can repeat a partially written output. A per-target commit marker identifies a
  canonical file that may be incomplete, allowing replay to repair that exact path instead of
  preserving corrupt bytes and writing a suffixed duplicate.

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
