# Plan 027: Make sync-run finalization monotonic and idempotent

> **Executor instructions**: Implement only the sync-run state transition described here. Run every
> verification and update the plan index when complete.
>
> **Drift check (run first)**: `git diff --stat fd5693d..HEAD -- apps/pane-view/src/server/sync/store.ts apps/pane-view/src/server/sync/store.test.ts apps/pane-view/src/server/management/sync-run-control.ts`

## Status

- **Status**: DONE (`13eda05`, independently verified 2026-07-13)
- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `fd5693d`, 2026-07-13
- **Original finding**: 5

## Why this matters

Manual cancellation updates only a running run, but client finalization updates solely by ID and can
overwrite `cancelled` with `completed` or `failed`. Terminal state and operator intent must be
monotonic, while exact replay of an already-recorded completion should remain safe.

## Current state

- `sync-run-control.ts:36-44` uses `id AND status = running` for cancellation.
- `sync/store.ts:180-189` finalizes with `WHERE id = ...` and rewrites every terminal status.
- Tests in `sync/store.test.ts` mock Drizzle chains; extend that existing pattern.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused tests | `pnpm --filter @latch-works/pane-view test -- src/server/sync/store.test.ts` | all pass |
| Pane check | `pnpm --filter @latch-works/pane-view check` | exit 0 |

## Scope

**In scope**: `apps/pane-view/src/server/sync/store.ts` and `store.test.ts`; route tests only if the
error mapping changes.

**Out of scope**: changing Lockstep event semantics; adding new statuses; cancelling in-flight HTTP
requests from Pane View; management UI changes.

## Git workflow

- Branch: `codex/027-preserve-terminal-sync-status`
- Commit message: `Preserve terminal sync run status`

## Steps

### Step 1: Define legal finalization transitions

Update a run only when its status is `running`. If no row updates, read the current row: return
success for an exact same-status replay, but reject a conflicting terminal rewrite. Never replace a
manual cancellation's error/counts with later client values.

**Verify**: focused tests pass for running->completed, running->failed, running->cancelled, exact
replay, cancelled->completed rejection, and completed->failed rejection.

### Step 2: Preserve route behavior

Confirm a conflicting finalization receives the repository's existing error response rather than a
false success. Do not expose internal DB details.

**Verify**: `pnpm --filter @latch-works/pane-view test -- src/server/sync/routes.test.ts` -> all pass.

## Test plan

Model tests after the current `finalizeSyncRun` block in `store.test.ts`. Assert both the update
predicate and replay behavior; do not only assert `.set()` arguments.

## Done criteria

- [ ] No terminal status can be rewritten to a different status.
- [ ] Same-status replay is idempotent.
- [ ] Manual cancellation details survive late client finalization.
- [ ] Pane View tests and check pass.

## STOP conditions

- Existing clients intentionally rely on changing one terminal status to another.
- Correctness requires a new public status or response shape.
- In-scope code drift makes current cancellation semantics unclear.

## Maintenance notes

All future sync-run state changes must encode their source status in the update predicate. Review any
new retry behavior for idempotency rather than reopening terminal rows.
