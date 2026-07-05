# Plan 020: Remove Unused Pane View Favorites Schema

> **Executor instructions**: Run the drift check first. This plan follows the
> maintainer decision: do not build favorites now; remove the unused table/schema
> instead. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 8f19cd4..HEAD -- apps/pane-view/src/server/db/schema.ts apps/pane-view/drizzle apps/pane-view/src/server/management apps/pane-view/src/features apps/pane-view/src/routes`

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/001-add-github-actions-verification-baseline.md
- **Category**: migration, tech-debt
- **Planned at**: commit `8f19cd4`, 2026-07-05

## Why This Matters

The audit originally suggested productizing favorites because the table exists,
but the maintainer explicitly does not want favorites in Pane View right now.
Leaving an unused table and cleanup code implies a feature direction that is not
desired. Removing it reduces schema surface and future confusion.

## Current State

- `apps/pane-view/src/server/db/schema.ts:385-398` defines `favorites` with
  `userId`, `subjectId`, `subjectType`, and `createdAt`.
- Grep found only deletion references outside schema:
  `server/management/library-wipe.ts:44` and `cleanup-worker.ts:276`.
- No favorites repository, route, server function, or UI exists.
- Drizzle migrations live in `apps/pane-view/drizzle/*.sql`; config is
  `apps/pane-view/drizzle.config.ts:5-12`.

## Commands You Will Need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Generate migration | `pnpm --filter @latch-works/pane-view db:generate` | creates one new migration |
| Pane View tests | `pnpm --filter @latch-works/pane-view test -- management db` | exit 0 |
| Typecheck | `pnpm --filter @latch-works/pane-view typecheck` | exit 0 |

## Scope

**In scope**:
- `apps/pane-view/src/server/db/schema.ts`
- New Drizzle migration under `apps/pane-view/drizzle/`
- `apps/pane-view/src/server/management/library-wipe.ts`
- `apps/pane-view/src/server/management/cleanup-worker.ts`
- Related management tests

**Out of scope**:
- Removing `viewer_state`.
- Removing `subject_type` if `viewer_state` still uses it.
- Any favorites UI or API.

## Git Workflow

- Branch: `advisor/020-remove-favorites-schema`
- Commit message: `Remove unused favorites schema`

## Steps

### Step 1: Remove Runtime References

Remove `favorites` imports and delete calls from `library-wipe.ts` and
`cleanup-worker.ts`. Keep viewer-state cleanup intact.

**Verify**: `grep -R "favorites" apps/pane-view/src/server/management apps/pane-view/src/features apps/pane-view/src/routes` -> no matches.

### Step 2: Remove Schema Table

Delete the `favorites` table definition from `schema.ts`. Keep `subjectTypeEnum`
because `viewer_state` still uses it.

**Verify**: `pnpm --filter @latch-works/pane-view typecheck` -> initially may fail until tests/imports are updated, then exits 0.

### Step 3: Generate And Review Migration

Run `pnpm --filter @latch-works/pane-view db:generate`. Review the generated SQL
to ensure it only drops the `favorites` table and related constraints/indexes.
Do not hand-edit unrelated migration history.

**Verify**: the new migration contains a `DROP TABLE` for favorites and no
unrelated table changes.

### Step 4: Update Tests

Update management tests that expected favorite cleanup calls. Add a small schema
or grep assertion only if the existing tests do not cover removed references.

**Verify**: `pnpm --filter @latch-works/pane-view test -- management && pnpm --filter @latch-works/pane-view typecheck` -> exits 0.

## Test Plan

- Existing library wipe and cleanup worker tests should pass after removing
  favorites delete expectations.
- No new product tests are needed because the feature is removed before use.

## Done Criteria

- [ ] `favorites` table removed from schema.
- [ ] New Drizzle migration drops only the favorites table.
- [ ] No runtime imports or references to `favorites` remain.
- [ ] Pane View focused tests and typecheck exit 0.
- [ ] `plans/README.md` status row updated.

## STOP Conditions

- Production data must be preserved or exported before dropping the table.
- Other code has been added that uses favorites since this plan was written.
- Drizzle generates unrelated schema changes.

## Maintenance Notes

- If favorites are desired later, reintroduce them from a fresh product plan with
  UI/API requirements rather than reviving dead schema by default.
