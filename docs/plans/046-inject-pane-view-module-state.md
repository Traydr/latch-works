# Plan 046: Remove test-only exports by injecting Pane View module state

> **Executor instructions**: This is a structural refactor, not a behavior change. Every step must
> keep observable behavior identical and delete the corresponding `*ForTests` export as its proof of
> completion. Run every gate and update the plan index.
>
> **Drift check (run first)**: `git diff --stat c0a1bdf..HEAD -- apps/pane-view/src/features/gallery apps/pane-view/src/server/auth apps/pane-view/src/server/media apps/pane-view/src/server/management`

## Status

- **Status**: TODO
- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: —
- **Category**: architecture / testability / security

## Why this matters

Eight modules in Pane View export functions that exist only so tests can reach module-level mutable
state:

| Export | Module | State it resets |
|---|---|---|
| `__resetGalleryThumbnailResolverForTests` | `features/gallery/batched-thumbnail-resolver.ts:204` | `cache`, `attempts` Maps |
| `__resetResolveThrottleForTests` | `features/gallery/resolve-throttle.ts:89` | `activeCount`, `waiters`, `consecutiveFailures`, `circuitOpenUntil` |
| `__resetResolvedMediaUrlCacheForTests` | `features/gallery/useResolvedMediaUrl.ts:182` | `resolveCache` Map |
| `resetSyncApiTokenDigestCacheForTests` | `server/auth/api-token.ts:11` | `cachedConfiguredToken`, `cachedConfiguredTokenDigest` |
| `getSyncApiTokenDigestCacheForTests` | `server/auth/api-token.ts:16` | reads the same cache |
| `resetLoginThrottleForTests` | `server/auth/login-throttle.ts:72` | `attemptsByKey` Map |
| `cleanupWorkerTestHooks` | `server/management/cleanup-worker.ts` | private batch processor |
| `shutterClientTestHooks` | `server/media/shutter-client.ts:122` | private request helpers |

Three costs follow from this shape, in descending order of importance:

1. **`login-throttle.ts` is a correctness problem, not just a testing one.** `attemptsByKey` is a
   per-process `Map`, so brute-force protection resets on every deploy and does not hold across
   replicas. Today `.railway/railway.ts` pins Pane View to one replica, which hides it. The moment
   that number changes, throttling silently weakens. This is the one item with a security
   consequence and it should be treated as the priority of this plan.
2. **Production bundles ship test scaffolding.** These exports are reachable at runtime. Nothing
   currently calls them in production, but nothing prevents it either.
3. **Tests are forced into reset ceremony.** Every suite touching these modules needs a `beforeEach`
   whose only job is to undo global state left by the previous test. That ceremony is what makes
   otherwise reasonable tests read as bloated, and it makes tests order-dependent by construction.

`shutter-client.ts:244` compounds this: `const startupCapabilityStatus = getShutterCapabilityKeyStatus();`
runs at module import time, so merely importing the module performs configuration work. That is why
the module needs test hooks at all.

## Current state

- Gallery modules keep caches and a circuit breaker in module scope; these are browser-side and
  per-tab, so the only real defect is testability.
- `api-token.ts` memoizes a token digest in module scope; correct for a single process, but the
  cache is only reachable for assertions through an exported getter.
- `login-throttle.ts` keeps security-relevant counters in module scope (see above).
- `cleanup-worker.ts` and `shutter-client.ts` export named hook objects to expose private functions.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `pnpm --filter @latch-works/pane-view typecheck` | no errors |
| Tests | `pnpm --filter @latch-works/pane-view test` | all suites pass |
| Check | `pnpm --filter @latch-works/pane-view check` | typecheck, tests, and build pass |
| Dead code | `pnpm knip` | no new unused exports |

## Scope

**In scope**: replacing module-level mutable state with explicitly constructed instances; deleting
all eight test-only exports; moving `login-throttle` counters to shared storage; removing the
import-time side effect in `shutter-client.ts`.

**Out of scope**: changing throttle/backoff tuning constants; changing Shutter request semantics;
redesigning the gallery caching strategy; touching Frame View or Gather Box.

## Git workflow

- Branch: `codex/046-inject-pane-view-module-state`
- Commit message: `Remove test-only exports by injecting Pane View module state`

## Steps

### Step 1: Make login throttling durable and shared

Move `attemptsByKey` out of module scope into the database, keyed by the same
`(clientIp, username)` tuple the current code uses. A small table with an expiry column is
sufficient; prune expired rows on read rather than with a scheduled job.

Keep `isLoginThrottled` and its recording counterpart as the only public surface, and take the clock
as an injected parameter so tests can advance time without waiting. Preserve the existing threshold
and window constants exactly — this step must not change how many attempts are allowed.

Do not skip the replica question: state in the commit body whether throttling now holds across
replicas, because that is the property this step exists to establish.

**Verify**: `resetLoginThrottleForTests` is deleted; existing throttle and spoofing suites pass
against injected time; a test asserts that counters survive a simulated process restart.

### Step 2: Convert gallery module state into constructed instances

Replace the module-level `cache`/`attempts` Maps, the resolve cache, and the throttle/circuit
variables with factory functions (`createThumbnailResolver`, `createResolveThrottle`,
`createResolvedMediaUrlCache`) that close over their own state. Keep one shared instance created at
module load for production callers, so component call sites do not change.

Tests then construct a private instance per test instead of resetting a global. This is what removes
the reset ceremony rather than relocating it.

**Verify**: all three `__reset*ForTests` exports are deleted; `batched-thumbnail-resolver`,
`resolve-throttle`, `useResolvedMediaUrl`, and `useWindowedThumbnailResolution` suites pass with no
`beforeEach` that exists solely to clear state.

### Step 3: Inject the sync token digest cache

Give `api-token.ts` a factory that owns `cachedConfiguredToken` and `cachedConfiguredTokenDigest`,
with the configured-token lookup passed in rather than read from module scope. Export one shared
instance for production use.

The existing test asserting digest memoization must keep asserting it — through the instance's own
surface, not through a getter exported from production code.

**Verify**: both `*SyncApiTokenDigestCacheForTests` exports are deleted; `api-token.test.ts` passes
including the caching assertion.

### Step 4: Remove import-time work and the two hook objects

Make `shutter-client.ts` compute `startupCapabilityStatus` lazily on first use instead of at module
import. Then extract the functions currently reached through `shutterClientTestHooks` and
`cleanupWorkerTestHooks` into their own modules with ordinary exports, so tests import them directly
and the hook objects disappear.

Prefer extraction over widening visibility: if a function is worth testing, it is worth being a
named export of a module with a clear responsibility.

**Verify**: both hook objects are deleted; importing `shutter-client.ts` performs no configuration
work; `shutter-client`, `shutter-delivery-redirect`, and cleanup-worker suites pass.

### Step 5: Add a gate against reintroduction

Add a check that fails when a production module under `apps/pane-view/src` exports an identifier
matching `/ForTests$|TestHooks$|^__/`. A focused test or a lint rule are both acceptable; it must run
inside `pnpm check`.

**Verify**: adding a throwaway `export function fooForTests() {}` makes `check` fail with the
offending file named; removing it restores a green run.

## Test plan

Cover: login throttling across a simulated restart and with injected time; independent gallery
resolver instances not sharing cache state; digest memoization through the injected instance; lazy
Shutter capability evaluation; and the reintroduction gate. No suite may depend on execution order.

## Rollout and risk

Steps 2–4 are pure refactors behind unchanged public surfaces and can land together. **Step 1 changes
runtime behavior and adds a table — land it on its own** so a throttling regression is bisectable.

The main risk is Step 1 trading an in-memory read for a database read on the login path. Keep the
query on an indexed key and confirm login latency is unchanged before merging.
