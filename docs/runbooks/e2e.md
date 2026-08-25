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
| `browse.spec.ts` | root and folder listings, sidebar navigation |
| `sorting.spec.ts` | all five sort modes, paging past 60 items, random seed stability and Shuffle |
| `modes.spec.ts` | image/video filters, recursive, recursive excludes, comic mode and the reader |
| `search.spec.ts` | plain query, literal `%`/`_`, empty result |
| `viewer.spec.ts` | step/wrap/loop, page-boundary stepping, video resume, PDF, grid keyboard |
| `manage.spec.ts` | sync token guard, active-run maintenance block, stats page, folder soft-delete |

The bucket gets a CORS rule for the app origin during setup: the PDF viewer fetches signed
originals from the browser, as it does against a production bucket.

## Adding a spec

Use the helpers in `e2e/src/pane-view.ts` (`gotoBrowse`, `readCardPaths`, `expectEntryCount`,
`chooseSort`, `openViewer`, …) and derive expectations from `e2e/src/fixture.ts`. A spec that
mutates the library (delete, wipe) must run last in its file and use fixture data nothing else
depends on (`disposable/`).
