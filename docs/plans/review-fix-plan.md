# Review Fix Plan

Date: 2026-06-12

Source findings:

- `docs/analysis/final-code-review.md`
- `docs/analysis/prior-review-validation.md`
- `docs/analysis/documentation-audit.md`

Goal: fix the validated review issues without broad refactors, prioritizing archive correctness,
auth boundaries, sync integrity, and tests for the risky paths.

## Principles

- Fix boundary validation before adding new behavior.
- Add regression tests in the same patch as each fix.
- Keep compatibility with existing Lockstep clients unless a validation issue requires a clear
  breaking change.
- Prefer shared helpers over repeating extension, path, and object-key rules.
- Do not spend time on the rejected Gather Box font issue; the font files exist.

## Phase 1: Archive Boundary Guards

Purpose: stop unsupported and unauthenticated data flow at the earliest points.

### 1.1 Fix unsupported media filtering

Files:

- `packages/media-index/src/scan.ts`
- `packages/media-index/src/scan.test.ts`
- `apps/pane-view/src/routes/api.sync.upload-url.ts`

Implementation:

- Replace truthiness checks on `detectMediaType()` with `mediaType === "unknown"` or
  `isSupportedMediaFile()`.
- Keep `skippedEntries` reason as `"unsupported-extension"` in `scanArchive`.
- Make `/api/sync/upload-url` return `400` for unsupported filenames.

Tests:

- Add a scan test with `notes.txt`, `archive.zip`, and one valid media file.
- Add route/helper-level coverage for upload-url rejecting unsupported filenames if the current
  route testing setup allows it. If route testing is awkward, extract validation to a small pure
  helper and test that helper.

Verification:

- `pnpm --filter @latch-works/media-index test`
- `pnpm --filter @latch-works/pane-view test`

### 1.2 Add auth to `getLibrarySnapshot`

Files:

- `apps/pane-view/src/features/library/library-service.ts`
- `apps/pane-view/src/features/library/library-service.test.ts` or nearest existing test location

Implementation:

- Add `isCurrentWebSessionValid()` at the start of `getLibrarySnapshot`.
- Return/throw consistently with other server functions. If keeping `throw new Error("Unauthorized")`,
  use the same pattern as `deleteLibraryEntry` for now.
- Consider adding a small shared `requireCurrentWebSession()` helper after this fix, but do not
  block the bug fix on middleware refactoring.

Tests:

- Unauthenticated snapshot request rejects before reading the repository.
- Authenticated snapshot request still calls `readDatabaseLibrarySnapshot` with normalized inputs.

Verification:

- `pnpm --filter @latch-works/pane-view test`
- `pnpm --filter @latch-works/pane-view typecheck`

## Phase 2: Sync Ingest Integrity

Purpose: ensure the sync API persists only internally consistent media metadata.

### 2.1 Centralize sync object validation

Files:

- `apps/pane-view/src/routes/api.sync.complete-object.ts`
- `apps/pane-view/src/server/sync/store.ts`
- New helper, for example `apps/pane-view/src/server/sync/validation.ts`
- Tests beside the helper or sync store

Implementation:

- Reject `mediaType === "unknown"`.
- Validate SHA-256 with the same 64-char hex rule as `media-storage`.
- Normalize `logicalPath` with shared archive path helpers.
- Reject empty paths, paths containing `..` segments, absolute paths, or trailing slash file paths.
- Derive `filename` from `logicalPath` and require it to match the submitted `filename`, or stop
  accepting submitted `filename`.
- Derive `extension` from `filename` and require it to match submitted `extension`.
- Recompute `objectKey` from `sha256`, `extension`, and `mediaType`.
- If clients still send `objectKey`, require equality with the derived key.

Tests:

- Valid image ingest is accepted.
- `"unknown"` media is rejected.
- Invalid SHA-256 is rejected.
- Mismatched object key is rejected.
- Mismatched filename/logicalPath is rejected.
- Mismatched extension is rejected.

Verification:

- `pnpm --filter @latch-works/pane-view test`
- `pnpm --filter @latch-works/pane-view typecheck`

### 2.2 Add sync-run finalization

Files:

- `apps/pane-view/src/server/sync/store.ts`
- New route such as `apps/pane-view/src/routes/api.sync.runs.$syncRunId.complete.ts`
- `tools/lockstep/src/commands.ts`

Implementation:

- Add a Pane View API endpoint that marks a sync run `completed` or `failed`, sets `completedAt`,
  and stores final counts/error text.
- Keep bearer sync-token auth.
- In Lockstep, call finalization in a `finally` block after the item loop.
- Include `pushed`, `failed`, and total planned/capped counts.

Tests:

- Store-level tests for finalizing completed and failed runs.
- Lockstep command tests with mocked fetch: all-success run finalizes completed; partial failure
  finalizes failed.

Verification:

- `pnpm --filter @latch-works/pane-view test`
- `env -u LOCKSTEP_API_URL -u LOCKSTEP_API_TOKEN pnpm --filter @latch-works/lockstep test`

## Phase 3: Lockstep Push Correctness

Purpose: make `push` safe and predictable for first-deployment and capped batches.

### 3.1 Always hash for push

Files:

- `tools/lockstep/src/commands.ts`
- `tools/lockstep/src/commands.test.ts`

Implementation:

- Change `willHash` so every `push` hashes during scan, regardless of `--max-changes`.
- Keep `plan` and `verify` behavior explicit: `--hash` means content-accurate; no `--hash` means
  size-based comparison.
- Update progress/output copy if needed.

Tests:

- `push --max-changes 1` calls `scanArchive` with `hashFiles: true`.
- `plan --max-changes` is not applicable and should not change hashing behavior.

Verification:

- `env -u LOCKSTEP_API_URL -u LOCKSTEP_API_TOKEN pnpm --filter @latch-works/lockstep test`

### 3.2 Make capped deletes explicit

Files:

- `tools/lockstep/src/commands.ts`
- `tools/lockstep/README.md`
- `docs/runbooks/lockstep.md`

Implementation options:

- Preferred: order capped changes by action buckets so deletes are not indefinitely delayed.
- Simpler acceptable option: keep current ordering but print a warning when capped items omit any
  deletes, including the number delayed.

Tests:

- Capped push with uploads and deletes either includes deletes according to the chosen policy or
  prints the warning.

Verification:

- Lockstep tests.

### 3.3 Add local path containment guard

Files:

- `tools/lockstep/src/commands.ts`

Implementation:

- Resolve `sourceRoot` and the joined local file path.
- Reject any non-delete local path outside the resolved source root.
- Keep platform path casing in mind on Windows.

Tests:

- Valid archive path resolves inside source.
- `../outside.jpg` is rejected.

## Phase 4: Media Delivery Resilience

Purpose: prevent broken derivatives and reduce expensive request-path work.

### 4.1 Reclaim stale derivative jobs

Files:

- `apps/pane-view/src/server/media/derivative-service.ts`
- Tests for derivative service behavior

Implementation:

- Define a processing lease timeout, for example 10 minutes.
- When an existing row is `processing` and `updatedAt` is older than the timeout, reclaim it by
  setting status back to `pending` or by claiming it directly.
- Keep normal concurrent request behavior: fresh `processing` rows still return pending.

Tests:

- Fresh processing row returns pending.
- Stale processing row is reclaimed and generation proceeds or is marked retryable.

### 4.2 Add a lightweight derivative throttle plan

Files:

- `apps/pane-view/src/server/media/derivative-service.ts`
- Possible new queue/concurrency helper

Implementation:

- Start with a small in-process concurrency limiter around Sharp/ffmpeg derivative generation.
- Keep DB claim semantics as the cross-request coordination point.
- Defer a full worker queue until there is evidence it is needed.

Tests:

- Unit test the limiter if extracted.
- Existing derivative tests should still pass.

## Phase 5: App Hardening

Purpose: address medium-risk app boundary issues.

### 5.1 Add login throttling

Files:

- `apps/pane-view/src/routes/api.auth.login.ts`
- Possible helper under `apps/pane-view/src/server/auth/`

Implementation:

- Add a small in-memory throttle keyed by IP and username for local/private deployment.
- Use conservative values, for example 5 failed attempts per 5 minutes.
- Return the same invalid redirect to avoid revealing which field failed.

Tests:

- Failed attempts increment throttle.
- Successful login clears or ignores the failed counter.
- Throttled attempts do not call Better Auth.

### 5.2 Authorize Frame View folder listing

Files:

- `apps/frame-view/src/main/ipc/registerIpc.ts`
- `apps/frame-view/tests/main/ipc/registerIpc.test.ts`

Implementation:

- Before `listFolderChildren(resolvedPath)`, require that `resolvedPath` is within an authorized
  media root or is itself an authorized root.
- Preserve folder dialog behavior: user-selected folders should become authorized before browsing.

Tests:

- Unauthorized directory listing returns validation error.
- Authorized directory listing returns children.

### 5.3 Centralize Gather Box URL and filename validation

Files:

- `apps/gather-box/src/shared/sites.ts` or a new `download-policy.ts`
- `apps/gather-box/src/popup/downloader.ts`
- Collectors under `apps/gather-box/src/content/collectors/`
- New Gather Box tests

Implementation:

- Define allowed download URL policies by site.
- Validate final URLs in `downloadImages()` even if collectors already validate.
- Sanitize all final filenames before `getFileHandle()`.
- Keep story PDF names using the existing sanitized helper.

Tests:

- Valid URLs pass per supported site.
- Cross-site or unsupported-host URLs fail.
- Unsafe filenames are sanitized.
- Retry path revalidates persisted URLs.

## Phase 6: Folder Counts, Tooling, and Docs

Purpose: clean up lower-risk drift after correctness fixes land.

### 6.1 Decide folder count behavior

Files:

- `apps/pane-view/src/server/sync/store.ts`
- `apps/pane-view/src/server/library/repository.ts`

Implementation options:

- Remove `entryCount`/`folderCount` from returned API meaning if unused.
- Or maintain counts after sync by recomputing affected parent folders.

Preferred first step: stop using counts for `hasChildren` unless they are maintained, or compute
`hasChildren` from direct child queries.

### 6.2 Bring Gather Box into lint/test tooling

Files:

- `apps/gather-box/package.json`
- Root `biome.json` if appropriate
- Gather Box test config if adding Vitest

Implementation:

- Add a `test` script once tests exist.
- Add a `lint` script or document why root Biome excludes Gather Box.
- Keep Frame View's separate Biome config intact unless a broader lint unification is desired.

### 6.3 Update docs after fixes

Files:

- `docs/runbooks/lockstep.md`
- `docs/end-to-end-request-flow.md`
- `apps/pane-view/README.md`
- `README.md`
- `docs/ARCHITECTURE_PLAN.md`
- `tools/lockstep/README.md`

Implementation:

- Replace old `pnpm lockstep -- ...` examples with `pnpm start:lockstep -- ...`.
- Update read-only language to mention Pane View soft delete or remove the claim.
- Remove or qualify favorites/resume claims until implemented.
- Add `apps/showcase` to root workspace docs if the app remains.
- Mark `ARCHITECTURE_PLAN.md` as historical, or add implemented/planned status.
- Document final `--max-changes` behavior after the code fix.

## Suggested PR Order

1. `fix-media-boundary-validation`
   - Phase 1.1 and tests.
2. `fix-pane-snapshot-auth`
   - Phase 1.2 and tests.
3. `harden-sync-ingest`
   - Phase 2.1 and tests.
4. `fix-lockstep-push-hashing`
   - Phase 3.1, 3.2, 3.3 and tests.
5. `finalize-sync-runs`
   - Phase 2.2 and tests.
6. `reclaim-derivative-jobs`
   - Phase 4.1, optionally 4.2.
7. `harden-desktop-and-collector-boundaries`
   - Phase 5.2 and 5.3.
8. `docs-and-tooling-followup`
   - Phase 6.

## Definition of Done

- All P0 and P1 issues have code fixes and regression tests.
- No sync API path accepts `"unknown"` media.
- Unauthenticated callers cannot retrieve library snapshots.
- Capped Lockstep pushes still hash local files before planning.
- Failed or successful sync runs do not remain permanently `"running"`.
- Stale derivative `processing` rows recover without manual database edits.
- Gather Box validates final download URLs and file names at the downloader boundary.
- Frame View IPC cannot list arbitrary directories outside authorized media roots.
- Docs match the implemented command names and feature state.

## Verification Checklist

Run focused checks after each PR:

- `pnpm --filter @latch-works/media-index test`
- `pnpm --filter @latch-works/pane-view test`
- `pnpm --filter @latch-works/pane-view typecheck`
- `env -u LOCKSTEP_API_URL -u LOCKSTEP_API_TOKEN pnpm --filter @latch-works/lockstep test`
- `pnpm --filter @latch-works/gather-box typecheck`
- `pnpm --filter @latch-works/frame-view test`

Before a larger handoff, run the broadest practical workspace check. If full `pnpm check` still has
the known Frame View/Linux caveat, document the exact failing test and run the remaining workspace
checks separately.
