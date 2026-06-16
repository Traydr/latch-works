# Plan 003: Add Indexes For Gallery Scope And Search Queries

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving to the next step. If anything in the "STOP
> conditions" section occurs, stop and report - do not improvise. When done, update the status
> row for this plan in `plans/README.md` unless a reviewer told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat c328a78..HEAD -- apps/pane-view/src/server/library/repository.ts apps/pane-view/src/server/db/schema.ts apps/pane-view/drizzle`
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

Pane View's recursive browse and path/name search use `ILIKE` patterns over archive paths. The schema
has B-tree indexes for exact parent-path and logical-path uniqueness, but no index that clearly
supports case-insensitive prefix/substr matching. As the archive grows, recursive folder opens and
search can become table scans in the gallery's initial data path.

This plan adds explicit database support for the existing query shapes and captures query-plan
verification so the later server-owned listing plan has a stable foundation.

## Current state

Relevant files:

- `apps/pane-view/src/server/library/repository.ts` - builds gallery folder/media SQL.
- `apps/pane-view/src/server/db/schema.ts` - Drizzle schema and known indexes.
- `apps/pane-view/drizzle/` - SQL migrations.

Current search and recursive predicates:

```ts
// apps/pane-view/src/server/library/repository.ts:46
const queryPattern = `%${escapeLikePattern(trimmedQuery)}%`;
const mediaQueryCondition = or(
  ilike(libraryEntries.logicalPath, queryPattern),
  ilike(libraryEntries.filename, queryPattern),
);
const folderQueryCondition = or(
  ilike(folders.path, queryPattern),
  ilike(folders.name, queryPattern),
);
```

```ts
// apps/pane-view/src/server/library/repository.ts:67
if (mediaScope.mode === "subtree") {
  mediaConditions.push(
    ilike(libraryEntries.logicalPath, `${escapeLikePattern(mediaScope.pathPrefix)}/%`),
  );
} else if (mediaScope.mode === "direct-children") {
  mediaConditions.push(eq(libraryEntries.parentPath, mediaScope.parentPath));
}
```

Current schema indexes:

```ts
// apps/pane-view/src/server/db/schema.ts:256
(table) => ({
  logicalPathUnique: uniqueIndex("library_entries_logical_path_unique").on(table.logicalPath),
  parentIndex: index("library_entries_parent_path_idx").on(table.parentPath),
  mediaObjectIndex: index("library_entries_media_object_id_idx").on(table.mediaObjectId),
  deletedAtIndex: index("library_entries_deleted_at_idx").on(table.deletedAt),
}),
```

Existing migrations are plain SQL, for example:

```sql
-- apps/pane-view/drizzle/0004_phase7_index_audit.sql:1
CREATE INDEX IF NOT EXISTS "folders_deleted_at_idx" ON "folders" USING btree ("deleted_at");
CREATE INDEX IF NOT EXISTS "library_entries_deleted_at_idx" ON "library_entries" USING btree ("deleted_at");
```

Repo conventions to match:

- Drizzle migrations live under `apps/pane-view/drizzle/` and use numbered SQL files.
- Prefer matching Drizzle schema declarations when Drizzle can represent the index cleanly.
- Keep local service setup notes in AGENTS.md in mind: Pane View uses PostgreSQL.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Typecheck Pane View | `pnpm --filter @latch-works/pane-view typecheck` | exit 0 |
| Focused library tests | `pnpm --filter @latch-works/pane-view test -- src/server/library src/features/library` | exit 0 |
| Generate migrations, if schema changed | `pnpm --filter @latch-works/pane-view db:generate` | exits 0 and does not create unrelated churn |
| Full Pane View check | `pnpm --filter @latch-works/pane-view check` | exit 0 |

## Scope

**In scope**:

- `apps/pane-view/src/server/db/schema.ts`
- New migration under `apps/pane-view/drizzle/`
- `apps/pane-view/drizzle/meta/` only if produced by `drizzle-kit generate`
- Optional: `apps/pane-view/src/server/library/repository.ts` if switching prefix scope from
  `ilike` to a more index-friendly equivalent is required and covered by tests.
- Existing focused tests for query helper behavior.

**Out of scope**:

- Changing gallery response shapes.
- Adding search features beyond existing path/name matching.
- Rewriting search to full-text search.
- Starting PostgreSQL or MinIO unless explicitly asked by the operator.

## Git workflow

- Branch: `codex/003-index-gallery-scope-and-search-queries`
- Commit message style: short imperative, for example `Add gallery query indexes`
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Decide the exact index shape

Inspect the generated SQL and Drizzle support for PostgreSQL operator classes. The target index set
should support:

- recursive path prefix lookup on `library_entries.logical_path`;
- substring search on `library_entries.logical_path` and `library_entries.filename`;
- substring search on `folders.path` and `folders.name`;
- existing exact `parent_path` lookups should continue using current B-tree indexes.

Preferred approach:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS "library_entries_logical_path_trgm_idx"
  ON "library_entries" USING gin ("logical_path" gin_trgm_ops)
  WHERE "deleted_at" IS NULL;
CREATE INDEX IF NOT EXISTS "library_entries_filename_trgm_idx"
  ON "library_entries" USING gin ("filename" gin_trgm_ops)
  WHERE "deleted_at" IS NULL;
CREATE INDEX IF NOT EXISTS "folders_path_trgm_idx"
  ON "folders" USING gin ("path" gin_trgm_ops)
  WHERE "deleted_at" IS NULL;
CREATE INDEX IF NOT EXISTS "folders_name_trgm_idx"
  ON "folders" USING gin ("name" gin_trgm_ops)
  WHERE "deleted_at" IS NULL;
```

If Drizzle cannot represent these indexes cleanly in `schema.ts`, use a manual migration and add a
short comment in the migration explaining why it is manual.

**Verify**: `pnpm --filter @latch-works/pane-view typecheck` -> exit 0.

### Step 2: Add or generate the migration

Create the next numbered migration under `apps/pane-view/drizzle/`. At commit `c328a78`, the latest
visible migration is `0007_derivative_queue_priority.sql`, so the next file should be
`0008_gallery_query_indexes.sql` unless new migrations have appeared.

Use `IF NOT EXISTS` for extension and indexes.

If you model the indexes in `schema.ts`, run:

`pnpm --filter @latch-works/pane-view db:generate`

Then inspect the generated migration. Keep only relevant migration output.

**Verify**: `pnpm --filter @latch-works/pane-view typecheck` -> exit 0.

### Step 3: Preserve query-helper behavior

Do not change search semantics unless Step 1 proves a query rewrite is necessary. If you do change
`repository.ts` from `ilike` to another expression, add or update focused tests so these still hold:

- recursive subtree under `sfw/patreon` matches descendants, not sibling prefixes;
- search escapes `%` and `_`;
- direct child mode still uses `parentPath` equality.

Use `apps/pane-view/src/server/library/repository.test.ts` as the pattern.

**Verify**: `pnpm --filter @latch-works/pane-view test -- src/server/library src/features/library` -> exit 0.

### Step 4: Add optional local EXPLAIN documentation if Postgres is available

If a local Pane View database is already running and configured, apply the migration and run
`EXPLAIN` manually for these query shapes:

- recursive path prefix: `logical_path ILIKE 'some/path/%'`;
- search: `logical_path ILIKE '%term%' OR filename ILIKE '%term%'`.

Do not start services or source secrets unless instructed by the operator. If Postgres is not already
available, skip this step and note it in the PR/summary.

**Verify**: With Postgres available, `EXPLAIN` shows a `Bitmap Index Scan` or equivalent index use
for selective searches. Without Postgres, record "EXPLAIN not run; no local DB available".

## Test plan

- Focused library tests must pass.
- Typecheck must pass.
- If repository predicates change, add tests for escaping and subtree boundaries.
- If a local DB is available, run EXPLAIN as described.

## Done criteria

- [ ] A migration adds indexes for existing gallery recursive/search query shapes.
- [ ] `pg_trgm` extension creation is included if trigram indexes are used.
- [ ] `pnpm --filter @latch-works/pane-view typecheck` exits 0.
- [ ] `pnpm --filter @latch-works/pane-view test -- src/server/library src/features/library` exits 0.
- [ ] `pnpm --filter @latch-works/pane-view check` exits 0, or any known pre-existing failure is documented.
- [ ] No source files outside the in-scope list are modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back if:

- Drizzle generates destructive migration SQL.
- The migration would require dropping or rebuilding existing unique indexes.
- Query semantics would need to become case-sensitive.
- The exact index approach cannot be represented or documented without broad schema churn.
- Verification fails twice after reasonable fixes.

## Maintenance notes

Plan 004's server-owned listing queries should be designed with these indexes in mind. Reviewers
should check migration safety and production impact; GIN trigram indexes can be large, but the
gallery query path is user-facing enough to justify them if EXPLAIN confirms benefit.
