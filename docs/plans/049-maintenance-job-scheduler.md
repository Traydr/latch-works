# Plan 049: One scheduler and a validated progress seam for maintenance jobs

> **Executor instructions**: Server-only. No schema migration in this plan (see Decisions). Land the
> steps in order; each step keeps the three existing purge actions working. Update the index when done.
>
> **Drift check (run first)**: `git diff --stat 7076ce8..HEAD -- apps/pane-view/src/server/management apps/pane-view/src/features/management apps/pane-view/src/server/db/schema.ts apps/pane-view/drizzle`
> If `cleanup-worker.ts` or any `schedule*` file changed, re-read before Step 1. If a migration past
> `0016` touched `maintenance_jobs`, re-check the "Decisions" section.

## Status

- **Status**: TODO
- **Priority**: P3 (downgraded 2026-08-17: the cross-type phase leak is latent — only pre-Shutter
  hard-wipe rows ever carried `s3_derivatives`, and the purge types did not exist then — so this is
  hardening, dedupe, and test coverage rather than a live bug)
- **Effort**: M
- **Risk**: MEDIUM — durable job state; a wrong phase migration can strand a job
- **Depends on**: — (soft: land after Plan 051 so `cleanup-worker.test.ts` can use its pglite
  `db` adapter instead of `vi.mock("../db")`; if 051 has landed, prefer that harness for Step 3)
- **Category**: architecture / correctness
- **Planned at**: commit `7076ce8`, 2026-08-14
- **Original finding**: Pane View architecture review 2026-08-14, candidate 4

## Why this matters

Three schedulers (`soft-deleted-purge.ts`, `shutter-source-purge.ts`, `library-wipe.ts`) repeat the
same prologue — transaction, startup advisory lock, "no active sync run", "no active cleanup job",
probe, insert, kick worker — and each has a test that re-verifies that same prologue. The invariant
"one cleanup at a time, never during a sync" is asserted identically in three places, differently in
a fourth (`deleteFolders` checks sync only), and not at all in a fifth (`folder-delete.ts` has no
guards and is directly callable). The 581-line worker — the one module with real failure modes — is
the only module in the directory without a test.

The worker also treats its `jsonb` progress column as trusted: four unchecked casts, a schema-level
default phase (`s3_originals`) that is only valid for hard wipes, and a legacy-phase migration that
would push a `soft_deleted_purge` job into a phase its `switch` cannot handle. `errorCount` and
`lastError` are set to zero/cleared at scheduling and rendered in the UI, but no code path ever
increments or sets them.

## Current state

All references are to `apps/pane-view/src/`.

- Prologue duplicated at `server/management/soft-deleted-purge.ts:12-17`,
  `shutter-source-purge.ts:12-17`, `library-wipe.ts:41-47`. Only `library-wipe.ts:83-88` handles the
  `23505` unique-violation race.
- DB enforces one active job **per type** (`db/schema.ts:439-441`
  `maintenance_jobs_active_type_unique`) — not one active job overall. Cross-type exclusion is
  app-level via `readActiveCleanupJob` under `acquireLibraryMutationStartupLock`.
- The "orphaned Shutter source" eligibility SQL (media object with a soft-deleted reference and no
  active reference) is written three times: `shutter-source-purge.ts:29-47`,
  `cleanup-worker.ts:210-231`, `cleanup-worker.ts:335-355`.
- Unchecked casts: `cleanup-worker.ts:88,91,93` (`readCleanupJobStatus`), `:190,194,198`
  (`processMaintenanceJobBatch`), `:179` (`as { phase?: string }`).
- Legacy migration at `cleanup-worker.ts:178-186`: any job whose progress phase is `s3_derivatives`
  is rewritten to `s3_originals` regardless of `job.type`.
- `s3_originals` as universal default: `db/schema.ts:423-427` (column default), `guards.ts:85`
  (`phase ?? "s3_originals"`).
- Dead fields: `errorCount` initialised at `soft-deleted-purge.ts:32`, `shutter-source-purge.ts:57`,
  `library-wipe.ts:66`, forwarded at `cleanup-worker.ts:181`, read via raw SQL at `guards.ts:59`,
  rendered at `features/management/CleanupJobProgress.tsx:103-108`; never incremented. `lastError`
  cleared at `cleanup-worker.ts:277`; never set. The worker is fail-fast — first error rejects the
  batch promise and the job is marked `failed` with `maintenanceJobs.error`
  (`cleanup-worker.ts:132-149`).
- Guard coverage: `management-service.ts:60-65` `deleteFolders` calls `assertNoActiveSyncRun` only;
  `folder-delete.ts` calls no guards; sync start/upload/complete call `assertNoActiveCleanupJob`
  (`sync/store.ts:75,112,257`, `routes/api.sync.*`).
- Tests: `soft-deleted-purge.test.ts` (76 lines), `shutter-source-purge.test.ts` (70),
  `library-wipe.test.ts` (120) each mock `../db`, `./guards`, `./cleanup-worker` and assert the
  prologue sequence. **No `cleanup-worker.test.ts`.** House pattern for testing SQL without a
  database: `server/auth/login-throttle-sql.test.ts` (build the drizzle query, `.toSQL()`, assert).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Management tests | `pnpm --filter @latch-works/pane-view test -- src/server/management src/features/management` | all pass |
| Pane check | `pnpm --filter @latch-works/pane-view check` | exit 0 |
| Manual smoke | `pnpm dev:pane` → `/manage` | see Step 6 |

## Scope

**In scope**: new `server/management/maintenance-scheduler.ts`; new
`server/management/maintenance-progress.ts` (parser); collapsing the three `schedule*` modules into
per-type descriptors; guard consistency for `deleteFolders`; removing `errorCount`/`lastError`;
`cleanup-worker.test.ts`; consolidating the three-times-written eligibility SQL.

**Out of scope**: a new migration (see Decisions); changing job phases or their order; the
`processMaintenanceJob` re-entry/`setTimeout` loop; `maintenance-storage.ts`; `sync-run-control.ts`;
`management-service.ts` beyond swapping imports and the one guard.

## Decisions taken in this plan

1. **No migration.** This plan is a refactor and keeps the schema untouched. Cross-type "one
   active cleanup" stays app-level under the existing advisory lock, which already serialises
   schedulers. Making it a DB constraint is a small follow-up (Plan 025 landed on 2026-08-17, so
   `db:generate` produces correct migrations again; the executor may generate that index in a
   separate commit if the user asks). The universal schema default (`s3_originals`, only valid for
   hard wipes) is likewise left in place — the scheduler always supplies explicit progress, and the
   parser (Step 2) rejects a mismatched phase — but note it in the PR as debt.
2. **`errorCount` and `lastError` are removed** from the progress types and UI, not wired. The
   worker is fail-fast by design; a per-item error counter would need a policy for continuing past
   failures that nobody has asked for. Existing rows carrying `errorCount: 0` parse fine because the
   parser ignores unknown keys.
3. **`deleteFolders` gets the cleanup guard.** It mutates library rows that an in-flight
   `soft_deleted_purge` may be hard-deleting; today only the sync-run guard is applied. This is a
   behaviour change (a folder delete during a purge now errors instead of proceeding) — call it out
   in the PR.

## Git workflow

- Branch: `agent/049-maintenance-scheduler`
- Commit message: `Deepen Pane View maintenance job scheduling`

## Steps

### Step 1: Extract the eligibility query once

Add `server/management/orphaned-sources.ts` exporting `orphanedMediaObjectCondition()` (returns the
`and(exists(deletedReference), notExists(activeReference))` SQL against `mediaObjects`) and
`orphanedShutterSourceCondition()` (the `shutter_source_cleanup` variant with `notExists(alreadyQueued)`).
Replace the three inline copies.

**Verify**: a rendered-SQL test proves both conditions render as before (capture the current SQL
from one of the three sites first and pin it); the three purge test files still pass unchanged.

### Step 2: Add the progress parser at the worker's seam

Create `server/management/maintenance-progress.ts`:

```ts
export type MaintenanceJobType = "library_hard_wipe" | "soft_deleted_purge" | "shutter_source_purge";
export function parseMaintenanceProgress(type: MaintenanceJobType, raw: unknown):
  | { ok: true; progress: MaintenanceJobProgress }
  | { ok: false; reason: string };
export function initialProgressFor(type: MaintenanceJobType): MaintenanceJobProgress;
```

The parser validates `phase` against the per-type phase list and `processedCount` as a non-negative
integer; for `library_hard_wipe` it also passes through `orphanPrefix`/`orphanContinuationToken` when
strings. It maps the retired `s3_derivatives` phase to `s3_originals` **only when `type ===
"library_hard_wipe"`**; for any other type an unknown phase is `{ ok: false }`.

Drop `errorCount`/`lastError` from the three progress interfaces in `db/schema.ts:389-410`; the parser
ignores extra keys so stored rows still load.

**Verify**: `maintenance-progress.test.ts` covers: valid progress for each type; wrong-type phase
rejected; `s3_derivatives` accepted for wipe and rejected for purge; extra keys ignored;
`processedCount: -1` and `"3"` rejected.

### Step 3: Route the worker through the parser and fail closed

In `cleanup-worker.ts`:

- `processMaintenanceJobBatch`: replace the three casts and the inline `s3_derivatives` block with
  `parseMaintenanceProgress(job.type, job.progress)`. On `{ ok: false }`, mark the job `failed` with
  `error: "Unrecognised job progress: <reason>"` and return `false`. This is the fix for the
  cross-type phase leak.
- `readCleanupJobStatus`: same parser; return `null` on failure as it does for retired types.
- Remove the `lastError: undefined` write at `:277` and the `errorCount` passthrough at `:181`.
- Extract the repeated "complete this job" update (`:290-303`, `:373-386`, `:551-566`) into one
  `completeMaintenanceJob(jobId, progress)`.
- Extract the repeated `isMaintenanceJobActive` + `updateJobProgress` shape unchanged — they are
  already single functions; leave them.

Update `guards.ts:53-92` `readActiveCleanupJob` to drop `errorCount` and to stop defaulting `phase`
to `"s3_originals"` — return the raw string and let `overview.ts` render it. Update
`overview.ts:8-14` and `CleanupJobProgress.tsx:103-108` accordingly.

**Verify**: new `cleanup-worker.test.ts` with `../db` mocked the way `soft-deleted-purge.test.ts`
mocks it: (a) a `soft_deleted_purge` row whose progress phase is `s3_derivatives` is marked `failed`,
not advanced; (b) a `library_hard_wipe` row with `s3_derivatives` is advanced to `s3_originals`; (c)
each type's `completed` phase returns `false` and does not touch the DB; (d) a batch that throws
marks the job `failed` with the error message and clears `runningJobs`.

### Step 4: One scheduler

Create `server/management/maintenance-scheduler.ts`:

```ts
export interface MaintenanceJobDescriptor {
  type: MaintenanceJobType;
  /** Return true if there is work; runs inside the scheduling transaction. */
  probe(tx: Transaction): Promise<boolean>;
  /** Optional work to do inside the same transaction before the job row is inserted (library wipe). */
  prepare?(tx: Transaction): Promise<void>;
  emptyMessage?: never; // callers map { phase: "empty" } themselves
}
export async function scheduleMaintenanceJob(descriptor): Promise<{ jobId: string | null; phase: "empty" | "scheduled" }>;
```

The scheduler owns: `db.transaction` → `acquireLibraryMutationStartupLock` → `assertNoActiveSyncRun`
→ `readActiveCleanupJob` guard (message: `"A cleanup job is already in progress."`) → `prepare?` →
`probe` → insert with `initialProgressFor(type)` → `processMaintenanceJob(jobId)` after commit →
`23505` mapped to the same "already in progress" error for every type (today only wipe does this).

Rewrite the three `schedule*` exports as thin descriptors calling it:

- `scheduleSoftDeletedPurge` — probe: any `libraryEntries.deletedAt IS NOT NULL`.
- `scheduleShutterSourcePurge` — probe: queued unpurged source OR `orphanedMediaObjectCondition()`.
- `scheduleLibraryWipe` — keeps its confirmation string and `assertSyncApiTokenFromBody` **outside**
  the scheduler (they are input validation, not scheduling); `prepare` does the soft-delete/cascade
  block at `library-wipe.ts:52-60`; probe returns `true`. Return type stays `{ jobId: string;
  phase: "scheduled" }` by asserting `jobId` non-null.

**Verify**: replace the three prologue-asserting test files with one `maintenance-scheduler.test.ts`
covering: lock acquired before guards; sync-run guard failure aborts before probe; active-job guard
failure aborts before probe; probe `false` → `{ jobId: null, phase: "empty" }` and no insert; probe
`true` → insert with `initialProgressFor(type)` and `processMaintenanceJob` called **after** the
transaction resolves; `23505` → "already in progress" for all three types. Keep one small test per
descriptor for its own probe/prepare (wipe's confirmation string, wipe's cascade block, purge's
eligibility condition).

### Step 5: Guard consistency

`management-service.ts:60-65` `deleteFolders`: add `assertNoActiveCleanupJob()` alongside
`assertNoActiveSyncRun()`. Add a comment in `folder-delete.ts` stating it is guard-free by design and
must only be called from `management-service.ts` (or move the two guards into
`softDeleteFolderSubtree` itself — executor's choice; prefer moving them in, since the deletion test
says the guards belong with the mutation).

**Verify**: `folder-delete.test.ts` gains a case that a delete during an active cleanup job throws.

### Step 6: Manual smoke

With `pnpm dev:pane`, a synced archive, and something soft-deleted:

- [ ] `/manage` → "Purge deleted items" schedules, progresses through `orphaned_media` →
      `db_hard_delete` → completed; UI no longer shows an error-count line.
- [ ] Start a purge, then immediately try "Purge Shutter sources" → "already in progress".
- [ ] Cancel a running job → status `cancelled`; polling stops.
- [ ] Wipe still requires `WIPE LIBRARY` + token and completes end-to-end (use a scratch DB/bucket).

## Test plan

Rendered-SQL pin for the eligibility condition (Step 1); pure parser tests (Step 2); worker tests
with the existing `../db` mock style (Step 3); one scheduler test file replacing three (Step 4). Net
test file count in `server/management/` should not grow by more than one.

## Done criteria

- [ ] `scheduleMaintenanceJob` is the only place the scheduling prologue exists.
- [ ] `parseMaintenanceProgress` is the only way progress enters the worker or the status reader;
      a wrong-type phase fails the job instead of advancing it.
- [ ] Orphaned-source eligibility SQL exists once.
- [ ] `errorCount`/`lastError` are gone from types, worker, guards, overview, and UI.
- [ ] `deleteFolders` is guarded like the schedulers.
- [ ] `cleanup-worker.ts` has a test file; `pnpm --filter @latch-works/pane-view check` passes.

## STOP conditions

- The user wants `errorCount` wired (continue-past-failure semantics) — that is a behaviour design,
  not a refactor; write it up separately before touching the worker.
- The user wants the cross-type constraint in the DB now — generate it as its own migration and
  commit, rather than folding schema change into this refactor.
- A live deployment has an active job at the moment of deploy: the parser change is
  backward-compatible with stored rows, but confirm no job is mid-flight before rolling out.

## Maintenance notes

New job types are one descriptor plus one phase list in `maintenance-progress.ts` plus a `switch`
arm in the worker. Reviewers should reject any new `db.transaction` that re-implements the guard
prologue outside `maintenance-scheduler.ts`. As a follow-up, add a partial unique index on
`status in ('pending','running')` without the `type` column, and drop the app-level
`readActiveCleanupJob` check inside the scheduler in favour of catching `23505`.
