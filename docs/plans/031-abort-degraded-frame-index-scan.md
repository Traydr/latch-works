# Plan 031: Prevent degraded Frame View scans from finalizing the index

> **Executor instructions**: Preserve gallery batch delivery but never mark a partially persisted
> durable index as complete. Run every verification and update the plan index.
>
> **Drift check (run first)**: `git diff --stat fd5693d..HEAD -- apps/frame-view/src/main/catalog/CatalogRuntime.ts apps/frame-view/src/main/db/mediaIndexService.ts apps/frame-view/tests/main/catalog/CatalogRuntime.test.ts`

## Status

- **Priority**: P1
- **Effort**: S-M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `fd5693d`, 2026-07-13
- **Original finding**: 4

## Why this matters

When a media-index batch fails, the runtime emits an error but later calls `finishScan`, which deletes
previous rows not tagged with the new scan ID and emits `done`. A transient persistence failure can
therefore destroy valid index coverage while the UI reports success. Gallery batches may remain
best-effort, but durable scan finalization must abort and retain the previous committed index.

## Current state

- `CatalogRuntime.flushIndexedBatch` ignores an error after emitting it.
- `CatalogRuntime.executeScan` always calls `finishScan` and emits `done` for an active run.
- `mediaIndexService.finishScan` deletes rows with another `lastSeenScanId`.
- Existing test “emits scan batches even when best-effort index upserts fail” currently expects
  `done`; replace that incorrect terminal expectation.
- Main-process APIs use `better-result`; preserve that convention.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused tests | `pnpm --filter @latch-works/frame-view test -- tests/main/catalog/CatalogRuntime.test.ts` | all pass |
| Frame check | `pnpm --filter @latch-works/frame-view check` | exit 0 |

## Scope

**In scope**: `CatalogRuntime.ts`, its focused test, and `mediaIndexService.ts` only if a distinct
failed scan status is required.

**Out of scope**: retrying SQLite writes; changing scan batching/performance; hiding in-memory gallery
items; rebuilding the database; thumbnail generation.

## Git workflow

- Branch: `codex/031-abort-degraded-frame-index-scan`
- Commit message: `Abort degraded media index scans`

## Steps

### Step 1: Record durable persistence failure in scan context

When `upsertBatch` fails, emit the existing error, mark durable persistence failed, and stop further
index writes. It is acceptable to continue emitting already-discovered gallery batches, but do not
call `finishScan` for that scan ID.

**Verify**: focused test injects a middle-batch failure and asserts `finishScan` is never called.

### Step 2: Terminate the durable scan honestly

Call `cancelScan` or add a `failScan` operation that marks the scan non-done without deleting previous
rows. Emit a terminal error/cancelled event consistent with existing contracts; do not emit a
successful `done` for the durable scan. If UI needs a terminal event to stop loading, include an
explicit degraded/failed terminal shape through the existing Zod IPC contract and tests.

**Verify**: tests assert old indexed rows are retained, terminal UI state is not stuck, and
`finishScan` failure itself is not reported as success.

## Test plan

Extend the injected `mediaIndexService` test double. Cover first, middle, and final batch failure;
`cancelScan` failure; `finishScan` failure; and the normal successful path.

## Done criteria

- [ ] No failed upsert scan calls destructive `finishScan`.
- [ ] Previously committed rows remain available.
- [ ] Renderer receives a terminal non-success state.
- [ ] Successful scans behave unchanged.
- [ ] Focused tests and Frame check pass.

## STOP conditions

- The renderer has no compatible terminal failure contract and changing it expands beyond the listed
  shared contract/test files.
- Retaining previous rows conflicts with an established catalog invariant.
- Fix requires deleting/rebuilding user index data.

## Maintenance notes

Treat scan finalization as a commit point: every batch must persist before stale rows may be removed.
Review future “best effort” changes against that invariant.

