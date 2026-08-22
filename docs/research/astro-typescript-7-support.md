# Astro support for TypeScript 7

Research date: 2026-08-22

## Conclusion

No released version of `astro`, `@astrojs/check`, or `@astrojs/language-server`
can use the TypeScript 7 compiler API to type-check `.astro` files. Upgrading Astro from the
version in this repository to the latest Astro release does not remove that limit.

The current repository setup is the official workaround. `apps/showcase` exposes TypeScript 6
as `typescript` for `astro check`, and exposes TypeScript 7 under `@typescript/native` for the
`tsc` command. Keep the TypeScript 6 compatibility dependency for now.

## Released support

The latest packages published on the research date were
[`astro@7.2.4`](https://registry.npmjs.org/astro/7.2.4),
[`@astrojs/check@0.9.10`](https://registry.npmjs.org/@astrojs%2fcheck/0.9.10), and
[`@astrojs/language-server@2.16.14`](https://registry.npmjs.org/@astrojs%2flanguage-server/2.16.14).

| Package | TypeScript 7 status | Evidence |
| --- | --- | --- |
| `astro@7.2.4` | It can transpile TypeScript syntax, but this is not TypeScript 7 compiler-API support. | Astro documents that `astro build` transpiles with esbuild and does not type-check. Astro delegates type-checking to `astro check`. See the [Astro TypeScript guide](https://docs.astro.build/en/guides/typescript/#type-checking). |
| `@astrojs/check@0.9.10` | Unsupported. | Its published source declares `typescript: "^5.0.0 \|\| ^6.0.0"` as a peer dependency. See the [package manifest](https://github.com/withastro/astro/blob/99d3d3dbbfa4fd7b128a056337f1a719437a7377/packages/language-tools/astro-check/package.json#L46-L48). |
| `@astrojs/language-server@2.16.14` | Unsupported for `astro check`. | Version 2.16.12 added an explicit failure for TypeScript 7 because the native compiler lacks the required programmatic API. Later releases do not claim support. See the [language-server changelog](https://github.com/withastro/astro/blob/99d3d3dbbfa4fd7b128a056337f1a719437a7377/packages/language-tools/language-server/CHANGELOG.md#L15-L20) and the [runtime guard](https://github.com/withastro/astro/blob/99d3d3dbbfa4fd7b128a056337f1a719437a7377/packages/language-tools/language-server/src/check.ts#L199-L215). |

Astro issue
[#17268](https://github.com/withastro/astro/issues/17268) remains open, has no milestone, and is
marked as blocked upstream. An Astro maintainer states that TypeScript 7 does not yet support
Astro's embedded-language workflow and that Astro cannot fix the integration until TypeScript
provides the required API.

An open Astro PR,
[#17714](https://github.com/withastro/astro/pull/17714), fixes two misleading package-resolution
errors. The PR explicitly keeps TypeScript 7 outside `@astrojs/check`'s peer range because it
does not add diagnostics support. Even if Astro merges and releases that PR, it will only replace
the current install prompt or crash with an actionable error.

## Official workarounds

Microsoft recommends that Astro projects continue to use TypeScript 6 for embedded-language
workflows. The TypeScript 7 release post also documents the side-by-side package arrangement:

```json
{
  "devDependencies": {
    "@typescript/native": "npm:typescript@^7.0.2",
    "typescript": "npm:@typescript/typescript6@^6.0.2"
  }
}
```

The `@typescript/typescript6` package provides the TypeScript 6 programmatic API and a `tsc6`
binary. The aliased TypeScript 7 package supplies `tsc`. See Microsoft's
[side-by-side instructions](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-60).

This split has two useful boundaries:

- Run TypeScript 7 `tsc` against `.ts` and `.tsx` files.
- Let `astro check` resolve the package named `typescript` to TypeScript 6 so it can check
  `.astro` files.

For editor support, Microsoft tells Astro users to stay on TypeScript 6 for now. In VS Code,
run **Disable TypeScript 7 Language Server** when the TypeScript 7 extension interferes with
Astro support. See Microsoft's
[embedded-language guidance](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#typescript-and-embedded-languages).

## Roadmap and timing

The following items are facts:

- Microsoft says TypeScript 7.0 ships without a programmatic API and expects TypeScript 7.1 to
  ship a new, different API. See the
  [TypeScript 7 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-60).
- Microsoft's
  [TypeScript 7.1 iteration plan](https://github.com/microsoft/TypeScript/issues/63703)
  schedules the beta for 2026-09-09, the release candidate for 2026-10-20, and the stable release
  for 2026-11-10. The plan includes stabilizing the Content Mapper, Emit, and Language Service
  APIs.
- Microsoft merged the
  [Content Mapper API](https://github.com/microsoft/typescript-go/pull/4712) on 2026-08-19.
  Content mappers let tools transform embedded file formats into TypeScript and map diagnostics
  back to the original file. The TypeScript team names Astro as one of the consumers that needs
  this work in its
  [API roadmap](https://github.com/microsoft/typescript-go/issues/4830).
- Astro tracks its work in
  [roadmap discussion #1321](https://github.com/withastro/roadmap/discussions/1321). On
  2026-08-20, an Astro maintainer said that the TypeScript team was working on the missing support.
  The discussion does not give an Astro version or release date.
- As of the research date, `typescript@next` is a TypeScript 7.1 nightly and exposes APIs under
  `./unstable/*`. These APIs are not stable, and Astro's current source still uses the TypeScript 6
  API. See the
  [`typescript@7.1.0-dev.20260822.1` package metadata](https://registry.npmjs.org/typescript/7.1.0-dev.20260822.1).

The 2026-11-10 TypeScript 7.1 date is an upstream target, not an Astro support date. Astro still
needs to adopt the new API and publish compatible versions of its language tools. No primary
source gives a date when Astro can drop TypeScript 6.

## Recommendation for this repository

Do not remove TypeScript 6 yet.

`apps/showcase/package.json` already matches Microsoft's side-by-side example. Removing its
`typescript: "npm:@typescript/typescript6@^6.0.2"` alias would break `astro check`, and upgrading
Astro alone would not change that result.

The repository also has a separate TypeScript 6 dependency in `apps/pane-view`. The
`production-export-names.test.ts` test imports `@typescript/typescript6` directly for the legacy
compiler API. Full repository removal therefore has two independent gates:

1. Astro and its Volar dependency must release TypeScript 7 API support, and
   `@astrojs/check` must advertise TypeScript 7 compatibility.
2. The Pane View test must move to a supported TypeScript 7 API or another parser.

After both changes, remove the compatibility dependencies and verify at least
`pnpm --filter @latch-works/showcase typecheck`, the Pane View tests, `pnpm test`, and
`pnpm typecheck`.
