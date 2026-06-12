# Plan 009: Stream Large Originals During Derivative Generation

> **Executor instructions**: Follow this plan step by step. Run every verification
> command and confirm the expected result before moving to the next step. If any
> STOP condition occurs, stop and report instead of improvising. When done,
> update this plan's row in `plans/README.md` unless a reviewer says they own the
> index.
>
> **Drift check (run first)**:
> `git diff --stat 326110f..HEAD -- apps/pane-view/src/server/media/derivative-service.ts packages/media-storage/src/s3.ts packages/media-storage/src/index.ts apps/pane-view/src/server/media/*.test.ts packages/media-storage/src/*.test.ts`
> If any in-scope file changed, compare the excerpts below with the live code
> before proceeding. A mismatch is a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/002-reclaim-derivative-jobs.md
- **Category**: perf
- **Planned at**: commit `326110f`, 2026-06-12

## Why this matters

Derivative generation currently reads the entire original object into memory.
For videos it then writes the full buffer back to a temp file before ffmpeg can
extract a poster frame. A few large videos can consume hundreds of megabytes and
block other requests. The storage layer already exposes readable object streams,
so video thumbnail generation should stream originals to temp files and only keep
the small generated poster/thumbnail in memory.

## Current state

- `apps/pane-view/src/server/media/derivative-service.ts` generates thumbnails
  and video poster previews.
- `packages/media-storage/src/s3.ts` exposes both `getStoredObject` for streams
  and `readStoredObjectBytes` for buffering.

Relevant excerpts at `326110f`:

```ts
// apps/pane-view/src/server/media/derivative-service.ts:287-315
const sourceBytes = await readStoredObjectBytes({ key: sourceKey, storage });
if (!sourceBytes) {
  throw new Error(`original object missing: ${sourceKey}`);
}

if (sourceBytes.byteLength > maxSourceBytes) {
  throw new Error(`original object exceeds ${maxSourceBytes} bytes`);
}

if (context.mediaType === "video") {
  const posterFrame = await extractVideoPosterFrame(sourceBytes, context.extension);
  return resizeImageToWebp(posterFrame, size);
}

return resizeImageToWebp(sourceBytes, size);
```

```ts
// apps/pane-view/src/server/media/derivative-service.ts:337-348
async function extractVideoPosterFrame(videoBytes: Buffer, extension: string): Promise<Buffer> {
  ...
  await writeFile(inputPath, videoBytes);
  await runFfmpeg(ffmpegPath, [
```

```ts
// packages/media-storage/src/s3.ts:126-155
export async function getStoredObject(...): Promise<StoredObjectBody | null> {
  ...
  return {
    body: response.Body as Readable,
    contentLength: response.ContentLength,
    ...
  };
}
```

Repo conventions to match:

- Keep derivative concurrency control through `createConcurrencyLimiter(2)`.
- Use Node stream APIs in server code; do not pull browser APIs into the server.
- Keep `sharp` output as WebP bytes stored through `putStoredObject`.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Media tests | `pnpm --filter @latch-works/pane-view test -- src/server/media` | exit 0, focused tests pass |
| Storage tests | `pnpm --filter @latch-works/media-storage test` | exit 0, if storage tests exist |
| Typecheck | `pnpm --filter @latch-works/pane-view typecheck && pnpm --filter @latch-works/media-storage typecheck` | both exit 0 |

## Scope

**In scope**:

- `apps/pane-view/src/server/media/derivative-service.ts`
- `packages/media-storage/src/s3.ts` and `packages/media-storage/src/index.ts`
  only if a small stream helper is needed
- Focused media/storage tests
- `plans/README.md`, status row only

**Out of scope**:

- Background workers or sync-time pre-warm. That is plan 015.
- PDF cover generation. That is plan 015.
- Changing thumbnail dimensions or object keys.
- Replacing `sharp` or `ffmpeg-static`.

## Git workflow

- Branch: `codex/009-stream-derivative-generation`
- Commit style: short imperative summary, for example
  `Stream videos during derivative generation.`
- Do not push or open a PR unless the operator asks.

## Steps

### Step 1: Add a small stream-to-temp helper

In `derivative-service.ts` or `media-storage`, add a helper that writes a
`Readable` stream to a temp file while enforcing `maxSourceBytes`.

Requirements:

- Use `stream/promises.pipeline`.
- Count bytes while streaming and reject if the count exceeds `maxSourceBytes`.
- Always remove temp directories in `finally`.
- Return `null` or throw a clear missing-object error if storage returns no body.

Keep the helper local to Pane View unless another package already needs it.

**Verify**:
`pnpm --filter @latch-works/pane-view typecheck` -> exit 0.

### Step 2: Stream video originals to ffmpeg

Change the video path in `generateDerivativeBytes` so it calls `getStoredObject`
and streams the original to a temp file, then invokes ffmpeg on that temp file.

Avoid this sequence for videos:

1. `readStoredObjectBytes`
2. full-buffer `writeFile`
3. ffmpeg

The function may still read the generated poster image into memory because that
file is small.

**Verify**:
`pnpm --filter @latch-works/pane-view typecheck` -> exit 0.

### Step 3: Keep image/GIF behavior bounded

For image and GIF derivatives, it is acceptable to continue buffering the source
for `sharp`, but keep the `maxSourceBytes` guard. If storage exposes
`contentLength`, prefer checking it before buffering so oversized originals fail
early.

Do not change GIF/image visual behavior in this plan.

**Verify**:
`pnpm --filter @latch-works/pane-view typecheck` -> exit 0.

### Step 4: Add tests for streaming and cleanup

Add tests that mock storage and ffmpeg execution.

Cover at least:

- Video generation uses a streamed object body and does not call
  `readStoredObjectBytes` for the original video.
- Oversized streamed source rejects before ffmpeg succeeds.
- Temp directories are removed after success and failure.
- Image path still uses `sharp` with the existing max-size guard.

If `runFfmpeg` is private and hard to mock, introduce a narrow injectable helper
inside the module rather than spawning a real process in tests.

**Verify**:
`pnpm --filter @latch-works/pane-view test -- src/server/media` -> exit 0.

## Test plan

- Media server unit tests with mocked storage streams.
- No real S3, ffmpeg, or sharp work should be needed; mock external pieces.
- Keep plan 002 landed first so pending/processing job tests are stable.

## Done criteria

- [ ] Video derivative generation no longer buffers the full original before
      writing a temp file.
- [ ] Streamed source size is capped at `maxSourceBytes`.
- [ ] Temp files/directories are cleaned up on success and failure.
- [ ] Image/GIF derivative behavior is unchanged except optional early size
      rejection.
- [ ] Focused media tests and typechecks pass.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

Stop and report if:

- `ffmpeg` can consume the storage stream directly without a temp file and that
  approach is simpler, but requires a broader process-piping redesign.
- The storage SDK body type is not a Node `Readable` in the deployed runtime.
- Tests cannot mock ffmpeg without changing production exports broadly.

## Maintenance notes

This plan reduces origin memory pressure, but derivative generation can still be
CPU-heavy. If origin load remains high after this change, execute plan 015 to
evaluate pre-warm and worker strategies.
