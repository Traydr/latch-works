# Update application icons

The six SVG masters use flat fills and smooth curves. Edit these files directly. Avoid raster
tracing, texture, bevels, and cast shadows.

| Application | SVG master |
| --- | --- |
| Latch Works showcase | `apps/showcase/public/favicon.svg` |
| Pane View | `apps/pane-view/public/favicon.svg` |
| Frame View | `apps/frame-view/media/frame-view-icon.svg` |
| Gather Box | `apps/gather-box/assets/icons/gather-box-icon.svg` |
| Lockstep (now Oriel's Sync mode; no rasters) | `apps/oriel/media/modes/lockstep-icon.svg` |
| Glazier (now Oriel's Tidy mode; no rasters) | `apps/oriel/media/modes/glazier-icon.svg` |

The [approved artwork comparison](https://vellum.traydr.dev/01a080ab-f279-724d-90a1-e214fdb18574)
is available until October 8, 2026.

## Regenerate platform assets

Run this from the repository root after `pnpm install`:

```sh
pnpm icons
```

`scripts/generate-icons.ts` renders each SVG at 2048 pixels with sharp and downsamples with
Lanczos. It overwrites the PNG, ICO, and ICNS files of every master that still ships as an app. Screenshot
PNGs are not touched.

Web pages use the SVG directly for logos and favicons. The only rasters they keep are
`favicon.ico` for legacy browsers and `apple-touch-icon.png` for iOS home screens. Chrome
extension icons and Electron window icons retain PNG filenames. Desktop packagers retain ICO
and ICNS filenames. Every raster is generated from the SVG masters; do not edit them by hand.

## Verify the result

1. Open the SVGs and generated PNGs on light and dark backgrounds. Check curves at large size
   and readability at 16, 32, 48, and 64 pixels.
2. Build Showcase and Pane View. Check their favicon links, the Showcase header, and Pane
   View's login and sidebar logos.
3. Build Gather Box and load its `dist/` folder as an unpacked extension. Check the extension
   icon in Chrome.
4. Package Frame View on the target platform. Check the installer, application,
   Dock or taskbar, and window icons. Frame View packaging must be run by the user under
   `apps/frame-view/AGENTS.md`.
