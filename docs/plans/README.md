# Improvement plan index

Generated from the deep repository survey at commit `fd5693d` on 2026-07-13. Every plan is written
for an implementation agent and begins with a drift check. Status changes belong in this index and
the corresponding plan.

## Recommended execution order

| Plan | Outcome | Priority | Effort | Depends on | Status |
|---|---|---:|---:|---|---|
| [024](024-exclude-pnpm-store-from-biome.md) | Make root Biome checks checkout-local | P1 | S | — | TODO |
| [025](025-repair-drizzle-snapshot-baseline.md) | Restore a current Drizzle snapshot baseline | P1 | M | — | TODO |
| [026](026-attest-sync-uploads.md) | Verify uploaded bytes before DB registration | P1 | M | — | TODO |
| [027](027-preserve-terminal-sync-status.md) | Make sync-run terminal states immutable | P1 | S | — | TODO |
| [028](028-drain-thumbnail-batches.md) | Resolve every thumbnail beyond the 48-item batch | P1 | S | — | TODO |
| [029](029-atomic-folder-subtree-delete.md) | Delete folder selections in one transaction | P1 | S | — | TODO |
| [030](030-serialize-sync-and-hard-wipe.md) | Make sync/hard-wipe exclusion race-free | P1 | M | 025 | TODO |
| [031](031-abort-degraded-frame-index-scan.md) | Prevent failed index batches from finishing scans | P1 | S–M | — | TODO |
| [032](032-serialize-gather-last-run-writes.md) | Prevent stale extension state saves | P2 | S | — | TODO |
| [033](033-reunify-frame-media-domain.md) | Reuse shared media/path semantics in Frame | P2 | M | — | TODO |
| [034](034-virtualize-pdf-pages.md) | Bound Pane PDF rendering work | P2 | M | — | TODO |
| [035](035-parallelize-archive-scan.md) | Add bounded scan/stat/hash concurrency | P2 | M | — | TODO |
| [036](036-pipeline-lockstep-uploads.md) | Add bounded parallel Lockstep uploads | P2 | L | 026 | TODO |
| [037](037-batch-sync-registration.md) | Batch server registration and ancestor writes | P3 | L | 026, 030, 036 | TODO |
| [038](038-avoid-repeating-comic-folder-tree.md) | Fetch comic folder structure once per browse key | P2 | M | — | TODO |
| [039](039-reconcile-shutter-docs.md) | Make docs match Shutter and current scripts | P1 | M | — | TODO |
| [040](040-frame-view-pdf-spike.md) | Validate and specify Frame PDF reading | P2 | M spike | 033, 034 | TODO |

Plans without dependencies can run in parallel. Within the dependent chain, execute `025 -> 030`,
`026 -> 036`, then `026 + 030 + 036 -> 037`. Run the PDF direction spike only after Plans 033 and
034 establish the shared media model and bounded PDF rendering contract.

## Finding coverage

The requested findings map as follows: 2 -> 026, 4 -> 031, 5 -> 027, 6 -> 028, 7 -> 029,
8 -> 030, 10 -> 025, 11 -> 024, 13 -> 034, 14 -> 035, 15 -> 036, 16 -> 037, 17 -> 038,
18 -> 032, 20 -> 033, and 22 -> 039. Direction 1 maps to 040.

Finding 11 is machine-dependent rather than speculative: root Biome configuration explicitly walks
the repository but does not exclude `.pnpm-store`, while `.gitignore` alone does not prevent that
traversal. A checkout with a local pnpm store therefore lints cached package contents; Plan 024 adds
the narrow exclusion and a regression check without hiding other dot-directories.

## Historical and rejected work

- [023: Gallery performance audit](023-gallery-performance-audit.md) — **REJECTED / superseded**.
  Its stored-derivative and prewarming recommendations predate the controlling Shutter-only
  architecture. Re-measure gallery queries before reviving any still-relevant index idea.
- Deleting source objects during ordinary soft deletion — rejected because immutable source retention
  is an explicit recovery property; hard wipe is the destructive boundary.
- Hashing every file during prune — rejected because prune deliberately relies on the indexed
  path/size/mtime fingerprint and avoids source reads.
- Following symlinks or indexing non-regular files — rejected because selected-root containment and
  predictable local-file semantics are intentional safety constraints.
- Pane-owned rendition prewarm/worker queues — rejected because Shutter is the sole rendition provider.

## Status vocabulary

- **TODO**: ready for an executor after dependencies and drift check.
- **IN PROGRESS**: branch exists and implementation has begun.
- **BLOCKED**: a named STOP condition or dependency prevents safe progress.
- **DONE**: all plan gates and done criteria are satisfied.
- **REJECTED**: evidence or architecture superseded the proposal; retain the record for context.
