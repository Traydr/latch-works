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
- **On by default** since the second measurement below; it was off at first.
- **Variants tab.** Sets of variants leave Similar and the totals (and Convert's holds) and wait
  under Variants with every version kept, so Return marks them as not duplicates.
- **Keep suggestions removed.** The bulk resolve (`resolve-duplicate-sets`, ⌘↩) is gone, since a
  wrong suggestion in bulk was the harm. No catalog had a plan of that kind.
- **Top bar.** Similarity level, the Spot variants switch, and a Not duplicates toggle with its
  count replace the ⋯ menu.

Later: Convert and Shrink no longer hold back members of open sets, so "Convert's holds" above no
longer exists; a set's files can change while it waits for the owner. See "Duplicates and Convert or
Shrink" in `docs/runbooks/oriel.md`.

## Not done

- Animations, and videos that differ in size or length: comparing their frames needs aligning by
  content, not by position.
- A resolution's hold reason still names the set's first keeper, not the picture each copy
  matched.

## Second measurement (2026-11-04)

The owner still got variants offered as duplicates at the balanced level with Spot variants on. Of
the 39 sets with more than one content dismissed since 2026-10-27, the first rule had called 24
something other than all variants. All counts below come from a clone of the catalog at schema 9:
481 dismissals over 2,055 files, of which 79 hold only identical bytes and 71 are video. Hardly any
removed copies survive (one of 5,171 holds is still on disk), so the copy class is generated: 240
stills, 3 kinds of source, 28 ways each, including Convert's AVIF of a re-encode, one frame through
SVT-AV1 at Shrink's CRF 35, and pairs of copies of one source.

### Why variants slipped through

| Pairs the first rule called copies | Train half |
| --- | --- |
| Variant pairs dismissed | 4,273 |
| Called copies | 59, in 31 sets |
| Of those the same size in pixels | 55 |
| Largest block difference at 512×512 above 4 | 45 |
| No block above what a re-encode leaves, even at full size | 10, in 5 sets |

- **64×64 averages small changes away.** The misses had a typical block under 1 and `local` under
  4, with a patch of 4 to about 1,700 of 262,144 pixels changed at 512×512. Of the 45 with a visible
  spot, all but the colour-only pair had at least 82% of pixels within a grey level.
- **Colour.** One of the 59 was a colour-only change (grey `local` 2, colour 39). It is rare, but
  grey alone cannot see it.
- **The 64-bit fingerprint** does not help: missed pairs sat at distance 0 to 4.
- **Comparing with each picture's first version only** was not the problem: comparing with every
  version of a picture changed no set on the train half, so it stays first-version only.
- **The median** is not the problem it might be: no missed pair had a large typical block.
- **The opposite error was larger than expected.** The print itself called 15% of generated copies
  variants, and 24% of same-size JPEGs. The decoder's resize differs by format: libvips decodes a
  JPEG at an eighth and resizes that, an AVIF from full size. Averaging a full decode took that to
  2.2% with the variants caught nearly unchanged (97.9% to 97.7%). It also settles the synthetic
  `sunset.png` and its 320×240 JPEG: `local` 6.8 before, 1.6 now. Rounding cells to whole pixels
  instead of weighting them brought aliasing back (a third-size WebP stayed a copy in 86.5%, with
  weights in 100%).

### Rule

Thresholds were frozen on the train half and only then run on the test half. Dismissals split by
id, copies by source, and a source that is a dismissed file goes with its dismissal.

- **Print.** 64×64 grey, averaged from the full decode with fractional cell weights, whatever the
  format. `DETAIL_VERSION` is 2. A pair is variants when `local` > 5 (was 4; the closer look carries
  what that loses). The lossless special case added nothing and is gone.
- **Closer look.** A pair the prints call copies is decoded to 512×512. It is variants when a 16 px
  colour block moved by more than 12, or, between files of one size in pixels, when a 4 px grey block
  strays outside the other picture's neighbouring 3×3 pixels by more than 20, or by more than 4 where
  at least 80% of pixels match within a grey level. Between sizes only colour counts, since a
  resized copy leaves as large a spot as a small variant.
- **Nothing on a print's word.** A set whose stills lack a print or an answer keeps every file and
  waits out of every queue, counted as being checked (see below).
- **Video.** Dismissed video pairs were the same size and within 100 ms in 52 of 53 pairs, so their
  sample frames do line up. Two videos of one size and length are variants when the median frame is
  more than 4 bits apart. This reads stored fingerprints and decodes nothing.
- **On by default**, and analysis catches up by itself when Tidy opens on prints from an older
  version. Matching keeps its three levels with the same thresholds: every generated copy was within
  Balanced's 8 bits, so nothing argued for moving them.

### Held-out results

Test half, frozen rule. "Before" is the first rule on the same files; the train half is alongside to
show how far it was tuned to.

| | Before (test) | Now (test) | Now (train) |
| --- | --- | --- | --- |
| Variant pairs caught, of 4,637 | 4,577 (98.7%) | 4,622 (99.7%) | 99.7% of 4,273 |
| Dismissed sets kept whole, of 164 | 141 (86.0%) | 155 (94.5%) | 94.4% of 160 |
| Files they offered for removal | 45 | 14 | 13 (was 55) |
| Sets since 2026-10-27 kept whole, of 19 | 9 (47.4%) | 19 (100%) | 95.0% of 20 |
| Generated copies still copies, of 3,192 | 2,828 (88.6%) | 3,159 (99.0%) | 99.0% of 3,528 |
| Dismissed video sets kept whole, of 34 | 0 | 16 (47.1%) | 45.9% of 37 |
| Generated video copies still copies, of 96 | 96 | 96 (100%) | 97.9% of 96 |

Copies by kind on the test half: Convert, AV1, AVIF, WebP and every resize without a crop 98% to
100%; a 2 px crop 80.7% (was 46.5%); sharpened 93.0% (was 75.4%). All of them were within Balanced's
fingerprint. Video re-encodes at Shrink's settings stayed at a median of 0 bits; another frame rate
and a 33 ms trim stayed copies in 22 of 24 on the train half and all 24 on the test half.

**The balance.** A variant wrongly offered risks a picture and a review; a copy wrongly called a
variant keeps a file. On the test half the rule lets 15 of 4,637 variant pairs through and keeps
33 of 3,192 copies, and the two lean as intended where it matters: no variant in the last 19 sets
was offered, while Convert and Shrink stay copies. Video is deliberately cautious, since drawn test
clips reach a median of 4 and must stay copies, so about half of the dismissed video sets are still
offered.

### The owner's catalog

| Open sets at Balanced | Before | Now |
| --- | --- | --- |
| Identical | 0 | 0 |
| Similar with at least one copy | 1,005 | 907 |
| All variants | 2,761 | 2,859 |
| Files the suggestions hold | 1,156 | 1,032 |
| Bytes the suggestions free | 0.19 GB | 0.16 GB |

108 sets went from similar to variants and 10 back, and 16 stayed similar with fewer files to remove.
The closer look made 1,429 comparisons, 389 of them variants, 3 of those at different sizes. Only 3
open sets are video, so the video rule moved none today.

CPU, alternating old and new twice at a load of 20 to 25 on 18 cores (M5 Pro), so wall times are
load-affected: printing 11,616 stills took 1,764 s and 1,795 s before, about 107 s wall; now 1,681 s
and 1,688 s, about 100 s wall, plus 289 s and 290 s for the closer look, about 17 s wall. That is
about 11% more CPU for a full analysis, once. A Duplicates page is unchanged at 0.32 s cold and
0.007 s cached. `file_comparisons` takes 82 KB for its 1,429 rows; prints stay 4 KB each. The
catalog compacted went from 80.6 MB to 78.5 MB, as prints of dismissed sets are not made again.

### Being checked

Going to `DETAIL_VERSION` 2 takes every print away at once, and a set without prints used to suggest
keeping one copy. Pairs waiting for a look used to sit in Variants, where Return records "not
duplicates" for good. So a similar set with a still lacking a print or a pair lacking an answer now
offers nothing and waits out of Similar, Variants and the totals, with its own count under the
scopes.

- **A final answer always comes.** A print that fails to decode, or a pair that cannot be read, is
  recorded as a picture of its own, which keeps the file. Without libvips every print records that,
  and is taken back once libvips loads.
- **A stopped or failed analysis** leaves the sets held. The line under the scopes then reads "Not
  checked yet" with Check now, and analysis is due at the next launch or scan while any set is held.
  With background analysis off, only Check now runs it.
- **The set on screen** comes back into focus once it is checked.

### Against what the owner actually sees

The queue sorts by bytes freed, and the owner works its top. Sets the old rule offered that this rule
moves to Variants, from the same catalog, in the old queue's order:

| Old queue | To Variants | Keep more, not all | Of bytes |
| --- | --- | --- | --- |
| Top 40 | 11 (27.5%) | 7 | 27.5% |
| Top 100 | 25 (25.0%) | 12 | 25.4% |
| Top 300 | 63 (21.0%) | 15 | 22.1% |
| Rank 301 to 600 | 30 (10.0%) | 1 | 10.6% |
| Rank 601 to 1,005 | 15 (3.7%) | 0 | 3.8% |
| All 1,005 | 108 (10.7%) | 16 | 15.7% |

Nearly all of it is among sets with two versions of one size: 11 of 37 in the top 40 (29.7%), against
0 of 3 where every version differs in size, and 106 of 754 against 2 of 251 over the whole queue. Two
versions alone and of one size moved less: 7.1% in the top 40, 6.9% overall.

That agrees with the owner's decisions. Dismissals dated from the start of 2026-10-27 UTC were 12
plain and 5 from plans, beside 23 applied resolutions. 14 of the 17 are stills; the first rule offered
9 of them, 9 false offers to 23 real ones, or 28%. This rule keeps all 14 whole. The earlier "since
2026-10-27" rows start at local midnight, two hours before that, and take in the end of a session on
the day Spot variants arrived.

**The thresholds stay.** Of the 593 pairs of one size still called copies on the open sets, 368 have
a spot of at most 1 and 135 of 1 to 1.5, which is where generated same-size copies sit; 43 are at 1.5
to 2, 31 at 2 to 3, 6 at 3 to 4, 2 of those matching at 80% or more. 10 pass 4 but match under 80%,
as tone-shifted and sharpened copies do. In the top 100 of the new queue 94 of 96 such pairs are at
1.5 or less. On the train half no owner pair of one size lies between 1.04 and 4, so any threshold
from 1.5 to 4 catches the same pairs, and lowering it only costs copies (spot over 2: 1.79% of
copies, 1: 8.56%, against 1.17%). The match, print and colour gates show the same. Only new decisions
can tell whether the pairs between 2 and 4 are variants: the rule cannot be moved on this evidence.

The test half has been read more than once now (first with the rule frozen, again to confirm the
numbers after later changes that touch no threshold), so it is no longer untouched. Nothing has been
tuned on it.

To re-measure from the owner's next decisions:

```sh
cargo run --release -p oriel-core-tidy --example dup_precision -- \
  measure <catalog copy> <scratch> since:2026-11-05
```

It reports the sets dismissed since then against this rule, how many resolutions were applied beside
them, and how removed copies still in holding compare with the closest still left. It writes each
pair's measures to `<scratch>/pairs-since-2026-11-05.tsv`, numbers only. Anything the rule offered
that the owner then dismissed is what would justify moving a threshold.

### With Convert and Shrink

Files keep their ids through a change, so a stored answer has to end with the bytes it was about.
`file_comparisons` rows hold each file's size and mtime and go when Tidy takes a file as changed: a
trigger removes prints and answers when a file's fingerprint clears, as a conversion or a scan that
sees a change does, or its change time clears, as an undo does until the rescan. Convert keeps the
mtime, so size and mtime alone would not catch a result of the same length. An answer read from a file
that changes meanwhile is not stored, and the pair is asked again.

On synthetic files through the engine: a converted still is a copy both of its source and of the
other file in its set, keeps its id and set key, and its answers then hold its new size, and after
Undo its old one. An AV1 re-encode stays in its set as one piece of footage, with its byte-identical
pair still one version, and comes back after Undo. Identical copies stay identical through both
(`round_trip.rs`).

### What this cannot tell

- There are no owner's decisions on the 907 open sets, and removed copies are gone, so generated
  copies stand in for real ones. 593 pairs of one size remain called copies; nothing here can say
  how many are variants too small to see.
- 10 missed train pairs show nothing beyond a re-encode's noise at full size. They may be copies kept
  inside a set the owner dismissed whole, or a change smaller than that noise.
- 79 dismissals of identical bytes are left out: no comparison of pixels can honour them.
- Colour rests on one owner's pair; its threshold is set by how far copies move, not by variants.
