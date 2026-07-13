# Plan 025: Restore a trustworthy Drizzle migration baseline

> **Executor instructions**: This is migration metadata work. Use two disposable databases and
> inspect generated SQL before replacing it with a no-op. Run every gate and stop on any unexpected
> DDL. Update the status row in `docs/plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat fd5693d..HEAD -- apps/pane-view/drizzle apps/pane-view/src/server/db/schema.ts apps/pane-view/drizzle.config.ts`

## Status

- **Status**: BLOCKED after execution; revised procedure awaits a fresh executor
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
already-applied changes and emit destructive or misleading SQL. The target is a comments-only
baseline migration whose ordinary-generator snapshot matches the current schema, verified on both
fresh and already-migrated disposable PostgreSQL databases.

## Current state

- `apps/pane-view/drizzle/meta/_journal.json:54-80` records `0007` through `0010`.
- `apps/pane-view/drizzle/meta/0006_snapshot.json:1515` still contains `public.thumbnails`.
- `apps/pane-view/drizzle/0009_shutter_only.sql` drops that table and derivative enums.
- `apps/pane-view/src/server/db/schema.ts` is the current Shutter-only schema.
- An execution attempt proved that Drizzle Kit `0.31.10` custom migrations copy the latest snapshot:
  `--custom` created empty SQL but retained `public.thumbnails` and `public.thumbnail_status`.
- Ordinary `drizzle-kit generate` derives a current snapshot from `schema.ts`; its generated SQL must
  first be audited as the already-applied net effect of hand-written migrations `0007` through `0010`,
  then only the new SQL body is replaced with an explanatory comments-only no-op.
- Drizzle config imports the full validated Pane environment; use a secret-free disposable env and
  never copy values from an existing `.env` into committed files.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Generate baseline | `SKIP_ENV_VALIDATION=1 pnpm --filter @latch-works/pane-view db:generate --name schema_baseline` | one new migration, journal entry, and current snapshot |
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

### Step 1: Prepare the through-0010 upgrade database

Provision two empty disposable PostgreSQL databases: one for the fresh path and one for the upgrade
path. Before generating `0011`, point `DATABASE_URL` only at the upgrade database and run the existing
migrations through `0010`. Use `SKIP_ENV_VALIDATION=1` so unrelated application secrets are not
required. Record the current application-table/enum catalog for later comparison; never print the
database URL.

**Verify**:

```bash
SKIP_ENV_VALIDATION=1 DATABASE_URL="$UPGRADE_DATABASE_URL" pnpm --filter @latch-works/pane-view db:migrate
```

Expected: exit 0 with journal entries only through `0010`.

### Step 2: Generate and audit a current snapshot

Run ordinary generation, not `--custom`. It should compare stale snapshot `0006` with current
`schema.ts`, producing `0011_schema_baseline.sql`, `meta/0011_snapshot.json`, and one journal entry.
Before editing the SQL, account for every generated operation against the already-applied net effect
of `0007`-`0010`. The manual `pg_trgm` extension/indexes from `0008` are intentionally not modeled by
`schema.ts`; do not add them to the snapshot.

The new snapshot must omit `public.thumbnails`, `public.thumbnail_status`,
`derivative_queue_source`, and `derivative_queue_variant`; it must contain the current
`maintenance_job_type` values including `legacy_derivative_cleanup`. Its `prevId` must equal the
`id` from `0006_snapshot.json`.

**Verify**: run
`SKIP_ENV_VALIDATION=1 pnpm --filter @latch-works/pane-view db:generate --name schema_baseline`.
It must create exactly the three expected metadata/migration changes; the snapshot must match
`schema.ts`, and no generated operation may be unexplained by `0007`-`0010`.

### Step 3: Convert only the new migration body to a no-op

Replace only the executable body of `0011_schema_baseline.sql` with comments explaining that
`0007`-`0010` already applied the represented schema delta and `0011` advances Drizzle's snapshot
baseline. Do not edit the generated snapshot IDs, journal entry, or any migration `0000`-`0010`.

**Verify**:

```bash
rg -n 'CREATE|ALTER|DROP|TRUNCATE|DELETE|UPDATE|INSERT' apps/pane-view/drizzle/0011_*.sql
```

Expected: no executable DDL/DML matches.

### Step 4: Prove fresh and upgrade paths are equivalent

Run all migrations through `0011` on the fresh database. Then run migration again against the upgrade
database so only comments-only `0011` is newly applied. Compare relevant PostgreSQL catalogs: current
modeled tables/enums must match, obsolete thumbnail objects must be absent, and both databases must
retain the manual `0008` indexes.

**Verify**: run `db:migrate` once with `DATABASE_URL="$FRESH_DATABASE_URL"` and once with
`DATABASE_URL="$UPGRADE_DATABASE_URL"`, setting `SKIP_ENV_VALIDATION=1` for both. Both commands must
exit 0 and the catalog comparison must have no differences.

### Step 5: Prove future generation stability

Run ordinary `db:generate` with the final `0011` snapshot present. Record `git status --short` before
and after. Drizzle must report no schema changes and create no `0012` files or tracked modifications.
Remove any untracked probe artifact before reporting; do not commit it.

**Verify**: `SKIP_ENV_VALIDATION=1 pnpm --filter @latch-works/pane-view db:generate` reports no
schema changes; `pnpm --filter @latch-works/pane-view typecheck` exits 0.

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

- Ordinary generation does not create a current snapshot with this Drizzle version.
- Generated SQL contains an operation not fully accounted for by `0007`-`0010`.
- Repair would require changing applied migration checksums or rewriting `0000`-`0010`.
- Fresh and upgrade-path databases produce different current schemas.
- A generation probe after `0011` creates another schema diff.

## Maintenance notes

Future hand-written migrations must leave Drizzle with a current snapshot baseline. Reviewers should
reject schema changes that update SQL/journal without an equivalent generation-drift verification.
