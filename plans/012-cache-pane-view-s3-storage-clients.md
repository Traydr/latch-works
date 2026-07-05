# Plan 012: Cache Pane View S3 Storage Clients

> **Executor instructions**: Run the drift check first. Keep env validation and
> test isolation intact. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 8f19cd4..HEAD -- apps/pane-view/src/server/media/storage-client.ts apps/pane-view/src/routes/api.sync.upload-url.ts apps/pane-view/src/server/media/*.test.ts apps/pane-view/src/server/sync/*.test.ts`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-add-github-actions-verification-baseline.md
- **Category**: perf
- **Planned at**: commit `8f19cd4`, 2026-07-05

## Why This Matters

Pane View constructs a new AWS S3 client on repeated hot paths: gallery delivery
resolution, CDN delivery, derivative work, cleanup, and sync upload URL signing.
AWS SDK clients are designed to be reused. A lazy singleton lowers CPU and heap
churn without changing external behavior.

## Current State

- `storage-client.ts:4-12` returns `createS3StorageClient(...)` every call.
- `packages/media-storage/src/s3.ts:45-61` constructs `new S3Client(...)`.
- `derivative-delivery-url.ts:6-12` calls `createPaneViewStorageClient()` when
  building dev signed URLs.
- `apps/pane-view/src/server/library/repository.ts:193-246` maps gallery rows
  with per-row `buildDerivativeDeliveryUrl(...)` calls for ready thumbnails and
  previews.
- `api.sync.upload-url.ts:44-54` constructs a separate S3 client inline instead
  of using `createPaneViewStorageClient`.

## Commands You Will Need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Pane View tests | `pnpm --filter @latch-works/pane-view test -- storage upload-url media` | exit 0 |
| Typecheck | `pnpm --filter @latch-works/pane-view typecheck` | exit 0 |

## Scope

**In scope**:
- `apps/pane-view/src/server/media/storage-client.ts`
- `apps/pane-view/src/routes/api.sync.upload-url.ts`
- Tests that mock or assert client creation behavior

**Out of scope**:
- Changing `packages/media-storage` public API.
- Changing S3 credentials/env names.
- Adding connection pooling beyond AWS SDK client reuse.

## Git Workflow

- Branch: `advisor/012-cache-pane-view-s3-client`
- Commit message: `Cache Pane View S3 client`

## Steps

### Step 1: Add Lazy Singleton With Test Reset

In `storage-client.ts`, add a module-level `let cachedStorageClient` and return
it after first creation. Add `resetPaneViewStorageClientForTests()` so tests can
clear the singleton when env/mocks change.

**Verify**: `pnpm --filter @latch-works/pane-view typecheck` -> exits 0.

### Step 2: Route Upload URL Through The Shared Client

In `api.sync.upload-url.ts`, replace the inline `createS3StorageClient` call with
`createPaneViewStorageClient()`. Remove direct env/S3 client imports that are no
longer needed.

**Verify**: `pnpm --filter @latch-works/pane-view test -- upload-url` -> route tests pass.

### Step 3: Add A Cache Test

Mock `@latch-works/media-storage` and assert two calls to
`createPaneViewStorageClient()` result in one call to `createS3StorageClient`.
Then call the reset helper and assert a new client is created.

**Verify**: `pnpm --filter @latch-works/pane-view test -- storage-client` -> exits 0.

## Test Plan

- Unit test for singleton reuse/reset.
- Existing media delivery and sync upload-url tests continue to pass.

## Done Criteria

- [ ] `createPaneViewStorageClient()` reuses a process-local client.
- [ ] Tests can reset the cached client.
- [ ] Upload-url route uses the shared accessor.
- [ ] Focused tests and typecheck exit 0.
- [ ] `plans/README.md` status row updated.

## STOP Conditions

- Tests rely on changing env values within the same module instance and cannot
  use a reset helper safely.
- Reusing the client breaks S3-compatible storage tests.

## Maintenance Notes

- If Pane View later supports per-request storage credentials, remove or key the
  singleton by config; do not keep a single global client for multiple buckets.
