# Plan 002: Resolve Gallery Delivery Batches Without Per-Item Re-Reads

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving to the next step. If anything in the "STOP
> conditions" section occurs, stop and report - do not improvise. When done, update the status
> row for this plan in `plans/README.md` unless a reviewer told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat c328a78..HEAD -- apps/pane-view/src/features/media/media-delivery-service.ts apps/pane-view/src/server/media/resolve-delivery-url.ts apps/pane-view/src/server/media/repository.ts apps/pane-view/src/server/media/derivative-service.ts`
> If this reports changes, compare the "Current state" excerpts below against the live code before
> proceeding. On a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `c328a78`, 2026-06-17

## Why this matters

The browser already sends visible gallery thumbnail work as a bounded batch of up to 48 items, but
the server turns that batch back into per-item resolver calls. Thumbnail resolution repeatedly reads
media context and may then enter the Derivative Queue path one item at a time. This keeps gallery
scroll latency tied to many small DB round trips when a single batched query can gather the media
contexts.

This plan keeps the public server function shape stable and optimizes its implementation.

## Current state

Relevant files:

- `apps/pane-view/src/features/media/media-delivery-service.ts` - server functions called by the
  browser.
- `apps/pane-view/src/server/media/resolve-delivery-url.ts` - per-item delivery resolution.
- `apps/pane-view/src/server/media/repository.ts` - media delivery DB reads.
- `apps/pane-view/src/server/media/derivative-service.ts` - Derivative Queue ensure/regenerate path.

Current batch server function fans out into per-item calls:

```ts
// apps/pane-view/src/features/media/media-delivery-service.ts:95
const results = await Promise.all(
  uniqueItems.map(async (item): Promise<MediaDeliveryBatchResult> => {
    try {
      const result = await resolveMediaDeliveryUrlForVariant({
        mediaId: item.mediaId,
        size: item.size,
        variant: item.variant,
      });
```

Current image thumbnail path reads media context:

```ts
// apps/pane-view/src/server/media/resolve-delivery-url.ts:47
const media = await readMediaThumbnailContext({ mediaId });
if (!media) {
  throw new Error("Media not found");
}

if (resolveImageDeliveryMode() === "bunny") {
  return {
    deliveryToken: mintImageOriginalDeliveryToken(media),
    pending: false,
  };
}
```

Current queued derivative path also reads media context:

```ts
// apps/pane-view/src/server/media/resolve-delivery-url.ts:75
const media = await readMediaThumbnailContext({ mediaId });
if (!media) {
  throw new Error("Media not found");
}

const derivative =
  variant === "preview"
    ? await ensurePreviewDerivative({ mediaId })
    : await ensureThumbnailDerivative({
        mediaId,
        requestedSize: snapThumbnailSize(size ?? 320),
      });
```

Current derivative ensure reads context again:

```ts
// apps/pane-view/src/server/media/derivative-service.ts:183
const size = snapThumbnailSize(requestedSize);
const context = await readMediaThumbnailContext({ mediaId });
if (!context) {
  return { status: "failed" };
}
```

Repo conventions to match:

- Server functions validate input with Zod and then dynamically import server-only modules.
- Delivery terms from `CONTEXT.md`: use "Delivery Token", "Image Delivery", and "Derivative Queue".
- Keep renderer code free of raw Node APIs.
- Tests are colocated as `*.test.ts`.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Focused media tests | `pnpm --filter @latch-works/pane-view test -- src/server/media src/features/media` | exit 0 |
| Typecheck Pane View | `pnpm --filter @latch-works/pane-view typecheck` | exit 0 |
| Full Pane View check | `pnpm --filter @latch-works/pane-view check` | exit 0 |

## Scope

**In scope**:

- `apps/pane-view/src/features/media/media-delivery-service.ts`
- `apps/pane-view/src/server/media/resolve-delivery-url.ts`
- `apps/pane-view/src/server/media/repository.ts`
- `apps/pane-view/src/server/media/derivative-service.ts`
- New or existing focused tests under `apps/pane-view/src/server/media/`

**Out of scope**:

- Browser batch size and retry policy in `batched-thumbnail-resolver.ts`.
- CDN token shape.
- Derivative Queue schema.
- Optimizer claim/complete APIs.
- Gallery UI rendering.

## Git workflow

- Branch: `codex/002-batch-gallery-delivery-resolution`
- Commit message style: short imperative, for example `Batch gallery delivery resolution`
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add a batched media context read

In `apps/pane-view/src/server/media/repository.ts`, add a function such as
`readMediaThumbnailContextsByEntryIds({ mediaIds })`.

Requirements:

- Accept unique library entry IDs.
- Query `library_entries` joined to `media_objects` once using `inArray(libraryEntries.id, mediaIds)`.
- Keep `isNull(libraryEntries.deletedAt)`.
- Return a `Map<string, MediaThumbnailContext>` keyed by library entry ID. The existing
  `MediaThumbnailContext.mediaObjectId` remains the media object ID.

Do not remove `readMediaThumbnailContext`; single-item routes still use it.

**Verify**: `pnpm --filter @latch-works/pane-view typecheck` -> exit 0.

### Step 2: Add context-aware derivative ensure helpers

In `derivative-service.ts`, factor the body of `ensureThumbnailDerivative` so it can run with an
already-loaded `MediaThumbnailContext`.

Target shape:

- Keep exported `ensureThumbnailDerivative({ mediaId, requestedSize })` for current callers.
- Add an exported or internal helper such as
  `ensureThumbnailDerivativeForContext({ context, requestedSize })`.
- `ensurePreviewDerivative({ mediaId })` can continue to call the public single-item wrapper, or
  you may add `ensurePreviewDerivativeForContext({ context })`.

The helper must preserve all existing behavior:

- snap sizes;
- reject unsupported types;
- return `unsupported` for Bunny image delivery;
- insert/promote/reset pending rows;
- wake optimizer in triggered mode;
- inline generation in inline mode.

**Verify**: `pnpm --filter @latch-works/pane-view test -- src/server/media/derivative-service.test.ts` -> exit 0.

### Step 3: Implement a true server-side batch resolver

In `resolve-delivery-url.ts`, add a function such as:

```ts
export async function resolveMediaDeliveryUrlsForVariants(items: Array<{
  mediaId: string;
  size?: number;
  variant: "thumbnail" | "preview" | "original";
}>): Promise<MediaDeliveryBatchResult[]>
```

If importing `MediaDeliveryBatchResult` from `features/media` would create a layering problem, define
a server-local result type and map it in `media-delivery-service.ts`.

Behavior:

- Dedupe items by `variant:mediaId:size` before resolving.
- For `original`, it is acceptable to keep using the existing per-item path because originals are not
  the gallery thumbnail hot path.
- For thumbnail/preview items, read all media contexts once with the new repository function.
- For Bunny image thumbnails, mint Delivery Tokens directly from the context.
- For queued video thumbnails/previews, call the context-aware derivative helper.
- Preserve the existing status mapping: `ready`, `pending`, or `failed`.

**Verify**: `pnpm --filter @latch-works/pane-view typecheck` -> exit 0.

### Step 4: Wire the server function to the batch resolver

In `media-delivery-service.ts`, replace the `Promise.all(uniqueItems.map(...resolveMediaDeliveryUrlForVariant))`
implementation with a call to the new server batch resolver.

Keep the existing Zod input contract:

```ts
items: z.array(resolveMediaDeliveryRequestSchema).min(1).max(48)
```

Keep authentication exactly as-is.

**Verify**: `pnpm --filter @latch-works/pane-view test -- src/features/media src/server/media` -> exit 0.

### Step 5: Add focused regression coverage

Add tests in a focused server media test file. Cover at least:

- duplicate batch entries are resolved once;
- Bunny image thumbnail returns a Delivery Token without calling derivative ensure;
- missing/deleted media returns `failed` for that item without failing the whole batch;
- video thumbnail/preview pending maps to batch result `pending`.

Use existing tests in `apps/pane-view/src/server/media/derivative-service.test.ts` and
`apps/pane-view/src/server/media/cdn-delivery.test.ts` as patterns for test organization.

**Verify**: `pnpm --filter @latch-works/pane-view test -- src/server/media src/features/media` -> exit 0.

## Test plan

- Existing derivative-service tests must pass unchanged.
- New batch resolver tests cover ready, pending, failed, dedupe, and Bunny image paths.
- Pane View typecheck and check must pass.

## Done criteria

- [ ] The gallery batch server function no longer maps every item through
      `resolveMediaDeliveryUrlForVariant`.
- [ ] Thumbnail/preview media contexts for a batch are read with one DB query.
- [ ] Single-item delivery routes still compile and behave through existing exports.
- [ ] New tests exist and pass.
- [ ] `pnpm --filter @latch-works/pane-view check` exits 0.
- [ ] `git diff --stat` shows only in-scope files changed.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back if:

- Refactoring `ensureThumbnailDerivative` would require changing Derivative Queue semantics.
- The batch resolver needs a schema change.
- A circular import appears between `features/media` and `server/media`.
- Tests require real S3/network access.
- Verification fails twice after reasonable fixes.

## Maintenance notes

Reviewers should scrutinize that the optimization does not change token TTLs, Delivery Token payloads,
or queue priority behavior. The main future interaction is Plan 004: server-owned gallery pages should
be able to reuse this batch resolver or avoid calling it for entries that already carry embedded URLs.
