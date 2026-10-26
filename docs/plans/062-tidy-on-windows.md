# Plan 062: Tidy on Windows, Shrink and Spot variants on an x64 build

> **Executor instructions**: Written 2026-10-26 for an agent on the owner's Windows machine. Oriel
> 0.1.2 to 0.1.5 were built and tested only on an M5 Pro Mac: per-decision Undo, Finder's and
> Explorer's folder files (`.DS_Store`, `desktop.ini`, `Thumbs.db`) ignored, zip-based mods no
> longer called misnamed, Shrink (plan 060) with a time estimate that learns each machine's speed,
> and Spot variants (plan 061). These decisions are the owner's and stand: AV1 with SVT-AV1 at
> CRF 35 for the default quality, Shrink outside Tidy up, Spot variants' thresholds (measured on
> the owner's library, which this machine must not act on), Explorer's files left alone like
> Finder's. Read plans 060 and 061 and `docs/runbooks/oriel.md` first.
>
> **Drift check (run first)**: `git diff --stat 4371765..HEAD -- apps/oriel/media-tools.ts
> apps/oriel/forge.config.ts packages/glazier-core/src e2e/src`.

## Status

- **Status**: TODO
- **Priority**: P2
- **Effort**: M
- **Risk**: MEDIUM. A new ffmpeg ships inside the Windows app, and Windows treats open files,
  long paths and drives differently from macOS in exactly the places Tidy moves files.
- **Planned at**: commit `4371765`, 2026-10-26

## Ground rules

- **Throwaway data only.** Every check runs on an archive the test builds in a temp folder, with
  Oriel on a throwaway `--user-data-dir`. The owner's library syncs through Tresorit to the Mac,
  where Tidy already rewrites it; Windows Tidy opens it only when the owner says so, and then only
  to scan and look. Two machines rewriting the same files through a sync client make conflict
  copies.
- **Numbers, not content.** The library is adult content. Reports, screenshots and uploads carry
  counts, sizes and timings, never its frames, thumbnails or file names. Screenshots of test
  archives are fine.
- **Commits.** Work on a branch; subjects read `type(scope): description`. Commit and push when
  the owner asks.

## Steps

1. **Baseline.** Install the prerequisites in the runbook's Windows column, then `pnpm install`,
   `pnpm test`, `pnpm -r --workspace-concurrency=1 typecheck` (the parallel `pnpm typecheck` was
   killed for memory on the Mac), `pnpm lint:all` and `pnpm knip`. Done when each passes, or each
   failure is written down with its output as a Windows finding.

2. **See which ffmpeg Tidy gets.** `pnpm --filter @latch-works/oriel package`, then run the staged
   ffmpeg from `apps/oriel/out/Oriel-win32-x64` with `-version` and `-hide_banner -encoders`.
   With no Windows pin, Tidy uses `ffmpeg-static` 5.3.0 (release `b6.1.1`, built by gyan.dev; the
   docs call it 6.0, so record what it prints). Encode two seconds with `-c:v libsvtav1` and note
   the `SVT-AV1 Encoder Lib` version it logs. Done when the report has the ffmpeg version, whether
   `libsvtav1` and `libdav1d` are there, and the SVT-AV1 version.

3. **Pin a current Windows ffmpeg.** The Mac pins ffmpeg 9.0.2 with SVT-AV1 4.2. An older SVT-AV1
   maps CRF to size and quality differently, so plan 060's numbers would not hold on Windows. Add
   a `win32-x64` entry to `PINS` in `apps/oriel/media-tools.ts`:
   - a static GPL build from a source ffmpeg.org's download page links to for Windows, with
     `libsvtav1` (4.x if offered), `libdav1d` and ffprobe, as close to 9.0.x as offered;
   - pinned by URL and SHA-256, like the Mac's;
   - unpacked without `ditto`, which is macOS only (Windows 10 and later ship `tar.exe`, which
     reads zip), taking `ffmpeg.exe` and `ffprobe.exe` out of whatever folder tree the zip holds;
   - a new executable added to `ignoreBinaries` in `knip.json`.

   Update the runbook's paragraph on the pinned build and plan 060's "Not done". Done when a clean
   build downloads, verifies and stages both `.exe` files into the app's `resources/media-tools`, a
   second build reuses `apps/oriel/.media-tools/win32-x64`, and shrinking a test clip records the
   step note "Encoded with SVT-AV1" in History. (Settings' "AV1 video" row is on whenever WebCodecs
   can encode AV1 too, so it does not tell.)

4. **Check Shrink's estimate learns this machine.** Each SVT-AV1 encode is timed into the
   catalog's `encode_timings`, and once a size class has three encodes of 10 s or more, Shrink's
   estimate uses their median; other classes scale the M5 Pro's figures (3.5× real time up to
   1 MP, 2.4× up to 2.2 MP, 1.7× above) by how this machine compares
   (`packages/glazier-core/src/optimize/encode-speed.ts`). Shrink 20-second 720p, 1080p and 1440p
   test clips (the `testsrc2` plus noise kind `e2e/tests/glazier/shrink.spec.ts` builds), three or
   more of each. Done when the Next run card has gone from "a first guess" to "at this computer's
   speed", its time for a further run is within about a fifth of what that run took, and the
   report has this machine's speeds next to the Mac's.

5. **Run the Windows checks** below. Done when each has a result: works, fails (with output), or
   fixed (with the commit).

6. **End to end.** `pnpm e2e:glazier` and `pnpm e2e:oriel` need `ffmpeg` and `ffprobe` on `PATH`
   and no Docker. `e2e/src/oriel.ts` names the Electron binary `electron` on everything but macOS;
   Windows' is `electron.exe`, so expect to fix that first. Done when both projects pass, or each
   failure is explained.

7. **Installer.** `pnpm make:oriel` makes Velopack's `Oriel-win-Setup.exe`. Install it, start
   `Oriel.exe --user-data-dir=<temp folder>`, and shrink a test clip. Done when the installed app
   starts with nothing in its log and the step note reads "Encoded with SVT-AV1".

8. **Report** to the owner: what each step found, the pin's URLs and hashes, the speed table,
   each check's result, test counts, the files changed, and anything left for the owner to
   decide.

## Windows checks

Each runs on a throwaway archive, through the app or the e2e harness.

- **Open files.** Windows refuses to rename or delete a file another process has open. Hold a
  video while it plays in Duplicates (tiles and the loupe play straight from the file), convert a
  file View has open, and hold a file just written while Defender scans it. Expected: the step
  fails with a readable message, the file stays where it was, and nothing is half moved
  (`moveFile` in `packages/glazier-core/src/plans/holding.ts`).
- **Replacing in place.** When the output keeps the original's name (Shrink's MP4 to MP4), the
  executor holds the original first, then moves the output into place, and puts the original back
  if that move fails (`convert` in `packages/glazier-core/src/plans/executor.ts`). Check that path
  and Undo with the output open in another program.
- **Drives.** With the archive on `D:` and the data folder on `C:`, holding goes to
  `D:\.latch-works\glazier\holding` by rename. A root that is a whole drive (`D:\`) holds in the
  data folder by copying (`HoldingPlaces`). Try both, then Undo.
- **Long paths.** The owner's library nests deep folders with long names. Give a test file a path
  past 260 characters and check that scanning, fingerprints, Spot variants' prints (sharp),
  thumbnails, ffprobe and Shrink (ffmpeg, a child process) all handle it.
- **Names.** Japanese and other non-ASCII names through ffmpeg's arguments and the
  `glazier-media://` protocol, which carries `C:\` paths URL-encoded.
- **Explorer's files.** A folder holding only `desktop.ini` or `Thumbs.db` counts as empty;
  removing it holds them first, and Undo puts them back. Explorer marks `desktop.ini` hidden and
  system, and a customized folder can carry the read-only attribute, which can stop the folder
  being removed. Check both.
- **Hard links.** `mklink /H` a picture: a hard link of the kept file frees nothing, so it is
  never held (`removalsFor` in `duplicates/sets.ts`, which keys on `dev` and `ino`).
- **Sync and ctime.** The executor re-hashes a file whose only change since the scan is its
  ctime (Tresorit's tags on macOS), so a decision is not refused. Resolve a duplicate in a test
  folder the sync client watches and check that the set does not come back.
- **Spot variants.** `duplicates/variants.test.ts` and `e2e/tests/glazier/variants.spec.ts` pin
  the behaviour. Time the first comparison on a few thousand test stills; the Mac printed 11,377
  in 322 s.

## Not in scope

- Linux builds, and moving View off `ffmpeg-static`.
- Re-measuring CRF 35 or Spot variants' thresholds: both need the owner's library.
