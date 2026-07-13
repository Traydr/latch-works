# Plan 032: Serialize and coalesce Gather Box last-run writes

> **Executor instructions**: Preserve the persisted `LastRunState` shape. Run every gate and update
> the plan index when complete.
>
> **Drift check (run first)**: `git diff --stat fd5693d..HEAD -- apps/gather-box/src/shared/gather-controller.ts apps/gather-box/src/shared/last-run.ts apps/gather-box/src/**/*.test.ts`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `fd5693d`, 2026-07-13
- **Original finding**: 18

## Why this matters

Every log append starts an unawaited whole-object storage write. Older saves can finish after newer
failure/retry state and overwrite it, so reopening Gather Box may lose retry availability. Writes
must be serialized and coalesced, with an explicit flush for terminal download state.

## Current state

- `gather-controller.ts:753-756` calls `void this.persistLastRun({})` for every log line.
- `persistLastRun` rebuilds and writes the complete state through `saveLastRun`.
- `last-run.ts:51-53` directly awaits `chrome.storage.local.set`.
- Gather Box uses 2-space formatting and colocated Vitest tests under `src/`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Tests | `pnpm --filter @latch-works/gather-box test` | all pass |
| Check | `pnpm --filter @latch-works/gather-box check` | exit 0 |

## Scope

**In scope**: `gather-controller.ts`, `last-run.ts`, and new focused tests such as
`last-run.test.ts`/`gather-controller.test.ts`.

**Out of scope**: changing storage key/schema; collector selectors; download concurrency; sidecar
manifests; UI redesign.

## Git workflow

- Branch: `codex/032-serialize-gather-last-run-writes`
- Commit message: `Serialize Gather Box last run persistence`

## Steps

### Step 1: Extract a serialized coalescing writer

Add a small testable queue that accepts immutable state snapshots, keeps at most one write in flight,
and replaces queued-but-not-started work with the newest snapshot. A failed write must not deadlock
later writes. Expose `flush()` to await the latest accepted snapshot.

**Verify**: unit tests with deferred storage promises prove max concurrency 1 and newest state wins
when completions are delayed.

### Step 2: Route controller persistence through the writer

Construct snapshots before enqueueing so later mutations cannot alter an in-flight value. Log saves
may remain fire-and-forget through the queue; terminal success/failure/retry updates must await
`flush()` before the operation reports completion or closes its running state.

**Verify**: controller test delays an older log save, records newer retry data, resolves out of order,
and asserts persisted `failedItems`, `retryImages`, and `canRetry` are current.

## Test plan

Mock `chrome.storage.local`. Cover rapid logs, terminal patch during in-flight save, write rejection,
flush with no work, flush during work, and a subsequent save after failure.

## Done criteria

- [ ] At most one last-run write is active.
- [ ] Newest accepted snapshot is ultimately persisted.
- [ ] Terminal retry state is flushed before completion.
- [ ] Persisted schema/key remains unchanged.
- [ ] Gather tests and check pass.

## STOP conditions

- Chrome storage requires concurrent writes for a documented reason.
- Correctness requires changing the persisted schema.
- Popup lifecycle prevents any reliable terminal flush; report the lifecycle limitation instead.

## Maintenance notes

Future persistent controller state should use the same queue rather than calling Chrome storage from
event/log handlers directly.

