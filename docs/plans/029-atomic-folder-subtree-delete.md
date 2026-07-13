# Plan 029: Make folder-subtree deletion atomic

> **Executor instructions**: Implement the transaction boundary exactly as specified, run every
> gate, and update `docs/plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat fd5693d..HEAD -- apps/pane-view/src/server/management/folder-delete.ts apps/pane-view/src/server/management/folder-delete.test.ts`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `fd5693d`, 2026-07-13
- **Original finding**: 7

## Why this matters

Subtree deletion currently updates entries and folders in separate statements and repeats that pair
outside a transaction for every selected root. An error can leave the hierarchy partially deleted.
The full user action must either commit all selected subtrees or leave every row untouched.

## Current state

- `folder-delete.ts:49-56` normalizes and validates all requested paths before mutation; retain this.
- `folder-delete.ts:60-88` performs two root-DB updates per path without a transaction.
- `folder-delete.test.ts` uses mocked Drizzle update chains but does not model rollback.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused tests | `pnpm --filter @latch-works/pane-view test -- src/server/management/folder-delete.test.ts` | all pass |
| Pane check | `pnpm --filter @latch-works/pane-view check` | exit 0 |

## Scope

**In scope**: `folder-delete.ts`, `folder-delete.test.ts`; a small disposable-Postgres integration
test only if the existing test harness supports it cleanly.

**Out of scope**: hard wipe; restoring deleted folders; S3/Shutter deletion; UI confirmation text;
changing path matching semantics.

## Git workflow

- Branch: `codex/029-atomic-folder-subtree-delete`
- Commit message: `Make folder subtree deletion atomic`

## Steps

### Step 1: Move every mutation into one transaction

Keep normalization and root rejection before opening the transaction. Inside one `db.transaction`,
process every normalized selected path and collect the existing per-path counts. Use the same `now`
timestamp for the whole action.

**Verify**: tests assert one transaction wraps all updates and two selected roots return two results.

### Step 2: Prove rollback behavior

Add a regression test where the folder update for the second selected root fails. The transaction
must reject and expose no successful result. Prefer a disposable PostgreSQL integration assertion if
available; otherwise make the transaction mock record staged mutations and discard them on failure.

**Verify**: focused tests pass, including second-statement and second-root failure.

## Test plan

Cover empty/root rejection, deduped normalized paths, one root, multiple roots, failure during the
folder update, and failure on a later root. Follow the existing `folder-delete.test.ts` style.

## Done criteria

- [ ] All selected subtrees commit in one transaction.
- [ ] Any mutation error rejects the whole action.
- [ ] Existing result shape and matching rules remain unchanged.
- [ ] Focused tests and Pane check pass.

## STOP conditions

- Product intent requires partial success per selected root.
- A transaction would require changing the public response shape.
- Real database behavior differs from the transaction mock.

## Maintenance notes

Large selections hold locks longer; reviewers should ensure path validation happens before the
transaction and that no network I/O is introduced inside it.

