# Plan 004: Add A Real Confirmation Gate To Lockstep Prune

> **Executor instructions**: Follow this plan step by step. Run every verification
> command and confirm the expected result before moving to the next step. If any
> STOP condition occurs, stop and report instead of improvising. When done,
> update this plan's row in `plans/README.md` unless a reviewer says they own the
> index.
>
> **Drift check (run first)**:
> `git diff --stat 326110f..HEAD -- apps/lockstep-cli/src/commands.ts apps/lockstep-cli/src/options.ts apps/lockstep-cli/src/*.test.ts packages/lockstep-core/src/prune-deleted.ts apps/lockstep-cli/README.md`
> If any in-scope file changed, compare the excerpts below with the live code
> before proceeding. A mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: safety
- **Planned at**: commit `326110f`, 2026-06-12

## Why this matters

`lockstep prune` applies remote deletes. The CLI has a `--yes` option, but prune
currently proceeds without requiring it and without printing the delete list.
That makes a destructive sync action too easy to run accidentally, especially
because plan summaries suppress changed-item previews for both `push` and
`prune`. This plan adds a preview plus an explicit confirmation gate while
preserving scriptable use through `--yes`.

## Current state

- `apps/lockstep-cli/src/options.ts` parses `--yes`.
- `apps/lockstep-cli/src/commands.ts` executes `pruneDeleted` directly for
  `options.command === "prune"`.
- `packages/lockstep-core/src/prune-deleted.ts` performs the actual API delete
  calls. Do not move CLI confirmation into core.

Relevant excerpts at `326110f`:

```ts
// apps/lockstep-cli/src/commands.ts:142-152
if (options.command === "prune") {
  const result = await pruneDeleted(
    {
      apiToken: requiredApiToken,
      apiUrl: requiredApiUrl,
      maxChanges: options.maxChanges,
      plan,
      sourceRoot: options.source,
    },
    observer,
  );
```

```ts
// apps/lockstep-cli/src/commands.ts:188-191
const changedItems = plan.items.filter((item) => item.action !== "keep");
const previewCount = options.command === "push" || options.command === "prune" ? 5 : 20;
const changedPreview = changedItems.slice(0, previewCount);
if (changedPreview.length > 0 && options.command !== "push" && options.command !== "prune") {
```

Repo conventions to match:

- CLI is a thin wrapper over `packages/lockstep-core`; keep prompting and
  terminal UI inside `apps/lockstep-cli`.
- `plan` and `verify` are read-only; `push` uploads/updates; `prune` deletes.
- Existing tests use Vitest and should not call real APIs.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| CLI tests | `pnpm --filter @latch-works/lockstep test` | exit 0, all CLI tests pass |
| Core tests | `pnpm --filter @latch-works/lockstep-core test` | exit 0, all core tests pass |
| CLI typecheck | `pnpm --filter @latch-works/lockstep typecheck` | exit 0, no TypeScript errors |

## Scope

**In scope**:

- `apps/lockstep-cli/src/commands.ts`
- `apps/lockstep-cli/src/options.ts`, only if help text needs adjustment
- `apps/lockstep-cli/src/*.test.ts`
- `apps/lockstep-cli/README.md`, only for CLI behavior wording
- `plans/README.md`, status row only

**Out of scope**:

- Changing `packages/lockstep-core/src/prune-deleted.ts` deletion semantics.
- Adding desktop app confirmation. This plan is CLI-only.
- Changing push behavior.
- Adding a TUI or long-lived interactive wizard.

## Git workflow

- Branch: `codex/004-lockstep-prune-confirmation`
- Commit style: short imperative summary, for example
  `Require confirmation for lockstep prune.`
- Do not push or open a PR unless the operator asks.

## Steps

### Step 1: Print delete previews for prune

Change `printPlanSummary` so `prune` prints the planned delete items it is about
to apply. Keep `push` concise if that is the intended behavior, but prune should
show delete paths because the operation is destructive.

Recommended behavior:

- For `prune`, preview only `plan.items` where `item.action === "delete"`.
- Respect `--max-changes` when deciding which deletes will be applied.
- Print a bounded list, for example first 20 paths plus `... and N more`.
- Include the total delete count and capped count if applicable.

**Verify**:
`pnpm --filter @latch-works/lockstep typecheck` -> exit 0.

### Step 2: Require explicit confirmation unless `--yes` is present

Before calling `pruneDeleted`, require one of:

- `options.yes === true`, for non-interactive/scripted runs.
- A TTY confirmation where the user types an exact phrase such as `prune`.

If stdin is not interactive and `--yes` is absent, exit without pruning and set a
non-zero `process.exitCode`.

Implementation guidance:

- Keep the prompt helper private to `commands.ts` unless an existing CLI prompt
  utility exists.
- Do not prompt if there are zero delete items; print "Nothing to prune."
  without calling core.
- Do not require confirmation for `plan`, `verify`, `doctor`, or `push`.

**Verify**:
`pnpm --filter @latch-works/lockstep typecheck` -> exit 0.

### Step 3: Add CLI tests

Add tests that mock `pruneDeleted` and exercise `executeCommand`.

Cover at least:

- `prune` with delete items and no `--yes` in a non-interactive environment does
  not call `pruneDeleted` and exits non-zero.
- `prune --yes` calls `pruneDeleted`.
- `prune` prints delete paths in the summary.
- `prune` with zero delete items does not prompt and does not call
  `pruneDeleted`.

If existing tests do not expose `executeCommand`, add the smallest test seam
needed. Avoid testing real stdin if a simple injected prompt helper is cleaner.

**Verify**:
`pnpm --filter @latch-works/lockstep test` -> exit 0.

### Step 4: Update CLI docs

Update `apps/lockstep-cli/README.md` so prune is clearly described as the
delete-applying command and `--yes` is required for scripted pruning.

**Verify**:
`rg "prune|--yes|delete" apps/lockstep-cli/README.md` -> output includes the new
confirmation wording.

## Test plan

- CLI tests in `apps/lockstep-cli/src`.
- No network calls; mock `packages/lockstep-core`.
- The critical regression is that destructive prune cannot run silently without
  `--yes` or an interactive exact confirmation.

## Done criteria

- [ ] `prune` previews the delete paths it will apply.
- [ ] `prune` requires `--yes` or exact interactive confirmation when deletes
      are present.
- [ ] Non-interactive prune without `--yes` does not call core and exits non-zero.
- [ ] Zero-delete prune remains a no-op without prompting.
- [ ] CLI tests and typecheck pass.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

Stop and report if:

- Existing CLI architecture has no reliable way to detect or inject TTY
  confirmation without a broad refactor.
- Tests show another documented workflow depends on non-interactive prune
  without `--yes`.
- The delete list can contain sensitive absolute paths that should not be printed
  in full; report and ask for a redaction policy.

## Maintenance notes

Keep confirmation in the CLI layer. Core must remain usable by desktop and other
callers that provide their own UX. Reviewers should check that `--yes` is still
required in automation and that the summary cannot hide a destructive operation.
