# Gather Box

Personal-use Chrome extension for downloading original comic images and story PDFs from supported content pages.

## What It Does

- Validates the active tab is a supported MyHentaiGallery gallery, Kemono post, FANBOX post, AO3 work, Hentai Foundry story page, or fanfiction.net story page.
- Lets you choose a destination folder with Chrome's directory picker and remembers it for later.
- Collects images from supported page-specific selectors, including `ul.comics-grid.clear div.comic-thumb img[src]` on MyHentaiGallery, `div.post__files a.fileThumb.image-link[href]` on Kemono, and FANBOX image CDN anchors.
- Collects story PDF download links from AO3 works and Hentai Foundry story pages.
- Collects fanfiction.net chapter URLs and generates a local PDF from the chapter HTML.
- Rewrites `/thumbnail/` URLs to `/original/` for MyHentaiGallery and downloads Kemono and FANBOX files directly from the `href`.
- Downloads AO3 and Hentai Foundry story PDFs directly from the page's PDF link, including site cookies/session credentials for pages that are accessible in your browser session.
- Fetches fanfiction.net chapters with your browser session and writes one generated PDF as `{author}-{story}.pdf`.
- Saves files into inferred subfolders while preserving the original filenames.
- Saves AO3, Hentai Foundry, and fanfiction.net story PDFs directly into the selected site folder as `{author}-{story}.pdf`.
- Converts spaces in inferred folder names to underscores.
- Converts spaces in inferred story PDF filenames to underscores.
- For Kemono posts, infers nested folders as `<root>/<user_type>/<user_name>/<post_title>/` and converts spaces to underscores in each segment.
- For FANBOX posts, infers nested folders as `<root>/<creator_name>/<post_title>-<post_id>/` from the creator subdomain, post title, and post id.

## Project Structure

- [manifest.json](./manifest.json)
- [package.json](./package.json)
- [tsconfig.json](./tsconfig.json)
- [scripts/build.mjs](./scripts/build.mjs)
- [src/](./src)
- [popup/popup.html](./popup/popup.html)
- [popup/popup.css](./popup/popup.css)
- `assets/icons/*.png`

## Development

Install dependencies:

```powershell
pnpm install
```

Run the TypeScript checker:

```powershell
pnpm typecheck
```

Build the extension:

```powershell
pnpm build
```

## Load In Chrome

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select the generated `dist` directory.

## Usage

1. Open a supported page, for example `https://myhentaigallery.com/a/20942`, `https://kemono.cr/fanbox/user/24921130/post/11471817`, `https://somebody.fanbox.cc/posts/11929835`, `https://archiveofourown.org/works/18187196`, `https://www.hentai-foundry.com/stories/user/dotDelamora/70617/Taming-Guinevere`, or `https://www.fanfiction.net/s/12620462/1/Taboo`.
2. Click the extension icon.
3. Click `Choose Folder` and select a writable destination.
4. Click `Download Content`.
5. Wait for the popup to report the save summary.

## Notes

- Source code lives in `src/` and is bundled into `dist/` with `pnpm build`. Reload the unpacked extension in Chrome after rebuilding.
- The popup shows the picked folder name only. Browsers do not expose the full absolute path through the File System Access API.
- The extension remembers the last chosen folder separately for each supported site and asks Chrome to re-confirm access if needed.
- Downloads continue after individual file failures and report failures in the popup log.

## Manual Checks

- Popup opens without console errors after loading the unpacked extension.
- Unsupported pages keep the download action disabled.
- The collector ignores ad blocks because it only reads `div.comic-thumb img[src]`.
- Saved image files keep names like `001.webp`, `002.webp`, and so on.
- Saved story PDFs use names like `GrandLeviathan-Eagle_Cafe.pdf` and `dotDelamora-Taming_Guinevere.pdf`.
- fanfiction.net pages are detected, the collected chapter count matches the chapter selector, and the generated PDF opens with all chapters in order.
- fanfiction.net generated PDFs preserve basic bold and italic text.
- FANBOX creator subdomain pages are detected and image CDN anchors download into `<creator_name>/<post_title>-<post_id>/`.
