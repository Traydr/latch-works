# Oriel RS, Phase 0: the ports

This page holds Phase 0's four port checks against the TypeScript packages: natural order,
fingerprints, the scan with SHA-256, and the AVIF encoder. Each port matches the TypeScript:
natural order on all but 19 Han pairs, which the owner accepted, and the fingerprints bit for bit.
The fingerprints match only through the libvips build sharp ships, not through the pure-Rust
`image` crates.

## Natural order matches but for 19 Han pairs

`packages/media-domain/src/conformance.test.ts` computes the vectors from the real `sort.ts` and
checks them against `apps/oriel-rs/conformance/media-domain/sort.json`. With
`ORIEL_RS_UPDATE_VECTORS=1` it rewrites them. `cargo test -p oriel-core-domain` checks Rust
against the same file. The corpus has 282 names in 200 equal classes, the name-then-path
tie-break, the FNV-1a hash over UTF-16 units, and every sort mode, random included with 8 seeds.

- 39,602 of 39,621 pairs agree. They include 64-bit and 254-digit runs, full-width and other digit
  scripts, NFC and NFD, Thai, Hangul jamo, emoji and ignorable characters.
- The 19 that differ are Han from different blocks (U+20000, U+3400, U+9FFF, U+F900 against
  common characters). Node's ICU orders all Han by radical and stroke ("unihan"). Chromium's and
  ICU4X's data order them by block, then code point ("implicithan"). Electron Oriel's main process
  and renderer both order the 19 as Rust does. Pane View's server and the Lockstep CLI run under
  Node, so they already disagree with Electron Oriel on these pairs. The Rust test pins the 19 as
  known differences, so a new difference or a vanished one fails.
- Rust collates with the root order. Electron Oriel follows the system locale, which on this Mac
  is English and collates by root too. A Lithuanian-first Mac would differ.
- ICU4X's compiled data adds 1.24 MB to the binary.

## Fingerprints match only through sharp's libvips

`crates/core-tidy` ports the 64-bit perceptual hash, the detail print, the comparisons, animation
frame sampling and video frames. Spot variants depends on both prints. The corpus is 37 synthetic
files (1.75 MB) in `apps/oriel-rs/conformance/fingerprints/`, which
`scripts/fingerprints/make-corpus.mts` rebuilds byte for byte.

| Pipeline | Stills exact (hash, pixels, detail print) |
|---|---|
| libvips 8.18.7, sharp's build, loaded at run time | 35 of 35, plus both animations, the video, 16 pairs and the probes |
| libvips 8.18.3 | 35 of 35 |
| libvips 8.17.3 | 34 of 35 (one CMYK detail print off by up to 3 levels; same hash) |
| `image` crates, written by hand | 13 of 33 hashes, 1 of 33 detail prints |

- Parity needs sharp's libvips release line. The binding is about 40 functions loaded from the
  dylib at run time, so nothing is needed at build time, and dynamic loading keeps to the LGPL.
- The tests pin sharp's exact build. Whether the app pins it too, or accepts any 8.18.x, is still
  open.
- sharp runs its steps in an order the JavaScript chain hides: resize before EXIF rotation, and
  16-bit images flattened onto 65,280. V8's `Math.cos` also differs from Rust's in 11 of the 256
  table entries, so the crate embeds V8's table.
- The `image` crates fail mostly on decoding, because libvips decodes JPEG and WebP already shrunk.

## The scan's walk and SHA-256 are faster in Rust

On the 19 GB fixture, medians of 3:

| | glazier-core | Rust, 4 threads | Rust, 16 threads |
|---|---:|---:|---:|
| Walk, 21,136 files | 70–93 ms | 23–36 ms | about the same |
| SHA-256 of every file, warm | 2.40 GB/s | 11.0 GB/s | 38 GB/s |
| SHA-256 of every file, pages dropped | 2.37 GB/s | 4.0 GB/s | 10.0 GB/s |

glazier-core's hash pass reads only files that share a size: 142 MB of 19 GB here, 0.11 s in
TypeScript and 0.04–0.07 s in Rust. Its whole engine scan takes 5.1–5.3 s, and 85 % of that is
reading media details through ffprobe. That is where the Rust scan's time will go.

## libavif in Rust gives the same quality in less time

20 fixture JPEGs, the same decoded pixels to both encoders, at `ARCHIVE_AVIF_OPTIONS`:

| | Size | Encode, median per still | SSIM / PSNR |
|---|---:|---:|---:|
| Wasm (libavif 1.0.1, aom 3.7.0) | 5.62 MB | 1,787 ms | 0.9767 / 45.30 dB |
| Rust, libavif 1.4.2 with aom 3.15.2, 1 thread | +0.15 % | 442 ms | equal |
| Rust, 8 threads | +0.4 % | 142 ms | equal |

libavif can express every setting. The `libavif` crate needs cmake, which this Mac lacks, and it
bundles an older libavif. The spike links Homebrew's libavif through a small C shim instead.
Which of the two the app uses is still open.

## Run the checks again

Run these from `apps/oriel-rs`:

- `pnpm oriel-rs:check` (from the repository root): `cargo fmt --check`, clippy with
  `-D warnings`, and the tests. Phase 0 ended with 53 tests.
- Fingerprints: `cargo run -p oriel-core-tidy --example fingerprint_parity`.
- Scan and AVIF: `cargo build --release -p oriel-bench` (AVIF needs `cargo run -p xtask -- vendor` first), then `scan-bench` and
  `avif-bench`. The TypeScript side is `scripts/fixture/bench-glazier.mts`.
