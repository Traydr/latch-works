# Plan 010: Throttle Lockstep Scan Progress Events

> **Executor instructions**: Follow this plan step by step. Run every verification
> command and confirm the expected result before moving to the next step. If any
> STOP condition occurs, stop and report instead of improvising. When done,
> update this plan's row in `plans/README.md` unless a reviewer says they own the
> index.
>
> **Drift check (run first)**:
> `git diff --stat 326110f..HEAD -- packages/media-index/src/scan.ts packages/lockstep-core/src/plan-sync.ts packages/lockstep-core/src/types.ts apps/lockstep/src/main/services/runService.ts apps/lockstep/src/renderer/App.tsx packages/lockstep-core/src/*.test.ts packages/media-index/src/*.test.ts`
> If any in-scope file changed, compare the excerpts below with the live code
> before proceeding. A mismatch is a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `326110f`, 2026-06-12

## Why this matters

Hash progress is emitted on every file stream chunk, then forwarded directly
through Lockstep core, Electron IPC, and React state updates. Large files can
produce many events per second, which wastes CPU and can make the desktop UI feel
busy even though the useful information only changes at human-scale intervals.
Throttling progress events keeps the UI responsive while preserving final
progress accuracy.

## Current state

- `packages/media-index/src/scan.ts` emits scan progress on skip events, file
  discoveries, and every hash stream chunk.
- `packages/lockstep-core/src/plan-sync.ts` forwards every scan progress event to
  the observer.
- `apps/lockstep/src/main/services/runService.ts` forwards every observer event
  over Electron IPC.
- `apps/lockstep/src/renderer/App.tsx` logs every `scan-progress` event into
  React state.

Relevant excerpts at `326110f`:

```ts
// packages/media-index/src/scan.ts:61-67
stream.on("data", (chunk) => {
  hash.update(chunk);
  bytesHashed += chunk.length;
  onProgress?.(bytesHashed);
});
```

```ts
// packages/media-index/src/scan.ts:145-156
const sha256 = hashFiles
  ? await hashFile({
      filePath: absolutePath,
      onProgress: (bytesHashed) =>
        onProgress?.({
          bytesHashed,
          fileSize: fileStat.size,
          filesFound: items.length,
          path: relativePath,
          skipped: skippedEntries.length,
          stage: "hashing",
        }),
    })
```

```ts
// packages/lockstep-core/src/plan-sync.ts:44-47
const scan = await scanArchive({
  hashFiles: willHash,
  onProgress: (progress) => observer?.onEvent({ type: "scan-progress", progress }),
  ...
});
```

```ts
// apps/lockstep/src/renderer/App.tsx:75-82
if (event.type === "scan-progress") {
  const message = event.progress.stage === "hashing"
    ? `Hashing ${event.progress.path ?? ""} (${event.progress.filesFound} files)`
    : `Scanning (${event.progress.filesFound} files, ${event.progress.skipped} skipped)`;
  setRunLabel(message);
  setLogs((current) => [...current.slice(-200), message]);
}
```

Repo conventions to match:

- `packages/media-index` is shared archive-scanning logic and should remain UI
  agnostic.
- `packages/lockstep-core` is headless and can shape observer events.
- Desktop renderer should avoid unnecessary state churn.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Core tests | `pnpm --filter @latch-works/lockstep-core test` | exit 0, all tests pass |
| Media-index tests | `pnpm --filter @latch-works/media-index test` | exit 0, all tests pass |
| Desktop tests | `pnpm --filter @latch-works/lockstep-app test` | exit 0, all tests pass |
| Typecheck | `pnpm --filter @latch-works/lockstep-core typecheck && pnpm --filter @latch-works/media-index typecheck && pnpm --filter @latch-works/lockstep-app typecheck` | all exit 0 |

## Scope

**In scope**:

- `packages/lockstep-core/src/plan-sync.ts`
- `packages/lockstep-core/src/types.ts`, only if helper types are needed
- `packages/media-index/src/scan.ts`, only if final progress events cannot be
  preserved from core
- `apps/lockstep/src/renderer/App.tsx`, only if log spam still remains after
  core throttling
- Focused tests in affected packages
- `plans/README.md`, status row only

**Out of scope**:

- Changing hash algorithms.
- Changing sync plan results.
- Removing progress reporting entirely.
- Redesigning the desktop run log.

## Git workflow

- Branch: `codex/010-throttle-lockstep-progress`
- Commit style: short imperative summary, for example
  `Throttle Lockstep scan progress.`
- Do not push or open a PR unless the operator asks.

## Steps

### Step 1: Add a progress coalescer in Lockstep core

In `packages/lockstep-core/src/plan-sync.ts`, wrap scan progress forwarding with a
small coalescer.

Recommended behavior:

- Emit immediately when a scan starts or when the path changes.
- During hashing of the same file, emit at most once every 100-250 ms.
- Always emit the latest pending progress before `scanArchive` resolves, so the
  final file count and hash progress are not lost.
- Keep cancellation responsive; do not use timers that continue after the run.

Prefer a deterministic helper that can accept `now()` in tests.

**Verify**:
`pnpm --filter @latch-works/lockstep-core typecheck` -> exit 0.

### Step 2: Keep media-index semantics stable

Leave `packages/media-index/src/scan.ts` unchanged unless core cannot guarantee a
final event. Direct consumers of `scanArchive` may still want raw progress.

If you must change `media-index`, keep `onProgress` semantically equivalent for
callers or add an option rather than changing default behavior.

**Verify**:
`pnpm --filter @latch-works/media-index test` -> exit 0.

### Step 3: Reduce renderer log spam if needed

If core throttling still causes repetitive renderer log entries, update
`apps/lockstep/src/renderer/App.tsx` so scan progress updates `runLabel` but only
logs meaningful milestones, such as path changes or stage changes.

Do not hide item success/failure logs.

**Verify**:
`pnpm --filter @latch-works/lockstep-app typecheck` -> exit 0.

### Step 4: Add tests with fake time

Add tests in `packages/lockstep-core` for the coalescer.

Cover at least:

- Many hashing updates within the throttle window produce one observer event.
- Updates after the throttle window produce another event.
- Changing `path` emits promptly.
- Flushing at scan completion emits the latest pending progress.
- Cancellation/throw paths do not leave timers running.

Use fake timers or an injected clock; do not rely on real sleeps.

**Verify**:
`pnpm --filter @latch-works/lockstep-core test` -> exit 0.

## Test plan

- Core unit tests for the coalescer.
- Existing media-index tests should pass unchanged.
- Desktop tests/typecheck only if renderer logic changes.

## Done criteria

- [ ] Lockstep core no longer forwards every hash stream chunk as an observer
      event.
- [ ] The latest scan progress is still emitted before planning completes.
- [ ] Renderer log spam is reduced or core throttling makes renderer changes
      unnecessary.
- [ ] Core tests cover coalescing, path changes, and flushing.
- [ ] Focused tests and typechecks pass.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

Stop and report if:

- Existing CLI progress tests depend on every single scan-progress event.
- Fake timers are incompatible with the core test harness and real-time tests
  would be flaky.
- Throttling in core would hide progress from a non-desktop consumer that needs
  raw events.

## Maintenance notes

Future progress event types should define their frequency expectations. Reviewers
should check that throttling does not delay cancellation and that final progress
is flushed even when a scan completes quickly.
