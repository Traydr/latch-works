# Final Code Review

Date: 2026-06-12

Scope: the full Latch Works monorepo: shared packages, Pane View, Frame View, Gather Box,
Showcase, Lockstep, docs, and root tooling.

## Executive Summary

The codebase has a sensible shape: shared media packages, a clear Lockstep-to-Pane sync path, and
good security primitives in several places. The highest-risk problems are not architectural
sprawl; they are a handful of missing guards at the boundaries:

- unsupported media is not rejected consistently;
- one major server function is missing auth;
- sync ingest trusts too much client-supplied metadata;
- Lockstep capped push changes hash behavior in a surprising way;
- tests are thin around the exact paths that mutate or expose the archive.

Fixing those first will give the rest of the project a much steadier floor.

## P0 Findings

### P0-1: Unsupported files are indexed and can enter sync

Evidence:

- `packages/media-index/src/scan.ts:117` calls `detectMediaType(entry.name)`.
- `packages/media-index/src/scan.ts:118` checks `if (!mediaType)`.
- `detectMediaType()` returns `"unknown"` for unsupported extensions, and `"unknown"` is truthy.
- `apps/pane-view/src/routes/api.sync.upload-url.ts:31` repeats the same pattern.

Impact:

- `.txt`, `.zip`, and other unsupported files can be indexed as media.
- Lockstep can plan and push non-media files.
- Pane View can issue upload URLs for unsupported filenames.

Fix:

- Use `isSupportedMediaFile()` or explicitly reject `mediaType === "unknown"` in both locations.
- Add tests for unsupported local scan entries and unsupported upload-url requests.

### P0-2: `getLibrarySnapshot` has no auth check

Evidence:

- `apps/pane-view/src/features/library/library-service.ts:37` protects `deleteLibraryEntry`.
- `apps/pane-view/src/features/library/library-service.ts:48` starts `getLibrarySnapshot`.
- The snapshot handler reads database state at line 56 without checking the current session.

Impact:

- Route guards protect normal navigation, but the server function can be called independently.
- The response exposes logical paths, names, UUIDs, sizes, SHA-256 values, media types, and ready
  thumbnail CDN URLs.

Fix:

- Require `isCurrentWebSessionValid()` at the top of `getLibrarySnapshot`.
- Add an auth regression test for this server function.

### P0-3: Sync ingest accepts inconsistent client metadata

Evidence:

- `apps/pane-view/src/routes/api.sync.complete-object.ts:49` validates `mediaType` with a schema
  that includes `"unknown"`.
- `apps/pane-view/src/routes/api.sync.complete-object.ts:71` passes through a client-supplied
  `objectKey`.
- `apps/pane-view/src/server/sync/store.ts:81` uses the supplied object key when present.
- `completeSyncedObject()` persists `filename`, `logicalPath`, `extension`, `mediaType`,
  `sha256`, `size`, and `objectKey` without consistency checks.

Impact:

- A sync-token holder or compromised client can bind a library entry to the wrong bucket key.
- The database can contain unsupported media, mismatched paths/filenames, or object keys that do
  not match the declared SHA-256.

Fix:

- Reject `mediaType === "unknown"`.
- Validate SHA-256 format.
- Normalize and reject unsafe logical paths.
- Derive `filename`, `extension`, and `objectKey` server-side where possible.
- If an `objectKey` is accepted for compatibility, require it to equal the derived key.

## P1 Findings

### P1-1: Lockstep capped push disables pre-plan hashing

Evidence:

- `tools/lockstep/src/commands.ts:70` sets `willHash` to true for push only when
  `!options.maxChanges`.
- `tools/lockstep/src/commands.ts:146` slices changed items for capped pushes.

Impact:

- `push --max-changes` without `--hash` can miss same-size content changes before upload begins.
- Deletes are appended after local upload/update plan items, so capped pushes can delay deletes.

Fix:

- Always hash for `push`, regardless of `--max-changes`.
- Consider bucketing capped pushes so deletes are not silently starved.
- Add command tests for capped push planning.

### P1-2: Sync runs never finalize

Evidence:

- Lockstep creates a sync run before pushing.
- Pane View has no completion/failure endpoint.
- Per-item failures only affect the final process exit code.

Impact:

- `sync_runs.status` can remain `"running"` forever after both successful and failed pushes.
- Operational history is hard to trust.

Fix:

- Add a sync-run finalization endpoint.
- Call it in a `finally` block with success/failure counts and status.

### P1-3: Derivative rows can stay `processing` forever

Evidence:

- `apps/pane-view/src/server/media/derivative-service.ts:134` treats `processing` as pending.
- `apps/pane-view/src/server/media/derivative-service.ts:163` claims work by setting
  `processing`.
- There is no stale job timeout or lease reclaim.

Impact:

- If the process crashes after claiming a derivative, later requests can return 503 forever.

Fix:

- Add a processing timeout based on `updatedAt`.
- Reclaim stale jobs back to `pending` or retry them directly.

### P1-4: Gather Box needs centralized URL and filename validation

Evidence:

- `apps/gather-box/src/popup/downloader.ts:61` fetches `image.originalUrl` directly.
- `apps/gather-box/src/popup/downloader.ts:67` writes `image.fileName` directly.
- Some collectors validate hosts well, but Kemono accepts DOM `href` values directly and AO3/HF
  primarily check PDF path suffixes.

Impact:

- Browser host permissions limit the blast radius, but final fetch/write policy is scattered.
- Filenames from DOM or URL basenames are not consistently sanitized.

Fix:

- Add central `assertAllowedDownloadUrl(site, url)`.
- Sanitize file names at the downloader boundary.
- Add collector fixture tests and downloader tests.

### P1-5: Frame View directory listing IPC lacks path authorization

Evidence:

- `apps/frame-view/src/main/ipc/registerIpc.ts:194` handles `listFolderChildren`.
- It validates and resolves the path, then calls `listFolderChildren()` at line 212.
- Nearby `revealInFolder` and `probeVideoMetadata` handlers call `isAuthorizedMediaPath()`.

Impact:

- Renderer code can enumerate directories outside authorized media roots.
- Severity is medium for the current local packaged app, higher if untrusted renderer content is
  ever introduced.

Fix:

- Require a selected/authorized root before listing children.
- Add IPC tests for authorized and unauthorized paths.

## P2 Findings

### P2-1: Pane View derivative generation is request-bound

Thumbnail and preview routes can invoke Sharp/ffmpeg work in the request path. There is a source
size cap, but no request rate limit or queue limit. This is mainly an authenticated-session DoS
risk.

### P2-2: Login has no throttling

Login uses timing-safe comparison, but has no rate limit, lockout, or backoff. Add a small
single-user-friendly throttle.

### P2-3: Folder counts are not maintained

The `folders` table exposes `entry_count` and `folder_count`, but sync folder upserts do not update
them. Current UI does not heavily depend on these values, but the API contract is misleading.

### P2-4: Root linting excludes two apps

`biome.json` excludes `apps/frame-view` and `apps/gather-box`. Frame View has its own lint script,
but Gather Box does not. Root docs should not imply a complete workspace lint pass unless this is
intentional and documented.

### P2-5: Test coverage is concentrated away from risky paths

Focused package tests pass, but missing coverage lines up with the main bugs:

- no unsupported-extension scan test;
- no library snapshot auth test;
- no sync route validation tests;
- no Lockstep push/network tests;
- no Gather Box tests.

## Recommended First Patch Batch

1. Fix unsupported-media checks in `scanArchive` and `/api/sync/upload-url`.
2. Add auth to `getLibrarySnapshot`.
3. Harden `/api/sync/complete-object` validation and object-key derivation.
4. Make Lockstep hash on every push.
5. Add tests for all four changes.

After that, address derivative stale-job reclaim, sync-run finalization, Gather Box URL validation,
and Frame View directory authorization.
