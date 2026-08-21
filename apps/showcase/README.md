# Showcase

Server-rendered marketing site for the Latch Works ecosystem — product pages, documentation, and screenshots.

Built with [Astro](https://astro.build/) (`output: "server"`) so pages and MDX docs render on the server.

## Development

```bash
pnpm dev:showcase
```

Opens at http://127.0.0.1:3100

- `/` — ecosystem overview
- `/{slug}` — Gather Box, Frame View, Lockstep, Pane View
- `/docs` — MDX documentation

## Screenshots

Product screenshots live in `public/screenshots/`. They are captured from the **real
applications** — no preview harnesses or mocked layouts. Regenerate them after UI changes to the
source apps:

```bash
# One-time setup: local services + synced showcase archive
docker compose -f docs/localhost/compose.yaml up -d      # Postgres + rustfs
pnpm --filter @latch-works/pane-view db:migrate
node apps/showcase/scripts/prepare-showcase-media.mjs
LOCKSTEP_API_URL=http://localhost:3000 LOCKSTEP_API_TOKEN=$PANE_VIEW_SYNC_TOKEN \
  pnpm --filter @latch-works/lockstep start push --source /tmp/showcase-archive
pnpm --filter @latch-works/gather-box build

# With the Pane View dev server running on port 3000:
pnpm --filter @latch-works/showcase screenshots
```

`capture-screenshots.mjs` runs four per-app scripts (each also runnable on its own):

- `capture-pane-view.mjs` — logs into the running web app and captures login, gallery, and
  viewer. Thumbnails come straight from rustfs via Pane View's Shutter-less pass-through mode
  (leave `SHUTTER_EDGE_URL` empty in `.env`).
- `capture-frame-view.mjs` — launches the real Electron app over CDP against
  `apps/frame-view/showcase-media`. Backs up and restores your personal settings file.
- `capture-lockstep.mjs` — launches the real Lockstep desktop app, runs a real plan and push
  against the local sync API (seeding fresh sample scans each run), and captures the review and
  run-log screens. Backs up and restores your profiles.
- `capture-gather-box.mjs` — loads the unpacked extension into the vendored Chrome and captures
  the actual side panel in idle and active states.

All captures are dark mode at 1440x900 @2x. Set `CHROME_PATH` to override the vendored
Chrome for Testing binary.

## Future considerations

An enamel-matched grayscale + multiply screenshot treatment looked strong on Colorblock plates, but it misrepresented real app color. Keep screenshots in natural color for now; reconsider that tonal treatment later as optional art direction, not the default.

## Build

```bash
pnpm --filter @latch-works/showcase build
pnpm --filter @latch-works/showcase preview
```
