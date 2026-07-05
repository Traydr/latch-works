# Plan 009: Handle Sub-Second Video Poster Extraction

> **Executor instructions**: Run the drift check first. Keep output format and
> storage keys unchanged. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 8f19cd4..HEAD -- packages/media-derivatives/src/video.ts packages/media-derivatives/src/generate.test.ts packages/media-derivatives/src/video.test.ts packages/media-derivatives/src/descriptor.ts`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-add-github-actions-verification-baseline.md
- **Category**: bug
- **Planned at**: commit `8f19cd4`, 2026-07-05

## Why This Matters

Video poster extraction seeks to one second before reading a frame. Very short
videos can have no frame at that timestamp, causing repeated derivative failure.
The poster frame should gracefully fall back to the first frame.

## Current State

- `packages/media-derivatives/src/video.ts:120-133` invokes ffmpeg with `-ss 1`,
  `-frames:v 1`, and writes `poster.jpg`.
- `video.ts:135` immediately reads `poster.jpg`.
- No fallback exists if ffmpeg exits successfully but no output file is produced.

## Commands You Will Need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Media derivatives tests | `pnpm --filter @latch-works/media-derivatives test` | exit 0 |
| Typecheck | `pnpm --filter @latch-works/media-derivatives typecheck` | exit 0 |

## Scope

**In scope**:
- `packages/media-derivatives/src/video.ts`
- Media-derivatives tests, creating `video.test.ts` if useful

**Out of scope**:
- Changing derivative object keys.
- Changing video derivative size ladder.
- Adding PDF support. Plan 021 handles that.

## Git Workflow

- Branch: `advisor/009-short-video-poster-fallback`
- Commit message: `Handle short video poster extraction`

## Steps

### Step 1: Add A Unit Test Around Fallback Behavior

Test `extractVideoPosterFrameAtPath` indirectly if it remains private, or export
a small test-only seam only if necessary. Use a fake `ffmpegRunner` that records
args. Simulate the first `-ss 1` attempt producing no output and the fallback
attempt producing a file.

**Verify**: `pnpm --filter @latch-works/media-derivatives test` -> new test fails before implementation.

### Step 2: Add First-Frame Fallback

After the first ffmpeg attempt, check whether `poster.jpg` exists before
`readFile`. If missing, rerun ffmpeg with `-ss 0` and the same output path, then
read the output. Alternatively, use `-ss 0` as the primary seek if tests prove
that is acceptable for all current poster use cases.

**Verify**: `pnpm --filter @latch-works/media-derivatives typecheck` -> exits 0.

### Step 3: Preserve Error Reporting

If both attempts fail or no output exists after fallback, throw a clear error
such as `ffmpeg did not produce a poster frame`. Do not swallow ffmpeg stderr.

**Verify**: `pnpm --filter @latch-works/media-derivatives test` -> all tests pass.

## Test Plan

- Fallback test: first seek creates no output, second seek reads output.
- Failure test: no output after fallback throws a clear error.
- Existing generation tests continue to pass.

## Done Criteria

- [ ] Sub-second/empty-output poster extraction retries at the first frame.
- [ ] Existing output format remains JPEG input to downstream WebP conversion.
- [ ] Focused tests and typecheck exit 0.
- [ ] `plans/README.md` status row updated.

## STOP Conditions

- ffmpeg behavior in tests cannot be simulated without real video fixtures.
- Fallback requires large binary fixtures or network downloads.
- Changing seek time would alter product expectations documented elsewhere.

## Maintenance Notes

- If future poster selection becomes configurable, keep the first-frame fallback
  as the safety net for clips shorter than the configured timestamp.
