# Gather Box

> Chrome extension for downloading image galleries and story PDFs from supported sites into a local archive.

Gather Box is the **collection** step in [Latch Works](../../README.md): media enters the ecosystem here, gets organized on disk (often alongside [Frame View](../frame-view)), and can later be synced to [Pane View](../pane-view) via [Lockstep](../../apps/lockstep-cli).

## Supported sites

| Site | Content |
| --- | --- |
| **MyHentaiGallery** | Gallery images (`/thumbnail/` → `/original/`) |
| **Kemono** | Post image attachments |
| **pixiv FANBOX** | Post image CDN files |
| **Archive of Our Own** | Work PDF download |
| **Hentai Foundry** | Story PDF download |
| **fanfiction.net** | All chapters fetched and merged into one local PDF |

Each site remembers its own destination folder. Folder and filename inference rules (underscores, nested paths for Kemono/FANBOX, `{author}-{story}.pdf` for stories) are implemented per collector in `src/content/collectors/`.

## How it works

1. Open a supported page in Chrome.
2. Click the extension icon.
3. Choose a writable destination folder (Chrome File System Access API).
4. Click **Download Content**.
5. The popup reports progress and any per-file failures.

Downloads use your browser session cookies where needed (AO3, Hentai Foundry, fanfiction.net). Individual file failures do not stop the rest of the batch.

## Project structure

```text
gather-box/
├── manifest.json
├── popup/               # Extension popup HTML/CSS
├── src/
│   ├── popup/           # Popup logic and UI state
│   ├── content/         # Per-site collectors (injected scripts)
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

## Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `apps/gather-box/dist` directory

## Usage example URLs

- `https://myhentaigallery.com/a/20942`
- `https://kemono.cr/fanbox/user/24921130/post/11471817`
- `https://creator.fanbox.cc/posts/11929835`
- `https://archiveofourown.org/works/18187196`
- `https://www.hentai-foundry.com/stories/user/dotDelamora/70617/Taming-Guinevere`
- `https://www.fanfiction.net/s/12620462/1/Taboo`

## Folder layout examples

**Kemono** — nested by user type, name, and post title:

```text
<root>/<user_type>/<user_name>/<post_title>/
```

**FANBOX** — nested by creator and post:

```text
<root>/<creator_name>/<post_title>-<post_id>/
```

**Story PDFs** (AO3, Hentai Foundry, fanfiction.net):

```text
<site-folder>/Author_Name-Story_Title.pdf
```

Spaces in folder and PDF names are converted to underscores.

## Notes

- The popup shows the picked folder **name** only — browsers do not expose the full absolute path through the File System Access API.
- The extension re-confirms folder access with Chrome when needed.
- MyHentaiGallery collection targets `ul.comics-grid.clear div.comic-thumb img[src]` and ignores ad blocks outside that selector.

## Manual checks

- [ ] Popup opens without console errors after loading unpacked
- [ ] Unsupported pages keep the download action disabled
- [ ] Image files keep sequential names (`001.webp`, `002.webp`, …)
- [ ] Story PDFs use `{author}-{story}.pdf` naming
- [ ] fanfiction.net: chapter count matches selector; generated PDF has all chapters in order with basic bold/italic preserved
- [ ] FANBOX: files land in `<creator>/<post_title>-<post_id>/`

## Related

- [Frame View](../frame-view/README.md) — browse downloaded folders locally
- [Lockstep](../../apps/lockstep-cli/README.md) — publish archive to Pane View
- [Root README](../../README.md) — monorepo overview
