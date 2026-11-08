# Vendored anti-slop Oxlint plugin

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), path
`skills/install-anti-slop/assets/anti-slop`, commit `d2a9aea3b896ffcb291a85f2c1301aa2543ad8c8`
(2026-09-13). No later upstream commit changes that path as of `13909c9` (2026-10-13).

Every file in this directory except this record is byte-identical to that commit. To check it, run
`git archive d2a9aea skills/install-anti-slop/assets/anti-slop` in an upstream clone and `diff -r`
the result against this directory.

## Installed paths

- `index.ts` is the generic plugin. `.oxlintrc.json` registers it as `anti-slop`.
- `effect/` is the opt-in Effect plugin. It is not registered, because no workspace depends on
  `effect`.
- `vendor/eslint-stylistic/` holds the MIT-licensed padding-line rule behind
  `require-readable-spacing`. Keep its `LICENSE` and `UPSTREAM.md`.

## Local deviations

None in the rule source. Repository policy lives outside this directory:

- `.oxlintrc.json` enables every generic rule at `error`, plus the native companion
  `oxc/no-accumulating-spread`.
- `biome.json` excludes this directory, so Biome does not reformat it. The first install
  (commit `622fa18`, 2026-08-17) was Biome-formatted, which made this update a two-way review.
  That copy had no rule edits in Git history.
- `knip.json` ignores unused exports and types here.

## Update history

- 2026-08-17: first install, 15 generic rules, upstream revision not recorded.
- 2026-09-18: updated to `e6676e8`. Added `no-array-filter-map`, `no-reduce-accumulator-copy`, and
  `require-readable-spacing`. Upstream also changed 13 existing rules and 3 shared helpers, and
  added the Effect plugin. The updated existing rules report no new findings in this repository.
- 2026-11-09: updated to `d2a9aea`, a three-way merge from base `e6676e8`. The local copy matched
  the base, so the only change is upstream's: `require-readable-spacing` now keeps consecutive
  single-line `const`, `let`, `var`, and `using` declarations grouped at module scope too, and the
  vendored padding engine takes an optional table of caller-defined statement types. A binding
  with its own leading comment still needs a blank line before it. No rules were added, and the
  configuration did not change.

## Verifying rules

The repository does not typecheck or test this directory. After an update, run `pnpm lint:oxlint`
and lint a probe file that should fail, because an ignored directory is not evidence that a rule
works.
