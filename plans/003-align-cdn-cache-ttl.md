# Plan 003: Align CDN Cache Headers With Signed Token Expiry

> **Executor instructions**: Follow this plan step by step. Run every verification
> command and confirm the expected result before moving to the next step. If any
> STOP condition occurs, stop and report instead of improvising. When done,
> update this plan's row in `plans/README.md` unless a reviewer says they own the
> index.
>
> **Drift check (run first)**:
> `git diff --stat 326110f..HEAD -- apps/pane-view/src/server/media/cdn-delivery.ts apps/pane-view/src/server/media/cdn-response.ts packages/media-delivery/src/token.ts docs/runbooks/pane-view-thumbnails.md docs/runbooks/railway-cdn-pane-view.md`
> If any in-scope file changed, compare the excerpts below with the live code
> before proceeding. A mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `326110f`, 2026-06-12

## Why this matters

Pane View signs derivative URLs with an expiration, then serves successful CDN
responses with a one-year immutable cache header. A CDN that caches the response
can continue serving bytes long after the token's `exp` would fail verification
at the app. Thumbnails are less sensitive than originals, but this undermines the
meaning of signed URLs and makes revocation expectations confusing. The cache
duration should be bounded by the delivery token TTL, or the design should
intentionally switch to immutable public derivative keys.

## Current state

- `apps/pane-view/src/server/media/cdn-delivery.ts` signs tokens with
  `env.MEDIA_DELIVERY_TTL_SECONDS`.
- `packages/media-delivery/src/token.ts` verifies `exp`.
- `apps/pane-view/src/server/media/cdn-response.ts` verifies a token only when
  the request reaches the app and then returns `CDN_CACHE_CONTROL`.
- `docs/runbooks/pane-view-thumbnails.md` documents signed CDN delivery.

Relevant excerpts at `326110f`:

```ts
// apps/pane-view/src/server/media/cdn-delivery.ts:18-25
const token = deliverySigner.sign({
  exp: readDeliveryTokenExpiration(
    Math.floor(Date.now() / 1000),
    env.MEDIA_DELIVERY_TTL_SECONDS,
  ),
  objectKey,
  purpose,
});
```

```ts
// apps/pane-view/src/server/media/cdn-delivery.ts:34
export const CDN_CACHE_CONTROL = "public, max-age=31536000, immutable";
```

```ts
// apps/pane-view/src/server/media/cdn-response.ts:13-37
const payload = verifyCdnDeliveryToken(token);
if (!payload) {
  return new Response("Forbidden", { status: 403 });
}
...
"cache-control": CDN_CACHE_CONTROL,
```

Documentation currently says:

```md
<!-- docs/runbooks/pane-view-thumbnails.md:7-10 -->
Gallery or <img> uses /api/media/:id/thumbnail?size=320 until a ready row
exists, then switches to /cdn/v1/... from the library snapshot.
...
The browser loads /cdn/v1/{token} without an Authorization header so Railway CDN
can cache image/webp responses.
```

Repo conventions to match:

- Delivery token helpers live in `packages/media-delivery`; Pane View owns env
  and response headers.
- Use explicit constants for response cache policies.
- Keep API thumbnail redirects private and no-store.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Focused tests | `pnpm --filter @latch-works/pane-view test -- src/server/media` | exit 0, all media server tests pass |
| Delivery tests | `pnpm --filter @latch-works/media-delivery test` | exit 0, all package tests pass |
| Pane typecheck | `pnpm --filter @latch-works/pane-view typecheck` | exit 0, no TypeScript errors |

## Scope

**In scope**:

- `apps/pane-view/src/server/media/cdn-delivery.ts`
- `apps/pane-view/src/server/media/cdn-response.ts`
- Media/CDN tests in `apps/pane-view/src/server/media`
- `docs/runbooks/pane-view-thumbnails.md`
- `docs/runbooks/railway-cdn-pane-view.md`, only for cache policy wording
- `plans/README.md`, status row only

**Out of scope**:

- Changing token format or signing algorithm.
- Changing object key format.
- Making thumbnails public forever by design.
- Changing original media routes.

## Git workflow

- Branch: `codex/003-align-cdn-cache-ttl`
- Commit style: short imperative summary, for example
  `Align CDN cache with delivery tokens.`
- Do not push or open a PR unless the operator asks.

## Steps

### Step 1: Choose and document the policy in code

Use a conservative policy: CDN `max-age` must not exceed the signed token TTL.
Keep `public` so the CDN can cache derivative bytes, but remove `immutable`
unless the response URL is deliberately cacheable beyond token expiry.

Suggested shape:

- Replace the fixed `CDN_CACHE_CONTROL` string with a function such as
  `readCdnCacheControl()` or `buildCdnCacheControl(ttlSeconds)`.
- Use `env.MEDIA_DELIVERY_TTL_SECONDS` as the upper bound.
- Consider a small lower bound only if the env schema already enforces positive
  TTLs. Do not invent a second env var in this plan.

**Verify**:
`pnpm --filter @latch-works/pane-view typecheck` -> exit 0.

### Step 2: Apply the dynamic header in CDN responses

Update `serveCdnDeliveryRequest` to set `cache-control` from the chosen function.
Keep `accept-ranges`, `content-type`, `content-length`, `content-range`, and
`etag` behavior unchanged.

**Verify**:
`pnpm --filter @latch-works/pane-view typecheck` -> exit 0.

### Step 3: Add tests around cache headers

Add a focused test that exercises `serveCdnDeliveryRequest` or the cache-control
helper. Mock storage and token verification if needed.

Cover at least:

- A valid token response sets `cache-control` with `public`.
- `max-age` equals or is less than `MEDIA_DELIVERY_TTL_SECONDS`.
- The header does not include `immutable`.
- Invalid tokens still return `403` without object storage reads.

**Verify**:
`pnpm --filter @latch-works/pane-view test -- src/server/media` -> exit 0.

### Step 4: Update operational docs

Update thumbnail/CDN runbooks so operators know cached derivative responses are
bounded by the token TTL. Remove language that implies a one-year immutable CDN
cache unless the implementation intentionally keeps such a design.

**Verify**:
`rg "31536000|immutable" apps/pane-view/src docs/runbooks packages/media-delivery`
-> no matches for thumbnail CDN cache policy, except unrelated explanations if
they are clearly marked.

## Test plan

- Add tests under `apps/pane-view/src/server/media`.
- Existing `packages/media-delivery` token tests should continue passing.
- Do not use a real CDN or object storage in tests.

## Done criteria

- [ ] CDN derivative responses no longer advertise a cache lifetime longer than
      token TTL.
- [ ] CDN derivative responses do not use `immutable` with expiring signed URLs.
- [ ] Invalid-token behavior remains `403`.
- [ ] Docs match the new cache policy.
- [ ] Focused media tests and Pane View typecheck pass.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

Stop and report if:

- Product direction explicitly says thumbnails should be public immutable assets.
- The env schema allows zero, negative, or non-numeric delivery TTLs and fixing
  that would require broader env migration work.
- Railway CDN behavior requires a different header to prevent stale serving and
  that behavior is not documented in-repo.

## Maintenance notes

Reviewers should check that the code still permits CDN caching, just with a
bounded lifetime. If the product later moves to truly public derivative URLs,
that should be captured as a separate design decision and can then restore
immutable caching.
