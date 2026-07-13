# Plan 036: Pipeline Lockstep uploads with bounded concurrency

> **Executor instructions**: Land upload integrity first. Preserve final counts, cancellation, and
> `--max-changes`. Run every gate and update the plan index.
>
> **Drift check (run first)**: `git diff --stat fd5693d..HEAD -- packages/lockstep-core/src/push-changes.ts packages/lockstep-core/src/remote-api.ts packages/lockstep-core/src/types.ts packages/lockstep-core/src/*test.ts apps/lockstep-cli/src apps/lockstep/src/main/services/runService.ts`

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `docs/plans/026-attest-sync-uploads.md`
- **Category**: perf
- **Planned at**: commit `fd5693d`, 2026-07-13
- **Original finding**: 15

## Why this matters

Every changed item currently waits for its hash, upload-target request, object PUT, and completion
registration before the next item starts. Thousands of small files pay network latency serially.
A low bounded worker pool can overlap independent items without compromising integrity or allowing
unbounded memory/network pressure.

## Current state

- `push-changes.ts:87-133` is a serial `for` loop.
- `pushMediaItem` owns all stages for one item and emits stage text through a callback.
- `sync-cancellation.test.ts` verifies finalization uses a non-aborted signal.
- Events carry stable `current`/`total`; completion order may differ, but item ordinals must not.
- Plan 026 adds signed-header/checksum and mutation guarantees; do not bypass them.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Core tests | `pnpm --filter @latch-works/lockstep-core test` | all pass |
| CLI tests | `env -u LOCKSTEP_API_URL -u LOCKSTEP_API_TOKEN pnpm --filter @latch-works/lockstep test` | all pass |
| Desktop tests | `pnpm --filter @latch-works/lockstep-app test` | all pass |
| Typecheck | `pnpm typecheck` | exit 0 |

## Scope

**In scope**: core push options/worker pool/events/tests; CLI option plumbing/help/tests; desktop may
use the safe default without a new setting unless existing UX cleanly supports it.

**Out of scope**: batched DB registration (Plan 037); concurrent prune; scan/hash pool internals;
changing max-change selection; retrying failed uploads automatically.

## Git workflow

- Branch: `codex/036-pipeline-lockstep-uploads`
- Commit message: `Pipeline Lockstep uploads`

## Steps

### Step 1: Add a bounded upload option

Add `uploadConcurrency` to `PushChangesOptions`, default 3, validate integer range 1-8. Add a CLI flag
with the same bounds and document it. Desktop uses default 3 unless an existing profile/settings
pattern supports adding the field without UI churn.

**Verify**: option parsing tests accept bounds and reject 0, fractions, and >8.

### Step 2: Replace the serial loop with an abort-aware worker pool

Assign stable ordinals before dispatch. Workers dequeue only while not aborted; no more than the
configured count may call `pushMediaItem`. On normal item failure, record failure and continue. On
abort, stop scheduling, await in-flight work to settle, then finalize cancellation using no aborted
signal as today.

**Verify**: deferred-promise tests prove peak concurrency, stable ordinal metadata, no scheduling after
abort, and all in-flight promises settle.

### Step 3: Make aggregation concurrency-safe and deterministic

Update pushed/failed counters exactly once per item. Emit per-item success/failure as each settles;
final summary counts must be independent of completion order. Keep `itemsToPush` selection and
`maxChanges` semantics unchanged.

**Verify**: out-of-order mixed success/failure test yields exact final counts and one terminal event.

### Step 4: Exercise real local HTTP/storage behavior

Use the direct HTTP/upload tests from Plan 026 with multiple synthetic files and delayed endpoints.
Confirm signed headers, progress, checksum verification, and cancellation remain correct under overlap.

**Verify**: local integration test shows >1 concurrent PUT and no integrity mismatch.

## Test plan

Extend `push-changes.test.ts` and `sync-cancellation.test.ts`. Cover concurrency 1/3/8, fewer items than
workers, mixed failures, abort before/during dispatch, maxChanges, event ordinals, and finalize failure.

## Done criteria

- [ ] Peak upload concurrency never exceeds the configured bound.
- [ ] No new item starts after abort.
- [ ] Final counts/events are exact under out-of-order completion.
- [ ] Plan 026 integrity guarantees remain enforced.
- [ ] Core, CLI, desktop, and typecheck gates pass.

## STOP conditions

- Plan 026 is incomplete.
- Existing UI assumes strictly sequential status events and cannot tolerate stable out-of-order items.
- Cancellation would require abandoning active streams without settlement.
- Provider rate limits make default 3 unsafe in local integration.

## Maintenance notes

Keep item concurrency separate from archive hash concurrency. Any future retry must preserve exactly-
once counters and avoid registering an object twice.

