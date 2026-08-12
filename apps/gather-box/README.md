# Gather Box

> Chrome extension for downloading media galleries and story PDFs from supported sites into a local archive.

Gather Box is the **collection** step in [Latch Works](../../README.md): media enters the ecosystem here, gets organized on disk (often alongside [Frame View](../frame-view)), and can later be synced to [Pane View](../pane-view) via [Lockstep](../../apps/lockstep-cli).

## Supported sites

| Site | Content |
| --- | --- |
| **X** | Post images, animated GIF videos, and videos |
| **Reddit** | Community and user-profile post images, galleries, GIFs as MP4, and embedded video posts |
| **pixiv** | Original artwork pages, including collapsed multi-image works |
| **Archive of Our Own** | Work PDF download |
| **fanfiction.net** | All chapters fetched and merged into one local PDF |

Each site remembers its own destination folder. Folder and filename inference rules (underscores,
nested post paths, `{author}-{story}.pdf` for stories) are implemented per collector in
`src/content/collectors/`.

`source-catalog.json` is the authoritative list. Entries marked `"unlisted": true` are fully
supported at runtime but are deliberately kept out of enumerated surfaces — this README, the
options page, and the generated docs site. Read the catalog directly for the complete set.

## How it works

1. Open a supported page in Chrome.
2. Click the extension icon.
3. Choose a writable destination folder (Chrome File System Access API).
4. Click **Download Content**.
5. The side panel reports progress and any per-file failures while the Gather Run continues in the
   background.

When another output is already running, **Download Content** becomes **Add to Queue**. Wait for the
side panel to confirm the page was queued, then navigate or close the source tab. Gather Box captures
page metadata first and processes queued outputs one at a time in the background. The queue is
persisted so fully captured jobs can resume safely after a browser restart.

On a supported page, hold the right Shift key and press `]` to toggle Gather Box, or `[` to start
the download immediately. Left Shift does not activate these page shortcuts, and the shortcuts can
be disabled from Gather Box settings.

For focus-independent shortcuts, Chrome commands default to `Ctrl+Shift+Period`
(`Command+Shift+Period` on macOS) to toggle Gather Box and `Ctrl+Shift+Comma`
(`Command+Shift+Comma` on macOS) to download. They can be remapped in
`chrome://extensions/shortcuts`.

Downloads use your browser session cookies where needed (AO3, fanfiction.net, and other login-gated sources). Individual file failures do not stop the rest of the batch.
The always-on page script contains only the optional Right Shift shortcuts. When gathering starts,
the service worker injects exactly one catalog-selected collector into the captured tab's main frame.

The optional **Convert media for the AVIF archive** setting keeps Gather Box compatible with an
archive normalized to AVIF and MP4. It converts JPEG, PNG, WebP, and BMP still images to AVIF at
quality 70 / speed 6, converts downloaded GIFs to H.264 MP4, and leaves existing AVIF and MP4 media
unchanged. Conversion runs locally in the extension. When the converted target filename already
exists, Gather Box skips the item before fetching it.

## Project structure

```text
gather-box/
├── manifest.base.json   # Stable MV3 shell; source access is generated
├── source-catalog.json  # Authoritative Gather Source policy
├── sidepanel/           # The sole Gather Box UI
├── offscreen/           # Persistent Gather Output execution document
├── ui/                  # Shared extension-page styling
├── src/
│   ├── background/      # Commands and Gather Run coordination
│   ├── gather/          # Collection/output adapters and UI helpers
│   ├── content/         # Per-site collectors (injected scripts)
│   ├── offscreen/       # Gather Output executor
│   └── shared/          # Site detection, path helpers
├── scripts/
│   ├── build.mjs        # esbuild bundle → dist/
│   └── clean.mjs
└── assets/icons/
```

## Development

Install dependencies from the **repo root** (`pnpm install`), then:

```powershell
# Typecheck
pnpm --filter @latch-works/gather-box typecheck

# Build extension to dist/
pnpm --filter @latch-works/gather-box build

# Clean build output
pnpm --filter @latch-works/gather-box clean
```

Source lives in `src/` and is bundled into `dist/`. Reload the unpacked extension in Chrome after every rebuild.
The build emits the reviewable manifest and a host-permission ownership report from
`source-catalog.json`; generated reports live in `.build-meta/` and are not packaged.

## Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `apps/gather-box/dist` directory

## Usage example URLs

- `https://x.com/<user>/status/<post_id>/photo/1`
- `https://www.reddit.com/r/<subreddit>/comments/<post_id>/<slug>/`
- `https://www.pixiv.net/en/artworks/<artwork_id>`
- `https://archiveofourown.org/works/<work_id>`
- `https://www.fanfiction.net/s/<story_id>/1/<slug>`

## Folder layout examples

**X** — one folder per username (an initial ASCII capital is lowercased):

```text
<root>/<username>/<site media filename>
```

**pixiv** — one folder per creator and stable user ID:

```text
<root>/<username>-<user_id>/<artwork_id>_p<page>.<extension>
```

**Reddit** — single media saves directly; galleries use an ordered post folder:

```text
<root>/<media filename>
<root>/<post_title>_<post_id>/01_<media filename>
```

**Story PDFs** (AO3, fanfiction.net):

```text
<site-folder>/Author_Name-Story_Title.pdf
```

Some picture collectors normalize the artist folder, lowercasing only the first ASCII character and
reusing an existing all-lowercase folder when one is already present. Spaces in folder and PDF names
are converted to underscores.

## Notes

- The side panel shows the picked folder **name** only — browsers do not expose the full absolute path through the File System Access API.
- Existing media is never overwritten. Gather Box compares SHA-256 hashes when a site filename already exists, skips identical content, and appends a four-character suffix before the extension for different content. In AVIF archive mode, an existing converted target filename is treated as already gathered and skipped without a network request.
- pixiv original-image requests use a narrowly scoped extension rule to supply pixiv's required `Referer` header.
- X video resolution uses X's public syndication data first, then its web-client media response. The fallback flow was informed by [Cobalt's X extractor](https://github.com/imputnet/cobalt/blob/main/api/src/processing/services/twitter.js); Gather Box does not call a hosted Cobalt instance.
- Embedded third-party video posts are resolved locally through the host's temporary-token API; the extension downloads the returned HD MP4 when available. A narrowly scoped request rule supplies the required origin headers. See `src/background/` for the per-host resolvers and their attribution.
- Reddit GIF posts use Reddit's existing signed MP4 rendition, avoiding local transcoding and its bundle/runtime cost.
- The extension re-confirms folder access with Chrome when needed.
- A permission-required job pauses the output queue until folder access is confirmed or the job is
  cancelled.
- Gallery collectors target a specific grid selector per site and ignore ad blocks outside it.

## Manual checks

- [ ] Toolbar action and toggle shortcut open/close the same side panel without console errors
- [ ] Unsupported pages keep the download action disabled
- [ ] Image files keep sequential names (`001.webp`, `002.webp`, …)
- [ ] Story PDFs use `{author}-{story}.pdf` naming
- [ ] fanfiction.net: chapter count matches selector; generated PDF has all chapters in order with basic bold/italic preserved
- [ ] Nested post collectors: files land in `<creator>/<post_title>-<post_id>/`
- [ ] Reddit: single media lands at the root; galleries use `<post_title>_<post_id>/01_<filename>`

## Related

- [Frame View](../frame-view/README.md) — browse downloaded folders locally
- [Lockstep](../../apps/lockstep-cli/README.md) — publish archive to Pane View
- [Root README](../../README.md) — monorepo overview
