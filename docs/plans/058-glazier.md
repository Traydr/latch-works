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
2. **Holding**: outside the root, so a sync client or indexer that knows nothing of Glazier
   (Tresorit, an older Lockstep) never sees it. Glazier's data folder holds when it shares the
   root's volume; otherwise `.latch-works/glazier/holding` at the top of that volume does, so a
   removal is still a rename with exact undo. Only a root that is a whole volume copies across to
   the data folder. Emptying sends holding to the system Trash (the Recycle Bin on Windows).
   (Revised: holding first lived in `<root>/.glazier-holding`, and the Lockstep then installed
   pushed it, since only this branch taught scanners to skip it.)
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

## Revision: the house-style redesign (2026-10-24, same branch)

The owner found the workflow redesign still Lockstep-like: small buttons, too much talking back,
and picking a duplicate still too slow. Three independent reviews (visual UI, workflows, layout)
ran three rounds against Frame View, Pane View and T3 Code, with the reports driving each rebuild.
It supersedes items 1, 2, 3 and 6 above.

1. **House style.** The system font at 13 px, 32–36 px controls, rounded surfaces lifted by a soft
   ring, neutral selection, and one violet primary per screen (`gz-*` tokens in
   `apps/glazier/src/index.css`). No monospace, nothing under 12 px, shortcuts in tooltips. The
   native title bar is hidden on macOS; there is no status bar and no path header.
2. **Structure.** Overview is home, with one **Tidy up** that runs Clean up, identical copies,
   silent soundtracks and Convert in order as one change. Duplicates, Convert and Clean up are
   pages of their own; Library and History follow; Holding and Settings (a page) sit at the foot
   of the sidebar, which becomes an icon rail under 1180 px (⌘\).
3. **Duplicates.** A set shows every version as a tile, the keeper ringed. A click or a number
   key keeps that version and goes on; ⇧ keeps it as well. The keeper's badge names what decided
   the suggestion on hover; a close call (only a tie-breaker decided) shows the keeper as
   "Suggested" and is left out of Keep all suggestions. C opens a full-window loupe that flips
   between versions. Each decision toasts with Undo, and ⌘Z brings the set back.
4. **Less confirmation.** Changes apply at once and toast once. Empty to Trash does not confirm,
   since the Trash is the safety net; only Forget folder does, and it now sends that folder's held
   files to the Trash too.
5. **Holding left the root.** Held files live in Glazier's data folder (or
   `.latch-works/glazier/holding` at the top of another volume), because a sync client that does
   not know Glazier, such as the installed Lockstep or Tresorit, synced `<root>/.glazier-holding`.
   Older catalogs move their held files out on start (migration 3 records each held file's full
   path).
6. **One folder for every app's data.** Glazier, Frame View and Lockstep desktop keep their data
   in `~/.latch-works/<app>`, beside the Lockstep CLI's config and hash caches, instead of each
   app's own `Application Support` folder; the first start moves the old folder there. Every
   scanner skips `.latch-works`.
7. **Convert waits for review.** Members of open similar sets, and files not yet checked for
   similar versions while analysis is on, are not converted, so review never compares a
   re-encoded copy.
8. **After using it (same branch).** Every version and copy shows its whole folder path, wrapped,
   since a cut path could not tell two copies apart; the reason line, the "goes to holding" line
   and the top bar's counts are gone. A decision toasts with Undo, because a stray click had to
   be undone from History. The Similar and Identical tabs span the queue. On macOS the rail is
   88 px, since macOS 27's window buttons end near 76 px and spilled over the top bar. Folders are
   chosen in Glazier's own picker. `pnpm start` came up blank every other run: the main window's
   and the transcoder's Vite dev servers shared one dependency cache with different configs, so
   each start one re-optimized and the other got `504 Outdated Optimize Dep`; each now has its own
   `cacheDir`.
9. **Reviewing by hand (same branch).** An owner sorting a collector's folders needs to see where
   each copy lives and decide it there, so Duplicates gained a Show in Finder button per version
   and copy (⇧⌘R), a checkbox per identical copy to keep it in several folders (the kept copies
   come back as a set later; what to do about them is open), and playback with sound in each
   video tile, since a silent or shorter version can slip past the checks. The bulk "Remove all
   identical copies" button is gone, because it cannot weigh where the copies are. A video whose
   sound was never measured says "sound not checked", not "sound".

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

- Hide the native title bar in Lockstep too (Glazier now does), and bring Lockstep to the same
  house style.
- Merge for duplicates: keep the best bytes at the preferred copy's path (`placeAt`), as Apple
  Photos' Merge does.
- Route animated WebP to MP4 in Gather Box once its downloads know their frame count.
- Copy Finder tags (extended attributes) onto converted files.
- Video hover-scrubbing across a set's tiles, a stack overview of every set, unchecking single
  files on Convert, emptying holding automatically after 30 days, and one History entry per Tidy
  up run.
- A `glazier` CLI over `glazier-core` (`report`, `plan`, `apply`).
- Lockstep's renderer has the same broken Geist `@import` Glazier avoided (fonts are referenced but
  not emitted); importing the font from JS fixes it.
