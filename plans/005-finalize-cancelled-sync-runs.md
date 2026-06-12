# Plan 005: Finalize Cancelled Lockstep Sync Runs

> **Executor instructions**: Follow this plan step by step. Run every verification
> command and confirm the expected result before moving to the next step. If any
> STOP condition occurs, stop and report instead of improvising. When done,
> update this plan's row in `plans/README.md` unless a reviewer says they own the
> index.
>
> **Drift check (run first)**:
> `git diff --stat 326110f..HEAD -- packages/lockstep-core/src/push-changes.ts packages/lockstep-core/src/prune-deleted.ts packages/lockstep-core/src/*.test.ts apps/lockstep/src/main/services/runService.ts apps/lockstep/src/**/*.test.ts apps/pane-view/src/server/sync apps/pane-view/src/routes/api.sync.runs.$syncRunId.complete.ts`
> If any in-scope file changed, compare the excerpts below with the live code
> before proceeding. A mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `326110f`, 2026-06-12

## Why this matters

Lockstep creates a remote sync run before pushing or pruning. On cancellation,
core tries to finalize that run in a `finally` block but reuses the same aborted
signal, so finalization can be aborted too. The desktop app then reports a
cancelled run with `action: "plan"` even if the user cancelled a push or prune.
This leaves Pane View with stale `running` sync runs and gives users misleading
completion summaries.

## Current state

- `packages/lockstep-core/src/push-changes.ts` creates and finalizes push sync
  runs.
- `packages/lockstep-core/src/prune-deleted.ts` creates and finalizes prune sync
  runs.
- `apps/lockstep/src/main/services/runService.ts` wraps core calls for the
  desktop UI.
- Pane View's schema has a sync run status enum with a `cancelled` value in the
  database model, but the finalize API types may only accept completed/failed.

Relevant excerpts at `326110f`:

```ts
// packages/lockstep-core/src/push-changes.ts:73-83
const syncRun = await postJson<{ syncRunId: string }>(
  options.apiUrl,
  "/api/sync/runs",
  options.apiToken,
  { counts: plan.counts, sourceRoot: plan.sourceRoot },
  signal,
);
```

```ts
// packages/lockstep-core/src/push-changes.ts:135-152
} finally {
  await postJson(
    options.apiUrl,
    `/api/sync/runs/${syncRun.syncRunId}/complete`,
    options.apiToken,
    { ... status: failed > 0 ? "failed" : "completed" },
    signal,
  ).catch((error) => { ... });
}
```

```ts
// packages/lockstep-core/src/prune-deleted.ts:125-142
} finally {
  await postJson(
    options.apiUrl,
    `/api/sync/runs/${syncRun.syncRunId}/complete`,
    options.apiToken,
    { ... status: failed > 0 ? "failed" : "completed" },
    signal,
  ).catch((error) => { ... });
}
```

```ts
// apps/lockstep/src/main/services/runService.ts:183-194
if (this.abortController.signal.aborted) {
  const summary: LockstepRunSummary = {
    action: "plan",
    completedAt: new Date().toISOString(),
    failed: 0,
    profileId: request.profileId,
    pushed: 0,
    status: "cancelled",
  };
  observer.onEvent({ type: "cancelled" });
  observer.onEvent({ type: "complete", summary });
```

Repo conventions to match:

- `packages/lockstep-core` is headless and should not prompt or write to the
  console.
- Desktop uses Zod-backed IPC contracts and `better-result` payloads; do not
  expose raw Node APIs to renderer code.
- Keep cancellation user-facing as `cancelled`; do not collapse it into generic
  failure unless the API cannot represent cancelled.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Core tests | `pnpm --filter @latch-works/lockstep-core test` | exit 0, all tests pass |
| Desktop tests | `pnpm --filter @latch-works/lockstep-app test` | exit 0, all tests pass |
| Pane tests | `pnpm --filter @latch-works/pane-view test -- src/server/sync` | exit 0, sync tests pass |
| Typecheck | `pnpm --filter @latch-works/lockstep-core typecheck && pnpm --filter @latch-works/lockstep-app typecheck && pnpm --filter @latch-works/pane-view typecheck` | all exit 0 |

## Scope

**In scope**:

- `packages/lockstep-core/src/push-changes.ts`
- `packages/lockstep-core/src/prune-deleted.ts`
- Lockstep core tests
- `apps/lockstep/src/main/services/runService.ts`
- Desktop IPC/run-service tests, if present or easy to add
- Pane View finalize sync-run schema/store/route only if needed to accept
  `cancelled`
- `plans/README.md`, status row only

**Out of scope**:

- Redesigning sync run tables.
- Changing plan/verify behavior.
- Adding retry queues for failed finalization.
- Changing CLI output except what naturally follows from core summaries.

## Git workflow

- Branch: `codex/005-finalize-cancelled-sync-runs`
- Commit style: short imperative summary, for example
  `Finalize cancelled lockstep runs.`
- Do not push or open a PR unless the operator asks.

## Steps

### Step 1: Confirm Pane View accepts `cancelled`

Inspect the finalize route, input schema, and store types for sync runs. If
`cancelled` is already accepted end to end, do not change Pane View. If the DB
enum supports `cancelled` but the route schema rejects it, extend the route/input
type to accept `"cancelled"` and add a focused test.

The finalization payload for cancellation should include:

- `status: "cancelled"`
- final counts including planned count, attempted count, succeeded count, and
  failed count where the existing shape supports them
- an error/message such as `Run cancelled by user`

**Verify**:
`pnpm --filter @latch-works/pane-view test -- src/server/sync` -> exit 0.

### Step 2: Finalize with an independent cleanup signal

In `pushChanges` and `pruneDeleted`, do not pass the operation's aborted signal
to the finalization `postJson` call. Use no signal or a new short-lived
`AbortSignal.timeout(...)` if the runtime and project target support it.

When the operation was aborted, finalize as `cancelled` instead of `completed` or
`failed`. Detect this using `signal?.aborted` in the `finally` block.

Keep warning behavior if finalization still fails, but the warning should no
longer be caused by reusing the already-aborted signal.

**Verify**:
`pnpm --filter @latch-works/lockstep-core typecheck` -> exit 0.

### Step 3: Preserve accurate core summaries

Ensure `pushChanges` and `pruneDeleted` emit a `complete` event with
`summary.status === "cancelled"` when cancellation occurs after a sync run was
created. Include the correct `action`: `"push"` for push, `"prune"` for prune.

Avoid double-emitting conflicting complete summaries. If an abort is thrown after
finalization, the caller should not replace the summary with `action: "plan"`.

**Verify**:
`pnpm --filter @latch-works/lockstep-core test` -> exit 0.

### Step 4: Fix desktop cancellation summaries

In `apps/lockstep/src/main/services/runService.ts`, use the `_operation`
parameter or change it to a typed `operation` parameter so cancellation summaries
use the actual operation. Prefer a union type matching `LockstepRunSummary["action"]`.

If core now emits the complete cancelled summary before throwing, avoid emitting a
second desktop summary. One acceptable approach is to track whether a `complete`
event was already observed by `createObserver`.

**Verify**:
`pnpm --filter @latch-works/lockstep-app test` -> exit 0.

### Step 5: Add cancellation tests

Add tests for:

- Push cancellation finalizes the remote sync run with `status: "cancelled"` and
  does not pass an already-aborted signal to the finalization call.
- Prune cancellation has the same behavior.
- Desktop cancelled push/prune summary reports the correct action.
- Existing failed-item finalization still uses `status: "failed"`.

Mock HTTP/post helpers; do not call a real Pane View server.

**Verify**:
`pnpm --filter @latch-works/lockstep-core test` -> exit 0.

**Verify**:
`pnpm --filter @latch-works/lockstep-app test` -> exit 0.

## Test plan

- Core tests under `packages/lockstep-core/src`.
- Desktop service tests under `apps/lockstep/src`, if a test harness exists.
- Pane View sync tests only if route/input schema changes.
- No network or Electron GUI should be required.

## Done criteria

- [ ] Cancelled push and prune runs call `/api/sync/runs/{id}/complete` with
      `status: "cancelled"` after cancellation.
- [ ] Finalization does not reuse the already-aborted operation signal.
- [ ] Desktop summaries use `action: "push"` or `action: "prune"` for cancelled
      runs, not `"plan"`.
- [ ] No duplicate conflicting complete summaries are emitted.
- [ ] Focused core, desktop, and any Pane View tests pass.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

Stop and report if:

- Pane View's actual database enum does not support `cancelled`.
- Electron tests cannot exercise `runService` without launching a GUI and there
  is no existing test seam.
- The core `postJson` helper cannot be tested without a broad HTTP refactor.
- The renderer contract rejects `cancelled` despite the current summary type.

## Maintenance notes

Reviewers should check cancellation at three layers: core finalization, desktop
event emission, and Pane View accepted status. Future sync operations that create
remote runs should share the same independent cleanup-finalization pattern.
