# Showcase

Server-rendered marketing site for the Latch Works ecosystem — product pages, documentation, and screenshots.

Built with [Astro](https://astro.build/) (`output: "server"`) so pages and MDX docs render on the server.

## Development

```bash
pnpm dev:showcase
```

Opens at http://127.0.0.1:3100

- `/` — ecosystem overview
- `/{slug}` — Pane View, Frame View, Gather Box, Lockstep
- `/docs` — MDX documentation

## Screenshots

Product screenshots live in `public/screenshots/`. Regenerate them after UI changes to the source apps:

```bash
# Prepare sample media, then capture (Pane View optional but recommended)
pnpm --filter @latch-works/showcase screenshots
```

The capture script:

- Forces dark mode for Pane View, Gather Box, Lockstep terminal renders, and Frame View
- Logs into a local Pane View instance when `/api/health` is healthy (probes `localhost:3000` and `127.0.0.1:3000`)
- Loads repo-root `.env` for `PANE_VIEW_USERNAME`, `PANE_VIEW_PASSWORD`, and `LOCKSTEP_SOURCE` when those vars are not already set
- Runs real Lockstep `plan` / `push` commands for terminal screenshots
- Renders Gather Box from the extension popup CSS
- Boots Frame View's `preview:showcase` Vite entry so screenshots use the real React UI (not a mock layout)

Set `CHROME_PATH` if Chrome is installed outside the default macOS / Linux locations.

## Build

```bash
pnpm --filter @latch-works/showcase build
pnpm --filter @latch-works/showcase preview
```
