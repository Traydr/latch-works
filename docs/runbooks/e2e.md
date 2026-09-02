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
pnpm e2e:frame                           # Frame View, through Playwright's Electron driver
pnpm e2e:lockstep                        # Lockstep desktop, pushing into the Pane View server
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

`tests/frame-view/build.setup.ts` runs `electron-forge package` (about ten seconds; the only
supported way to get a production `.vite/build`, skip with `E2E_SKIP_BUILD=1`). Each test launches
the build with Playwright's `_electron` driver on a fresh userData directory and replaces
`dialog.showOpenDialog` from the main process, so "Open" lands on a fixture folder without a
native picker. `ELECTRON_RUN_AS_NODE` is stripped from the child environment; with it set, the
Electron binary starts as plain Node and Playwright reports "Process failed to launch".

`gallery.spec.ts` covers: open + child listing + recursive, root-child excludes through the
Folders overlay, the image/video filters, the four ordered sort modes against the shared oracle,
Random + Shuffle, thumbnail rendering, viewer stepping (keys and buttons), comic mode + reader, and
the remembered folder across a relaunch. Frame View indexes images and videos only, so the
fixture PDF is excluded from its expectations. One test ("a fresh scan lands in the configured
sort order") is red today: a fresh scan shows discovery order until the sort is re-chosen. That is
a product bug, and the suite stays red until it is fixed.

## What the Lockstep project covers

`tests/lockstep/sync.spec.ts` packages the Lockstep desktop app (setup project), launches it on
a fresh userData directory, creates a profile against the e2e Pane View server with the
`lockstep-source` fixture (two images that are not in the seeded archive), runs Plan (two uploads),
Push (two pushed, zero failed, both paths in `/api/sync/snapshot`), Plan again (nothing to upload),
and checks `lockstep-settings.json` never holds the token in the clear. The project depends on
`pane-view`, so `pnpm e2e:lockstep` runs the Pane View suite first; `--no-deps` skips that while
iterating (the server is still started or reused).

## Gather Box: manual smoke checklist

Gather Box has no e2e project (plan 056, STOP 2): its output directory is a File System Access
handle that only a native picker plus a user-gesture `requestPermission` can produce, there is no
`chrome.downloads` fallback, and every source is bound to a real hostname, so nothing automatable
would start a run. Before a Gather Box PR is ready, check by hand with the unpacked `dist/` build:

1. Options page: pick an output folder; reopening the options page shows it as granted.
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
