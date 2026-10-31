# End-to-end suite

The `e2e/` workspace drives the built Pane View with Playwright. It is the final check before a
PR is marked ready and is **not** part of `pnpm test`; it takes minutes and needs the local stack.
Oriel's end-to-end cases are GPUI headless tests in its own workspace instead (see
[Oriel](#oriel) below).

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
pnpm --filter @latch-works/e2e fixture   # render e2e/.fixtures/ from the manifest (once)
pnpm e2e:pane                            # Pane View, seeded through the Lockstep CLI
```

`pnpm e2e` runs the same suite: Pane View is its only project.

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

## Oriel

Oriel has no Playwright project. The cases the Electron app's specs covered (the shell, View's
gallery, Tidy's workbench, Spot variants, Shrink and Tidy up, and Sync) are GPUI headless tests in
`apps/oriel` (`crates/app/tests`, `crates/mode-view/tests/gallery.rs`,
`crates/mode-tidy/tests`, `crates/mode-sync/tests`), and run with `cargo test --workspace` (see
the [Oriel runbook](oriel.md)).

Two of its tests use this suite's stack and are ignored by default: `oriel-mode-sync`'s and
`oriel-core-sync`'s `stack` tests push into the e2e Pane View that `scripts/start-pane-view.ts`
serves on port 3100. The Sync one also needs the fixture command's second archive,
`e2e/.fixtures/lockstep-source` (two images that are not in the seeded one). Each test's module
comment says how to run it.

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
