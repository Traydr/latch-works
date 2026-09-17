# Build tooling for the Gather Box MV3 extension

Research date: 2026-09-18

## Conclusion

Use [WXT](https://wxt.dev) 0.21.x on Vite 8 if Gather Box adopts an extension framework. It is the
only candidate that is actively maintained, runs on Rolldown today, builds every content script and
injected script as its own IIFE, and exposes hooks for the manifest and the build output. A local
trial on 2026-09-18 built a Gather Box shaped extension with `wxt@0.21.4`, `vite@8.3.0`,
`rolldown@1.2.9` and `typescript@7.0.2` without changes to WXT.

The main trade-off: WXT replaces only the bundling and file-copy parts of
`apps/gather-box/scripts/build.mjs` (about 75 of its 440 lines). The manifest derivation from
`source-catalog.json`, the permission report, the size report, the content-isolation check and the
budgets are project rules. They survive as hook code under every tool. In exchange for a dev
server, browser launch, reload on change and `wxt zip`, WXT requires 13 entry files to be rewritten
around `defineBackground`, `defineContentScript` and `defineUnlistedScript`, moves the HTML files,
changes output paths, adds a small runtime wrapper to each script, and is still a 0.x project that
shipped a breaking minor on 2026-07-26. Because output paths and wrappers change, a before/after
artifact comparison is weak under WXT, and the manual smoke checklist carries the verification.

The Zod size problem does not need a framework. Replacing `esbuild` with the Rolldown JS API inside
the existing `build.mjs` fixes it and keeps every output path. Measured locally on a copy of the
real content scripts with Zod 4.6.1: the `x` collector is 55,210 B with esbuild 0.28.2 and 45,267 B
with Rolldown 1.2.9, under the 48,000 B budget. That swap is a sensible first change in either
case, because it gives a Rolldown-built baseline to compare a later WXT build against. Stop there
if the dev loop and packaging features are not wanted.

That swap has since been made in `apps/gather-box/scripts/build.mjs` with `rolldown@1.2.8` and
`transform.target: "chrome145"`. As built, the `x` collector is 42,715 B on Zod 4.6.1, the largest
collector, and the Zod pin in `apps/gather-box/package.json` is gone. The 45,267 B figure above
came from a trial config without that target.

Do not use Plasmo (no release since 2025-05-17, Parcel 2.9.3), `vite-plugin-web-extension` (its
README points to WXT as successor) or Bedframe (pins CRXJS 2.3.0, about 120 downloads a week).
CRXJS is maintained and supports Vite 8, but it lists injected IIFE scripts as web accessible to
all `http` and `https` pages and has an open Vite 8 service worker bug. Extension.js is maintained
and Rspack also avoids the Zod problem, but it is a single-maintainer project with about 6,800
weekly downloads, a static `manifest.json`, and fixed root-level folders.

## Constraints from Chrome

Chrome's own documentation constrains every option, but says little about build tools.

- All logic must ship in the package. "In Manifest V3, all of your extension's logic must be part
  of the extension package." CDN libraries and code fetched at runtime are not allowed. See
  [Improve extension security](https://developer.chrome.com/docs/extensions/develop/migrate/improve-security).
  Every candidate bundles dependencies into the output, so none conflicts with this.
- A service worker can use static `import` when the manifest sets `"type": "module"`. Dynamic
  `import()` "is not supported" in extension service workers. See
  [Extension service worker basics](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/basics).
  A bundler that leaves a real `import()` in the service worker graph breaks it. Gather Box's
  service worker graph has no dynamic import today (checked in `.build-meta/background.json`).
- Chrome's [content scripts guide](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
  and the [`content_scripts` manifest reference](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts)
  do not mention ES modules or `import` at all. The practical rule that a content script file must
  be self-contained comes from the tools: WXT tracks ESM content scripts as an open feature request
  that depends on an async `import()` loader and breaks `run_at`
  ([wxt#357](https://github.com/wxt-dev/wxt/issues/357)), and CRXJS implements the same loader.
- Rolldown rejects IIFE output for more than one entry: "UMD and IIFE are not supported for
  code-splitting builds" (measured locally, `rolldown@1.2.9`). Every Rollup or Rolldown based tool
  therefore runs one build per IIFE script. esbuild accepts many IIFE entries in one call, which is
  why `build.mjs` builds all 12 content scripts in one group.
- The Chrome pages above contain no guidance on bundlers, frameworks or build tooling.

## Bundler and the Zod size finding

[Vite 8](https://vite.dev/blog/announcing-vite8) was released on 2026-03-12 and "ships with
Rolldown as its single, unified, Rust-based bundler". The repository already pins `vite@8.3.0`.

Measured locally before this research: with Zod 4.6.1, `z.catch()` in `zod/mini` calls
`core.util.constantCatch(...)` through a nested namespace. esbuild 0.28.2 keeps the whole
`v4/core/util.js` namespace. Rolldown 1.2.8 resolves the call and drops the rest.

Measured locally during this research (`/tmp`, minified IIFE, bytes):

| Input | esbuild 0.28.2 | Rolldown 1.2.9 | Rspack 2.2.6 |
| --- | ---: | ---: | ---: |
| Small entry, `zod/mini` with `z.catch` | 24,666 | 14,978 | 14,553 |
| Same entry without `z.catch` | 13,714 | 14,085 | 13,799 |
| Real `x` collector, Zod 4.6.1 | 55,210 | 45,267 | not measured |
| Real `fanbox` collector, Zod 4.6.1 | 46,653 | 38,517 | not measured |
| Real `reddit` collector, Zod 4.6.1 | 33,971 | 35,075 | not measured |
| Real `x` collector, Zod 4.4.3 | 42,514 | 40,656 | not measured |
| Real `reddit` collector, Zod 4.4.3 | 30,685 | 31,294 | not measured |

Two points follow. Rolldown and Rspack both avoid the 10 kB penalty, so the WXT, CRXJS, plain
Rolldown and Extension.js options all solve it. Rolldown's minifier output is 0.5 to 1.1 kB larger
than esbuild's on collectors that do not use `z.catch`. With Rolldown and Zod 4.6.1 all 11
collectors stay under 48,000 B, and `x` has about 2.7 kB of headroom.

Twelve parallel Rolldown builds of the real content scripts took 25 ms. One esbuild call for the
same 12 took 33 ms. Build time does not separate the options at this size.

## Candidates

Registry data was read with `npm view` and `api.npmjs.org` on 2026-09-18. Download counts cover
2026-09-10 to 2026-09-16. Stars and issue counts come from the GitHub API on the same day.

### WXT

- Version and cadence: [`wxt@0.21.4`](https://registry.npmjs.org/wxt/0.21.4), published
  2026-08-11. 21 stable releases in the last 12 months. 535,836 weekly downloads. 10,519 stars. The
  default branch was last pushed on 2026-09-16. In the last 90 days the repository closed 48
  issues, opened 29 and merged 101 pull requests. 164 issues and 51 pull requests are open.
- Stability: WXT is pre-1.0. `0.21.1` (2026-07-26) was a breaking release: Node 22 minimum,
  `web-ext` moved to a peer dependency, zip template changes, and the default `globalName` for
  content and unlisted scripts changed to `false`. See the
  [changelog](https://github.com/wxt-dev/wxt/blob/a747b9c7ecd635c633ade13314552abfdb345bba/packages/wxt/CHANGELOG.md).
  The maintainer says ESM content scripts wait until after v1.0 and gives no date for v1.0
  ([wxt#357](https://github.com/wxt-dev/wxt/issues/357)).
- Bundler: Vite is a required peer, range `^6.3.4 || ^7.0.0 || ^8.0.0-0`
  ([package.json](https://github.com/wxt-dev/wxt/blob/a747b9c7ecd635c633ade13314552abfdb345bba/packages/wxt/package.json#L50)).
  Vite 8 support landed in `0.20.19` on 2026-03-14
  ([wxt#2195](https://github.com/wxt-dev/wxt/issues/2195)). The maintainer closed the Rolldown
  tracking issue on 2026-06-28 as done ([wxt#1677](https://github.com/wxt-dev/wxt/issues/1677)).
  `0.21.1` removed WXT's own `esbuild` dependency, and WXT's repository develops against Vite 8
  since `0.21.3`.
- Entrypoints: HTML pages and an ESM background are grouped into one multi-page Vite build.
  Content scripts and unlisted scripts are each an "individual" group
  ([group-entrypoints.ts](https://github.com/wxt-dev/wxt/blob/a747b9c7ecd635c633ade13314552abfdb345bba/packages/wxt/src/core/utils/building/group-entrypoints.ts#L16-L49)).
  Each individual group is a Vite library-mode build with `formats: ['iife']`
  ([vite builder](https://github.com/wxt-dev/wxt/blob/a747b9c7ecd635c633ade13314552abfdb345bba/packages/wxt/src/core/builders/vite/index.ts#L157-L163)).
  Groups are built one after another in a `for` loop with `await`, not in parallel
  ([build-entrypoints.ts](https://github.com/wxt-dev/wxt/blob/a747b9c7ecd635c633ade13314552abfdb345bba/packages/wxt/src/core/utils/building/build-entrypoints.ts#L20-L30)).
  Side panel and options pages are named entrypoint types. An offscreen document is an "unlisted
  page". A collector injected with `chrome.scripting.executeScript` is an "unlisted script".
- Measured locally: a trial with a module background, side panel, options and offscreen pages, one
  declared content script, 11 unlisted scripts that parse with `zod/mini` and `z.catch`, and a
  worker created with `new Worker(new URL(...), { type: "module" })` ran 13 build steps and
  finished in 295 ms. Each unlisted script was one IIFE file of 14.86 kB with no imports. The
  worker was emitted to `assets/worker-<hash>.js`. Because the ESM background shares a build with
  the pages, shared code (Zod here) moved into a chunk that `background.js` imports statically.
  Today Gather Box ships the service worker as one file.
- Wrappers: every script entry must default-export `defineBackground`, `defineContentScript` or
  `defineUnlistedScript`, and WXT imports the entry file in Node at build time to read its
  options, so "you cannot place any runtime code outside the `main` function"
  ([entrypoints.md](https://github.com/wxt-dev/wxt/blob/a747b9c7ecd635c633ade13314552abfdb345bba/docs/guide/essentials/entrypoints.md#L210),
  [entrypoint loaders](https://github.com/wxt-dev/wxt/blob/a747b9c7ecd635c633ade13314552abfdb345bba/docs/guide/essentials/config/entrypoint-loaders.md)).
  Measured locally: the unlisted-script wrapper adds about 0.45 kB. The declared content script
  wrapper (`ContentScriptContext`, location watcher) made an otherwise empty script 3,456 B.
  Gather Box's page-shortcuts script is 1,532 B against a 10,000 B budget.
- Manifest: there is no source `manifest.json`. The `manifest` config can be a function, and
  entrypoints contribute their own keys
  ([manifest.md](https://github.com/wxt-dev/wxt/blob/a747b9c7ecd635c633ade13314552abfdb345bba/docs/guide/essentials/config/manifest.md)).
  The `build:manifestGenerated` hook receives the final object for changes or validation. `version`
  comes from `package.json`. The trial passed `declarative_net_request`, `host_permissions` and
  `minimum_chrome_version` through unchanged and generated `background`, `side_panel`,
  `options_ui` and `content_scripts`.
- Directory convention: entrypoints are discovered by file name inside one directory, zero or one
  level deep. `srcDir`, `entrypointsDir` and `publicDir` are configurable
  ([project-structure.md](https://github.com/wxt-dev/wxt/blob/a747b9c7ecd635c633ade13314552abfdb345bba/docs/guide/essentials/project-structure.md#L90-L96)),
  the name patterns are not. The documented `entrypoints:found` hook adds entrypoints from any
  path. Measured locally: that hook registered `src/content/entries/x.ts`, and setting
  `entrypoint.outputDir` in `entrypoints:resolved` emitted it to `content/collectors/x.js`. The
  `outputDir` mutation works in 0.21.4 but is not documented as supported. Default output paths
  are `<name>.js` for unlisted scripts, `content-scripts/<name>.js` for content scripts,
  `background.js`, and `<name>.html`.
- Dev experience: `wxt` starts a Vite dev server and opens a browser with the extension loaded
  (`web-ext` peer, configurable through `webExt`). Page scripts get Vite HMR. A changed content
  script is reloaded on its own. A changed background or manifest reloads the whole extension
  ([detect-dev-changes.ts](https://github.com/wxt-dev/wxt/blob/a747b9c7ecd635c633ade13314552abfdb345bba/packages/wxt/src/core/utils/building/detect-dev-changes.ts#L11-L40)).
  WXT does not support Vite watch mode for builds.
- Packaging: `wxt zip` writes the extension zip and, for Firefox, a sources zip. `wxt submit`
  uploads to the Chrome Web Store, Edge and Firefox through `publish-browser-extension`
  ([publishing.md](https://github.com/wxt-dev/wxt/blob/a747b9c7ecd635c633ade13314552abfdb345bba/docs/guide/essentials/publishing.md)).
- Bundler metadata: the `build:done` hook receives every build step. Its typed chunk shape is only
  `fileName` and `moduleIds`
  ([types.ts](https://github.com/wxt-dev/wxt/blob/a747b9c7ecd635c633ade13314552abfdb345bba/packages/wxt/src/types.ts#L554-L564)),
  which is enough for the content-isolation check. Measured locally: a Vite plugin passed through
  the `vite` config option received the full Rolldown bundle in `generateBundle` for each step,
  with `code`, `modules`, `imports` and `dynamicImports`, which covers the chunk-graph
  measurements. `wxt build --analyze` can keep per-step `stats-*.json` files.
- Assets and wasm: files in `public/` are copied as they are. The docs describe copying a wasm file
  from `node_modules` with the `build:publicAssets` hook
  ([assets.md](https://github.com/wxt-dev/wxt/blob/a747b9c7ecd635c633ade13314552abfdb345bba/docs/guide/essentials/assets.md#L108)).
  The trial copied `public/rules/r.json` to `rules/r.json`.
- TypeScript 7: WXT's source does not import the `typescript` package. Its peer range is
  `>=5.4` and optional. `wxt prepare` writes `.wxt/tsconfig.json`. Measured locally: `tsc` 7.0.2
  ran against that file. The generated config sets `noUncheckedIndexedAccess` and
  `verbatimModuleSyntax`, which Gather Box's `tsconfig.json` does not. Gather Box can keep its own
  `tsconfig.json` and not extend the generated one, but then loses the `define*` globals unless
  it imports them explicitly (`imports: false` disables auto-imports).
- Sharp edges from the tracker:
  - [wxt#2599](https://github.com/wxt-dev/wxt/issues/2599) (open, 2026-08-25): in dev mode, page
    scripts are served from `localhost`, so worker URLs are cross-origin and `new Worker()` crashes
    the renderer in Chrome 148 and later. Gather Box creates its AVIF worker from the offscreen
    document. Building the worker as an unlisted script and loading it with
    `chrome.runtime.getURL` avoids the dev server URL. That changes the worker from a module
    worker to a classic IIFE worker.
  - [wxt#942](https://github.com/wxt-dev/wxt/issues/942) (open): a worker built as an unlisted
    script threw `_<name> is not defined`. A commenter on 2026-09-14 could not reproduce it on
    current versions. Not verified here.
  - [wxt#1611](https://github.com/wxt-dev/wxt/issues/1611) (open): `import.meta.env.ENTRYPOINT` is
    undefined in the side panel. Gather Box does not use it.
  - No open issue was found for offscreen documents, declarativeNetRequest rule files or pnpm
    workspaces. [wxt#1505](https://github.com/wxt-dev/wxt/issues/1505) concerns Firefox source
    zips in monorepos and does not apply to a Chrome-only extension.

### CRXJS (`@crxjs/vite-plugin`)

- Version and cadence: [`2.7.1`](https://registry.npmjs.org/@crxjs%2fvite-plugin/2.7.1), published
  2026-07-01. 8 stable releases in the last 12 months. 336,913 weekly downloads. 4,170 stars. 324
  commits since 2025-09-18. 15 issues closed and 26 pull requests merged in the last 90 days. 18
  issues are open.
- Bundler: Vite plugin, peer range `^3 || ^4 || ^5 || ^6 || ^7 || ^8`. It also depends on
  `rollup@2.80.0` for its dev file writer
  ([package.json](https://github.com/crxjs/chrome-extension-tools/blob/6718d1d1074cba46b8e8a34bff4bfe1e7d5524a8/packages/vite-plugin/package.json#L82)).
  Vite 8 support arrived in 2.5.0 and was patched again in 2.7.1
  ([changelog](https://github.com/crxjs/chrome-extension-tools/blob/6718d1d1074cba46b8e8a34bff4bfe1e7d5524a8/packages/vite-plugin/CHANGELOG.md)).
- Content scripts: the default is an ESM content script behind a generated loader, which needs
  `web_accessible_resources`. IIFE output is opt-in since 2.6.0 (2026-06-11) through a `.iife.ts`
  file name, an `?iife` import query, or `contentScripts.standaloneFiles`. Each IIFE script is a
  secondary Vite library build, run one after another
  ([plugin-contentScripts_iife.ts](https://github.com/crxjs/chrome-extension-tools/blob/6718d1d1074cba46b8e8a34bff4bfe1e7d5524a8/packages/vite-plugin/src/node/plugin-contentScripts_iife.ts#L36-L70)).
- Measured locally (`@crxjs/vite-plugin@2.7.1`, `vite@8.3.0`): two scripts imported from the
  service worker with `?script&iife` were each built to one 14,415 B IIFE file. CRXJS added both to
  `web_accessible_resources` with matches `http://*/*` and `https://*/*`, wrapped the service
  worker in `service-worker-loader.js`, and left two unreferenced intermediate chunks in
  `assets/`. Gather Box's manifest has no web accessible resources today, so this widens what web
  pages can probe unless the manifest is post-processed.
- Injected scripts must be imported in code (`?script`) or listed in the manifest. Gather Box reads
  `collectorEntry` paths from `source-catalog.json` at runtime, so that design would change.
- Manifest: `defineManifest` accepts an async function, and plugins can implement
  `transformCrxManifest` and `renderCrxManifest`
  ([types.ts](https://github.com/crxjs/chrome-extension-tools/blob/6718d1d1074cba46b8e8a34bff4bfe1e7d5524a8/packages/vite-plugin/src/node/types.ts#L58-L75)).
- No directory convention. Manifest paths point at source files. Extra pages such as an offscreen
  document go in `build.rollupOptions.input` ([docs](https://crxjs.dev/concepts/pages)).
- Dev: HMR for pages and content scripts. It does not launch a browser. No zip or publish command.
- Metadata: it is a normal Vite build, so any plugin's `generateBundle` sees the main bundle. The
  secondary IIFE builds run inside the plugin. Whether user plugins see those bundles is unknown.
- Sharp edge: [crxjs#1235](https://github.com/crxjs/chrome-extension-tools/issues/1235) (open,
  2026-08-26) reports that under Vite 8 a dynamic `import()` in the service worker graph is left in
  place and crashes the worker at startup. Gather Box's service worker has no dynamic import today.

### Extension.js (`extension`)

- Version and cadence: [`extension@4.1.21`](https://registry.npmjs.org/extension/4.1.21), published
  2026-09-17. 122 stable releases in the last 12 months, 8 of them in the last 12 days. 6,815
  weekly downloads. 5,160 stars. 6 open issues, no open pull requests, 89 merged in 90 days. One
  author has 2,713 of the commits. The next human contributor has 16.
- Bundler: Rspack, `@rspack/core@^2.2.3`
  ([package.json](https://github.com/extension-js/extension.js/blob/b8eb6ee5deeff17b24f217fb03b6e1774bbbdaaf/programs/develop/package.json#L96)).
  It does not use Vite or Rolldown. Rspack 2.2.6 also avoids the Zod penalty (table above).
- Entrypoints: `manifest.json` is the entry point and one Rspack compilation builds everything.
  Its default split-chunks rule only touches HTML pages, so "background, content scripts and
  injected scripts keep one file each"
  ([split-chunks.ts](https://github.com/extension-js/extension.js/blob/b8eb6ee5deeff17b24f217fb03b6e1774bbbdaaf/programs/develop/lib/split-chunks.ts#L55-L76)).
- Manifest: a static `manifest.json` file. The
  [configuration docs](https://extension.js.org/docs/features/extension-configuration) describe a
  `config` hook that patches the Rspack configuration and do not describe a manifest transform.
  Gather Box would keep a script that writes `manifest.json` before the build.
- Directory convention: `pages/`, `scripts/` and `public/` are special folders at the package
  root, not under `src/`. A file in `scripts/` is built only when its path is referenced somewhere
  in the project ([special folders](https://extension.js.org/docs/features/special-folders)).
- Content scripts must default-export a synchronous mount function
  ([content scripts](https://extension.js.org/docs/implementation-guide/content-scripts)).
- Dev: launches a browser with a managed profile, HMR for pages, reinjection for content scripts
  ([ARCHITECTURE.md](https://github.com/extension-js/extension.js/blob/b8eb6ee5deeff17b24f217fb03b6e1774bbbdaaf/docs/ARCHITECTURE.md)).
  `--zip` output exists. The same document lists performance budgets and WebAssembly as built-in
  plugin concerns.

### Plasmo

- [`plasmo@0.90.5`](https://registry.npmjs.org/plasmo/0.90.5), published 2025-05-17. No stable
  release in the last 12 months. The last commit on `main` has the same date. 13,151 stars. 556,691
  weekly downloads. 347 open issues, none closed and no pull request merged in the last 90 days.
- Bundler: Parcel, `@parcel/core@2.9.3`, and it depends on `typescript@5.8.2`
  ([package.json](https://github.com/PlasmoHQ/plasmo/blob/9369e2835de237caa60620b74b12ea3e2d4f3600/cli/plasmo/package.json#L42)).
  No Vite or Rolldown path exists.
- [plasmo#1345](https://github.com/PlasmoHQ/plasmo/issues/1345), "Is it ready to continue
  maintenance?", opened 2026-02-07, has no maintainer reply.
- Not evaluated further.

### `vite-plugin-web-extension`

- [`4.5.1`](https://registry.npmjs.org/vite-plugin-web-extension/4.5.1), published 2026-04-06. Two
  stable releases in the last 12 months. 43,539 weekly downloads. 843 stars. It lists
  `vite@^8.0.0` among its supported ranges.
- Its README says it "will soon be deprecated in favor of WXT, it's successor" and that new
  features and fixes go to WXT
  ([README](https://github.com/aklinker1/vite-plugin-web-extension/blob/8faf968989f30b4f37f8243407181beb82ac3f94/README.md)).
  Same author as WXT. Not evaluated further.

### Bedframe

- `@bedframe/cli@0.1.2`, published 2026-03-17, 126 weekly downloads. `@bedframe/core@0.1.0` depends
  on `@crxjs/vite-plugin` pinned to `2.3.0`, which predates CRXJS's Vite 8 and IIFE work. 583
  stars. Recent commits are dependency bot merges. It is a layer over CRXJS. Not evaluated
  further.

### Plain Vite 8 or Rolldown, no framework

- A single `vite.config.ts` cannot express this build. Vite builds one configuration per call, and
  Rolldown rejects multi-entry IIFE output, so 12 content scripts need 12 `build()` calls plus one
  for pages and one for the service worker. That is a build script again, and it is what WXT does
  internally.
- The smaller variant keeps `build.mjs` and replaces its three `esbuild` calls with Rolldown's JS
  API: one ESM build with code splitting for pages and the worker, one ESM build with
  `codeSplitting: false` for the service worker, and 12 parallel IIFE builds. Rolldown 1.2.9 is
  already in the lockfile through Vite 8.
- Measured locally: Rolldown returns each chunk with `fileName`, `code`, `modules`, `imports`,
  `dynamicImports` and `moduleIds`. That covers what the esbuild metafile gives `build.mjs` today.
  For the `x` collector, `modules` contained exactly one path under `/collectors/`, so the
  isolation check ports directly.
- No dev server, reload, browser launch or zip. Rolldown has a `watch` API, which would give
  rebuild on save. Reload stays manual.
- TypeScript: Rolldown transforms TypeScript with Oxc and does not type-check. `tsc --noEmit`
  stays a separate step, as it is today.

### Other tools

A registry search for extension build tools found nothing else with meaningful use. The next
entries were `rsbuild-plugin-web-extension` (150 weekly downloads) and
`@samrum/vite-plugin-web-extension` (2,961 weekly downloads, last release 2024-09-26, Vite 4 and 5
only).

## Comparison

| | WXT 0.21.4 | CRXJS 2.7.1 | Extension.js 4.1.21 | Rolldown in `build.mjs` |
| --- | --- | --- | --- | --- |
| Last release | 2026-08-11 | 2026-07-01 | 2026-09-17 | Rolldown 1.2.9, 2026-09-16 |
| Stable releases, 12 months | 21 | 8 | 122 | not applicable |
| Weekly downloads | 535,836 | 336,913 | 6,815 | not applicable |
| Bundler | Vite 6 to 8 (Rolldown on 8) | Vite 3 to 8, plus Rollup 2 in dev | Rspack 2 | Rolldown |
| Avoids the Zod `z.catch` penalty | yes, measured | yes, measured | yes, measured for Rspack alone | yes, measured on real collectors |
| IIFE script per file, no shared chunks | built in, the only mode | opt-in since 2.6.0 | built in | hand-written, 12 builds |
| Per-script builds | sequential | sequential | one compilation | parallel |
| Injected (unlisted) scripts | first-class entrypoint type | `?script&iife` import, made web accessible to all sites | `scripts/` folder | any path |
| Manifest from code | `manifest` function and hook | `defineManifest` function and plugin hooks | static file | existing code |
| Directory convention | yes, name patterns fixed, directory configurable, hook adds any path | none | yes, root-level special folders | none |
| Script wrapper required | yes, `define*` default export | no | yes, default-export function | no |
| Dev server and reload | yes, opens browser | yes, no browser launch | yes, opens browser | no |
| Zip and store upload | `wxt zip`, `wxt submit` | no | zip | no |
| Bundle metadata | `build:done` hook, or Vite plugin `generateBundle` | Vite plugin for main build, IIFE builds unknown | Rspack stats through `config` hook | build result object |
| Uses the TypeScript API | no | no | unknown | no |
| Pre-1.0 | yes | no | no | Rolldown is 1.x |

## What a WXT migration of Gather Box would involve

Parts of `build.mjs` that map to built-in WXT features:

- `verifyVersionAgreement`: goes away. WXT takes `version` from `package.json`, and
  `manifest.base.json` no longer carries one.
- The three esbuild groups: WXT's page group and per-script builds. `target: "chrome145"` moves to
  `vite.build.target`.
- `packagedFiles`: `rules/`, `assets/fonts/` and `assets/icons/` move into a `public/` directory
  (or `publicDir` points at a directory that holds them) and are copied unchanged, so
  `chrome.runtime.getURL` paths for fonts and rule files stay the same. The HTML and CSS files
  stop being copied files. They become Vite inputs, and their CSS is emitted under `assets/` with
  hashed names.
- `manifest.base.json`: its static keys move into the `manifest` function in `wxt.config.ts`.
  WXT generates `background`, `side_panel`, `options_ui` and `content_scripts`.
- `node scripts/clean.mjs`: `wxt clean`.
- Dev mode, browser launch and zip are new capabilities with no counterpart today.

Parts that must survive as hooks, a WXT module, or a post-build script:

- `generateManifest`: catalog validation (`validateHttpsMatch`, the collector-file existence
  check), `host_permissions`, and the permission ownership report. The `manifest` function can
  compute `host_permissions`. The page-shortcuts `matches` can come from the catalog, either
  inside `defineContentScript` (the entry file is imported in Node, and a JSON import works there)
  or in `build:manifestGenerated`. A final assertion in `build:manifestGenerated` should confirm
  that the generated manifest has no `web_accessible_resources` and only the expected content
  script.
- The avif wasm copy: a `build:publicAssets` hook entry with `relativeDest:
  "codecs/avif_enc.wasm"`, as in WXT's wasm guide.
- `verifyContentIsolation`: a `build:done` hook over `step.chunks[].moduleIds`.
- `createArtifactReport` and `enforceBudgets`: a `build:done` hook, or a Vite plugin
  `generateBundle` when the chunk import graph is needed (side panel eager JS, offscreen base JS
  without the story and media chunks). File sizes can be read from disk as today. The
  `.build-meta/*.json` metafile dumps have no direct equivalent. The summary and permission
  reports can be written as before.
- Registration of the 11 collectors. Either move the entry files into the entrypoints directory
  under WXT's naming rules, or keep `src/content/entries/*.ts` and register them from
  `source-catalog.json` in an `entrypoints:found` hook. Keeping `content/collectors/<key>.js` as
  the output path needs the undocumented `outputDir` mutation. Otherwise `collectorEntry` values
  in the catalog change to WXT's `<name>.js` paths.

Source changes WXT forces:

- `src/background/index.ts` has top-level listener registration. It must move inside
  `defineBackground({ type: "module", main() { ... } })`. Listener registration stays synchronous
  inside `main`, which MV3 requires. Any module in the background graph that touches `chrome.*` at
  import time runs against WXT's fake browser in Node during the build. Whether one does was not
  checked.
- The 11 collector entries and `page-shortcuts-entry.ts` each gain a `defineUnlistedScript` or
  `defineContentScript` wrapper. `active-tab.ts` ignores the `executeScript` return value and
  waits for a message, so the 0.21 `globalName: false` default is fine.
- `sidepanel/sidepanel.html`, `options/options.html` and `offscreen/offscreen.html` move next to
  their scripts as `<name>/index.html` with a `<script type="module">` that points at source.
- The AVIF worker is created from `chrome.runtime.getURL("workers/avif-encoder.js")` as a module
  worker that shares chunks with the pages. Under WXT it becomes either a Vite worker import
  (module worker, hashed path under `assets/`, exposed to wxt#2599 in dev mode) or an unlisted
  script (classic IIFE worker, fixed path, its own copy of the encoder glue). The "media
  conversion JS" budget measurement changes with that choice.
- The service worker is no longer one file when it shares modules with the pages. The "service
  worker JS" budget must then measure the import graph instead of one file.

What cannot be verified without the manual smoke test in `docs/runbooks/e2e.md`:

- That collectors still inject and answer after the path and wrapper changes (smoke step 2).
- That the offscreen document, its dynamic chunks, the AVIF worker and the wasm URL still resolve
  (step 4). This is the area with the most moving parts.
- That the File System Access flow on the options page and the side panel still works after the
  HTML files move and their CSS is processed by Vite (steps 1 to 3).
- That cancel still leaves no partial file (step 5).
- That the declarativeNetRequest rules still apply. The checklist has no explicit step for this. A
  pixiv original-image download exercises the Referer rule.
- Artifact comparison can still confirm three things mechanically: the generated manifest differs
  from today's only in paths, `host_permissions` and the page-shortcuts `matches` are identical,
  and every budget passes.

For the Rolldown swap inside `build.mjs`, artifact comparison is strong. File names stay the same,
the manifest is byte-identical, and only JS contents and hashed chunk names change. The smoke test
is still needed because a different bundler and minifier produce different code.

## Not established

- Chrome's documentation does not state that content scripts cannot use ES module imports. The
  constraint is inferred from how WXT and CRXJS work around it. No Chromium source or issue was
  read to confirm it.
- The size of the real Gather Box collectors under WXT was not measured. The 0.45 kB wrapper
  figure comes from a trial script. With `x` at 45,267 B under plain Rolldown, the estimate is
  about 45.7 kB against the 48,000 B budget.
- WXT build time with the real pages (`@libpdf/core`, `mediabunny`, the AVIF codec) was not
  measured. Only the trial with small inputs was timed.
- Whether any module in Gather Box's background graph fails when WXT imports it in Node.
- Whether wxt#942 (unlisted script used as a worker) is fixed in 0.21.4.
- Whether mutating `entrypoint.outputDir` in `entrypoints:resolved` is a supported use of WXT.
- WXT dev mode was not run. Reload behavior is taken from WXT's source comments and docs.
- Whether CRXJS exposes its secondary IIFE bundles to user plugins, and whether its
  `web_accessible_resources` entries for `?script&iife` files can be turned off by configuration.
- Whether Extension.js runs a type-aware step, how it behaves with TypeScript 7, and how it
  handles module workers and offscreen documents. Only its chunking rule, configuration docs and
  special folders were read.
- Plasmo's 556,691 weekly downloads are higher than WXT's even though it has had no release for 16
  months. The registry does not say why. Download counts are not evidence of maintenance.
- No primary source gives a WXT 1.0 date.
