# Gather Box

> Chrome extension for downloading media galleries and story PDFs from supported sites into a local archive.

Gather Box is the **collection** step in [Latch Works](../../README.md): media enters the ecosystem here, gets organized on disk (often alongside [Oriel](../../docs/runbooks/oriel.md)), and can later be synced to [Pane View](../pane-view) via [Lockstep](../../apps/lockstep-cli).

## Profiles

A profile is a named set of remembered destination folders. Switch profiles from the dropdown at
the top of the side panel; **Manage** opens the settings page, where profiles can be added,
renamed, and deleted. Each profile keeps its own global and per-site folders, so switching profiles
switches where downloads are saved. Folders remembered before profiles existed belong to the
**Default** profile, which can be renamed but not deleted.

A queued page keeps the profile that was active when it was gathered, so switching profiles while
the queue runs does not move it. A paused job waiting for folder access can only be confirmed with
its own profile active; the side panel names that profile when more than one exists. Deleting a
profile forgets its remembered folders and ends any pages still queued for it; files already saved
stay on disk.

## Supported sites

| Site | Content |
| --- | --- |
| **X** | Post images, animated GIF videos, and videos |
| **Reddit** | Community and user-profile post images, galleries, GIFs as MP4, and embedded video posts |
| **pixiv** | Original artwork pages, including collapsed multi-image works |
| **Archive of Our Own** | Work PDF download |
| **FanFiction.Net** | All chapters fetched and merged into one local PDF |

Each site remembers its own destination folder (or one global folder, if chosen in settings).
Folder and filename inference rules (underscores, nested post paths, `{author}-{story}.pdf` for
stories) are implemented per collector in `src/content/collectors/`.

`src/shared/source-catalog.ts` is the authoritative list. Entries marked `unlisted: true` are fully
supported at runtime but are deliberately kept out of enumerated surfaces — this README, the
options page, the side panel's unsupported-page hint, and the showcase docs. A test checks that
this table and the showcase's site appendix list exactly the catalog's listed sources. Read the
catalog directly for the complete set.

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

Downloads send your browser session cookies to the sources that need them (AO3 and pixiv). Individual file failures do not stop the rest of the batch.
The always-on page script contains only the optional Right Shift shortcuts. When gathering starts,
the service worker injects exactly one catalog-selected collector into the captured tab's main frame.

The optional **Convert media for the AVIF archive** setting keeps Gather Box compatible with an
archive normalized to AVIF and MP4. It converts JPEG, PNG, WebP, and BMP still images to AVIF at
quality 70 / speed 6, converts downloaded GIFs to H.264 MP4, and leaves existing AVIF and MP4 media
unchanged. Conversion runs locally in the extension. When the converted target filename already
exists, Gather Box skips the item before fetching it. The AVIF encoder works inside a 2 GiB memory
limit. Large hard-edged artwork (from roughly 30 megapixels) can exceed it at speed 6, so Gather Box
retries such an image at speed 8, which needs half the memory and produces a somewhat larger file.
Beyond about 64 megapixels no setting fits; Gather Box then saves the original file unconverted and
notes it in the run log. A blocked file you hand back from the side panel is converted and saved
the same way, so the next gather finds it.

## Project structure

```text
gather-box/
├── manifest.base.json   # Stable MV3 shell; source access is generated from the catalog
├── rules/               # declarativeNetRequest rule files the catalog's sources declare
├── sidepanel/           # The sole Gather Box UI
├── offscreen/           # Persistent Gather Output execution document
├── ui/                  # Shared extension-page styling
├── src/                 # One folder per Chrome execution context
│   ├── background/      # Service worker: commands, Gather Run coordination, media resolvers
│   ├── content/         # Page-shortcut script and per-source collectors (collectors/<key>.ts)
│   ├── offscreen/       # Gather Output executor: downloads and story PDFs
│   ├── sidepanel/       # Side panel controller and DOM
│   ├── options/         # Settings page
│   └── shared/          # Catalog, source policies, run/queue model, protocol, storage, the
│                        # archive writer and AVIF/MP4 conversion (media/)
├── scripts/
│   ├── build.mjs        # Rolldown bundle → dist/
│   └── clean.mjs
└── assets/icons/
```

`src/shared/source-catalog.ts` defines every Gather Source; `src/shared/source-policies.ts` holds
the few source rules that are code (X post folders, Hentai Foundry's legacy artist folders). Adding
a source means a catalog entry and a collector at `src/content/collectors/<key>.ts` that exports
`collect`; the build generates its content script. Messages between contexts go through one
protocol module per channel in `src/shared/protocol/`.

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
`src/shared/source-catalog.ts`; generated reports live in `.build-meta/` and are not packaged.

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
<root>/Author_Name-Story_Title.pdf
```

Some picture collectors normalize the artist folder, lowercasing only the first ASCII character and
reusing an existing all-lowercase folder when one is already present. Spaces in folder and PDF names
are converted to underscores.

## Notes

- The side panel shows the picked folder **name** only — browsers do not expose the full absolute path through the File System Access API.
- Existing media is never overwritten. Gather Box compares SHA-256 hashes when a site filename already exists, skips identical content, and appends a four-character suffix before the extension for different content. The suffix is derived from the content, so gathering the same file again finds and skips the suffixed copy. In AVIF archive mode, an existing converted target filename is treated as already gathered and skipped without a network request.
- pixiv original-image requests use a narrowly scoped extension rule to supply pixiv's required `Referer` header.
- X video resolution uses X's public syndication data first, then its web-client media response. The fallback flow was informed by [Cobalt's X extractor](https://github.com/imputnet/cobalt/blob/main/api/src/processing/services/twitter.js); Gather Box does not call a hosted Cobalt instance.
- Embedded third-party video posts are resolved locally through the host's temporary-token API; the extension downloads the returned HD MP4 when available. A narrowly scoped request rule supplies the required origin headers. See `src/background/` for the per-host resolvers and their attribution.
- Reddit GIF posts use Reddit's existing signed MP4 rendition, avoiding local transcoding and its bundle/runtime cost.
- The extension re-confirms folder access with Chrome when needed.
- A permission-required job pauses the output queue until folder access is confirmed or the job is
  cancelled. The side panel names the page that can confirm it: any supported page when a global
  folder is set, otherwise a page from the paused job's own site. Confirming resumes the paused job
  and still queues the page you confirmed from.
- Retrying failed files confirms access to the folder of the run that failed, so it works from any
  tab rather than only from a tab on that run's site.
- A queued page is written to the folder that was remembered when it was gathered. If you choose a
  different folder before its turn, its files fail instead of moving to the new folder; Retry Failed
  sends them to the current folder. Choosing the same folder again does not affect queued pages.
- Gallery collectors target a specific grid selector per site and ignore ad blocks outside it.

## Manual checks

- [ ] Toolbar action and toggle shortcut open/close the same side panel without console errors
- [ ] Unsupported pages keep the download action disabled
- [ ] Image files keep their site filenames (only Reddit galleries get `01_` order prefixes)
- [ ] Story PDFs use `{author}-{story}.pdf` naming
- [ ] fanfiction.net: chapter count matches selector; generated PDF has all chapters in order with basic bold/italic preserved
- [ ] Nested post collectors: files land in `<creator>/<post_title>-<post_id>/`
- [ ] Reddit: single media lands at the root; galleries use `<post_title>_<post_id>/01_<filename>`
- [ ] Profiles: switching in the dropdown shows each profile's own folder; renames in settings
      appear in the side panel without reopening it

## Related

- [Oriel](../../docs/runbooks/oriel.md) — browse and tidy downloaded folders locally
- [Lockstep](../../apps/lockstep-cli/README.md) — publish archive to Pane View
- [Root README](../../README.md) — monorepo overview
