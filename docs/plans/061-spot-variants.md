# Plan 061: Spot variants, telling alternate versions from copies in duplicate review

> **Executor instructions**: Written 2026-10-26 from the owner's duplicate history, which decides
> the thresholds; re-measure on it before changing them. The owner asked for: a toggle for the
> heuristics, keeping versions in one folder that are not the same picture, dropping the copy with
> fewer pixels unless only it has sound, keeping a set together in one folder, removing Keep
> suggestions, and Duplicates' options in the top bar instead of a menu. Do not re-ask those.
>
> **Drift check (run first)**: `git diff --stat 3c9efa6..HEAD -- packages/glazier-core/src/duplicates
> packages/glazier-core/src/similarity packages/glazier-core/src/passes`.

## Status

- **Status**: IN REVIEW (2026-10-26)
- **Priority**: P2 (the owner asked for it)
- **Effort**: M
- **Risk**: LOW. It changes suggestions only; nothing moves until the owner decides a set, and a
  resolution still goes to holding. One table is added to the catalog.
- **Planned at**: commit `3c9efa6`, 2026-10-26

## Why

The owner's library has many alternate versions of one picture: another face or outfit, a comic
page with Japanese, English or no text. Their 64-bit fingerprints match, so Duplicates put them in
one set and suggested keeping one. At the balanced level 3,809 similar sets were open; the old
suggestions would have sent 2.2 GB to holding, most of it versions the owner wanted.

## What was measured

From the catalog at `3c9efa6`: 396 "not duplicates" decisions and 496 resolutions. Pairs were
compared as 64×64 grey prints in a 16×16 grid of 4×4 blocks, each print scaled to zero mean and
one spread. `local` is how far the most changed block stands above the median block.

| Pairs | Count | `local` median | Above 4 |
| --- | --- | --- | --- |
| Kept together by the owner (different contents) | 1,500 | ~55 | 99.3% |
| Removed by the owner, against the closest kept file in the keeper's folder | 230 | ~0.7 | 1.3% |

- The 64-bit fingerprint cannot tell them apart: kept-together pairs sat at every distance from 0
  to 24.
- "Same folder" is not the signal on its own: the owner removed 58 copies that shared a folder
  with the one they kept (resized or re-encoded copies, mostly video).
- Resizing straight to 64 aliases. A JPEG decoded at an eighth and its resized copy then differed
  enough that 62% of the removed copies counted as variants. Decoding at 256 and averaging 4×4
  fixed that.
- A copy enlarged to reach 256 (under 256 px on a side) can still count as a variant on hard
  edges. Only 18 of the 35,836 stills are that small, and the mistake keeps both files.
- Video frames do not line up between a copy and its original (different lengths and starts), so
  copies looked like variants as often as not. Videos and animations are left out.

On a copy of the catalog the shipped code printed 11,377 stills in 322 s (M5 Pro). Similar sets
went from 3,809 to 1,092 (707 of one picture, 359 with several pictures and their copies, 26 of
video), 2,717 moved to Variants, and what the suggestions free fell from 2.21 GB to 0.39 GB.

## Decisions

- **Variant.** Two stills are variants when `local` > 4, or when the median block is 0 (lossless
  files equal everywhere else) and `local` > 1 (`similarity/detail.ts`).
- **Pictures.** In keeper order, a version joins the first picture whose best version it is a
  copy of, or starts its own (`picturesOf` in `duplicates/sets.ts`). Each picture keeps one file;
  a set where every version is its own picture is a set of variants.
- **Which copy.** The keeper rules stand: preferred folder, sound, pixels, length. After length
  comes the home folder, the folder holding the most of the set's pictures, so the copy that
  stays is the one beside the rest of the set. The best-ranked file's folder breaks ties.
- **Prints.** Kept in `file_details`, apart from `files` so 4 KB rows never slow its scans, valid
  while the file keeps the size and mtime it was printed from. The similar job prints the stills
  of open similar sets after fingerprinting, only with Spot variants on. Turning it on or changing
  the level queues that job in the background, so review carries on.
- **Off by default.** `Settings.spotVariants`; the owner turns it on in Duplicates or Settings.
- **Variants tab.** Sets of variants leave Similar and the totals (and Convert's holds) and wait
  under Variants with every version kept, so Return marks them as not duplicates.
- **Keep suggestions removed.** The bulk resolve (`resolve-duplicate-sets`, ⌘↩) is gone, since a
  wrong suggestion in bulk was the harm. No catalog had a plan of that kind.
- **Top bar.** Similarity level, the Spot variants switch, and a Not duplicates toggle with its
  count replace the ⋯ menu.

## Not done

- Videos and animations: comparing frames needs aligning by content, not by position.
- A resolution's hold reason still names the set's first keeper, not the picture each copy
  matched.
