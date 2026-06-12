# Plan 012: Update Lockstep Delete Behavior Documentation

> **Executor instructions**: Follow this plan step by step. Run every verification
> command and confirm the expected result before moving to the next step. If any
> STOP condition occurs, stop and report instead of improvising. When done,
> update this plan's row in `plans/README.md` unless a reviewer says they own the
> index.
>
> **Drift check (run first)**:
> `git diff --stat 326110f..HEAD -- docs/runbooks/lockstep.md docs/end-to-end-request-flow.md apps/lockstep-cli/README.md apps/lockstep-cli/src/options.ts packages/lockstep-core/src/push-changes.ts packages/lockstep-core/src/prune-deleted.ts`
> If any in-scope file changed, compare the excerpts below with the live code
> before proceeding. A mismatch is a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/004-lockstep-prune-confirmation.md
- **Category**: docs
- **Planned at**: commit `326110f`, 2026-06-12

## Why this matters

Lockstep docs still describe deletes as part of `push`, but the current code
separates upload/update (`push`) from remote delete (`prune`). Stale docs are
risky here because they describe destructive sync behavior. This plan updates
runbooks and CLI docs so operators know exactly which command can delete remote
library entries.

## Current state

- `packages/lockstep-core/src/push-changes.ts` only selects upload/update items.
- `packages/lockstep-core/src/prune-deleted.ts` applies delete items.
- Docs still say push handles or records deletes.

Relevant excerpts at `326110f`:

```md
<!-- docs/runbooks/lockstep.md:86-89 -->
`push` sends the current local plan to the Pane View sync API. It hashes files
automatically, fetches the remote snapshot when `--remote-snapshot` is not
provided, asks the API for upload targets, uploads originals when storage
credentials are configured, and records deletes for local paths that disappeared.
```

```md
<!-- docs/runbooks/lockstep.md:120 -->
`push` always hashes local files before planning, even when `--max-changes` is
set. Capped pushes take the first N planned changes in plan order. If that cap
skips delete actions, Lockstep prints a warning with the number of delayed
deletes.
```

```md
<!-- docs/end-to-end-request-flow.md:110-117 -->
| `delete` | Path exists remotely but not locally (handled on push, not during plan-only) |

`plan` and `verify` stop here. Only `push` continues below.
```

```md
<!-- apps/lockstep-cli/README.md:7 -->
`plan` and `verify` are **read-only**. Only `push` writes to remote storage.
... Capped pushes warn when delete actions are delayed by `--max-changes` ...
```

Repo conventions to match:

- Docs use concise runbook language and PowerShell examples for Windows archive
  paths.
- Keep command syntax aligned with AGENTS: do not insert `--` between
  `pnpm start:lockstep` and subcommands in new docs unless preserving old quoted
  examples intentionally.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Text scan | `rg "handled on push|records deletes|delayed deletes|push.*delete|delete.*push" docs apps/lockstep-cli/README.md` | no stale claims remain |
| CLI tests | `pnpm --filter @latch-works/lockstep test` | exit 0, if docs examples are tested |
| Docs typecheck | `pnpm --filter @latch-works/showcase typecheck` | exit 0, if docs import/render checks are relevant |

## Scope

**In scope**:

- `docs/runbooks/lockstep.md`
- `docs/end-to-end-request-flow.md`
- `apps/lockstep-cli/README.md`
- `plans/README.md`, status row only

**Out of scope**:

- Changing Lockstep runtime behavior.
- Changing CLI option parsing.
- Rewriting unrelated architecture docs.
- Adding screenshots.

## Git workflow

- Branch: `codex/012-update-lockstep-delete-docs`
- Commit style: short imperative summary, for example
  `Update Lockstep delete docs.`
- Do not push or open a PR unless the operator asks.

## Steps

### Step 1: Update command responsibility language

Update docs so they consistently say:

- `plan` and `verify` are read-only.
- `push` hashes, uploads, and registers upload/update changes only.
- `prune` applies remote deletes for paths that are absent locally.
- If plan 004 has landed, `prune` requires `--yes` or explicit confirmation when
  delete items are present.

**Verify**:
`rg "records deletes|handled on push|delayed deletes" docs apps/lockstep-cli/README.md`
-> no matches.

### Step 2: Fix the end-to-end flow diagram

In `docs/end-to-end-request-flow.md`, split the flow into:

- plan creation with `delete` as a planned action
- push loop for upload/update only
- prune loop for delete actions

Keep the existing Mermaid style. Do not claim `push` calls
`/api/sync/complete-object` with `action: delete`.

**Verify**:
`rg "action: delete|delete.*complete-object|push.*delete" docs/end-to-end-request-flow.md`
-> no stale push-delete claim remains.

### Step 3: Update examples and caveats

Where examples show destructive behavior, use `prune --yes` only for scripted
automation and describe the preview/confirmation path for manual runs.

Do not include real tokens or private endpoints beyond existing placeholder
examples.

**Verify**:
`rg "prune|--yes|push" docs/runbooks/lockstep.md apps/lockstep-cli/README.md`
-> output reflects the new command split.

## Test plan

- Text scans are the primary verification.
- Run docs/showcase typecheck only if the touched docs are part of the showcase
  content pipeline.

## Done criteria

- [ ] Docs consistently separate `push` upload/update from `prune` delete.
- [ ] No stale "push records deletes" claims remain.
- [ ] End-to-end flow has a prune delete path.
- [ ] Examples avoid leaking real secrets and use current command syntax.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

Stop and report if:

- Code has changed so `push` once again applies deletes.
- Plan 004 has not landed and the operator does not want docs to mention prune
  confirmation yet.
- The docs are generated from another source file not listed here.

## Maintenance notes

When Lockstep command semantics change, update `apps/lockstep-cli/src/options.ts`
help text, CLI README, and runbooks in the same PR. Reviewers should treat stale
delete docs as a safety issue, not cosmetic wording.
