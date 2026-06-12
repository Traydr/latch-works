# Lockstep Desktop App Overhaul

## Summary
- Build a separate installed Electron/React desktop app for Lockstep as the primary UX.
- Keep the CLI as a thin scriptable surface over the same shared engine.
- Extract Lockstep behavior into a headless core so desktop, CLI, and future integrations cannot drift.
- Support named profiles, encrypted sync-token storage, remembered run data, and an explicit separate delete/prune step.

## Key Changes
- Create `@latch-works/lockstep-core` under [packages](/Users/traydr/dev/latch-works/packages) with no `console`, `process.exitCode`, prompts, or UI concerns.
- Core API:
  - `planSync(options, observer)` fetches/loads remote snapshot, scans local archive, returns counts/items/skipped entries.
  - `pushChanges(options, observer)` applies only `upload` and `update` items.
  - `pruneDeleted(options, observer)` applies only `delete` items.
  - `doctor(options, observer)` checks source path, API URL, token, and snapshot reachability.
  - All long-running APIs accept `AbortSignal` and emit structured events for scan, hash, upload, item success/failure, completion, and cancellation.
- Add `signal?: AbortSignal` support to `scanArchive` in `@latch-works/media-index`.
- Create separate `apps/lockstep` Electron Forge + Vite + React app, following Frame View’s IPC/security style: main-process services, preload bridge, Zod contracts, `better-result` result payloads.
- Desktop UX:
  - Profile setup/profile switcher with source folder picker, Pane View API URL, encrypted token save, and “Test connection”.
  - Dashboard showing selected profile, source, target, last run, health, and actions: Plan, Push uploads/updates, Apply deletes, Doctor.
  - Plan results screen with counts for upload/update/keep/delete, skipped files, searchable/filterable changed-item list, and clear warnings for delete actions.
  - Push flow never applies deletes; delete/prune requires its own confirmation after a plan.
  - Run progress screen supports cancel and stores last-run summaries.
- Persistence/security:
  - Store profiles and run summaries in Electron `userData/lockstep-settings.json`.
  - Store token as an Electron `safeStorage` encrypted blob; renderer only sees `tokenConfigured: boolean`.
  - If encryption is unavailable, allow session-only token entry and do not write token to disk.
  - Migrate existing `~/.latch-works/lockstep.json` into a default profile when no desktop profiles exist.
- CLI:
  - Refactor [tools/lockstep](/Users/traydr/dev/latch-works/tools/lockstep) to call `@latch-works/lockstep-core`.
  - Keep `plan`, `push`, `verify`, and `doctor`.
  - Change `push` to upload/update only by default.
  - Add `prune` for explicit remote delete application.
  - Update docs to call out the safer delete split.

## Public Interfaces
- New package export: `@latch-works/lockstep-core`.
- New shared types: `LockstepProfile`, `LockstepPlan`, `LockstepPlanItem`, `LockstepRunEvent`, `LockstepRunSummary`, `DoctorResult`.
- Desktop preload API exposes profile CRUD, source folder picker, `doctor`, `plan`, `push`, `prune`, run cancellation, and run-event subscription.
- Pane View sync API remains unchanged.

## Test Plan
- Core unit tests with fake fetch/storage responses for plan, push, prune, failure finalization, max-change caps, and cancellation.
- `media-index` tests for scan cancellation during directory walk and hashing.
- CLI tests for preserved commands plus new `prune` behavior and “push excludes deletes” behavior.
- Desktop main-process tests for profile persistence, migration, encrypted-token redaction, IPC validation, and cancellation.
- Renderer tests for setup, dashboard, plan results, push confirmation, and delete confirmation.
- Manual verification: create profile, run doctor, plan a fixture archive, push upload/update changes, then apply deletes separately.

## Assumptions
- V1 is a separate Lockstep desktop app, not inside Frame View.
- Named profiles are required for local/production targets.
- Encrypted local token storage is the default, with session-only fallback.
- OpenTUI is deferred because its current docs point native rendering toward Bun or Node 26.3+ experimental FFI, while this repo currently runs Node 24. Sources checked: [OpenTUI getting started](https://opentui.com/docs/getting-started/) and [standalone executables](https://opentui.com/docs/reference/standalone-executables/).
