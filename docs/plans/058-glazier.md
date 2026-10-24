# Plan 058: Glazier, the archive workbench

> **Executor instructions**: Implemented on `agent/058-glazier` (2026-10-24). Product decisions
> below were settled with the owner on 2026-10-24; do not re-ask them. The proposal that led here
> is the HTML draft `docs/plans/058-archive-workbench.html` (kept beside this file); where the two
> differ, this file is the record.
>
> **Drift check (run first)**: `git diff --stat 90041107..HEAD -- apps/gather-box/src/gather
> packages/media-domain/src/system-files.ts`. If Gather Box's encoders moved again, re-check that
> it still imports its policy and AVIF settings from `@latch-works/media-format`.

## Status

- **Status**: IN REVIEW (branch `agent/058-glazier`)
- **Priority**: P2 — owner-requested new app
- **Effort**: L
- **Risk**: MEDIUM — the first app that changes the archive in bulk; every change goes through
  holding and the journal
- **Planned at**: commit `90041107`, 2026-10-23

## What it is

Glazier is the Organize stage of Gather → Organize → Sync → View: a macOS-first Electron app
(cross-platform code) that scans a root, reports what it holds, finds exact and similar
duplicates, tells silent videos from ones with sound, and converts files to the archive formats.
Every change is a reviewed plan, applied by an executor that re-checks each file first, and every
removal or replaced original goes to a holding folder the journal can undo. The runbook is
[docs/runbooks/glazier.md](../runbooks/glazier.md).

## Settled decisions (2026-10-24, do not re-ask)

1. **Name**: Glazier. Folder `apps/glazier`, package `@latch-works/glazier-app`, productName
   `Glazier`; the engine is `packages/glazier-core`, leaving `@latch-works/glazier` and the binary
   `glazier` free for a later CLI.
2. **Holding**: a hidden folder per root, `.glazier-holding`, so a removal is a same-volume rename
   with exact undo. It is in `media-domain`'s system folder list, so it is never synced or
   indexed. Emptying sends it to the system Trash (the Recycle Bin on Windows).
3. **AVIF encoder**: Gather Box's libavif wasm (`@jsquash/avif`), quality 70, speed 6, speed 8 on
   heap exhaustion; sharp's native AVIF above 64 MP.
4. **Originals after a verified conversion** move to holding.
5. **GIF → MP4** is in scope and, like all video work, uses Mediabunny.
6. **One video container, MP4.** Archive codecs (H.264, HEVC, AV1; AAC, MP3) are copied when a
   file moves into MP4; others become H.264/AAC. **Re-encoding to HEVC or AV1 is an action the
   owner chooses**, never automatic, because an older device cannot play AV1.
7. **Similar duplicates** (the same picture or video from different sites, encoded differently)
   are a first-class view alongside exact duplicates.
8. **Platform**: macOS first; code kept cross-platform.
9. **UI** is functional for now; a later pass (with Fable 5.1) aligns styles across the apps.

## Revision: the workflow redesign (2026-10-24, branch `agent/058-glazier-ux`)

After the first build, the owner asked for two independent reviews of the app's workflows,
for casual and power users. Opus 5.5 and Fable 5.1 each drove the packaged app over a test
archive. Their two biggest findings were the same:
- Duplicate review took four clicks and a modal per group.
- Converting asked the owner to re-derive a fixed policy.

What changed, settled with the owner's brief ("no unnecessary confirmations, buttons, text or
clutter; one seamless process; the same feel as the other apps"):

1. **Act, then undo.** The plan review modal is gone. Every change applies at once and ends in a
   toast with Undo, and ⌘Z undoes the last change. Two native confirmations remain: Empty to
   Trash, which leaves Glazier's undo, and Forget, which drops a root's undo history. A
   change that would remove a copy from a preferred folder asks first.
2. **Four views instead of eight.**
   - **Tidy** (the ordered to-do list) replaces Overview, Optimize and Sound.
   - **Duplicates** is one queue for exact and similar sets.
   - **Library** keeps the file table, with filter menus instead of chips.
   - **History** merges Journal and Holding.

   Settings became a ⌘, sheet.
3. **Duplicates as a keyboard queue.** A file belongs to one set: byte-identical copies are one
   version.
   - Each set arrives with its keeper chosen and the deciding rule shown.
   - Return resolves the set and advances to the next. 1–9 picks a different keeper, and ⇧ also
     keeps that version.
   - ⌘Return resolves the rest. N dismisses the set, and P prefers a folder.
   - The keeper rules gained "right extension" and "original name" (copy-style names lose).
   - "Protected folders" are now "preferred folders".
4. **Convert is one button**, with an Options popover to leave out pictures, animations or
   videos.
   - The estimate is automatic and shown as one number.
   - Extra copies of duplicates and files that would not shrink are left out.
   - Extension renames moved to Clean up.
5. **Analysis runs in the background** after scans and changes. It yields to anything the owner
   starts.
6. **Shell, in Lockstep's form**: a status bar, an app menu with shortcuts, drag a folder to
   add it, and right-click menus.

## Shape

| Piece | Responsibility |
| --- | --- |
| `packages/media-format` | The archive format policy, shared with Gather Box: still and video plans, AVIF settings, the AVIF encoder contract, and the animated-image → MP4 encoder (Mediabunny). |
| `packages/glazier-core` | The Electron-free engine: SQLite catalog (`node:sqlite`), walk, sniff, probe (sharp, ffprobe), staged hashing, fingerprints, loudness, duplicate queries and keeper rules, optimize candidates, planner, executor, holding, journal, the zod contract. |
| `apps/glazier` main | Windows, IPC, `glazier-media://` protocol, and routing between the processes below. |
| Engine utility process | Hosts `GlazierEngine`; one job at a time. |
| AVIF worker processes | The libavif wasm encoder, one encode per worker. |
| Hidden transcoder window | Mediabunny over Chromium WebCodecs (hardware encoders), with file access limited to its job's paths. |

Gather Box now imports its still policy, AVIF settings and GIF encoder from `media-format`; its
behaviour is unchanged. One gap carried over on purpose: Gather Box still sends an animated WebP
to the still encoder (its downloads have no frame count), which keeps only the first frame.
Glazier's own policy (`planArchiveImage`) routes animated files to MP4.

## Verification

```sh
pnpm --filter @latch-works/media-format test
pnpm --filter @latch-works/glazier-core test
pnpm --filter @latch-works/gather-box test && pnpm --filter @latch-works/gather-box build
pnpm test && pnpm typecheck && pnpm lint:all && pnpm knip
pnpm e2e:glazier
```

The e2e spec builds its own archive (ffmpeg and sharp). It covers:
- the scan and Tidy's list;
- similar grouping of a resized JPEG, with number keys changing the keeper;
- silent versus sound;
- Return resolving a duplicate into holding, and the toast's Undo bringing it back;
- Convert of stills, a GIF, an H.264 MOV, a VP9/Opus WebM, VP9 with alpha, an odd-sized VP9 and
  MPEG-4 Part 2, with dates preserved;
- Clean up.

## Follow-ups

- Hide the native title bar (`titleBarStyle: "hiddenInset"`) in Glazier and Lockstep together,
  so neither shows two title rows.
- Merge for duplicates: keep the best bytes at the preferred copy's path (`placeAt`), as Apple
  Photos' Merge does.
- Route animated WebP to MP4 in Gather Box once its downloads know their frame count.
- Copy Finder tags (extended attributes) onto converted files.
- The UI style pass across Glazier, Lockstep and Frame View.
- A `glazier` CLI over `glazier-core` (`report`, `plan`, `apply`).
- Lockstep's renderer has the same broken Geist `@import` Glazier avoided (fonts are referenced but
  not emitted); importing the font from JS fixes it.
