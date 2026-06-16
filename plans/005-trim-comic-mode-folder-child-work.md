# Plan 005: Trim Comic Mode Folder Child Lookup Work

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving to the next step. If anything in the "STOP
> conditions" section occurs, stop and report - do not improvise. When done, update the status
> row for this plan in `plans/README.md` unless a reviewer told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat c328a78..HEAD -- apps/pane-view/src/server/library/repository.ts apps/pane-view/src/features/gallery/GalleryPage.tsx packages/media-domain/src/comics.ts`
> If this reports changes, compare the "Current state" excerpts below against the live code before
> proceeding. On a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S/M
- **Risk**: LOW-MED
- **Depends on**: none; if Plan 004 fully replaces comic listing, re-evaluate this plan first
- **Category**: perf
- **Planned at**: commit `c328a78`, 2026-06-17

## Why this matters

Comic mode requests all folders so the client can group image/gif pages into leaf-folder comics.
The current snapshot code then asks `readParentPathsWithChildren` about every returned folder path.
Once the path count crosses 500, that helper scans distinct parent paths from all active folders and
all active library entries, even though comic grouping only needs folder parent paths to know whether
a folder has child folders.

This plan reduces comic-mode snapshot work without changing comic grouping behavior.

## Current state

Relevant files:

- `apps/pane-view/src/server/library/repository.ts` - snapshot query and child lookup helper.
- `apps/pane-view/src/features/gallery/GalleryPage.tsx` - passes `library.allFolders` into comic
  grouping.
- `packages/media-domain/src/comics.ts` - uses only `parentPath` from folder nodes for leaf detection.

Current comic mode asks the snapshot to include all folders:

```ts
// apps/pane-view/src/features/library/library-service.ts:64
const databaseSnapshot = await readDatabaseLibrarySnapshot({
  currentPath,
  includeAllFolders: comicMode,
  limit: mediaLimit,
  offset: mediaOffset,
  query,
  recursive,
});
```

Current snapshot child lookup combines visible folders and all folders:

```ts
// apps/pane-view/src/server/library/repository.ts:111
const folderPaths = [...new Set([...folderRows, ...allFolderRows].map((folder) => folder.path))];
const parentPathsWithChildren = await readParentPathsWithChildren(folderPaths);
```

Current helper scans all active library entry parents when path count exceeds 500:

```ts
// apps/pane-view/src/server/library/repository.ts:255
const [folderParents, entryParents] =
  paths.length > parentPathLookupThreshold
    ? await Promise.all([
        db
          .selectDistinct({ parentPath: folders.parentPath })
          .from(folders)
          .where(isNull(folders.deletedAt)),
        db
          .selectDistinct({ parentPath: libraryEntries.parentPath })
          .from(libraryEntries)
          .where(isNull(libraryEntries.deletedAt)),
      ])
```

Current comic grouping only reads folder parent paths:

```ts
// packages/media-domain/src/comics.ts:26
const pathsWithChildFolders =
  options.leafFoldersOnly && options.folders
    ? new Set(
        options.folders
          .map((folder) => folder.parentPath)
          .filter((parentPath): parentPath is string => Boolean(parentPath)),
      )
    : null;
```

Repo conventions to match:

- Keep shared domain logic in `packages/media-domain` pure and I/O-free.
- Keep database-specific optimizations in `apps/pane-view/src/server/library`.
- Preserve the term "comic mode" used in Pane View docs and UI.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Media domain tests | `pnpm --filter @latch-works/media-domain test` | exit 0 |
| Focused library tests | `pnpm --filter @latch-works/pane-view test -- src/server/library src/features/library` | exit 0 |
| Typecheck Pane View | `pnpm --filter @latch-works/pane-view typecheck` | exit 0 |
| Full Pane View check | `pnpm --filter @latch-works/pane-view check` | exit 0 |

## Scope

**In scope**:

- `apps/pane-view/src/server/library/repository.ts`
- `apps/pane-view/src/server/library/repository.test.ts`
- Optional: `packages/media-domain/src/comics.ts` only if narrowing the folder type improves clarity.
- Optional: `packages/media-domain/src/media.test.ts` if shared comic behavior changes.

**Out of scope**:

- Redesigning comic mode.
- Server-owned comic listing from Plan 004.
- Changing `BrowserEntry` shape.
- Changing media filters or sort modes.
- Derivative or delivery code.

## Git workflow

- Branch: `codex/005-trim-comic-mode-folder-child-work`
- Commit message style: short imperative, for example `Trim comic mode folder lookup`
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Split visible folder child flags from comic folder metadata

In `readDatabaseLibrarySnapshot`, stop passing every `allFolderRows` path into the expensive
`readParentPathsWithChildren` helper.

Target behavior:

- `folderRows` used by the visible folder grid still get accurate `hasChildren` based on child folders
  and child media entries.
- `allFolders` used by comic grouping do not need accurate media-child `hasChildren`; comic grouping
  only needs `parentPath`.

One safe shape:

```ts
const visibleFolderPaths = [...new Set(folderRows.map((folder) => folder.path))];
const visibleParentPathsWithChildren = await readParentPathsWithChildren(visibleFolderPaths);
const folderParentPathsWithChildFolders = new Set(
  allFolderRows.map((folder) => folder.parentPath).filter(Boolean),
);
```

Then map:

- `folders` with `visibleParentPathsWithChildren`;
- `allFolders` with `hasChildren: folderParentPathsWithChildFolders.has(folder.path)` or by using a
  narrower mapper if `hasChildren` is irrelevant there.

**Verify**: `pnpm --filter @latch-works/pane-view typecheck` -> exit 0.

### Step 2: Add regression coverage for comic folder metadata

Add focused tests around the mapper/helper. If direct DB repository tests are too heavy, extract a
pure helper that maps folder rows to `FolderNode` and test that.

Cover:

- visible folders still mark `hasChildren` when they have child media entries;
- all-folder comic metadata marks leaf/non-leaf based on child folders only;
- `buildComicEntries(..., { leafFoldersOnly: true })` still skips folders with child folders.

Use `packages/media-domain/src/media.test.ts` comic tests as the behavioral reference.

**Verify**: `pnpm --filter @latch-works/pane-view test -- src/server/library src/features/library` -> exit 0.

### Step 3: Keep `readParentPathsWithChildren` bounded to visible folders

After Step 1, `readParentPathsWithChildren` should only receive visible folder paths for normal
folder-grid metadata. Do not remove its threshold fallback unless tests prove it is unreachable.

Search for calls:

`rg -n "readParentPathsWithChildren\\(" apps/pane-view/src/server/library/repository.ts`

There should be one call, and its argument should come from visible folder rows, not all folder rows.

**Verify**: command above -> one intentional call.

## Test plan

- Focused tests for folder metadata behavior.
- Existing media-domain comic tests must still pass.
- Pane View typecheck and check must pass.

## Done criteria

- [ ] Comic mode snapshots no longer scan active library entry parent paths for every folder in the
      archive just to build `allFolders`.
- [ ] Visible folder cards still get accurate `hasChildren`.
- [ ] Comic grouping leaf-folder behavior remains covered by tests.
- [ ] `pnpm --filter @latch-works/media-domain test` exits 0.
- [ ] `pnpm --filter @latch-works/pane-view check` exits 0.
- [ ] `git diff --stat` shows only in-scope files changed.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back if:

- `FolderNode.hasChildren` is used elsewhere in the UI for `allFolders`, not just visible folders.
- The change requires a DB schema migration.
- Plan 004 has already landed and removed the old comic-mode snapshot path.
- Verification fails twice after reasonable fixes.

## Maintenance notes

This is a tactical optimization. If Plan 004 later implements server-owned comic listing, revisit this
plan and either mark it DONE by replacement or REJECTED as superseded.
