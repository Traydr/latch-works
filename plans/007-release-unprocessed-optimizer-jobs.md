# Plan 007: Release Unprocessed Optimizer Jobs

> **Executor instructions**: Run the drift check first. Keep optimizer processing
> sequential; this plan only releases jobs that were claimed but not processed.
> Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 027d48a..HEAD -- apps/media-optimizer/src/processor.ts apps/media-optimizer/src/pane-view-client.ts apps/media-optimizer/src/processor.test.ts apps/pane-view/src/server/media/optimizer-jobs-service.ts apps/pane-view/src/server/media/derivative-queue.ts`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-add-github-actions-verification-baseline.md
- **Category**: bug
- **Planned at**: commit `027d48a`, 2026-06-23

## Why This Matters

Media Optimizer claims jobs in batches and processes them sequentially. If a
batch exits early, unprocessed claimed jobs remain `processing` until lease
expiry even though Pane View already has a release endpoint for this exact case.
Releasing remaining jobs lowers user-visible pending time after interruptions.

## Current State

- `apps/media-optimizer/src/processor.ts:13-18` imports `claimJobs`,
  `reportComplete`, and `reportFailure`, but not `releaseJobs`.
- `processor.ts:210-253` claims a batch and loops over every job sequentially.
- `pane-view-client.ts:100-118` exports `releaseJobs`, but grep found no call
  sites besides the export.
- `apps/pane-view/src/server/media/derivative-queue.ts:174-177` documents that
  release returns leased rows to `pending` without incrementing attempts.

## Commands You Will Need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Optimizer tests | `pnpm --filter @latch-works/media-optimizer test -- processor` | exit 0 |
| Typecheck | `pnpm --filter @latch-works/media-optimizer typecheck` | exit 0 |

## Scope

**In scope**:
- `apps/media-optimizer/src/processor.ts`
- `apps/media-optimizer/src/processor.test.ts`

**Out of scope**:
- Changing claim chunk size or processing concurrency.
- Changing Pane View release route semantics.
- Changing retry/attempt budgets.

## Git Workflow

- Branch: `advisor/007-release-optimizer-jobs`
- Commit message: `Release unprocessed optimizer jobs`

## Steps

### Step 1: Add Failing Processor Tests

Mock `claimJobs`, `reportComplete`, `reportFailure`, and `releaseJobs`. Add a
test where `claimJobs` returns three video jobs and processing throws or stops
after the first job. Assert `releaseJobs` is called with the two unprocessed job
ids/sizes and the same processing token.

Also add a success test asserting `releaseJobs` is not called when all claimed
jobs are processed.

**Verify**: `pnpm --filter @latch-works/media-optimizer test -- processor` -> new release test fails before implementation.

### Step 2: Track Remaining Jobs

In `processBatch`, after each claim, keep a mutable `remainingJobs` array. Before
processing each job, remove it from the remaining list only after the job is
about to be handled or immediately after it completes. The invariant should be:
`remainingJobs` contains only jobs that have not had `processJob` or
`reportFailure` attempted.

**Verify**: `pnpm --filter @latch-works/media-optimizer typecheck` -> exits 0.

### Step 3: Release In A Finally Block

Wrap the per-batch `for` loop in `try/finally`. In `finally`, call
`releaseJobs({ jobs: remainingJobs.map(({ mediaObjectId, size }) => ({ mediaObjectId, size })), processingToken })`.
Log release failures with `logOptimizerError` but do not mask the original
processing error.

**Verify**: `pnpm --filter @latch-works/media-optimizer test -- processor` -> all processor tests pass.

## Test Plan

- New test: early batch exit releases unprocessed jobs.
- New test: fully processed batch does not release anything.
- Existing processor tests should keep passing.

## Done Criteria

- [ ] `releaseJobs` is imported and called only for unprocessed claimed jobs.
- [ ] Release failures are logged and do not corrupt result counts.
- [ ] Focused tests and typecheck exit 0.
- [ ] `plans/README.md` status row updated.

## STOP Conditions

- Tests reveal `processBatch` is expected to propagate no errors at all.
- Release requires changing Pane View API shape.
- Correct implementation would require parallel processing.

## Maintenance Notes

- Reviewers should check that processed-but-failed jobs are not released after
  they have already been reported via `reportFailure`.
