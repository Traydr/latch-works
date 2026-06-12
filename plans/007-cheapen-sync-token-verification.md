# Plan 007: Remove Per-Request Scrypt From Sync Token Verification

> **Executor instructions**: Follow this plan step by step. Run every verification
> command and confirm the expected result before moving to the next step. If any
> STOP condition occurs, stop and report instead of improvising. When done,
> update this plan's row in `plans/README.md` unless a reviewer says they own the
> index.
>
> **Drift check (run first)**:
> `git diff --stat 326110f..HEAD -- apps/pane-view/src/server/auth/api-token.ts apps/pane-view/src/server/auth/*.test.ts apps/pane-view/src/routes/api.sync.*.ts`
> If any in-scope file changed, compare the excerpts below with the live code
> before proceeding. A mismatch is a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `326110f`, 2026-06-12

## Why this matters

Every sync API request verifies a bearer token by running synchronous `scrypt`
twice: once for the incoming token and once for the configured token. Sync
workflows make many upload-url and complete-object calls, so this CPU-bound
synchronous work can block the Node event loop. A bearer token stored in env does
not need password-style derivation on every request; a fixed-length digest with
constant-time comparison is enough for equality checking.

## Current state

- `apps/pane-view/src/server/auth/api-token.ts` owns sync API bearer token
  parsing and verification.
- Sync routes call `requireSyncApiToken(request)` before doing work.

Relevant excerpt at `326110f`:

```ts
// apps/pane-view/src/server/auth/api-token.ts:1-31
import { createHash, scryptSync, timingSafeEqual } from "node:crypto";
...
export function hashApiToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
...
const tokenHash = scryptSync(token, "pane-view-sync-token", 32);
const configuredHash = scryptSync(configured, "pane-view-sync-token", 32);
return timingSafeEqual(tokenHash, configuredHash);
```

Repo conventions to match:

- Keep auth helpers small and pure where possible.
- Preserve `readBearerToken`, `verifySyncApiToken`, and `requireSyncApiToken`
  public behavior unless tests show they are private.
- Do not log token values or derived values.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Auth tests | `pnpm --filter @latch-works/pane-view test -- src/server/auth` | exit 0, all auth tests pass |
| Pane typecheck | `pnpm --filter @latch-works/pane-view typecheck` | exit 0, no TypeScript errors |
| Pane tests | `pnpm --filter @latch-works/pane-view test` | exit 0, all Pane View tests pass |

## Scope

**In scope**:

- `apps/pane-view/src/server/auth/api-token.ts`
- Focused tests under `apps/pane-view/src/server/auth`
- `plans/README.md`, status row only

**Out of scope**:

- Rotating or changing actual sync token values.
- Moving tokens into the database.
- Changing Lockstep token storage.
- Changing authorization behavior of individual sync routes.

## Git workflow

- Branch: `codex/007-cheapen-sync-token-verification`
- Commit style: short imperative summary, for example
  `Cheapen sync token verification.`
- Do not push or open a PR unless the operator asks.

## Steps

### Step 1: Replace synchronous scrypt with fixed digest comparison

Use SHA-256 digests for equality checking:

- Keep or adapt `hashApiToken`.
- Convert both configured and incoming tokens to fixed-length `Buffer` digests.
- Use `timingSafeEqual` on equal-length buffers.
- Avoid doing expensive work for missing configured token or missing bearer
  token.

Precompute or lazily cache the configured token digest so each request only
hashes the incoming token. Be careful in tests: if env is mocked dynamically,
provide a way to reset the cache or compute lazily from the current env value.

**Verify**:
`pnpm --filter @latch-works/pane-view typecheck` -> exit 0.

### Step 2: Preserve API semantics

Confirm these cases keep the same boolean behavior:

- Missing configured token -> false.
- Missing bearer token -> false.
- Empty bearer token after trimming -> false.
- Wrong token -> false.
- Exact token -> true.

Do not throw on malformed input. Do not expose whether the configured token is
set.

**Verify**:
`pnpm --filter @latch-works/pane-view typecheck` -> exit 0.

### Step 3: Add tests and a regression guard

Add tests under `apps/pane-view/src/server/auth` for `readBearerToken`,
`hashApiToken`, and `verifySyncApiToken`.

Also add a test that spies on or mocks `node:crypto` enough to prove the
configured token digest is not recomputed on every request, if that can be done
without brittle module-loader gymnastics. If that is too brittle, test through a
small exported cache reset helper used only in tests.

**Verify**:
`pnpm --filter @latch-works/pane-view test -- src/server/auth` -> exit 0.

### Step 4: Remove unused scrypt import

Ensure `scryptSync` is no longer imported or used.

**Verify**:
`rg "scryptSync|pane-view-sync-token" apps/pane-view/src/server/auth/api-token.ts`
-> no `scryptSync` match. The old salt string should be gone unless a migration
note explicitly needs it.

## Test plan

- Unit tests for `api-token.ts`.
- No real sync API requests are needed.
- Tests must not print token values.

## Done criteria

- [ ] `verifySyncApiToken` no longer calls `scryptSync`.
- [ ] Configured token digest is precomputed or cached.
- [ ] Constant-time comparison is still used for fixed-length digests.
- [ ] Auth tests and Pane View typecheck pass.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

Stop and report if:

- The codebase expects `hashApiToken` to produce the old scrypt-derived value.
- Env access is intentionally dynamic per request and cannot support caching.
- Tests require exposing token values.

## Maintenance notes

This plan optimizes a shared secret equality check. If sync tokens become
user-managed passwords in the future, revisit storage and verification as a
database-backed token hash design rather than reverting per-request synchronous
scrypt.
