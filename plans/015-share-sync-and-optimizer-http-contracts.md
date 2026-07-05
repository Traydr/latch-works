# Plan 015: Share Sync And Optimizer HTTP Contracts

> **Executor instructions**: Run the drift check first. This plan consolidates
> contracts after the behavior is characterized and content-type validation is
> fixed. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 8f19cd4..HEAD -- apps/media-optimizer/src/pane-view-client.ts apps/pane-view/src/server/media/optimizer-jobs-service.ts apps/pane-view/src/server/sync/validation.ts packages/lockstep-core/src/remote-api.ts packages/*/src apps/*/package.json packages/*/package.json pnpm-lock.yaml`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/002-add-sync-orchestration-and-route-tests.md, plans/004-validate-sync-content-types-and-nosniff.md
- **Category**: tech-debt
- **Planned at**: commit `8f19cd4`, 2026-07-05

## Why This Matters

Pane View, Lockstep Core, and Media Optimizer describe the same HTTP payloads in
different files. The optimizer client casts JSON to interfaces without runtime
validation, while Pane View has Zod schemas for optimizer requests and a
hand-written sync validator. Shared contracts reduce drift as the sync and
derivative APIs evolve.

## Current State

- `apps/media-optimizer/src/pane-view-client.ts:5-23` declares `DerivativeJob`
  and `ClaimResponse`; `pane-view-client.ts:52` casts `response.json()` to that
  response type.
- `apps/pane-view/src/server/media/optimizer-jobs-service.ts:15-51` defines Zod
  request schemas and a matching `ClaimResponse` interface.
- `packages/lockstep-core/src/remote-api.ts:137-153` hand-builds the
  `complete-object` payload.
- `apps/pane-view/src/server/sync/validation.ts:30-117` manually validates and
  normalizes the same payload.

## Commands You Will Need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Package checks | `pnpm --filter @latch-works/lockstep-core check && pnpm --filter @latch-works/pane-view check && pnpm --filter @latch-works/media-optimizer check` | exit 0 |
| Full check | `pnpm check` | exit 0 |

## Scope

**In scope**:
- New shared package such as `packages/sync-contracts`, or a clearly named
  existing package if dependency direction stays clean
- Sync and optimizer contract schemas/types
- Consumers in Pane View, Lockstep Core, and Media Optimizer
- Package manifests and lockfile for the new workspace dependency

**Out of scope**:
- Changing endpoint URLs.
- Changing object-key layout.
- Adding source metadata/sidecars; the maintainer rejected that direction for now.
- Broad API redesign beyond sharing existing contracts.

## Git Workflow

- Branch: `advisor/015-shared-http-contracts`
- Commit message: `Share sync and optimizer contracts`

## Steps

### Step 1: Choose A Dependency-Safe Home

Prefer a new `packages/sync-contracts` package with no runtime dependencies
beyond `zod` and domain/storage helpers if needed. It must not import from apps.
If adding a package is too much, STOP and propose the alternative before folding
contracts into an existing package.

**Verify**: `pnpm -r --filter './packages/*' build` -> new package builds in dependency order.

### Step 2: Move Optimizer Contracts First

Move optimizer request schemas, `DerivativeJob`, and claim/match response schemas
into the shared package. Pane View should use the schemas for request validation
and response typing. Media Optimizer should parse `claimJobs` responses with the
shared response schema instead of `as ClaimResponse`.

**Verify**: `pnpm --filter @latch-works/media-optimizer test && pnpm --filter @latch-works/pane-view test -- optimizer` -> exits 0.

### Step 3: Move Sync Payload Contracts

Create a shared `completeObjectPayloadSchema` and related types. Preserve Pane
View's server-side normalization and validation from Plan 004: logical path
normalization, object-key derivation, extension/media checks, and content-type
allowlist. Lockstep Core should import the payload type/helper so it cannot drift
from Pane View.

**Verify**: `pnpm --filter @latch-works/lockstep-core test && pnpm --filter @latch-works/pane-view test -- validation sync` -> exits 0.

### Step 4: Remove Duplicate Local Interfaces

Delete local optimizer interfaces and hand-rolled payload types that are now
provided by the shared package. Keep app-specific wrappers for URL construction,
auth, and logging.

**Verify**: `pnpm check` -> exits 0.

## Test Plan

- Shared schema tests for valid/invalid sync payloads.
- Media Optimizer client test for invalid claim response rejection.
- Existing Pane View route/store and Lockstep Core tests pass.

## Done Criteria

- [ ] Optimizer client parses claim responses with a shared schema.
- [ ] Pane View and Lockstep Core use the same sync payload type/schema.
- [ ] No `as ClaimResponse` remains in `pane-view-client.ts`.
- [ ] Package checks and full check exit 0.
- [ ] `plans/README.md` status row updated.

## STOP Conditions

- Shared package introduces a circular dependency.
- Preserving sync path normalization cannot be expressed cleanly in the shared
  schema.
- Contract consolidation requires source metadata fields rejected by maintainer.

## Maintenance Notes

- Future API fields should be added to shared schemas first, then consumed by
  both sides in the same PR.
