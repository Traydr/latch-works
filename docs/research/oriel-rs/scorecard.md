# Oriel RS, Phase 9: the scorecard

Oriel RS kept Phase 0's advantages now that it is the whole app, with View's index, Tidy's
engine, Sync and the shell on board. On the same Mac and fixture it is 2.3 times smaller on disk
(3.9 times without the ffmpeg and ffprobe both carry), starts 2.7 times faster, steps the viewer
12 to 29 times faster, scrolls as smoothly with fewer long frames, analyses the 21k fixture in
the same time as glazier-core, and pushes to Pane View 1.7 times faster than the Lockstep CLI.
Its memory lead narrowed, from 3 to 2.1 times less footprint at rest and from 6 to 4 times after
a scroll, as View grew an index. Electron Oriel still opens video 2.6 to 3.8 times faster and
seeks it exactly 4 to 7 times faster.

Report date: 2026-10-30. Plan: [063](../../plans/063-oriel-rs.md), Phase 9. Oriel RS is built
from commit `b5e8dd5f` on branch `agent/063-0-spike`, with every phase through 7 on macOS in it
([parity](parity.md)). Machine: the M5 Pro of Phase 0 (18 cores, 48 GB), macOS 27.0.1 (26A434),
the built-in 120 Hz display, quiet: nothing else built or ran while a row was measured.

## How it was measured

- **Builds.** Oriel RS is the app the owner double-clicks: `cargo run -p xtask -- bundle`, run
  from `Oriel RS.app/Contents/MacOS/oriel-rs`. Electron Oriel is Phase 0's own build of
  `4c76020b`, 0.1.5 on Electron 44.7.2, driven by Playwright on the stock Electron binary as in
  Phase 0, since the packaged app blocks the debugger. Its code is unchanged since: main has only
  Windows work and a version bump (the catch-up list), and this branch adds tests only.
- **Rounds.** View's rows are medians of three rounds, alternating which app went first (Oriel RS,
  Electron; Electron, Oriel RS; Oriel RS, Electron), then three idle rounds the same way: Phase 0's
  own drivers, with the variables renamed. Rows measured on one app only are medians of three runs
  unless the row says otherwise.
- **Fixture.** `~/.latch-works/oriel-rs/sandbox/spike-fixture`: 21,135 files, 19 GB, synthetic
  (20,000 stills, half AVIF and half JPEG; 300 videos, 100 each of H.264, HEVC and AV1; 40
  comics). View opens `stills/` recursively in a window whose content is 1280 × 900 at scale 2,
  4 columns.
- **Cold.** `sudo purge` needs a password here, so cold means what it meant in Phase 0: a fresh
  data folder, with no catalog and no thumbnails, while the files may sit in the page cache.
  Every Oriel RS run had its own data folder (`ORIEL_RS_DATA_DIR=/tmp/oriel-rs-scorecard/…`), and
  every Electron run its own `--user-data-dir`.
- **Memory and CPU.** Oriel RS's memory is its own `proc_pid_rusage` reading at the spike's
  events, as in Phase 0: one process, with no child running at those moments. Electron's is
  summed over its 11 processes with `ps` and `footprint`. CPU is CPU time over a window, read
  from outside the app.
- **Video.** Oriel RS plays through libmpv, its default since Phase 1: the LGPL build the bundle
  carries, timed by `mpv_spike sweep` on the first 10 videos of each codec, as Phase 0 timed
  AVPlayer and Electron Oriel. Electron opens each in its viewer.

## The scorecard

Medians of three. "Phase 0" is [Phase 0's scorecard](phase-0-measurements.md) for Oriel RS's
View spike, and [Phase 1](phase-1.md) where it says libmpv. Electron Oriel's column is today's run,
which repeats its Phase 0 numbers within 10 % (see the notes).

| Measure | Oriel RS now | Oriel RS at Phase 0 | Electron Oriel | Oriel RS against Electron |
|---|---:|---:|---:|---|
| Size on disk (`du -sh` of the `.app`) | 223 MB; 97 MB without ffmpeg and ffprobe | 18.5 MB binary; about 37 MB as an `.app` (estimate, no ffmpeg) | 502 MB; 376 MB without ffmpeg and ffprobe | 2.3× smaller; 3.9× without the tools both carry |
| Cold start: launch to first thumbnails | 383 ms | 360 ms | 1,022 ms | 2.7× faster |
| Warm start, first screen's thumbnails on disk | 337 ms | 254 ms | 559 ms | 1.7× faster |
| Warm start after a full scroll (first screen evicted) | 416 ms | (kept every thumbnail) | 957 ms | 2.3× faster |
| All 20,000 stills listed | 151 ms after View opens, index made | about 0.13 s | 1.43 s after Recursive | 9.5× faster |
| Memory 60 s after opening, resident / footprint | 233 / 207 MB, 1 process | 148 / 141 MB | 1,499 / 436 MB, 11 processes | footprint 2.1× lighter (3.1× at Phase 0) |
| Memory 60 s after scrolling | 388 / 367 MB | 339 / 244 MB | 2,381 / 1,469 MB | footprint 4.0× lighter (6× at Phase 0) |
| Gallery scroll at 5,000 px/s: p50 / p95 / p99 / max | 8.33 / 8.5 / 10.0 / 18.1 ms | 8.33 / 9.7 / 10.2 / 10.5 ms | 8.3 / 9.2 / 10.3 / 17.4 ms | level |
| Long frames (over 1.5 × p50) in the scroll | 2 of 17,742 | 0 of 17,742 | 17 of 17,624 | 8× fewer |
| Viewer step, AVIF / JPEG, 500 ms apart (p50) | 4.4 / 5.7 ms | 5.5 / 5.8 ms | 129 / 67 ms | 29× / 12× faster |
| Viewer step every 100 ms, stills drawn | 20 of 20 for both | 20 of 20 for both | AVIF 10 of 20, JPEG 20 of 20 | every still drawn |
| Video open to first frame, H.264 / HEVC / AV1 | 97 / 78 / 86 ms | libmpv 103 / 79 / 87 ms; AVPlayer 65 / 61 / 62 ms | 33 / 21 / 33 ms | 2.6–3.8× slower |
| Exact seek to frame | 175 / 193 / 356 ms, all on target | libmpv 168 / 179 / 318 ms; AVPlayer 98 / 73 / 399 ms, AV1 on the keyframe before | 44 / 37 / 53 ms | 4–7× slower |
| Fast seek to frame | 43 / 30 / 31 ms | libmpv 41 / 31 / 31 ms; AVPlayer 57 / 56 / 53 ms | 46 / 23 / 41 ms | level |
| Library, 100,000 rows: sort by name, rows then frame | 177 / 184 ms | 175 / 181 ms | not measured | |
| Library: sort by size, date or dimensions, rows then frame | 6–9 / 13–17 ms | 7–10 ms | not measured | |
| Library: scroll at 30,000 px/s, p50 / p95 / max | 8.33 / 8.44 / 12.3–12.5 ms, 0 long frames of 12,798 | 8.33 / 8.40 / 9.4–13.1 ms, at most 1 | not measured | |
| Library: select a row to the frame showing it (200 rows) | 8.33 ms p50, 8.8 ms max | 8.33 ms p50, 8.5 ms max | not measured | |
| Library: memory after the scroll | 145 / 230 MB | 141 / 227 MB | not measured | |
| Tidy: scan to a finished Overview, 21,135 files, 19 GB | 332.5 s in the app (one run; the scan 4.9 s) | | 336.5 s, glazier-core headless (one run; the scan 5.2 s) | level |
| Tidy: memory when the analysis is done | 1,532 MB resident, 1,733 MB footprint | | 2,068 MB peak resident, headless | |
| Sync: plan of the smoke fixture (247 files, 195 MB) into an empty target | 11 ms, in process | | 177 ms for the CLI's run, of which 155 ms is Node and tsx starting | 2× faster once Node's start is left out |
| Sync: push of the same | 0.79 s | | 1.32 s | 1.7× faster; 1.5× without Node's start |
| CPU at rest in View, settled (30–90 s after opening) | 0.35 % | 0.41 % | 0.55 % | 1.6× less |
| CPU in View, the first 60 s after opening | 0.65 % | 0.47 % | 7.8 % | 12× less |
| CPU in View, the 60 s after the scroll | 0.40 % | 0.46 % | 475 % (thumbnail workers) | |
| CPU at rest in Tidy, on Overview after the analysis | 0.37 % (one run) | | not scripted | |
| CPU at rest in Sync, with no profile | 0.34 % | | not scripted | |
| Unplayable in View: stills without a thumbnail, steps not drawn, videos without a picture | 0 of 20,000; 0 of 80 steps a round; 0 of 30 videos | 0 of 20,000 stills | not counted for thumbnails; 0 of 40 steps at 500 ms; 0 of 30 videos | level |
| Unreadable in Tidy: probe or fingerprint errors | 0 of 21,135 files; 300 of 300 soundtracks measured | | the same, headless | level |
| Lines of code for the same features ([below](#lines-of-code)) | 65,561, plus 15,601 of tests | | 53,267, plus 6,881 of tests | 1.2× more code, 2.3× more tests |

Tidy and Sync were not in Phase 0, so these rows are new:

- **Tidy** ran once in each app, about six minutes a run. Oriel RS ran in the app: the fixture
  added as a root through `ORIEL_RS_TIDY_ROOT`, on Overview, and finished once the app and its
  ffmpeg and ffprobe children stayed quiet for 5 s. glazier-core ran headless through its own test
  harness (`openEngine`, as its differential test does) with a temp catalog and Electron Oriel's
  packaged ffmpeg and ffprobe, timed from `addRoot` until every job was done and Overview read.
  So Oriel RS's figure carries the UI and glazier-core's does not. Both catalogs hold the same
  counts: 21,135 files fingerprinted, 300 soundtracks measured, 88 files hashed. Phase 5's
  differential runs, on copies and on a busier machine, took 330.8 s in Rust and 354.4 s in
  glazier-core. Oriel RS stays at 1.5 GB resident after the analysis; why was not looked into.
- **Sync** was timed headless on both sides, since a push in the app needs a click: Oriel RS's
  `core-sync` (`plan_sync`, then `push_changes`) through a scratch binary kept out of the
  repository, and the Lockstep CLI (`apps/lockstep-cli`, through `tsx`), which runs the same
  lockstep-core as Electron Oriel's Sync. Each run pushed into a freshly recreated
  `latch_works_e2e` database on the local stack, with a fresh hash cache or `HOME`. Three rounds,
  alternating which went first. This mutates local state only: `e2e/scripts/start-pane-view.ts`
  drops and recreates `latch_works_e2e` on every start, and each push wrote the fixture's 247
  files (204,349,415 bytes) to the `latch-works-e2e` bucket on the local RustFS. Nothing went to
  a remote URL.

## What changed since Phase 0, and why

**Oriel RS.**

- **Size grew from an estimated 37 MB to 223 MB.** The bundle now carries what the app needs:
  the pinned ffmpeg and ffprobe (126 MB, the same files Electron Oriel carries), the LGPL libmpv
  set (26 MB), libvips (18 MB), libavif (5.5 MB) and the licences (6.4 MB). The binary went from
  18.5 to 43 MB with Tidy's engine, Sync, SQLite, HTTP and TLS, and the pages of all three
  modes. Without the shared ffmpeg and ffprobe, Oriel RS is 97 MB and Electron Oriel 376 MB.
- **The cold start is 23 ms slower** (360 to 383 ms). View is created 5 ms later, 122 ms after
  launch, beside Tidy's catalog and Sync, and draws its first thumbnails 15 ms later, while it
  writes its new SQLite index (`view/media-index.sqlite`) as it lists. The listing still ends
  about 0.15 s after View opens.
- **The warm start is 83 ms slower** (254 to 337 ms). With an index on disk, View lists later,
  183 ms after it opens against 117 ms at Phase 0, and draws the first thumbnails 25 ms after
  that. 11 to 16 tiles at the edge of the first screen are made again, since the cold start
  wrote only what it drew.
- **View now keeps 5,000 thumbnails on disk, as Electron Oriel does.** At Phase 0 it kept every
  one, so its warm start found the first screen on disk even after a full scroll. Now a full fill
  or scroll evicts the top of the gallery, as in Electron Oriel, and the warm start after one
  makes the first screen again: 416 ms against Electron Oriel's 957 ms. Making all 20,000 runs at
  269 a second, against 289 at Phase 0.
- **Memory at rest grew by 85 MB resident and 66 MB footprint, and after the scroll by 123 MB of
  footprint.** The growth is View's, not the other modes'. The whole app at rest in Sync, with
  nothing open, is 107 MB resident and 74 MB footprint; the Library spike reads 99.6 / 39.1 MB as
  Tidy starts and 145 / 230 MB after its scroll, the same as Phase 0's 105.8 / 38.3 and
  141 / 227 MB. View now holds a SQLite index and more about each item; which part costs what
  was not profiled.
- **The scroll is as smooth**, with a lower p95 (8.5 against 9.7 ms) but 2 long frames instead of
  0, and a higher max (18 against 10.5 ms); the cause was not looked into. Electron Oriel had 17
  long frames.
- **The viewer step did not change**: 4.4 and 5.7 ms.
- **Video is libmpv's now** (Phase 1). On the same ten files per codec, the bundle's LGPL build
  matches Phase 1's run of IINA's GPL build within 10 %, except AV1's exact seek (356 against
  318 ms, one run against three). It opens 15 to 35 ms later than AVPlayer did, and every exact
  seek lands on its target, where AVPlayer's AV1 seeks landed on the keyframe before.
- **CPU at rest is lower when settled** (0.35 against 0.41 %), and higher in the first minute
  after opening (0.65 against 0.47 %). The whole app at rest in Sync uses 0.34 %.
- **The Library table did not change**: the same sorts, the same scroll and the same memory.
  Its spike now needs a root in Tidy before the synthetic rows show, and the window in front.

**Electron Oriel** repeated its Phase 0 numbers within 10 %: the same build on the same macOS.
Its cold start was 1,022 ms against 936 ms, and CPU in the minute after the scroll 475 against
442 %. One thing did not repeat: Phase 0's separate warm-start runs kept all 11 processes, but
today's, the second relaunch of the same profile, started no thumbnail workers, so 5 processes
with 615 / 296 MB and 0.22 % CPU. The table uses the first relaunch, inside each round, which
kept 11 processes as Phase 0's did.

## After the first optimization round (2026-10-30)

The owner chose to go on toward replacing Electron Oriel and asked for every workflow to be
optimized (plan decisions 11 to 15). One round of agents worked on View, video, Tidy's engine,
Tidy's pages, Sync and the shell. Their work is commits `93d17fa1` to `be4e2add`. Each change
kept the formats, the orders and the outputs, and Tidy's full 21k differential still has 0
differences.

The table compares the bundle from `03dab588` ("before") with the bundle from `be4e2add`
("after"). It was measured on a quiet machine with `cargo run -p xtask -- measure`, the two apps
interleaved in each round. View, the Library and the idle rows ran 3 rounds; Tidy ran 2. Video
compared each side's own `mpv_spike` on the same libmpv. Medians, with the spread in brackets.

| Measure | Before | After | Change |
|---|---:|---:|---:|
| Cold start, launch to first thumbnails | 423 (405–520) ms | 290 (284–300) ms | −31 % |
| All 20,000 stills listed, after View opens | 194 ms | 51 ms | −74 % |
| Warm start, first screen on disk | 299 ms | 191 ms | −36 % |
| Warm start after a full fill | 384 ms | 301 ms | −22 % |
| Thumbnails made per second (full fill) | 284 | 494 | +74 % |
| Memory 60 s after opening, footprint | 224 MB | 166 MB | −26 % |
| Memory 60 s after scrolling, footprint | 324 MB | 302 MB | −7 % |
| Gallery scroll, p95 / long frames | 8.53 ms / 1 | 8.52 ms / 1 | level |
| Viewer step AVIF, p50 | 6.44 ms | 4.32 ms | −33 % |
| Video open, H.264 / HEVC / AV1 | 99 / 80 / 83 ms | 63 / 46 / 53 ms | −36 to −43 % |
| Video exact seek, H.264 / HEVC / AV1 | 176 / 200 / 334 ms | 166 / 193 / 330 ms | level |
| Video fast seek, H.264 / HEVC / AV1 | 43 / 30 / 30 ms | 47 / 30 / 33 ms | +0 to +10 % |
| Library 100k, sort by name, to the frame | 183 ms | 34 ms | −82 % |
| Library 100k, sort by kind, format or duration | 164–192 ms | 15 ms | −91 to −92 % |
| Library 100k, sort by size or modified | 13.1–13.4 ms | 15.0 ms | +12 to +15 % |
| Tidy, launch to a finished Overview, 21k fixture | 328 s | 138 s | −58 % |
| Tidy, footprint when the analysis is done | 939 MB | 179 MB | −81 % |
| Tidy, CPU time to the finished Overview (app and ffmpeg) | 1,992 s | 2,276 s | +14 % |
| At rest in Tidy with nothing open, footprint | 99.6 MB | 74.5 MB | −25 % |
| Bundle size | 223 MB | 205 MB | −8 % |

What made the difference:
- **View.** It no longer waits on its SQLite index while it lists, which ends a run of 2–3 MB
  blocks freed on every scan batch. It reads folders in bulk with `getattrlistbulk` and makes each
  item's key once. A thumbnail already on disk shows at once. View uses all cores but two for
  thumbnails, with the same WebP settings and cache keys.
- **Video.** libmpv engines are kept warm and reused: a dropped player gives its engine back,
  trimmed, for 30 s. The audio output is handed over between players. A preview with sound off
  decodes no soundtrack, and hovering a video tile starts an engine ahead. Like Electron Oriel,
  Oriel RS now draws no subtitles.
- **Tidy's engine.** Fingerprints, detail prints and loudness run one file per core, and a
  video's five frames run as five work items. Freed memory goes back to macOS after the analysis,
  after a change, after Convert's estimate, and when a catalog thread goes quiet. Convert encodes
  on all cores but two, within a memory budget.
- **Tidy's pages.**
  - A GPU texture leak in the thumbnail cache is fixed: 2.2 GB to 0.7 GB after a grid scroll.
  - Duplicates decodes the pictures on screen first, with ffmpeg writing fast PNGs: the first 8
    tiles of a 77-version set show in 0.8 s, against 11 s.
  - Long lists sort by collation-key ranks, which give exactly the collator's order.
- **Sync.**
  - The hash cache and the snapshot are read straight into their entries.
  - Uploads are read and hashed four chunks ahead.
  - The plan tree keeps what it shows. Typing in its filter takes 4.3 ms a keystroke, against
    23.2 ms.
- **The shell.**
  - The theme is applied without GPUI Kit's probe of every system font, 38 ms at launch.
  - The bundle's binary is built with fat LTO over one codegen unit and stripped, 25 MB against
    43 MB.

What it cost:
- **Tidy's analysis uses 14 % more CPU in all** for its 58 % shorter wall time. The cause is
  libvips' locks across 18 lanes and the slower kind of core.
- **Peak memory during the analysis** rose to about 3.3 GB, with 18 decodes at once.
- **Fast seeks** are 3 to 4 ms slower in H.264 and AV1.
- **The Library's sorts by size and date** are about 2 ms slower on 100k rows.
- **A bundle build** takes about 3 minutes after any change.

## Lines of code

Counted at `b5e8dd5f` with `git ls-files` piped to `wc -l`: every line of every tracked file,
comments and blank lines included.

| | Oriel RS | Electron Oriel |
|---|---:|---:|
| What was counted | `apps/oriel-rs/crates/*/src/**/*.rs`, `tests/` and `examples/` | `apps/oriel/src/**/*.{ts,tsx,css}` and `apps/oriel/tests/`, plus `packages/{app-data,glazier-core,lockstep-core,media-domain,media-format,media-index}/src` (the packages `apps/oriel/package.json` depends on, and the one they bring in) |
| The app's code | 65,561 | 53,267 |
| Its tests | 15,601 (12,663 in `tests/`, 2,938 in `#[cfg(test)]` modules) | 6,881 (`*.test.ts(x)`, `test-support/`, `apps/oriel/tests/`) |
| Build and bundle tooling | 3,770 (`xtask`, less its tests) | 731 (the Forge and Vite configs, `media-tools.ts`) |
| Measurement and differential tools | 3,425 (`bench`, the four `examples/`) | 1,405 (`e2e/scripts/frame-performance.ts`) |
| Tests that exist for Oriel RS only | | 7,811 (the conformance vectors and differential runs on this branch) |

Oriel RS needs about 1.2 times the lines for the same features, and more than twice the tests.
The Rust counts every type and match arm that TypeScript leaves to zod and the browser, and
it draws its own UI where Electron Oriel has the DOM and CSS. In the other direction, Electron
Oriel's e2e specs for its modes (`e2e/tests/{frame-view,glazier,lockstep,oriel}`, 1,305 lines)
are counted in neither column; Oriel RS's ports of them are in its `tests/`. The `#[cfg(test)]`
figure counts from each `#[cfg(test)] mod` line to the end of its file.

## The catch-up list

The Electron Oriel commits on `origin/main` since `4c76020b`, the commit Phase 0 measured
(`git log 4c76020b..origin/main -- apps/oriel packages e2e`):

| Commit | What it does | Does Oriel RS need it? |
|---|---|---|
| `6aef883b` fix(oriel): a Windows make empties Velopack's output first | `forge.config.ts`: a second `pnpm make` of one version no longer fails in Velopack's `vpk` | Not on macOS. Phase 8, when it makes Setup.exe through Velopack, starts from an empty output folder too. |
| `633cc3ab` feat(oriel): Windows draws its window buttons over Oriel's own top bar | No native title bar or menu on Windows: the caption buttons sit over the top bar's right end, in the theme's colours, light over the dark viewer, comic reader and loupe; every top bar keeps their width clear, and the sidebar's strip names Oriel. macOS and Linux unchanged | Not on macOS. Phase 8 needs it: it is parity's "The native caption buttons (`titleBarOverlay`)", Not started. |
| `e8931774` fix(oriel): only a dark screen on view keeps Windows' buttons light, and Linux's strip stays empty | A viewer, reader or loupe left open out of sight no longer keeps the buttons light | With `633cc3ab`, in Phase 8. |
| `5e53b15d` Merge pull request #190 | The two commits above | |
| `c8c843a3` chore(oriel): bump the version to 0.1.6 | `apps/oriel/package.json` | No: Oriel RS has its own version, 0.0.1. |

None of them changes macOS, so nothing on this list holds back the macOS port. Main has no
change to `packages/` or `e2e/` since `4c76020b`.

## What is still missing

[Parity](parity.md) has 104 features: 92 done, 2 partly done and 10 not started. On macOS what
is left is packaging and a person's check:

- VoiceOver: roles and names are set and pinned by tests, but nobody has listened (Partial).
- Signing with a real Developer ID identity has never been tried; ad hoc signing works (Partial).
- The DMG and ZIP, the offer to move to Applications, and a workflow that builds them (Not
  started).
- Windows, Phase 8: all 7 rows, among them the caption buttons the catch-up list names.

## What the numbers miss

These are left for the owner, since no script measures them:

- **Text rendering.** GPUI draws text with its own shaper and Core Text's rasteriser, not
  Chromium's. Whether names, captions and tables read as well as Electron Oriel's is a matter of
  looking at both.
- **Keyboard behaviour.** The e2e cases' keys are ported and tested headless, but this Mac allows
  no scripted input, so nothing here pressed a key in a real window. Focus order, repeat rates and
  shortcuts in the menus need a person.
- **VoiceOver.** Not heard by anyone yet (see above).
- **The feel after a day's use.** Whether Oriel RS is better to live with than Electron Oriel,
  on the owner's own library, is the owner's call, and the reason this page carries numbers only.

## Run it again

Oriel RS's rows are one command, `cargo run -p xtask -- measure` (`crates/xtask/src/measure/`),
which drives the spikes and reads the app as this page's drivers did. From `apps/oriel-rs`, with
the bundle made (`cargo run -p xtask -- bundle`), on a quiet Mac:

```sh
cargo run -p xtask -- measure view video library idle-sync --rounds 3 --electron
cargo run -p xtask -- measure tidy --rounds 1
cargo run -p xtask -- measure sync --rounds 1 --sync-url http://127.0.0.1:3100
```

The Sync line runs three times, each after `e2e/scripts/start-pane-view.ts` has started afresh,
since `measure` pushes into the target as it finds it and only a fresh one is empty.

It prints the median and spread of every measure, and writes each run's raw JSON
([the runbook](../../runbooks/oriel-rs.md#measuring) says where). Each row of the table above
comes from one of its rows:

| Scorecard row | `measure` row |
| --- | --- |
| Cold start; all 20,000 stills listed | `cold-start` |
| Warm start, first screen's thumbnails on disk; CPU at rest in View, settled | `warm-start` (the cold start's folder, 100 s at rest) |
| Warm start after a full scroll; memory 60 s after opening and after scrolling; the gallery scroll and its long frames; the viewer steps; CPU in View in the first 60 s and after the scroll | `scroll` (the fill's folder; it runs `fill` first) |
| Making all 20,000 thumbnails; stills without a thumbnail | `fill` |
| Video open, exact and fast seek | `video` (`mpv_spike sweep` on the bundle's libmpv) |
| Library | `library` |
| Tidy: scan to a finished Overview, its memory, CPU at rest in Tidy, unreadable files | `tidy` (one run is about six minutes) |
| Sync: plan and push | `sync` against the local e2e Pane View, each run into a recreated `latch_works_e2e` database as here |
| CPU at rest in Sync, with no profile | `idle-sync` |
| Electron Oriel's View, memory, CPU and video | `--electron`: `e2e/scripts/frame-performance.ts` once a round, interleaved as here (the first relaunch inside each round is its warm start) |

What `measure` does differently from this page's drivers, on purpose:

- The `footprint` tool no longer runs inside the View runs. It ran as the scroll started and as
  the viewer steps began; the memory rows were and are the spike's own readings.
- The warm start's footprint is read after its CPU window closes, at 90 s, rather than at 60 s
  inside it.
- `oriel-core-sync`'s `sync_bench` example times the plan and push on the tokio runtime the app
  runs Sync on (`oriel_runtime::TokioRuntime`); this page's timer ran tokio's multi-thread
  runtime.

Not in `measure`: the size on disk (`du -sh` of the `.app`), the lines of code (counted as that
section says), and the other sides of the Tidy and Sync rows, glazier-core headless through its
own test harness (`openEngine`, as its differential test does) and the Lockstep CLI through
`tsx src/cli.ts plan` and `push`. Their scratch timers are not kept.

This page's own drivers and raw logs were under `/tmp/oriel-rs-scorecard/` on the machine that
ran them, and they are not kept.
