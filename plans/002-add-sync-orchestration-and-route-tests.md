# Plan 002: Add Sync Orchestration And Route Tests

> **Executor instructions**: Follow this plan step by step. Run every
> verification command before moving on. Stop rather than improvising if drift is
> detected. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 027d48a..HEAD -- packages/lockstep-core/src apps/pane-view/src/routes apps/pane-view/src/server/sync`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/001-add-github-actions-verification-baseline.md
- **Category**: tests
- **Planned at**: commit `027d48a`, 2026-06-23

## Why This Matters

Lockstep push/prune is the write path into the remote archive, but the current
tests cover helpers rather than the orchestration loops and route wiring. Plans
003, 004, 014, and 015 all change this path, so characterization tests should
land first.

## Current State

- `packages/lockstep-core/src/push-changes.ts:86-167` loops over push items,
  tracks pushed/failed/cancelled counts, and finalizes `/api/sync/runs/:id/complete`.
- `packages/lockstep-core/src/prune-deleted.ts:83-157` mirrors that behavior for
  remote deletes.
- Existing `lockstep-core` tests are only `push-helpers.test.ts`,
  `scan-progress-coalescer.test.ts`, and `sync-cancellation.test.ts`.
- Grep found no Pane View tests importing `apps/pane-view/src/routes/*`.
- Route examples: `api.sync.runs.ts:14-22` loosely reads `counts/sourceRoot`,
  `api.sync.runs.$syncRunId.complete.ts:20-39` validates status and finalizes,
  and `api.sync.complete-object.ts` delegates upload/delete ingest.

## Commands You Will Need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Lockstep tests | `pnpm --filter @latch-works/lockstep-core test` | exit 0 |
| Pane View tests | `pnpm --filter @latch-works/pane-view test` | exit 0 |
| Typecheck | `pnpm --filter @latch-works/lockstep-core typecheck && pnpm --filter @latch-works/pane-view typecheck` | exit 0 |

## Scope

**In scope**:
- `packages/lockstep-core/src/push-changes.test.ts` (create)
- `packages/lockstep-core/src/prune-deleted.test.ts` (create)
- `apps/pane-view/src/routes/*.test.ts` for sync routes, or a colocated
  `apps/pane-view/src/server/sync/routes.test.ts` if route imports are easier
- Minimal exports/test seams needed to invoke route handlers

**Out of scope**:
- Behavior changes to push/prune/sync routes.
- Refactoring the sync API contracts. Plan 015 handles that.

## Git Workflow

- Branch: `advisor/002-sync-orchestration-route-tests`
- Commit message: `Add sync orchestration route tests`

## Steps

### Step 1: Test Lockstep Push Finalization

Create tests that `vi.mock("./remote-api.js")` for `postJson` and
`pushMediaItem`. Use a small `LockstepPlan` fixture with upload/update/delete
items. Assert:

- no changed items emits `complete` and does not create a sync run
- successful push creates a sync run, calls `pushMediaItem`, then finalizes with
  `status: "completed"`
- one item failure finalizes with `status: "failed"` and increments `failed`
- abort during an item finalizes with `status: "cancelled"` and rethrows abort

**Verify**: `pnpm --filter @latch-works/lockstep-core test -- push-changes` -> all new tests pass.

### Step 2: Test Lockstep Prune Finalization

Mirror Step 1 for `pruneDeleted`, mocking `deleteRemoteItem` and `postJson`.
Assert capped counts use `pushed: pruned` because that is the current API shape.

**Verify**: `pnpm --filter @latch-works/lockstep-core test -- prune-deleted` -> all new tests pass.

### Step 3: Test Pane View Sync Route Wiring

Import route modules and invoke their server `POST` handlers with constructed
`Request` objects. Mock `requireSyncApiToken`, `startSyncRun`,
`finalizeSyncRun`, `completeSyncedObject`, and `markRemoteDeleted`. Cover:

- `/api/sync/runs` passes `counts` and `sourceRoot` through
- `/api/sync/runs/$syncRunId/complete` rejects invalid status with 400
- `/api/sync/complete-object` routes `{ action: "delete" }` to `markRemoteDeleted`
- `/api/sync/complete-object` routes valid upload payload to `completeSyncedObject`
- unauthorized requests return the auth response without calling stores

**Verify**: `pnpm --filter @latch-works/pane-view test -- sync` -> all new tests pass.

## Test Plan

- Use existing Vitest style from `apps/pane-view/src/server/sync/store.test.ts`
  and `packages/lockstep-core/src/sync-cancellation.test.ts`.
- Keep mocks close to the real public function signatures.
- Verification: both focused test commands above and then `pnpm --filter @latch-works/pane-view test && pnpm --filter @latch-works/lockstep-core test`.

## Done Criteria

- [ ] Push orchestration has tests for success, failure, capped/no-op, and abort.
- [ ] Prune orchestration has tests for success, failure, capped/no-op, and abort.
- [ ] Pane View sync route handlers have auth and delegation tests.
- [ ] No production behavior changed.
- [ ] Focused test and typecheck commands exit 0.
- [ ] `plans/README.md` status row updated.

## STOP Conditions

- Route handlers cannot be imported without starting a server and no small test
  seam is obvious.
- Tests require a real database, S3, or network request.
- You discover existing behavior differs from the current-state excerpts.

## Maintenance Notes

- These tests are characterization. Keep assertions on current public behavior,
  not internal implementation ordering unless ordering is the behavior.
