# Plan 014: Reduce Folder Upsert Queries During Sync

> **Executor instructions**: Run the drift check first. This is performance work
> on the sync ingest path; preserve correctness and tests from Plans 002 and 003.
> Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 8f19cd4..HEAD -- apps/pane-view/src/server/sync/store.ts apps/pane-view/src/server/sync/store.test.ts apps/pane-view/src/server/db/schema.ts apps/pane-view/src/server/library`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/002-add-sync-orchestration-and-route-tests.md, plans/003-reject-writes-to-finalized-sync-runs.md
- **Category**: perf
- **Planned at**: commit `8f19cd4`, 2026-07-05

## Why This Matters

Every uploaded file calls `upsertContainingFolders`, which does a parent lookup
and an upsert for each ancestor folder. Large sync runs with deep paths can spend
many sequential Postgres round-trips only maintaining folder hierarchy.

## Current State

- `store.ts:122` calls `upsertContainingFolders(parentPath, tx)` inside
  `completeSyncedObject`.
- `store.ts:267-316` loops over `collectContainingFolderPaths(path)`.
- `store.ts:279-289` performs a `select id from folders where path = parentPath`
  when the parent was not upserted earlier in the same object.
- `store.ts:292-311` performs one `insert ... onConflictDoUpdate` per folder.
- `folders` schema has `pathUnique` and `parentIndex` in `schema.ts:208-227`.

## Commands You Will Need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Sync tests | `pnpm --filter @latch-works/pane-view test -- store sync` | exit 0 |
| Typecheck | `pnpm --filter @latch-works/pane-view typecheck` | exit 0 |

## Scope

**In scope**:
- `apps/pane-view/src/server/sync/store.ts`
- `apps/pane-view/src/server/sync/store.test.ts`
- SQL/helper code only if kept in the sync store layer

**Out of scope**:
- Schema changes to `folders`.
- Removing `folders.parentId` unless you prove no code reads it and add a
  separate migration plan.
- Changing library browsing results.

## Git Workflow

- Branch: `advisor/014-folder-upsert-performance`
- Commit message: `Reduce sync folder upsert queries`

## Steps

### Step 1: Characterize Current Folder Upsert Behavior

Add tests for `completeSyncedObject` or `upsertContainingFolders` that assert a
deep path creates every ancestor folder with correct `path`, `parentPath`,
`name`, `depth`, and `parentId`. Include an existing-parent case.

**Verify**: `pnpm --filter @latch-works/pane-view test -- store` -> tests pass on current behavior.

### Step 2: Replace Per-Ancestor Parent Selects With One Batch Lookup

Before the loop, compute all ancestor paths and parent paths. Query existing
folder ids for all relevant parent paths in one `inArray(folders.path, paths)`
select. Seed `parentIdByPath` from that result and then keep using ids returned
by upserts inside the loop.

This keeps dependency order simple and avoids a risky recursive CTE.

**Verify**: `pnpm --filter @latch-works/pane-view test -- store` -> folder tests pass.

### Step 3: Preserve Transaction And Guard Ordering

Keep `upsertContainingFolders` inside the same transaction as
`completeSyncedObject`. Ensure Plan 003's `assertWritableSyncRun` remains the
first transaction operation.

**Verify**: `pnpm --filter @latch-works/pane-view test -- store sync && pnpm --filter @latch-works/pane-view typecheck` -> exits 0.

## Test Plan

- Test deep path folder chain.
- Test existing parent folder id reuse.
- Test `completeSyncedObject` still creates/updates media and library entries.

## Done Criteria

- [ ] Folder parent-id lookup is batched per object instead of one select per
  ancestor.
- [ ] Folder upsert behavior and parent ids are preserved.
- [ ] Sync store tests and typecheck exit 0.
- [ ] `plans/README.md` status row updated.

## STOP Conditions

- The current Drizzle version cannot express the batch lookup without unsafe SQL.
- Tests reveal `parentId` is not reliable today and needs schema redesign.
- You need to change library query semantics to make the optimization work.

## Maintenance Notes

- This is intentionally smaller than a recursive CTE rewrite. If sync ingest is
  still slow after this, measure before planning a larger batch ingest design.
