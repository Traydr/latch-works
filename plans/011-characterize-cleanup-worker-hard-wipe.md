# Plan 011: Characterize Cleanup Worker Hard Wipe

> **Executor instructions**: Run the drift check first. This is a test plan for a
> destructive state machine; do not change behavior unless tests expose a small
> obvious bug. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat d8f3c52..HEAD -- apps/pane-view/src/server/management/cleanup-worker.ts apps/pane-view/src/server/management/*.test.ts apps/pane-view/src/server/db/schema.ts`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/001-add-github-actions-verification-baseline.md
- **Category**: tests
- **Planned at**: commit `d8f3c52`, 2026-06-28

## Why This Matters

The cleanup worker deletes thumbnails, originals, orphan storage objects, and
then hard-deletes library database rows. It is the most destructive Pane View
maintenance path and currently lacks direct tests. Characterization tests should
land before any cleanup or orphan-prune feature work.

## Current State

- `cleanup-worker.ts:24-25` has module-level `resumeStarted` and `runningJobs`.
- `cleanup-worker.ts:101-112` self-reschedules after a duration budget.
- `cleanup-worker.ts:141-282` implements phases: `s3_derivatives`,
  `s3_originals`, `s3_orphan_sweep`, and `db_hard_delete`.
- `cleanup-worker.ts:276-282` deletes favorites, viewer state, sync run items,
  sync runs, library entries, folders, and media objects.
- Existing management tests cover folder delete, thumbnail purge, library wipe,
  guards, and sync-run control, but no `cleanup-worker.test.ts` exists.

## Commands You Will Need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Management tests | `pnpm --filter @latch-works/pane-view test -- cleanup-worker management` | exit 0 |
| Typecheck | `pnpm --filter @latch-works/pane-view typecheck` | exit 0 |

## Scope

**In scope**:
- `apps/pane-view/src/server/management/cleanup-worker.test.ts` (create)
- `apps/pane-view/src/server/management/cleanup-worker.ts` only for test seams
  such as exported reset hooks or injectable batch processing

**Out of scope**:
- New orphan prune feature.
- Changing hard-wipe semantics.
- Changing management UI.

## Git Workflow

- Branch: `advisor/011-cleanup-worker-tests`
- Commit message: `Add cleanup worker characterization tests`

## Steps

### Step 1: Add Test Seams Safely

If needed, export `processMaintenanceJobBatch` and a test-only reset helper for
`resumeStarted`/`runningJobs`. Keep production behavior unchanged. Name the reset
helper with `ForTests` to match existing repo conventions like
`resetLoginThrottleForTests`.

**Verify**: `pnpm --filter @latch-works/pane-view typecheck` -> exits 0.

### Step 2: Mock DB And Storage

Follow patterns from existing management tests. Mock `db.select/update/delete`
and `@latch-works/media-storage` functions `deleteStoredObjectsBatch` and
`listStoredObjectsByPrefix`. Do not connect to real Postgres or S3.

**Verify**: `pnpm --filter @latch-works/pane-view test -- cleanup-worker` -> test harness compiles.

### Step 3: Cover Each Phase

Add tests for:

- `s3_derivatives`: deletes returned thumbnail object keys, deletes thumbnail
  rows, advances processed/error counts.
- `s3_originals`: deletes media object keys and rows, then advances to orphan sweep
  when empty.
- `s3_orphan_sweep`: paginates continuation tokens, advances prefixes, and then
  moves to `db_hard_delete`.
- `db_hard_delete`: deletes dependent tables before media objects and marks the
  job completed.

**Verify**: `pnpm --filter @latch-works/pane-view test -- cleanup-worker` -> exits 0.

## Test Plan

- New `cleanup-worker.test.ts` with phase-by-phase characterization.
- Existing `library-wipe.test.ts` should still pass.
- No real S3, filesystem, or database operations.

## Done Criteria

- [ ] Cleanup worker has direct tests for every phase.
- [ ] Module-level state can be reset between tests.
- [ ] No cleanup behavior changed except test seams.
- [ ] Focused tests and typecheck exit 0.
- [ ] `plans/README.md` status row updated.

## STOP Conditions

- Testing requires running real local services.
- Adding a test seam would expose production-only APIs publicly outside the
  module in an unsafe way.
- You discover a destructive behavior bug; write it down and stop unless the fix
  is a one-line guard with an obvious test.

## Maintenance Notes

- Future scoped orphan-prune work should extend these tests rather than creating
  a parallel cleanup harness.
