# Plan 025: Restore a trustworthy Drizzle migration baseline

> **Executor instructions**: This is migration metadata work. Use a disposable database and inspect
> generated SQL before applying anything. Run every gate and stop on any unexpected DDL. Update the
> status row in `docs/plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat fd5693d..HEAD -- apps/pane-view/drizzle apps/pane-view/src/server/db/schema.ts apps/pane-view/drizzle.config.ts`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: migration
- **Planned at**: commit `fd5693d`, 2026-07-13
- **Original finding**: 10

## Why this matters

The migration journal records migrations through `0010`, but the newest snapshot is `0006` and still
models the removed `thumbnails` table. A future `drizzle-kit generate` can therefore rediscover
already-applied changes and emit destructive or misleading SQL. The target is an explicit, empty
baseline migration whose snapshot matches the current schema, verified on both fresh and already-
migrated disposable PostgreSQL databases.

## Current state

- `apps/pane-view/drizzle/meta/_journal.json:54-80` records `0007` through `0010`.
- `apps/pane-view/drizzle/meta/0006_snapshot.json:1515` still contains `public.thumbnails`.
- `apps/pane-view/drizzle/0009_shutter_only.sql` drops that table and derivative enums.
- `apps/pane-view/src/server/db/schema.ts` is the current Shutter-only schema.
- Drizzle config imports the full validated Pane environment; use a secret-free disposable env and
  never copy values from an existing `.env` into committed files.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Generate baseline | `pnpm --filter @latch-works/pane-view db:generate -- --custom --name schema_baseline` | one new migration, journal entry, and snapshot |
| Migrate | `pnpm --filter @latch-works/pane-view db:migrate` | exit 0 against disposable DB |
| Typecheck | `pnpm --filter @latch-works/pane-view typecheck` | exit 0 |

## Scope

**In scope**: a new `apps/pane-view/drizzle/0011_*` baseline SQL file; its matching snapshot;
`apps/pane-view/drizzle/meta/_journal.json`; optionally a migration-drift check script under
`apps/pane-view/scripts/` and its package script.

**Out of scope**: rewriting `0000`-`0010`; editing production databases; changing application
schema; adding new product columns or indexes.

## Git workflow

- Branch: `codex/025-repair-drizzle-snapshot-baseline`
- Commit message: `Restore Drizzle schema baseline`
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Generate an explicit custom baseline

Run the custom generation command with a disposable environment. The new SQL must contain no schema
DDL: comments or an intentionally empty migration are acceptable. Confirm the new snapshot omits
`thumbnails`, old derivative queue types, and matches current tables/enums.

**Verify**: `rg -n 'CREATE|ALTER|DROP|TRUNCATE|DELETE|UPDATE|INSERT' apps/pane-view/drizzle/0011_*.sql`
-> no executable DDL/DML matches.

### Step 2: Prove fresh migration history

Create a disposable empty PostgreSQL database, run `db:migrate`, and inspect that all migrations
through the baseline apply once. Query for the current tables and confirm `thumbnails` is absent.

**Verify**: `pnpm --filter @latch-works/pane-view db:migrate` -> exit 0 against the fresh DB.

### Step 3: Prove upgrade compatibility and future generation stability

Create a second disposable DB migrated through `0010`, then apply only the new baseline. In a clean
temporary worktree, run ordinary `db:generate`; it must report no schema changes or generate an empty
diff. Do not commit any probe artifacts.

**Verify**: baseline migration exits 0 on the through-0010 DB; an ordinary generation produces no
executable schema migration.

### Step 4: Add a drift guard if it can remain deterministic

If Drizzle offers a stable check without modifying tracked files, expose it as a package script. If
the only check writes generated files, document the disposable-worktree procedure instead of adding
a destructive CI script.

**Verify**: `pnpm --filter @latch-works/pane-view typecheck` -> exit 0.

## Test plan

- Fresh empty database: migrations `0000` through baseline succeed.
- Existing through-`0010` database: baseline succeeds and changes no application tables.
- Current schema generation: no duplicate drop/create operations.
- Snapshot inspection: no `thumbnails`, `thumbnail_status`, or derivative queue types.

## Done criteria

- [ ] New baseline SQL contains no executable schema/data change.
- [ ] New snapshot represents the current schema.
- [ ] Both disposable migration paths succeed.
- [ ] A subsequent generation has no schema diff.
- [ ] Pane View typecheck passes.

## STOP conditions

- `--custom` does not create a current snapshot with this Drizzle version.
- Generated SQL contains any executable DDL/DML.
- Repair would require changing applied migration checksums or rewriting `0000`-`0010`.
- Fresh and upgrade-path databases produce different current schemas.

## Maintenance notes

Future hand-written migrations must leave Drizzle with a current snapshot baseline. Reviewers should
reject schema changes that update SQL/journal without an equivalent generation-drift verification.

