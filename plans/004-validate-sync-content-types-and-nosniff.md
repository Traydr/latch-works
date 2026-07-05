# Plan 004: Validate Sync Content Types And Add Nosniff

> **Executor instructions**: Run the drift check first. Do not weaken object-key
> validation while adding content-type validation. Update `plans/README.md` when
> done.
>
> **Drift check (run first)**: `git diff --stat 8f19cd4..HEAD -- apps/pane-view/src/server/sync apps/pane-view/src/routes/api.sync.upload-url.ts apps/pane-view/src/server/media/cdn-response.ts packages/lockstep-core/src/remote-api.ts`

## Status

- **Status**: DONE
- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/002-add-sync-orchestration-and-route-tests.md
- **Category**: security
- **Planned at**: commit `8f19cd4`, 2026-07-05
- **Pull request**: https://github.com/Traydr/latch-works/pull/50
- **Merged**: 2026-07-05, merge commit `86f1788`
- **Verified**: GitHub `Check` passed on PR #50 and latest `main` check passed
  at https://github.com/Traydr/latch-works/actions/runs/28746243602

## Completion Notes

- Added server-side expected content-type mapping for sync payload validation.
- Upload URL signing now uses the server-derived content type.
- CDN responses include `X-Content-Type-Options: nosniff`.
- Added focused validation, sync route, and CDN response coverage.

## Why This Matters

Pane View validates logical paths and object keys, but it stores and serves the
client-supplied `contentType` verbatim. Delivery then uses that stored header on
`/cdn/v1/*` responses without `X-Content-Type-Options: nosniff`. The server
should derive or allowlist media content types from the already-validated
extension/media type.

## Current State

- `api.sync.upload-url.ts:44-46` passes `body.contentType ??
  "application/octet-stream"` into the signed S3 PUT URL.
- `validation.ts:103-107` returns `contentType: String(body.contentType)` after
  validating path, extension, media type, sha256, and object key.
- `cdn-response.ts:34-38` sets `content-type` from the stored object and does not
  set `X-Content-Type-Options`.
- The legitimate Lockstep mapping is in `packages/lockstep-core/src/remote-api.ts:227-251`.

## Commands You Will Need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Pane View tests | `pnpm --filter @latch-works/pane-view test -- validation cdn-response sync` | exit 0 |
| Typecheck | `pnpm --filter @latch-works/pane-view typecheck` | exit 0 |
| Lockstep tests | `pnpm --filter @latch-works/lockstep-core test` | exit 0 if shared helper changes |

## Scope

**In scope**:
- `apps/pane-view/src/server/sync/validation.ts`
- `apps/pane-view/src/routes/api.sync.upload-url.ts`
- `apps/pane-view/src/server/media/cdn-response.ts`
- Related Pane View tests
- Optional shared content-type helper if you choose to remove duplication with
  `packages/lockstep-core/src/remote-api.ts`

**Out of scope**:
- Replacing all sync contracts with Zod. Plan 015 handles broader contracts.
- Changing S3 object key layout.
- Adding support for new media extensions.

## Git Workflow

- Branch: `advisor/004-sync-content-type-nosniff`
- Commit message: `Validate sync content types`

## Steps

### Step 1: Add A Server-Side Content-Type Mapping

Add a helper near sync validation that maps validated extensions to expected
content types. Match the current Lockstep mapping:

- `jpg`/`jpeg` -> `image/jpeg`
- `png` -> `image/png`
- `webp` -> `image/webp`
- `gif` -> `image/gif`
- `avif` -> `image/avif`
- `mp4`/`m4v` -> `video/mp4`
- `webm` -> `video/webm`
- `mov` -> `video/quicktime`
- `pdf` -> `application/pdf`

Reject any unsupported extension/content-type mismatch. If you create a shared
helper, update Lockstep to import it rather than duplicating the list.

**Verify**: `pnpm --filter @latch-works/pane-view test -- validation` -> new mismatch tests fail before implementation, pass after.

### Step 2: Validate Upload URL Requests

In `api.sync.upload-url.ts`, derive extension and media type from the filename.
If the request includes `contentType`, reject it unless it matches the helper.
Pass the expected content type into `createSignedPutUrl`; do not default to an
arbitrary client value.

**Verify**: `pnpm --filter @latch-works/pane-view test -- sync` -> upload-url route tests cover valid and mismatched content types.

### Step 3: Validate Complete Object Payloads

In `validateSyncObjectPayload`, after extension/media type validation, check
`body.contentType` against the expected content type. Return a 400 validation
error for mismatches.

**Verify**: `pnpm --filter @latch-works/pane-view test -- validation` -> includes mismatch test for complete-object payload.

### Step 4: Add Nosniff To CDN Responses

In `cdn-response.ts`, add `"x-content-type-options": "nosniff"` to the response
headers. Keep existing range, cache, etag, and content-length behavior.

**Verify**: `pnpm --filter @latch-works/pane-view test -- cdn-response` -> asserts `x-content-type-options` exists.

## Test Plan

- New validation tests for every allowed mapping and at least one mismatched
  value.
- Upload-url route test for rejected mismatch.
- CDN response test for `nosniff` on GET and HEAD.

## Done Criteria

- [x] Client-supplied content type is never persisted unless it matches the
  server-derived media mapping.
- [x] Upload URL signing uses the server-derived content type.
- [x] `/cdn/v1/*` responses include `X-Content-Type-Options: nosniff`.
- [x] Focused tests and the GitHub `Check` workflow exited 0.
- [x] `plans/README.md` status row updated.

## STOP Conditions

- Existing archives contain content types outside the mapping and must remain
  deliverable without migration.
- A shared helper would create a circular workspace dependency.
- The fix requires changing the public Lockstep CLI payload shape.

## Maintenance Notes

- When adding a new media extension, update tests for both Lockstep upload and
  Pane View validation in the same PR.
