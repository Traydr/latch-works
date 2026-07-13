# Plan 030: Serialize sync startup with hard-wipe scheduling

> **Executor instructions**: This is destructive-operation coordination. Use PostgreSQL-backed
> serialization, not process-local flags. Run migration tests and every gate. Update the index when
> complete.
>
> **Drift check (run first)**: `git diff --stat fd5693d..HEAD -- apps/pane-view/src/server/management/guards.ts apps/pane-view/src/server/management/library-wipe.ts apps/pane-view/src/server/sync/store.ts apps/pane-view/src/server/db/schema.ts apps/pane-view/drizzle`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: `docs/plans/025-repair-drizzle-snapshot-baseline.md`
- **Category**: bug
- **Planned at**: commit `fd5693d`, 2026-07-13
- **Original finding**: 8

## Why this matters

Sync startup and wipe scheduling perform independent check-then-act queries. Concurrent requests can
both pass, allowing uploads while destructive cleanup is deleting the library. Wipe DB mutation and
job insertion are also separate, so insertion failure can leave content hidden without a resumable
job. Coordination must work across server processes and transactions.

## Current state

- `management/guards.ts` reads running syncs and active cleanup jobs outside caller transactions.
- `library-wipe.ts:37-59` soft-deletes state in one transaction, then inserts the job afterward.
- `sync/store.ts:65-74` checks cleanup, then inserts a running sync separately.
- `.railway/railway.ts` currently deploys one replica, but correctness must not depend on that.
- Match existing Drizzle transaction/error conventions in `sync/store.ts`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Management tests | `pnpm --filter @latch-works/pane-view test -- src/server/management` | all pass |
| Sync tests | `pnpm --filter @latch-works/pane-view test -- src/server/sync/store.test.ts` | all pass |
| Pane check | `pnpm --filter @latch-works/pane-view check` | exit 0 |

## Scope

**In scope**: guards, wipe scheduler/tests, sync store/tests, maintenance-job schema, one generated
migration and snapshot, and a small shared DB-lock helper under `server/db/`.

**Out of scope**: cleanup worker phases; changing soft-vs-hard delete policy; cancelling active syncs
automatically; S3/Shutter purge order; multi-region job execution.

## Git workflow

- Branch: `codex/030-serialize-sync-and-hard-wipe`
- Commit message: `Serialize sync and library wipe startup`

## Steps

### Step 1: Add a shared transaction-scoped coordination lock

Create a helper accepting the transaction client and acquiring one stable PostgreSQL advisory
transaction lock for library-mutating operation startup. Use a fixed documented lock key; do not use
JavaScript `hashCode`, process mutexes, or session locks. Call it first inside both start transactions.

**Verify**: focused unit tests assert both paths call the same helper before their guard queries.

### Step 2: Make wipe scheduling one transaction

Inside the locked transaction: recheck no running sync, recheck no active wipe, perform initial soft
deletes/state cleanup, and insert the pending maintenance job. Commit before calling
`processMaintenanceJob`. If any step fails, nothing changes.

**Verify**: tests cover job-insert failure rollback and simultaneous scheduling attempts.

### Step 3: Make sync startup one transaction

Inside the same lock: recheck no active hard wipe, then insert the running sync. Keep the current
response shape.

**Verify**: a disposable PostgreSQL concurrency test starts wipe and sync transactions together;
exactly one succeeds and the loser observes the committed opposing state.

### Step 4: Enforce one active hard wipe in PostgreSQL

After Plan 025's baseline, generate a partial unique index preventing more than one
`library_hard_wipe` in `pending`/`running`. Map the constraint failure to the existing user-facing
"already in progress" error.

**Verify**: migration applies to fresh and upgraded disposable DBs; concurrent wipe insert test passes.

## Test plan

Extend `library-wipe.test.ts`, `guards.test.ts`, and `store.test.ts`, then add one real PostgreSQL
concurrency test. Cover sync-wins, wipe-wins, duplicate wipe, job insertion failure, and worker launch
only after commit.

## Done criteria

- [ ] Wipe and sync startup cannot overlap across processes.
- [ ] Initial wipe mutation and job insertion are atomic.
- [ ] Database constraint permits at most one active hard wipe.
- [ ] Purge ordering remains unchanged.
- [ ] Focused tests, migration checks, and Pane check pass.

## STOP conditions

- Plan 025 is incomplete or migration generation still sees stale schema.
- The chosen lock is not transaction-scoped or cannot be shared by both paths.
- Tests require changing the documented hard-wipe purge order.
- A network call would run while the coordination transaction is open.

## Maintenance notes

Every future operation that can invalidate the whole library must acquire this same startup lock.
Reviewers should scrutinize lock ordering to avoid deadlocks and ensure worker processing starts only
after commit.

