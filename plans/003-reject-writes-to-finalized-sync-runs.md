# Plan 003: Reject Writes To Finalized Sync Runs

> **Executor instructions**: Follow this plan exactly. Run the drift check first
> and update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 8f19cd4..HEAD -- apps/pane-view/src/server/sync/store.ts apps/pane-view/src/server/sync/store.test.ts apps/pane-view/src/routes/api.sync.complete-object.ts`

## Status

- **Status**: DONE
- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/002-add-sync-orchestration-and-route-tests.md
- **Category**: bug
- **Planned at**: commit `8f19cd4`, 2026-07-05
- **Pull request**: https://github.com/Traydr/latch-works/pull/49
- **Merged**: 2026-07-05, merge commit `6d10563`
- **Verified**: GitHub `Check` passed on PR #49 and latest `main` check passed
  at https://github.com/Traydr/latch-works/actions/runs/28746243602

## Completion Notes

- Added the writable sync-run guard at the start of upload completion writes.
- Added regression coverage confirming finalized runs reject late object
  completion writes.
- The upload and delete paths now share the same finalized-run write policy.

## Why This Matters

`completeSyncedObject` currently mutates media objects, library entries, folders,
and sync-run items without checking whether the sync run is still writable. A
late upload completion after `finalizeSyncRun` can drift library state away from
the finalized run counts. The delete path already rejects this case, so this is
a consistency bug rather than a new policy decision.

## Current State

- `apps/pane-view/src/server/sync/store.ts:94` starts a transaction in
  `completeSyncedObject` and immediately upserts `mediaObjects`.
- `store.ts:152-167` inserts or updates `syncRunItems` for the run.
- `store.ts:214-215` calls `assertWritableSyncRun(tx, syncRunId)` in
  `markRemoteDeleted`.
- `store.ts:251-264` defines `assertWritableSyncRun`, which throws unless the
  run exists and has `status === "running"`.

## Commands You Will Need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Focused tests | `pnpm --filter @latch-works/pane-view test -- store` | exit 0 |
| Typecheck | `pnpm --filter @latch-works/pane-view typecheck` | exit 0 |

## Scope

**In scope**:
- `apps/pane-view/src/server/sync/store.ts`
- `apps/pane-view/src/server/sync/store.test.ts`
- Route tests from Plan 002 only if needed to cover HTTP status mapping

**Out of scope**:
- Changing sync-run status names.
- Changing Lockstep client retry behavior.
- Refactoring folder/media object upserts.

## Git Workflow

- Branch: `advisor/003-finalized-sync-run-guard`
- Commit message: `Reject finalized sync run writes`

## Steps

### Step 1: Add A Failing Store Test

In `store.test.ts`, add a test mirroring the existing delete-path non-running
sync run test. The test should call `completeSyncedObject` with a sync run whose
selected status is `completed` or `cancelled`, then assert it rejects with
`Sync run is not accepting writes.` and no upsert statements are executed after
the guard.

**Verify**: `pnpm --filter @latch-works/pane-view test -- store` -> the new test fails before the implementation change.

### Step 2: Guard The Upload Completion Transaction

In `completeSyncedObject`, add this as the first statement inside
`db.transaction(async (tx) => { ... })`:

```ts
await assertWritableSyncRun(tx, input.syncRunId);
```

Keep the helper private and reuse the exact delete-path behavior.

**Verify**: `pnpm --filter @latch-works/pane-view test -- store` -> all store tests pass.

### Step 3: Confirm Route Behavior

If Plan 002 route tests exist, add or update one case showing that a store
rejection from upload completion is not swallowed. Do not invent a new HTTP
contract unless the existing route already maps errors.

**Verify**: `pnpm --filter @latch-works/pane-view test -- sync` -> all route tests pass.

## Test Plan

- New store test: finalized run rejects `completeSyncedObject`.
- Existing delete finalized-run test remains the pattern.
- Verification: `pnpm --filter @latch-works/pane-view test -- store`.

## Done Criteria

- [x] `completeSyncedObject` calls `assertWritableSyncRun` before any upsert.
- [x] Upload and delete paths now enforce the same writable-run rule.
- [x] Focused tests and the GitHub `Check` workflow exited 0.
- [x] `plans/README.md` status row updated.

## STOP Conditions

- `assertWritableSyncRun` has moved or changed semantics.
- Tests show Lockstep intentionally sends completion calls after finalization.
- Fix requires changing sync API response shapes.

## Maintenance Notes

- Reviewers should confirm the guard runs inside the same transaction as the
  later writes.
