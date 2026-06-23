# Plan 010: Make Archive Hash Cancellation Immediate

> **Executor instructions**: Run the drift check first. Preserve scan result
> ordering. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 027d48a..HEAD -- packages/media-index/src/scan.ts packages/media-index/src/scan.test.ts packages/lockstep-core/src/sync-cancellation.test.ts packages/lockstep-core/src/remote-api.ts`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-add-github-actions-verification-baseline.md
- **Category**: bug, dx
- **Planned at**: commit `027d48a`, 2026-06-23

## Why This Matters

Lockstep plan/push cancellation checks the abort signal between files, but the
current `scanArchive` hash stream ignores abort while reading a large file. A
cancelled scan can continue hashing multi-GB media until the active stream ends.

## Current State

- `packages/media-index/src/scan.ts:51-72` defines private `hashFile` with no
  `AbortSignal` parameter and no abort listener.
- `scan.ts:90-95` checks `throwIfAborted(signal)` before directories and file
  entries.
- `scan.ts:144-156` calls `hashFile` without passing `signal`.
- `packages/lockstep-core/src/remote-api.ts:45-55` shows the desired pattern:
  reject if already aborted, register an abort listener, destroy the stream, and
  remove the listener on end.

## Commands You Will Need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Media index tests | `pnpm --filter @latch-works/media-index test` | exit 0 |
| Lockstep tests | `pnpm --filter @latch-works/lockstep-core test -- sync-cancellation` | exit 0 |
| Typecheck | `pnpm --filter @latch-works/media-index typecheck` | exit 0 |

## Scope

**In scope**:
- `packages/media-index/src/scan.ts`
- `packages/media-index/src/scan.test.ts`
- `packages/lockstep-core/src/sync-cancellation.test.ts` only if integration
  coverage is straightforward

**Out of scope**:
- Parallelizing scan/hashing. This plan only improves cancellation.
- Changing progress event shapes.
- Changing scan ordering.

## Git Workflow

- Branch: `advisor/010-cancellable-scan-hash`
- Commit message: `Make archive hashing cancellable`

## Steps

### Step 1: Add A Cancellable Hash Test

Create a test that starts `scanArchive({ hashFiles: true, signal })` on a fixture
file and aborts while hashing. If real timing is flaky, mock `createReadStream`
or factor a small stream-hashing helper that accepts a `Readable` in tests.
Assert the promise rejects with the abort reason and does not emit completion.

**Verify**: `pnpm --filter @latch-works/media-index test -- scan` -> new test fails before implementation.

### Step 2: Pass AbortSignal Into hashFile

Change `hashFile` to accept `signal?: AbortSignal`. Before opening the stream,
reject if `signal.aborted`. Register an abort listener that destroys the stream
with the abort reason. Remove the listener on `end` and `error`.

**Verify**: `pnpm --filter @latch-works/media-index typecheck` -> exits 0.

### Step 3: Wire scanArchive To The Helper

Pass `signal` from `scanArchive` into `hashFile` at the existing call site. Keep
all progress payload fields unchanged.

**Verify**: `pnpm --filter @latch-works/media-index test && pnpm --filter @latch-works/lockstep-core test -- sync-cancellation` -> exits 0.

## Test Plan

- Unit test: abort during hash rejects promptly.
- Regression test: normal hash still returns the known sha256.
- Existing scan skipped-file tests continue to pass.

## Done Criteria

- [ ] `hashFile` accepts and honors `AbortSignal`.
- [ ] Aborting destroys the active read stream.
- [ ] Progress event shape is unchanged.
- [ ] Focused tests and typecheck exit 0.
- [ ] `plans/README.md` status row updated.

## STOP Conditions

- Testing requires changing public `scanArchive` API beyond existing options.
- Abort support changes scan result order or item ids.
- Node stream behavior makes the test flaky twice in a row.

## Maintenance Notes

- If Plan 014 or a future concurrency plan parallelizes hashing, preserve this
  per-stream abort behavior for every worker.
