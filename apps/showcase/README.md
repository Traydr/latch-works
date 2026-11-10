# Showcase

Server-rendered marketing site for the Latch Works ecosystem: product pages, documentation, and screenshots.

Built with [Astro](https://astro.build/) (`output: "server"`) so pages and MDX docs render on the server.

## Development

```bash
pnpm --filter @latch-works/showcase dev
```

Opens at http://127.0.0.1:3100

- `/`: ecosystem overview
- `/{slug}`: Gather Box, Oriel, Pane View
- `/docs`: MDX documentation (Start Here, Gather Box, Oriel, Lockstep CLI, Pane View, Reference)

The old Frame View and Lockstep product pages and docs redirect to their Oriel homes
(`redirects` in `astro.config.mjs`).

## Screenshots

Product screenshots live in `public/screenshots/`. They are captured from the **real
applications**, with no preview harnesses or mocked layouts. Regenerate them after UI changes to the
source apps:

```bash
# One-time setup: local services + synced showcase archive
docker compose -f docs/localhost/compose.yaml up -d      # Postgres + rustfs
pnpm --filter @latch-works/pane-view db:migrate
node apps/showcase/scripts/prepare-showcase-media.mjs
LOCKSTEP_API_URL=http://localhost:3000 LOCKSTEP_API_TOKEN=$PANE_VIEW_SYNC_TOKEN \
  pnpm --filter @latch-works/lockstep start push --source /tmp/showcase-archive
pnpm --filter @latch-works/gather-box build
pnpm --filter @latch-works/oriel bundle                          # Oriel.app (macOS)
pnpm --filter @latch-works/showcase screenshots:install-browser   # Chrome for Testing

# With the Pane View dev server running on port 3000:
pnpm --filter @latch-works/showcase screenshots
```

The sample archive always lives at `/tmp/showcase-archive`; the scripts ignore `LOCKSTEP_SOURCE`.
`prepare-showcase-media.mjs` creates it and leaves a `.showcase-archive-owner` marker inside.
The scripts refuse to write into a directory without that marker, a symbolic link, or a directory
holding any file they did not generate, so sample media never lands in a real archive. To start
over, delete `/tmp/showcase-archive` and run the prepare script again.

`capture-screenshots.mjs` runs three per-app scripts (each also runnable on its own):

- `capture-pane-view.mjs`: logs into the running web app and captures login, gallery, and
  viewer. Thumbnails come straight from rustfs via Pane View's Shutter-less pass-through mode
  (leave `SHUTTER_EDGE_URL` empty in `.env`).
- `capture-gather-box.mjs`: loads the unpacked extension into the vendored Chrome and captures
  the actual side panel in idle and active states. AO3 refuses automated browsers, so the AO3
  pages are a local mock (`mock-archive.mjs`) served at AO3's own URLs, where the extension's
  AO3 collector runs unchanged.
- `capture-oriel.mjs` (macOS only): launches the bundled Oriel once per screenshot on a throwaway
  data folder and captures its window with `screencapture`, once two captures in a row match. The
  `ORIEL_*` check variables (`docs/runbooks/oriel.md`) open each screen, all saved under
  `screenshots/oriel/`: View's gallery, viewer and settings (`view-*.png`), Tidy's overview of a
  copy of the archive in the run's sandbox (`tidy-overview.png`), and Sync's plan and a real push
  (`sync-*.png`), seeding fresh sample scans each run. Needs the Xcode command line tools for `swiftc` and Screen Recording permission for
  the terminal. Sync pushes to `http://localhost:3000` with `PANE_VIEW_SYNC_TOKEN` from `.env`;
  for a plan that shows only the sample archive, push to an empty server instead, such as the e2e
  one (`node e2e/scripts/start-pane-view.ts`, which recreates the e2e database and empties its
  bucket, and listens on the port in `e2e/stack.json`), with its port and sync token from
  `e2e/stack.json`:

  ```bash
  SHOWCASE_PANE_VIEW_URL=$(node -p '"http://127.0.0.1:" + require("./e2e/stack.json").paneView.port') \
  SHOWCASE_SYNC_TOKEN=$(node -p 'require("./e2e/stack.json").paneView.syncToken') \
    node apps/showcase/scripts/capture-oriel.mjs
  ```

All captures are dark mode at 1440x900 @2x. The Pane View and Gather Box captures use the newest
Chrome for Testing that `screenshots:install-browser` put in `apps/showcase/chrome` for your
platform; set `CHROME_PATH` to use another binary.

## Future considerations

An enamel-matched grayscale + multiply screenshot treatment looked strong on Colorblock plates, but it misrepresented real app color. Keep screenshots in natural color for now; reconsider that tonal treatment later as optional art direction, not the default.

## Build

```bash
pnpm --filter @latch-works/showcase build
pnpm --filter @latch-works/showcase preview
```
