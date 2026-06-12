# Plan 001: Make Sync Ingest And Delete Writes Atomic

> **Executor instructions**: Follow this plan step by step. Run every verification
> command and confirm the expected result before moving to the next step. If any
> STOP condition occurs, stop and report instead of improvising. When done,
> update this plan's row in `plans/README.md` unless a reviewer says they own the
> index.
>
> **Drift check (run first)**:
> `git diff --stat 326110f..HEAD -- apps/pane-view/src/server/sync/store.ts apps/pane-view/src/routes/api.sync.complete-object.ts apps/pane-view/src/server/sync/store.test.ts apps/pane-view/src/server/db/schema.ts`
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

Pane View records a completed Lockstep upload through several database writes:
media object, containing folders, library entry, and sync run item. Those writes
are currently independent. If one succeeds and a later one fails, the archive can
show media without an audit row, an audit row without the matching library state,
or a soft delete without a valid sync run item. Wrapping each ingest/delete in a
single transaction makes sync runs replayable and keeps the local archive
database trustworthy.

## Current state

- `apps/pane-view/src/server/sync/store.ts` owns sync run creation, object
  completion, run finalization, folder upserts, and remote delete marking.
- `apps/pane-view/src/routes/api.sync.complete-object.ts` routes Lockstep
  `complete-object` calls into this store.
- `apps/pane-view/src/server/sync/store.test.ts` currently only mocks
  `finalizeSyncRun`, so there are no regression tests around transaction
  boundaries.
- `apps/pane-view/src/server/db/schema.ts` defines `sync_runs` and
  `sync_run_items`; `sync_run_items.sync_run_id` is a foreign key to
  `sync_runs.id`.

Relevant excerpts at `326110f`:

```ts
// apps/pane-view/src/server/sync/store.ts:89-118
const [mediaObject] = await db
  .insert(mediaObjects)
  .values({ ... })
  .onConflictDoUpdate({ ... })
  .returning({ id: mediaObjects.id });

await upsertContainingFolders(parentPath);

await db
  .insert(libraryEntries)
  .values({ ... })
```

```ts
// apps/pane-view/src/server/sync/store.ts:146-161
await db
  .insert(syncRunItems)
  .values({
    action: "upload",
    logicalPath: input.logicalPath,
    mediaObjectId: mediaObject.id,
    syncRunId: input.syncRunId,
  })
  .onConflictDoUpdate({ ... });
```

```ts
// apps/pane-view/src/server/sync/store.ts:189-215
await db
  .update(libraryEntries)
  .set({ deletedAt: new Date() })
  .where(eq(libraryEntries.logicalPath, logicalPath));

await db
  .insert(syncRunItems)
  .values({ action: "delete", logicalPath, syncRunId })
  .onConflictDoUpdate({ ... });
```

Repo conventions to match:

- TypeScript ESM, named exports, 2-space formatting, 100-column Biome style.
- Server database code uses Drizzle query builders from `apps/pane-view/src/server/db`.
- Tests are colocated as `*.test.ts` and run with Vitest.
- Preserve the sync API response shapes unless explicitly adding a validation
  error path.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Focused tests | `pnpm --filter @latch-works/pane-view test -- src/server/sync/store.test.ts` | exit 0, all tests pass |
| Pane typecheck | `pnpm --filter @latch-works/pane-view typecheck` | exit 0, no TypeScript errors |
| Workspace check | `pnpm check` | exit 0, or only documented pre-existing caveats if the operator accepts them |

## Scope

**In scope**:

- `apps/pane-view/src/server/sync/store.ts`
- `apps/pane-view/src/routes/api.sync.complete-object.ts`, only if needed to
  preserve or improve error mapping for invalid sync runs
- `apps/pane-view/src/server/sync/store.test.ts`
- `plans/README.md`, status row only

**Out of scope**:

- Changing Lockstep CLI or desktop behavior.
- Changing storage object upload flow.
- Adding new sync action types.
- Reworking folder counters or the library browsing model.

## Git workflow

- Branch: `codex/001-sync-ingest-transactions`
- Commit style: short imperative summary, matching recent history such as
  `Add Showcase product handbook docs.`
- Do not push or open a PR unless the operator asks.

## Steps

### Step 1: Introduce a transaction-capable store shape

In `apps/pane-view/src/server/sync/store.ts`, make the existing write helpers
usable with either the root `db` object or a Drizzle transaction. Keep the
surface area small:

- Add a local type alias for the root database/transaction shape if needed.
- Change `upsertContainingFolders(parentPath)` to accept a database client
  parameter, defaulting to `db` only if that matches local style.
- Do not introduce a new repository abstraction.

Then wrap the body of `completeSyncedObject` in `db.transaction(async (tx) => { ... })`
and route every write inside that function through `tx`.

**Verify**:
`pnpm --filter @latch-works/pane-view typecheck` -> exit 0.

### Step 2: Make remote delete atomic too

Wrap `markRemoteDeleted` in `db.transaction(async (tx) => { ... })` and route both
the `libraryEntries` update and `syncRunItems` upsert through `tx`.

Add a small validation helper that confirms `syncRunId` exists before mutating
library state. Prefer checking inside the transaction before the library update.
If the existing `syncRunStatusEnum` has a `running` value, require that status.
If it does not, only require that the run exists and add a TODO-free comment
explaining why status is not checked.

Preserve the current behavior that a delete for an already-missing logical path
does not by itself fail, unless product code already has a clear "missing path is
an error" pattern.

**Verify**:
`pnpm --filter @latch-works/pane-view typecheck` -> exit 0.

### Step 3: Add regression tests for transaction usage and failures

Extend or restructure `apps/pane-view/src/server/sync/store.test.ts`.

Cover at least:

- `completeSyncedObject` calls `db.transaction` and uses the transaction client
  for media object, folder, library entry, and sync item writes.
- `markRemoteDeleted` calls `db.transaction` and does not update
  `libraryEntries` before sync-run validation.
- If validation fails, the function rejects and no library mutation is performed.
- Existing `finalizeSyncRun` tests still pass.

The current test file uses Vitest module mocks for `../db`; continue with that
style unless it becomes too brittle. If mocking the Drizzle fluent API gets
unreadable, use a narrowly scoped fake transaction client instead of adding a
real database dependency.

**Verify**:
`pnpm --filter @latch-works/pane-view test -- src/server/sync/store.test.ts` ->
exit 0, including the new tests.

### Step 4: Run package verification

Run the focused typecheck and tests again after any cleanup.

**Verify**:
`pnpm --filter @latch-works/pane-view test -- src/server/sync/store.test.ts` ->
exit 0.

**Verify**:
`pnpm --filter @latch-works/pane-view typecheck` -> exit 0.

## Test plan

- Add tests in `apps/pane-view/src/server/sync/store.test.ts`.
- Model the test organization after the existing `finalizeSyncRun` tests in the
  same file, but add transaction-aware mocks.
- The main regression is: a bad `syncRunId` must not leave a soft-deleted
  `libraryEntries` row behind.

## Done criteria

- [ ] `completeSyncedObject` performs all database writes inside one transaction.
- [ ] `markRemoteDeleted` performs all database writes inside one transaction.
- [ ] Invalid or non-writable sync runs are rejected before library state changes.
- [ ] Focused store tests pass.
- [ ] Pane View typecheck passes.
- [ ] No files outside the scope list are modified, except generated lockfiles
      only if an explicit dependency change was approved.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

Stop and report if:

- The live code no longer matches the current-state excerpts.
- Drizzle transaction typing requires broad casts across unrelated modules.
- Requiring `syncRuns.status === "running"` breaks an existing tested sync flow
  and there is no clear replacement invariant.
- A real database integration test becomes necessary but there is no test
  database available.

## Maintenance notes

Reviewers should check that every write inside `completeSyncedObject` and
`markRemoteDeleted` uses the transaction client, not the root `db`. Future sync
changes that add new write paths should extend these transactions instead of
adding independent writes after them.
