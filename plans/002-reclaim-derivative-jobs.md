# Plan 002: Reclaim Pending Derivative Jobs Reliably

> **Executor instructions**: Follow this plan step by step. Run every verification
> command and confirm the expected result before moving to the next step. If any
> STOP condition occurs, stop and report instead of improvising. When done,
> update this plan's row in `plans/README.md` unless a reviewer says they own the
> index.
>
> **Drift check (run first)**:
> `git diff --stat 326110f..HEAD -- apps/pane-view/src/server/media/derivative-service.ts apps/pane-view/src/server/media/derivative-lease.ts apps/pane-view/src/routes/api.media.$mediaId.thumbnail.ts apps/pane-view/src/server/media/*.test.ts`
> If any in-scope file changed, compare the excerpts below with the live code
> before proceeding. A mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `326110f`, 2026-06-12

## Why this matters

Pane View's thumbnail route returns `503` while a derivative is pending. Today a
newly inserted `pending` row and an expired `processing` lease can both return
`pending` without any worker claiming the job. That can strand thumbnails
forever, making galleries look broken even though the original media is present.
This plan makes the on-demand generator claim pending work deterministically and
adds regression coverage for the lease path.

## Current state

- `apps/pane-view/src/server/media/derivative-service.ts` contains the
  `ensureThumbnailDerivative` state machine.
- `apps/pane-view/src/server/media/derivative-lease.ts` defines lease expiry.
- `apps/pane-view/src/routes/api.media.$mediaId.thumbnail.ts` returns `503` for
  `pending`, so a stuck pending row is user-visible.

Relevant excerpts at `326110f`:

```ts
// apps/pane-view/src/server/media/derivative-service.ts:137-151
if (existing?.status === "processing") {
  if (!isDerivativeProcessingLeaseExpired(existing.updatedAt)) {
    return { status: "pending" };
  }

  await db.update(thumbnails).set({ error: null, status: "pending", updatedAt: new Date() })
    .where(and(eq(thumbnails.mediaObjectId, context.mediaObjectId), eq(thumbnails.size, size)));
} else if (existing?.status === "pending") {
  return { status: "pending" };
}
```

```ts
// apps/pane-view/src/server/media/derivative-service.ts:154-187
if (!existing) {
  await db.insert(thumbnails).values({ ... status: "pending" ... });
} else if (existing.status === "failed") {
  await db.update(thumbnails).set({ ... status: "pending" ... });
} else {
  return { status: "pending" };
}

const [claimed] = await db
  .update(thumbnails)
  .set({ status: "processing", updatedAt: new Date() })
  .where(and(..., eq(thumbnails.status, "pending")))
  .returning();
```

Repo conventions to match:

- Keep the state machine in `derivative-service.ts`; do not introduce a
  background queue in this plan.
- Use the existing `thumbnails` statuses: `pending`, `processing`, `ready`,
  `failed`.
- Keep `503` plus `Retry-After` route behavior for genuinely in-progress work.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Focused tests | `pnpm --filter @latch-works/pane-view test -- src/server/media` | exit 0, all media server tests pass |
| Pane typecheck | `pnpm --filter @latch-works/pane-view typecheck` | exit 0, no TypeScript errors |
| Workspace check | `pnpm check` | exit 0, or only documented pre-existing caveats if accepted |

## Scope

**In scope**:

- `apps/pane-view/src/server/media/derivative-service.ts`
- `apps/pane-view/src/server/media/derivative-lease.ts`, only if tests need a
  seam for time
- A new or existing `apps/pane-view/src/server/media/*.test.ts`
- `plans/README.md`, status row only

**Out of scope**:

- Streaming derivative generation. That is plan 009.
- Background workers or sync-time pre-warm. That is plan 015.
- CDN token or cache behavior. That is plan 003.
- Changing thumbnail object key formats.

## Git workflow

- Branch: `codex/002-reclaim-derivative-jobs`
- Commit style: short imperative summary, for example
  `Fix derivative job claiming.`
- Do not push or open a PR unless the operator asks.

## Steps

### Step 1: Rewrite the claim logic around "claimable" states

In `ensureThumbnailDerivative`, remove the early return for
`existing?.status === "pending"`. A pending row should be claimable by the
current request through the existing conditional update:

```ts
where(and(
  eq(thumbnails.mediaObjectId, context.mediaObjectId),
  eq(thumbnails.size, size),
  eq(thumbnails.status, "pending"),
))
```

Keep the early return for `processing` rows whose lease has not expired. For
expired processing rows, reset to `pending` and then continue into the same claim
attempt. For `ready`, continue to return the object immediately. For `failed`,
continue to reset the row to `pending` before claiming.

**Verify**:
`pnpm --filter @latch-works/pane-view typecheck` -> exit 0.

### Step 2: Preserve concurrent request safety

Ensure the conditional `pending` -> `processing` update remains the only claim
point. If two requests race, exactly one should get a `claimed` row and generate;
the other should return `{ status: "pending" }`.

Do not replace this with a non-conditional update or a read-then-write claim.

**Verify**:
`pnpm --filter @latch-works/pane-view typecheck` -> exit 0.

### Step 3: Add regression tests for each state path

Add tests around `ensureThumbnailDerivative` in a media server test file.

Cover at least:

- No existing row: inserts `pending`, claims it, and attempts generation.
- Existing `pending`: attempts to claim; if claim succeeds, generation runs.
- Existing `pending`: if claim returns no row, result is `{ status: "pending" }`.
- Existing `processing` with unexpired lease: no claim attempt, returns pending.
- Existing `processing` with expired lease: resets to pending, claims, and
  attempts generation.
- Existing `ready`: returns ready without writing.

Mock storage and media metadata so tests do not require S3, ffmpeg, or sharp.

**Verify**:
`pnpm --filter @latch-works/pane-view test -- src/server/media` -> exit 0.

### Step 4: Run focused verification

Run media tests and Pane View typecheck after cleanup.

**Verify**:
`pnpm --filter @latch-works/pane-view test -- src/server/media` -> exit 0.

**Verify**:
`pnpm --filter @latch-works/pane-view typecheck` -> exit 0.

## Test plan

- Add or extend Vitest tests under `apps/pane-view/src/server/media`.
- Use mocked Drizzle calls and mocked storage helpers, not real object storage.
- The key regression is that an existing pending row is no longer an automatic
  dead end.

## Done criteria

- [ ] Pending thumbnail rows are claimable by `ensureThumbnailDerivative`.
- [ ] Expired processing rows are reset and then claimable in the same request.
- [ ] Unexpired processing rows still return pending without duplicate work.
- [ ] New regression tests cover no row, pending, expired processing,
      unexpired processing, and ready.
- [ ] Focused media tests and Pane View typecheck pass.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

Stop and report if:

- The live derivative state machine has already been rewritten.
- Existing tests or schema reveal a separate worker is supposed to claim pending
  rows instead of the request path.
- The fix requires a migration or new thumbnail statuses.
- Mocking generation would require executing ffmpeg or talking to real S3.

## Maintenance notes

Reviewers should scrutinize the state transition ordering. Future background
worker work must preserve the single conditional claim point so requests and
workers cannot generate the same derivative concurrently.
