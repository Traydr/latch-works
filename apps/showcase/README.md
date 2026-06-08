# Showcase

Static marketing site for the Latch Works ecosystem — index page plus subpages for each app and tool.

## Development

```bash
pnpm dev:showcase
```

Opens at http://127.0.0.1:3100

## Screenshots

Product screenshots live in `public/screenshots/`. Regenerate them after UI changes to the source apps:

```bash
# Requires pane-view running with seeded archive data
pnpm --filter @latch-works/showcase screenshots
```

The capture script logs into a local Pane View instance, runs Lockstep commands, and renders Gather Box / Frame View previews from real extension CSS and archive media.

## Build

```bash
pnpm --filter @latch-works/showcase build
pnpm --filter @latch-works/showcase preview
```
