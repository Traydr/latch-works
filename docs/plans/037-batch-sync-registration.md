# Plan 037: Batch sync registration and deduplicate folder upserts

> **Executor instructions**: This changes transactional boundaries. Land integrity and concurrent
> upload plans first, use bounded batches, and preserve item-level reporting. Update the index when done.
>
> **Drift check (run first)**: `git diff --stat fd5693d..HEAD -- apps/pane-view/src/server/sync apps/pane-view/src/routes/api.sync* packages/lockstep-core/src packages/media-storage/src apps/pane-view/src/server/db/schema.ts`

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `docs/plans/026-attest-sync-uploads.md`, `docs/plans/030-serialize-sync-and-hard-wipe.md`, `docs/plans/036-pipeline-lockstep-uploads.md`
- **Category**: perf
- **Planned at**: commit `fd5693d`, 2026-07-13
- **Original finding**: 16

## Why this matters

Every completed object opens its own transaction and rebuilds every ancestor folder with repeated
select/upsert statements. Large sibling-heavy syncs pay O(files x depth) redundant database work.
Upload completions should be registered in bounded batches that verify each object, upsert each unique
ancestor once, and preserve resumable item outcomes.

## Current state

- `sync/store.ts:94` opens one transaction per object.
- `upsertContainingFolders` loops every ancestor and performs select + upsert.
- Lockstep currently registers immediately inside `pushMediaItem`; Plan 036 makes items concurrent.
- Plan 026 HEAD-verifies objects before DB mutation; batch flow must retain that invariant.
- Existing route validation rejects unsafe paths and derives object keys; reuse it per item.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Pane sync tests | `pnpm --filter @latch-works/pane-view test -- src/server/sync` | all pass |
| Core tests | `pnpm --filter @latch-works/lockstep-core test` | all pass |
| Pane check | `pnpm --filter @latch-works/pane-view check` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |

## Scope

**In scope**: new bounded batch completion route; sync validation/store/tests; Lockstep registration
buffer/tests; optional shared request types inside existing packages.

**Out of scope**: changing object-key format; upload concurrency limits; prune batching; background
queues; schema redesign; allowing partial validation inside a transaction.

## Git workflow

- Branch: `codex/037-batch-sync-registration`
- Commit message: `Batch sync object registration`

## Steps

### Step 1: Define a bounded batch contract

Add a POST completion endpoint accepting 1-50 object payloads. Validate/authenticate every item before
storage or DB work; reject duplicate logical paths in one batch. Response must return an outcome keyed
by logical path so Lockstep can preserve per-item success/failure. Keep the existing single endpoint as
a compatibility wrapper during rollout.

**Verify**: route tests cover empty, 51-item, duplicate-path, mixed-invalid, unauthorized, and valid batches.

### Step 2: Verify all stored objects before the transaction

HEAD-verify batch objects with a small separate concurrency bound using Plan 026's exact checks. If any
item fails verification, return its failure without including it in the DB batch; do not hold a DB
transaction during S3 calls.

**Verify**: tests prove no transaction starts until all included HEAD operations finish.

### Step 3: Upsert unique ancestors in constant statement groups

Collect unique ancestor paths across verified items and sort by depth. In one transaction: assert the
run writable; insert missing folder rows in bulk; read IDs for the path set; bulk-upsert correct
parentId/parentPath/deletedAt metadata; then bulk-upsert media objects, library entries, and run items.
Use chunk sizes below PostgreSQL parameter limits.

**Verify**: a 50-file same-folder test upserts each ancestor once and uses a bounded statement count
independent of file count; parent IDs and revive semantics match current behavior.

### Step 4: Buffer Lockstep registration after successful PUTs

Refactor the per-item upload step to return a validated completion payload. The push orchestrator
flushes successful payloads in chunks of at most 50, maps outcomes back to stable ordinals, and counts
an item pushed only after registration succeeds. Flush the final partial chunk and flush/settle on
cancellation according to explicit policy: already-uploaded bytes may remain unregistered, but no
cancelled run accepts later DB writes.

**Verify**: core tests cover chunk boundaries 1/50/51/101, mixed registration failures, abort, and exact counts.

### Step 5: Measure query reduction

Against disposable PostgreSQL, record statement/query counts for 1,000 files under shared depth-5
folders before and after. Do not use production data.

**Verify**: folder-related statements scale with unique paths/chunks, not files x depth.

## Test plan

Add route/store integration coverage using disposable PostgreSQL because mocked Drizzle chains cannot
prove bulk conflict/parent behavior. Keep unit tests for validation/chunking. Include revived folders,
conflicting hashes, duplicate paths, rollback, and run cancellation between HEAD and transaction.

## Done criteria

- [ ] Completion batches are bounded at 50.
- [ ] Storage verification occurs before DB transactions.
- [ ] Each unique ancestor is upserted once per batch.
- [ ] Item results/counts remain exact and resumable.
- [ ] Single endpoint remains compatible during migration.
- [ ] Tests, checks, and query-count benchmark pass.

## STOP conditions

- Any prerequisite plan is incomplete.
- Bulk upsert cannot preserve current media-object conflict identity or folder parent relationships.
- Provider verification would hold DB locks.
- Client compatibility requires removing the single endpoint immediately.

## Maintenance notes

Batch size and HEAD concurrency are separate controls. Reviewers should examine transaction duration,
PostgreSQL parameter limits, cancellation races, and how orphaned uploaded bytes are cleaned later.

