# End-to-end suite

The `e2e/` workspace drives the built apps with Playwright. It is the final check before a PR is
marked ready and is **not** part of `pnpm test`; it takes minutes, needs the local stack, and is
run per app.

## Prerequisites

- The local compose stack from `docs/localhost/` running (`docker compose up -d` there).
  Pane View e2e creates and uses its own `latch_works_e2e` database and `latch-works-e2e` bucket on
  that stack, so it never touches the archive you sync locally.
- `ffmpeg` on `PATH` (the fixture generator renders two short clips with it).
- Playwright's Chromium: `pnpm --filter @latch-works/e2e exec playwright install chromium` once.

Connection details are read from the repo-root `.env` (`DATABASE_URL`, `S3_*`); with no `.env`
the compose defaults apply.

## Run

```bash
pnpm --filter @latch-works/e2e fixture   # render e2e/.fixtures/archive from the manifest (once)
pnpm e2e:pane                            # Pane View, seeded through the Lockstep CLI
pnpm e2e:frame                           # Oriel's View mode, through Playwright's Electron driver
pnpm e2e:lockstep                        # Oriel's Sync mode, pushing into the Pane View server
pnpm e2e:glazier                         # Oriel's Tidy mode, over an archive it builds (no server)
pnpm e2e:oriel                           # Oriel's shell: the modes and the menu (no server)
pnpm e2e                                 # every project
```

`pnpm e2e:pane` starts Pane View itself: it drops and recreates the e2e database, runs the
migrations, builds `apps/pane-view` and serves the build on port 3100. The setup project then
pushes the fixture archive with `lockstep push` (that push is the Lockstep → Pane View roundtrip
test) and signs in once.

While iterating on specs, leave the server running between runs: an e2e server already listening
on 3100 is reused as-is (no rebuild, no reseed). Stop it to force a clean rebuild.
`E2E_SKIP_BUILD=1` serves the existing `.output` without rebuilding on a cold start.

Run one spec or test: `pnpm --filter @latch-works/e2e e2e:pane -- -g "comic mode"`.
Failures leave a trace in `e2e/test-results/`; open it with
`pnpm --filter @latch-works/e2e exec playwright show-trace <trace.zip>`.

## What the Pane View project covers

`e2e/src/fixture.ts` is the oracle: a manifest of 96 items chosen for natural ordering
(`1 < 2 < 10`, case folding, non-ASCII), search escaping (`%`, `_`), comic eligibility (root
media, parent folders, video-only folders) and paging (a 70-item folder). The specs derive every
expected order and count from it.

| spec | covers |
|---|---|
| `seed.setup.ts` | Lockstep push completes, a second push is a no-op, the remote snapshot matches |
| `auth.spec.ts` | login redirect, wrong password, five-failure throttle, sign out |
| `browse.spec.ts` | root and folder listings, sidebar navigation, prev/next sibling folder (buttons and Shift+A/D) |
| `sorting.spec.ts` | all five sort modes, paging past 60 items, random seed stability and Shuffle |
| `modes.spec.ts` | image/video filters, recursive, recursive excludes, comic mode and the reader |
| `search.spec.ts` | plain query, literal `%`/`_`, empty result |
| `viewer.spec.ts` | step/wrap/loop, page-boundary stepping, video resume, PDF, grid keyboard |
| `manage.spec.ts` | sync token guard, active-run maintenance block, stats page, folder soft-delete |

The bucket gets a CORS rule for the app origin during setup: images load cross-origin without
one, but the PDF viewer `fetch`es the signed original, which rustfs refuses without a rule.

## What the Frame View project covers

The specs drive View, Frame View as one of Oriel's modes. The `oriel-setup` project runs
`electron-forge package` for Oriel (the only supported way to get a production `.vite/build`;
skip with `E2E_SKIP_BUILD=1`). Each test launches the build with Playwright's `_electron` driver
on a fresh userData directory and replaces
`dialog.showOpenDialog` from the main process, so "Open" lands on a fixture folder without a
native picker. `ELECTRON_RUN_AS_NODE` is stripped from the child environment; with it set, the
Electron binary starts as plain Node and Playwright reports "Process failed to launch".

`gallery.spec.ts` covers: open + child listing + recursive, root-child excludes through the
Folders overlay, the image/video filters, the four ordered sort modes against the shared oracle,
Random + Shuffle, thumbnail rendering, viewer stepping (keys and buttons), comic mode + reader, and
the remembered folder across a relaunch. Frame View indexes images and videos only, so the
fixture PDF is excluded from its expectations.

## What the Lockstep project covers

`tests/lockstep/sync.spec.ts` drives Sync, the Lockstep desktop app as one of Oriel's modes. The
`oriel-setup` project packages Oriel; the spec launches it on a fresh userData directory, opens
Sync, creates a profile against the e2e Pane View server with the `lockstep-source` fixture (two
images that are not in the seeded archive), runs Plan (two uploads), Push (two pushed, zero
failed, both paths in `/api/sync/snapshot`), Plan again (nothing to upload; every seeded path is a
delete from this source), then Prune: one planned delete's file is copied back into the source
first, so Prune deletes every other planned path, skips that one, and leaves the Prune stage
disabled until the next Plan. It also checks `lockstep-settings.json` (in `lockstep/` inside the
run's userData) never holds the token in the clear. Sync encrypts tokens with a key file in that
folder on every platform, so no Keychain prompt blocks the run.
Prune empties the seeded archive in the e2e database, which is recreated
the next time the e2e server starts. The project depends on
`pane-view`, so `pnpm e2e:lockstep` runs the Pane View suite first; `--no-deps` skips that while
iterating (the server is still started or reused).

## What the Oriel project covers

`tests/oriel/build.setup.ts` packages Oriel (skip with `E2E_SKIP_BUILD=1`). `shell.spec.ts`
switches modes from the switcher and from the View menu (whose check mark follows the mode), and
relaunches on the same userData to check Oriel reopens in the mode it showed last, and opens a
folder in View, switches to Tidy and back, and checks the gallery is still there.
`migration.spec.ts` builds the folders the old apps leave (a Glazier and a Frame View `Local
Storage` from a real run, and Frame View's settings with a saved window) and checks the first
start brings the preferences, the theme and the window size over. Under `--user-data-dir` Oriel
never asks to quit or remove the old apps, so the spec runs beside installed copies. The project
needs no compose stack.

## What the Glazier project covers

The specs drive Tidy, Glazier as one of Oriel's modes; the `oriel-setup` project packages Oriel
(skip with `E2E_SKIP_BUILD=1`). The spec builds a throwaway archive in a temp folder with sharp and `ffmpeg` (it changes files, so it never uses the
shared fixture): stills including a resized twin and an AVIF misnamed `.jpg`, an animated GIF,
H.264/AAC in MOV, VP9/Opus in WebM, MP4s with sound, with a silent track and with no audio, an
exact copy, `Thumbs.db` and an empty folder. Tidy opens a hidden transcoder window as well as
Oriel's main one, so `e2e/src/oriel.ts` finds the main window by its page instead of taking the
first. Folders are added through Glazier's own picker: `chooseFolder` types the path into its field
and presses Choose, so no native dialog is stubbed. `workbench.spec.ts` covers, in order: adding and scanning the root and its findings;
**Find similar** grouping the resized JPEG with its original; sound measurement (one with no
track, one silent, four with sound); resolving the exact duplicate into holding and undoing it from
the decision's toast; and converting every category (stills to AVIF, the GIF and both videos to MP4, the
misnamed AVIF renamed), checking codecs with ffprobe and that each original's modification time
survived.

The project needs no compose stack: when only `glazier` (and its setup) is selected, the config
does not start the Pane View server. It needs `ffmpeg` and `ffprobe` on `PATH`, and a machine
whose WebCodecs can encode H.264 (any Mac).

## Gather Box: manual smoke checklist

Gather Box has no e2e project (plan 056, STOP 2): its output directory is a File System Access
handle that only a native picker plus a user-gesture `requestPermission` can produce, there is no
`chrome.downloads` fallback, and every source is bound to a real hostname, so nothing automatable
would start a run. Before a Gather Box PR is ready, check by hand with the unpacked `dist/` build:

1. Side panel: choose an output folder; reopening the side panel still shows it, with write access granted.
2. On one listed source page (a Reddit post with images is the cheapest), open the side panel and
   gather: the files land in the chosen folder under the source's folder convention.
3. Gather the same page again: identical files are skipped, differing ones get the four-character
   suffix, nothing is overwritten.
4. With archive media conversion on, a GIF post produces an MP4 and a still produces an AVIF.
5. Cancel a run mid-way: the panel shows it cancelled and no partial file is left behind.

## Adding a spec

Use the helpers in `e2e/src/pane-view.ts` (`gotoBrowse`, `readCardPaths`, `expectEntryCount`,
`chooseSort`, `openViewer`, …) and derive expectations from `e2e/src/fixture.ts`. A spec that
mutates the library (delete, wipe) must run last in its file and use fixture data nothing else
depends on (`disposable/`).
