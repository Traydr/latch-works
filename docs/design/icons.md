# Update application icons

The SVG masters use flat fills and smooth curves. Edit these files directly. Avoid raster
tracing, texture, bevels, and cast shadows.

| Application | SVG master |
| --- | --- |
| Latch Works showcase | `apps/showcase/public/favicon.svg` |
| Pane View | `apps/pane-view/public/favicon.svg` |
| Oriel: a bay window onto the view | `apps/oriel-rs/assets/oriel-icon.svg` |
| Oriel on macOS 26 and later: the same art as two Liquid Glass layers (the window's frame and the view) over the plate's fill, in `icon.json`; the app bundle does not compile it yet | `apps/oriel-rs/assets/oriel.icon/` |
| Oriel's DMG background (rendered with resvg; see the Oriel RS runbook's DMG section) | `apps/oriel-rs/crates/xtask/installer/dmg-background.svg` |
| Gather Box | `apps/gather-box/assets/icons/gather-box-icon.svg` |

The [approved artwork comparison](https://vellum.traydr.dev/01a080ab-f279-724d-90a1-e214fdb18574)
is available until October 8, 2026.

## Regenerate platform assets

Run this from the repository root after `pnpm install`:

```sh
pnpm icons
```

`scripts/generate-icons.ts` renders each SVG at 2048 pixels with sharp and downsamples with
Lanczos. It overwrites the PNG, ICO, and ICNS files of every master that still ships as an app. Screenshot
PNGs and the DMG background are not touched.

The `.icon` bundle is its own master: edit its two SVG layers, or open it in Xcode's Icon Composer.
Electron Oriel's packaging compiled it with `actool` on macOS 26 and later; Oriel RS's bundle
carries the `.icns` only.

Web pages use the SVG directly for logos and favicons. The only rasters they keep are
`favicon.ico` for legacy browsers and `apple-touch-icon.png` for iOS home screens. Chrome
extension icons retain PNG filenames. Desktop packagers retain ICO
and ICNS filenames. Every raster is generated from the SVG masters; do not edit them by hand.

## Verify the result

1. Open the SVGs and generated PNGs on light and dark backgrounds. Check curves at large size
   and readability at 16, 32, 48, and 64 pixels.
2. Build Showcase and Pane View. Check their favicon links, the Showcase header, and Pane
   View's login and sidebar logos.
3. Build Gather Box and load its `dist/` folder as an unpacked extension. Check the extension
   icon in Chrome.
4. Package Oriel on the target platform (`cargo run -p xtask -- dmg` or `-- package` in
   `apps/oriel-rs`). Check the installer, application, Dock or taskbar, and window icons.
