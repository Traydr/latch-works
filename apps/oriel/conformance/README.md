# Conformance vectors

JSON files that pin rules Oriel's Rust crates share with the TypeScript packages, one set of
vectors per function. A TypeScript suite makes each file from the code it pins and fails when the
committed file differs; the Rust tests read the same files. After a deliberate change, rewrite the
files and port the change:

```sh
ORIEL_UPDATE_VECTORS=1 pnpm -r --filter "./packages/**" test
cd apps/oriel && cargo test
```

The shared harness (`tools/conformance`) writes the files as ASCII and formats them with Biome.
Rules only the TypeScript runs are pinned by Vitest snapshots beside their package, not here.

| Folder | Made by | Read by |
| --- | --- | --- |
| `lockstep-core/` | `packages/lockstep-core/src/conformance.test.ts`; `api-schema.json` by `packages/sync-protocol/src/api-schema.test.ts` | `core-sync` (`src/vectors/`; its API types are generated from `api-schema.json` at build time) |
| `media-domain/` | `packages/media-domain/src/conformance.test.ts` | `core-domain` |
| `media-format/` | `packages/media-format/src/conformance.test.ts` | `core-format` |

`lockstep-core/wire.json` holds the routes, the bodies a sync client posts, what it makes of sample
snapshot answers, and the protocol's waits and limits. Pane View's sync routes must accept every
body it lists, the Rust client posts the same bodies to the same routes, and Rust's fake Pane View
(`core-sync`'s `testing`) checks each request's shape against it.

`lockstep-core/prune.json` holds prune's safety check: which of a plan's deletes go ahead and which
are skipped because the file is back in the source folder under a spelling planning treats as the
same, and when a folder listing is recent enough that it must be read again.

## Frozen fixtures

Rules that only Oriel runs belong to the Rust code. No TypeScript makes these any more, an update
keeps their committed values, and they change together with the Rust tests that read them.

Whole files:

- `media-domain/browser-entries.json`, `media-domain/comics.json`
- `media-format/still-policy.json` (the plan for images on disk), `media-format/video-policy.json`
- `lockstep-core/secret-storage/` (files Electron Oriel wrote, which Sync still reads)

Top-level keys of files the TypeScript still makes:

- `media-domain/sort.json`: `hashString`, `sortMediaItems`
