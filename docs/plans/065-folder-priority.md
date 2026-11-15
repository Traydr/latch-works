# Plan 065: Folder priority, keeping the copy from the folder the owner keeps

> **Executor instructions**: Written 2026-11-15 from the owner's duplicate history. The owner
> asked for: the suggestion picked from the folder they most likely want, nothing resolved on its
> own, a panel on the right listing the set's folders that re-selects the set from one with a click,
> and a numbered folder badge on each tile. They agreed to: numbering per set by priority, labels
> that show only the part of the paths that differs, ⌥1–9 to pick a folder, never dropping a
> picture, the rule below sound and above pixels, learning only from confirmed resolutions, and a
> Settings list to reorder by hand, which they asked to ship in the same PR. Do not re-ask those.
>
> **Drift check (run first)**: `git diff --stat 4409766..HEAD -- apps/oriel/crates/core-tidy/src/duplicates
> apps/oriel/crates/mode-tidy/src/duplicates`.

## Status

- **Status**: IN REVIEW (2026-11-15), Steps 1–5 on `feat/folder-priority`
- **Priority**: P2 (the owner asked for it)
- **Effort**: M
- **Risk**: LOW. It changes suggestions only. Nothing resolves without the owner, and a resolution
  still goes to holding with its Undo. No schema change: the history is read from `plan_steps`,
  and the owner's orders are one more optional field of the stored settings (`folderOrders`).
- **Planned at**: commit `4409766`, 2026-11-15

## Why

Most of the owner's duplicate decisions are about folders, not pixels. They keep the copy from the
site and artist folder they trust (`patreon` over `twitter`, `twitter` over `danbooru`), and the
keeper rules know nothing of that unless a folder is marked preferred, which beats every rule and
which the owner never set. Every such set takes a click to pick the right copy, and long paths make
it hard to tell which tile came from where.

## What was measured

From a copy of the catalog at `4409766`: 859 applied resolutions holding 1,055 files, and 555 "not
duplicates" decisions. A hold step's reason names the copy kept ("Duplicate of …"), so each held
file gives one (kept folder, removed folder) pair.

| Folder depth below the root | Same folder | Different folders |
| --- | ---: | ---: |
| 1 (`nsfw`) | 1,041 | 14 |
| 2 (`nsfw/twitter`) | 342 | 713 |
| 3 (`nsfw/twitter/croove`) | 245 | 810 |

- **Replayed in order**, predicting each decision only from those before it: the depth-3 pair when it
  had been decided before, else the depth-2 pair, else depth 1. It made a call on 769 of the 810
  removals across folders (95%) and was right on 734 (95.4%).
- **One ordered list of sites** (Bradley–Terry over depth 2) fits 685 of 713 (96.1%): `general`,
  `comics`, `pixiv-fanbox`, `patreon`, `pirate`, `other`, `twitter`, `pixiv`, `reddit`,
  `danbooru`. So an editable list (Step 5) is a fair picture of the preference.
- Only 27 site pairs exist, all settled. A fifth of artist-folder pairs were new when they came up,
  so learning goes on with every resolution rather than waiting for more.
- 114 of 555 dismissals span folders: folder priority does nothing for variants in one folder, which
  plan 061 handles.
- Not measurable: whether the copies kept from `patreon` ever had fewer pixels than the `twitter`
  ones (removed files leave the catalog), nor how often the owner changed the suggestion (it was
  never recorded). Step 4 records the suggestion from now on.

## Decisions

- **Learned, not stored.** The ranking is read from resolutions whose hold steps are done and not
  undone, so an Undo takes its decision back. Folder clicks teach nothing until Return confirms.
- **Folders.** A folder is the root plus up to its first three path parts. Two folders are compared at
  the deepest depth where they differ and the owner has decided between them, falling back a level
  when they have not; folders equal at a depth with no history there have no preference.
- **Score.** In a set, each folder scores +1 for every other folder of the set it usually wins over and
  −1 for each it usually loses to (majority of decisions, ties count nothing).
- **Rule order.** Preferred folder, sound, **folder priority** (`folder-priority`), pixels, length,
  home folder, and the rest as before.
- **The owner's order.** Settings › Folder priority lists, per level (1 to 3 parts below the root),
  each group of folders linked by decisions, best first (more folders beaten, then more copies kept
  than lost). Moving a folder up or down stores that group's whole order as a `FolderOrder`; at a
  depth where an order holds both folders it decides before the record does, and a level with no
  order falls back to the record. "Use learned order" drops it. Folders learned later join an
  ordered group after its ordered folders. Preferred folders (P) stay the pin above every order.
- **Pictures.** Folder priority ranks copies, and each picture still keeps its best copy, so a
  picture that only another folder holds keeps that copy.
- **Folders in a set** are the distinct folders of its tiles (a version's first file; for identical
  copies, every copy), numbered by first appearance in tile order. Folder 1 holds the suggestion.
- **Panel.** On the right of the stage, beside the versions and above the decision bar, which keeps
  the stage's whole width for its commands and a toast; it shows for every set so the grid keeps its
  width, and only in windows 960 px wide or more. Each row: the number badge, the part of
  the path that tells the folders apart, how many versions it holds, and the record against folder 1
  ("1 won 23–0"). The row that matches what is kept is marked. A click, or ⌥ and its number, keeps
  that folder's copy of each picture and the suggested copy of any picture it lacks, without deciding.
- **Badges.** A folder icon and number on each tile's top-right corner when the set spans two
  folders or more. The path stays at the foot of the tile.

## Steps

1. **History** (`core-tidy/src/duplicates/folders.rs`): load pairs from `plan_steps`, compare two
   folders, score a set's folders. Unit tests pin the fallback and the undo.
2. **Keeper rule**: `KeeperCandidate.folder_score`, `KeepReason::FolderPriority` after `HasSound`;
   `build_set` scores its folders; `DuplicateSet.folders` lists them with their record.
3. **Duplicates UI**: the folder panel, ⌥1–9, the tile badges, the reason line ("Keeping 1: you
   usually keep folder 1's copy").
4. **Record the suggestion**: `ResolveGroup.suggested` from the set's keep, written to each hold step's
   spec as `suggested` (paths in the root), so overrides can be measured later.
5. **Settings › Folder priority**: a level picker, each group best first with move up and move
   down, "Your order" on a group the owner ordered and "Use learned order" to drop it. A level with
   several groups lists each as a row that opens it. Preferred folders stay as they were.

## Result on the owner's catalog (2026-11-15)

`cargo run --release -p oriel-core-tidy --example folder_priority -- <catalog> <scratch>` compares
two copies of the catalog, with and without the resolution history.

| Open sets at the owner's level | Count |
| --- | ---: |
| Open | 771 |
| Spanning two folders or more | 689 |
| With a record between folder 1 and another | 525 |
| Decided by folder priority | 513 |
| Suggestion changed against no history | 134 |
| Of those, keeping fewer pixels than before | 20 |

In 379 of the 513 sets folder priority picks what the pixels and later rules already did. The 20
that now keep fewer pixels are the cost of ranking folders above pixels, which the owner chose; each
is still reviewed before anything moves.

## Verification

- `cargo test -p oriel-core-tidy duplicates::folders`, `cargo test -p oriel-mode-tidy`, then
  `pnpm oriel:check`.
- On a copy of the owner's catalog: open Similar sets at Balanced, how many now name
  `folder-priority`, and how many suggestions changed against `main`.
