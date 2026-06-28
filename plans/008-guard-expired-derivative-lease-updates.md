# Plan 008: Guard Expired Derivative Lease Updates

> **Executor instructions**: Run the drift check first. Match the existing queue
> guard pattern exactly. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat d8f3c52..HEAD -- apps/pane-view/src/server/media/derivative-service.ts apps/pane-view/src/server/media/derivative-service.test.ts apps/pane-view/src/server/media/derivative-queue.ts apps/pane-view/src/server/media/derivative-queue.test.ts`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-add-github-actions-verification-baseline.md
- **Category**: bug
- **Planned at**: commit `d8f3c52`, 2026-06-28

## Why This Matters

`ensureThumbnailDerivativeForContext` requeues expired `processing` rows, but its
update predicate does not re-check that the row is still expired and processing.
A concurrent optimizer completion can set a row to `ready` between the read and
update; the current update can overwrite it back to `pending`.

## Current State

- `derivative-service.ts:210-214` reads an existing thumbnail row.
- `derivative-service.ts:226-242` detects expired `processing` rows and updates
  with a predicate containing only `mediaObjectId` and `size`.
- `derivative-queue.ts:371-394` shows the safer pattern: include
  `eq(thumbnails.status, "processing")` and `lte(thumbnails.updatedAt, leaseExpiry)`.

## Commands You Will Need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Focused tests | `pnpm --filter @latch-works/pane-view test -- derivative-service derivative-queue` | exit 0 |
| Typecheck | `pnpm --filter @latch-works/pane-view typecheck` | exit 0 |

## Scope

**In scope**:
- `apps/pane-view/src/server/media/derivative-service.ts`
- `apps/pane-view/src/server/media/derivative-service.test.ts`

**Out of scope**:
- Changing derivative lease duration.
- Changing `claimDerivativeJobs` semantics.
- Changing optimizer wake behavior.

## Git Workflow

- Branch: `advisor/008-derivative-lease-update-guard`
- Commit message: `Guard expired derivative lease update`

## Steps

### Step 1: Add A Race-Guard Test

Add a test around `ensureThumbnailDerivativeForContext` showing that the expired
processing update includes status and lease-expiry predicates. If current tests
mock Drizzle calls rather than executing SQL, assert the where-clause builder
receives `status = processing` and `updatedAt <= now - derivativeProcessingLeaseMs`.

**Verify**: `pnpm --filter @latch-works/pane-view test -- derivative-service` -> new test fails before implementation.

### Step 2: Narrow The Update Predicate

In `derivative-service.ts`, compute the same lease cutoff used by
`isDerivativeProcessingLeaseExpired` or import/reuse a helper if one exists.
Change the expired-processing update so `.where(and(...))` includes:

```ts
eq(thumbnails.status, "processing")
lte(thumbnails.updatedAt, new Date(Date.now() - derivativeProcessingLeaseMs))
```

Do not remove the existing `mediaObjectId` and `size` predicates.

**Verify**: `pnpm --filter @latch-works/pane-view typecheck` -> exits 0.

### Step 3: Handle No-Op Update Cleanly

If the narrowed update returns no rows, treat the derivative as `pending` rather
than generating inline or waking the optimizer again from stale state. Preserve
current behavior for rows that still match.

**Verify**: `pnpm --filter @latch-works/pane-view test -- derivative-service derivative-queue` -> exits 0.

## Test Plan

- Add one test for the expired-processing requeue predicate.
- Keep existing ready/pending/failed derivative-service tests passing.

## Done Criteria

- [ ] Expired processing update includes status and lease-expiry guards.
- [ ] Ready rows cannot be overwritten by the stale requeue path.
- [ ] Focused tests and typecheck exit 0.
- [ ] `plans/README.md` status row updated.

## STOP Conditions

- `derivativeProcessingLeaseMs` is not accessible without creating a circular import.
- Tests show this path intentionally requeues any row regardless of status.
- Fix requires changing DB schema.

## Maintenance Notes

- Any future derivative queue update that follows read-then-update should use a
  compare-and-set predicate, not only the primary key.
