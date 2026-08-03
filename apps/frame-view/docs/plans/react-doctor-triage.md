# React Doctor zero-finding cleanup

## Baseline

Command:

```sh
pnpx react-doctor@latest apps/frame-view --yes --verbose --no-color --blocking warning --no-score
```

React Doctor 0.9.3 reported 44 findings across 21 files: 9 errors and 35 warnings.

## Triage

Confidence describes the classification, not the implementation risk. Every finding will be removed
from the final scan; false positives are addressed at their source instead of suppressed.

| # | Count | Rule and location | Classification | Resolution |
| --- | ---: | --- | --- | --- |
| 1 | 1 | `insecure-crypto-risk` in `.vite/renderer/main_window/assets/index-*.js` | False positive, high | The match is React DOM's internal `Math.random()` marker in ignored generated output. Remove the stale build output from the scan workspace; clean checkouts do not contain it. |
| 2 | 1 | `unused-dependency` for `scheduler` | True positive, high | Remove the unused direct dependency and update both Frame View lockfile importers. React keeps its own transitive dependency. |
| 3 | 1 | `require-pnpm-hardening`: missing `minimumReleaseAge` | True positive, high | Add the recommended seven-day release-age gate to Frame View's standalone workspace config. |
| 4 | 1 | `require-pnpm-hardening`: missing `trustPolicy` | True positive, high | Require `no-downgrade` trust signals for packages published within the last year while retaining pnpm's documented legacy-package cutoff for older unsigned releases. |
| 5 | 1 | `require-pnpm-hardening`: `blockExoticSubdeps: false` | True positive, high | Enable exotic transitive dependency blocking and redirect Electron Forge's pinned GitHub `@electron/node-gyp` tarball to the byte-equivalent registry release `10.2.0-electron.2`. |
| 6 | 1 | `js-combine-iterations` in `CatalogRuntime.ts` | True positive, high | Normalize and validate excluded paths in one loop. |
| 7 | 1 | `async-await-in-loop` in `mediaIndexService.ts` | True positive, medium | Start the independent synchronous-proxy upserts together and await them as one transaction batch. |
| 8 | 1 | `js-combine-iterations` in `registerIpc.ts` | True positive, high | Normalize and validate excluded paths in one loop. |
| 9 | 1 | `js-combine-iterations` in `thumbnailService.ts` | True positive, high | Build deletion tasks in one loop before awaiting them. |
| 10 | 1 | `no-giant-component` in `App.tsx` | True positive, high | Extract app overlay rendering and layout-prop orchestration behind focused seams. |
| 11 | 1 | `no-adjust-state-on-prop-change` in `ComicReader.tsx` | True positive, high | Key the reader by comic identity so React owns its state lifetime. |
| 12 | 1 | `no-reset-all-state-on-prop-change` in `ComicReader.tsx` | True positive, high | Remove the manual reset effect after keying the reader. |
| 13 | 1 | `prefer-html-dialog` in `ComicReader.tsx` | True positive, high | Use a native modal dialog and handle its cancel event. |
| 14 | 1 | `no-loading-flag-reset-outside-finally` in `FolderGridOverlay.tsx` | True positive, high | Reset the active request's loading state in `finally`, including rejection paths. |
| 15 | 1 | `no-reset-all-state-on-prop-change` in `SettingsDrawer.tsx` | True positive, high | Mount the drawer only while open so unmounting resets local state. |
| 16 | 1 | `no-adjust-state-on-prop-change` in `SettingsDrawer.tsx` | True positive, high | Remove the prop-driven reset effect and `isOpen` state mirror. |
| 17 | 1 | `no-giant-component` in `ViewerModal.tsx` | True positive, high | Extract video controls and keyboard behavior into focused modules. |
| 18 | 4 | `no-adjust-state-on-prop-change` in `ViewerModal.tsx` | True positive, high | Key the viewer by media identity and remove the four manual state resets. |
| 19 | 2 | `prefer-use-effect-event` in `ViewerModal.tsx` | True positive, high | Use React 19.2 Effect Events for the latest close and queued-step behavior without re-subscribing global listeners. |
| 20 | 1 | `prefer-html-dialog` in `ViewerModal.tsx` | True positive, high | Use a native modal dialog and preserve fullscreen behavior on the dialog element. |
| 21 | 1 | `control-has-associated-label` in `ViewerModal.tsx` | True positive, high | Give the seek slider an explicit accessible label. |
| 22 | 1 | `only-export-components` in `SettingsTabNav.tsx` | True positive, high | Move tab constants and types to a non-component module. |
| 23 | 9 | `no-ref-current-in-render` in `useAppBootstrap.ts` | True positive, high | Replace render-time callback-ref mutation with React 19.2 Effect Events. |
| 24 | 1 | `rerender-lazy-ref-init` in `useSettingsActions.ts` | True positive, high | Create the resolved promise only when the first queued update is scheduled. |
| 25 | 2 | `rerender-lazy-ref-init` in `useVideoMetadataQueue.ts` | True positive, high | Lazily create the stable mutable sets with state initializers. |
| 26 | 1 | `no-pass-data-to-parent` in `GalleryGrid.tsx` | False positive, high | The callback submits visible videos to an idempotent async work queue; expose that queue through context instead of a parent callback. |
| 27 | 1 | `no-prop-callback-in-effect` in `GalleryGrid.tsx` | False positive, high | Remove the prop chain by consuming the shared metadata queue directly. |
| 28 | 1 | `no-many-boolean-props` in `GalleryHeader.tsx` | True positive, high | Group folder navigation capabilities and use a status variant instead of four independent flags. |
| 29 | 1 | `no-usememo-simple-expression` in `useVirtualGridMetrics.ts` | True positive, high | Calculate the row stride directly. |
| 30 | 1 | `js-tosorted-immutable` in `browserEntries.ts` | True positive, high | Use `toSorted()` for the immutable folder sort. |
| 31 | 1 | `zod-v4-no-deprecated-schema-apis` in `contracts.ts` | True positive, high | Replace `.object(...).strict()` with the Zod 4 `strictObject` factory. |

## Verification gates

- React Doctor full scan: zero errors and zero warnings with warning-level blocking.
- Frame View lint, typecheck, and tests.
- Focused renderer tests for keyed modal/drawer lifecycles and accessibility behavior.
- Manual desktop smoke check: open a folder, browse items, open/step/close the viewer, open/close a
  comic, use video controls, and open/close each settings tab.
