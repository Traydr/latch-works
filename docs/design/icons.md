# Update application icons

The five SVG masters use flat fills and smooth curves. Edit these files directly. Avoid raster
tracing, texture, bevels, and cast shadows.

| Application | SVG master |
| --- | --- |
| Latch Works showcase | `apps/showcase/public/favicon.svg` |
| Pane View | `apps/pane-view/public/favicon.svg` |
| Frame View | `apps/frame-view/media/frame-view-icon.svg` |
| Gather Box | `apps/gather-box/assets/icons/gather-box-icon.svg` |
| Lockstep | `apps/lockstep/media/lockstep-icon.svg` |

The [approved artwork comparison](https://vellum.traydr.dev/01a080ab-f279-724d-90a1-e214fdb18574)
is available until October 8, 2026.

## Regenerate platform assets

Run these commands from the repository root:

```sh
python3 -m venv /tmp/latch-icon-tools
/tmp/latch-icon-tools/bin/pip install Pillow==11.3.0 resvg-py==0.3.2
/tmp/latch-icon-tools/bin/python scripts/generate-icons.py
```

The script renders each SVG at 2048 pixels and downsamples with Lanczos. It overwrites the
22 logo PNGs, four ICO files, and two ICNS files. It also copies Lockstep's SVG into the CLI
assets and its PNG into the macOS Icon Composer bundle. Screenshot PNGs are not regenerated.

Web pages use SVG for logos and favicons, with ICO and Apple touch PNG fallbacks. Chrome
extension icons and Electron window icons retain PNG filenames. Desktop packagers retain
ICO and ICNS filenames. These raster files are generated from the SVG masters.

Keep Lockstep's Icon Composer background matched to the SVG charcoal fill, `#2d323a`, with
its group shadow opacity set to zero.

## Verify the result

1. Open the SVGs and generated PNGs on light and dark backgrounds. Check curves at large size
   and readability at 16, 32, 48, and 64 pixels.
2. Build Showcase and Pane View. Check their favicon links, the Showcase header, and Pane
   View's login and sidebar logos.
3. Build Gather Box and load its `dist/` folder as an unpacked extension. Check the extension
   icon in Chrome.
4. Package Frame View and Lockstep on the target platform. Check the installer, application,
   Dock or taskbar, and window icons. Frame View packaging must be run by the user under
   `apps/frame-view/AGENTS.md`.
