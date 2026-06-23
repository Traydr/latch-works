# Plan 013: Debounce Gather Box Last-Run Persistence

> **Executor instructions**: Run the drift check first. Keep final last-run state
> durable after success/failure. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 027d48a..HEAD -- apps/gather-box/src/shared/gather-controller.ts apps/gather-box/src/shared/last-run.ts apps/gather-box/src/shared/*.test.ts apps/gather-box/src/**/*.test.ts`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-add-github-actions-verification-baseline.md
- **Category**: perf
- **Planned at**: commit `027d48a`, 2026-06-23

## Why This Matters

Gather Box logs one or more messages per downloaded file. Each log line currently
persists the full accumulated last-run log to `chrome.storage.local`, producing
quadratic serialization and extension storage writes on large galleries.

## Current State

- `gather-controller.ts:721-725` pushes a log entry and calls
  `void this.persistLastRun({})` every time.
- `gather-controller.ts:744-757` rebuilds the full `LastRunState`, including
  `log: this.logEntries`, and calls `saveLastRun`.
- `last-run.ts:51-52` writes the normalized full state to `chrome.storage.local`.
- Gather Box currently has very limited tests; `download-policy.test.ts` is the
  main shared test example.

## Commands You Will Need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Gather Box tests | `pnpm --filter @latch-works/gather-box test` | exit 0 |
| Typecheck | `pnpm --filter @latch-works/gather-box typecheck` | exit 0 |
| Build | `pnpm --filter @latch-works/gather-box build` | exit 0 |

## Scope

**In scope**:
- `apps/gather-box/src/shared/gather-controller.ts`
- New or existing Gather Box tests for persistence scheduling

**Out of scope**:
- Rewriting collectors.
- Changing last-run schema.
- Removing log restore behavior.

## Git Workflow

- Branch: `advisor/013-gather-box-last-run-debounce`
- Commit message: `Debounce Gather Box last-run persistence`

## Steps

### Step 1: Add A Persistence Scheduler

Inside `GatherController`, add a small debounce helper: `schedulePersistLastRun`,
`flushPersistLastRun`, and `clearPersistTimer` as private methods. Use a short
delay such as 500 ms. The scheduled flush should call the existing
`persistLastRun({})`.

**Verify**: `pnpm --filter @latch-works/gather-box typecheck` -> exits 0.

### Step 2: Replace Per-Log Writes With Scheduled Writes

Change `appendLog` to call `schedulePersistLastRun()` instead of
`persistLastRun({})`. At terminal points where a download succeeds, fails, or a
retry completes, call `await flushPersistLastRun()` after the final state patch
so the last state is durable before the UI returns to idle.

**Verify**: `pnpm --filter @latch-works/gather-box test` -> existing tests pass.

### Step 3: Add Tests With Fake Timers

Add tests that instantiate the persistence scheduler or controller with mocked
`saveLastRun`. Assert multiple log appends within the debounce window produce one
storage write, and `flushPersistLastRun` writes immediately.

**Verify**: `pnpm --filter @latch-works/gather-box test` -> all tests pass.

## Test Plan

- Fake-timer test for coalesced log writes.
- Flush test for final state durability.
- Build test for extension bundle.

## Done Criteria

- [ ] `appendLog` no longer writes to storage on every log line.
- [ ] Final success/failure/retry states still flush to storage.
- [ ] Gather Box tests, typecheck, and build exit 0.
- [ ] `plans/README.md` status row updated.

## STOP Conditions

- Controller construction is too DOM-bound to test without large rewrites.
- Debouncing risks losing final failed-item state and no safe flush point exists.

## Maintenance Notes

- If last-run logs become large again, consider persisting only a bounded tail;
  do not reintroduce per-line full-state writes.
