# Plan 035: Add bounded concurrency to archive discovery and hashing

> **Executor instructions**: Preserve cancellation, progress, and deterministic plan ordering. Run
> benchmarks only on synthetic/temp archives. Update the plan index when complete.
>
> **Drift check (run first)**: `git diff --stat fd5693d..HEAD -- packages/media-index/src/scan.ts packages/media-index/src/scan.test.ts packages/lockstep-core/src/plan-sync.ts packages/lockstep-core/src/types.ts`

## Status

- **Status**: DONE (`5baae31`, independently verified 2026-07-13)
- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `fd5693d`, 2026-07-13
- **Original finding**: 14

## Why this matters

Archive traversal awaits every child directory, stat, and full file hash in one serial chain. Large
archives underuse disks and CPUs, especially on network/removable storage. Small bounded pools should
parallelize latency while keeping results deterministic and cancellation prompt.

## Current state

- `scan.ts:90-102` recursively visits one directory at a time.
- `scan.ts:142-157` stats and optionally hashes one file before examining the next.
- Push planning defaults `hashFiles` to true.
- `createSyncPlan` preserves local item order, so changing scan order changes `--max-changes` choice;
  define a deterministic path order explicitly.
- Existing tests build temp trees and assert skips/abort behavior.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Index tests | `pnpm --filter @latch-works/media-index test` | all pass |
| Core tests | `pnpm --filter @latch-works/lockstep-core test` | all pass |
| Typecheck | `pnpm typecheck` | exit 0 |

## Scope

**In scope**: `media-index` scan implementation/options/tests; minimal Lockstep option plumbing if
concurrency becomes configurable; a synthetic benchmark script only if it is deterministic and ignored.

**Out of scope**: upload concurrency (Plan 036); following symlinks; changing supported extensions;
watch mode; persistent scan caches.

## Git workflow

- Branch: `codex/035-parallelize-archive-scan`
- Commit message: `Parallelize archive scanning and hashing`

## Steps

### Step 1: Define deterministic discovery output

Sort directory entries or final candidates by normalized logical archive path before plan assembly.
Document that this ordering controls capped pushes. Preserve skipped-entry determinism too.

**Verify**: randomized delayed filesystem test returns the same item/skipped order on repeated runs.

### Step 2: Add a bounded directory queue

Use a small internal worker pool (default 4, configurable within a safe range such as 1-16) to read
directories. Check AbortSignal before dequeue, after I/O, and before enqueue. Do not recursively spawn
unbounded promises.

**Verify**: test records peak directory concurrency at the configured bound and abort stops dequeue.

### Step 3: Add separate stat/hash workers

Process discovered supported files through a second bounded pool. Keep hashing stream-based, close
streams on abort/error, and emit progress with the correct file path/size even when events interleave.
Assemble results in deterministic path order after workers settle.

**Verify**: delayed hash tests prove peak concurrency bound, exact hashes, no dropped files, and prompt
abort cleanup.

### Step 4: Benchmark conservative defaults

Compare concurrency 1 versus default on synthetic many-small-file and few-large-file trees. Record
the command/results in the PR, not committed user paths. Lower defaults if the large-file case causes
disk thrash or worse latency.

**Verify**: default is no slower by more than 10% in the large-file synthetic case and improves the
many-file case; otherwise stop and report measurements.

## Test plan

Extend `scan.test.ts` with injectable delayed filesystem seams for deterministic scheduling. Cover
ordering, separate
pool limits, abort during readdir/stat/hash, read errors, empty trees, and progress counts.

## Done criteria

- [ ] Work concurrency is bounded and configurable or centrally constant.
- [ ] Results and capped-push order are deterministic.
- [ ] Abort closes streams and stops new work.
- [ ] Tests, typecheck, and synthetic benchmark gates pass.

## STOP conditions

- Deterministic ordering would intentionally change an established capped-push policy without approval.
- Concurrency requires buffering file contents.
- Default regression exceeds the benchmark threshold.

## Maintenance notes

Directory and hash pools serve different resources; keep their limits separate. Avoid turning later
progress-order expectations into accidental serialization.
