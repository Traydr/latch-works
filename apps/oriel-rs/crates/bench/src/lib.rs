//! Plan 063's Phase 0 measurements, as small binaries over this library:
//!
//! - `scan-bench` walks an archive the way `glazier-core`'s `walkRoot` does and hashes it the way
//!   its hash pass does, to compare files/s and MB/s with the TypeScript engine;
//! - `avif-bench` (with `--features avif`) encodes stills through libavif at `media-format`'s
//!   archive settings, to compare size and time with the wasm encoder.
//!
//! None of it writes inside the archive it measures.

pub mod hash;
pub mod page_cache;
pub mod walk;

/// The median of a few measurements; the mean of the middle two for an even count.
pub fn median(values: &[f64]) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let middle = sorted.len() / 2;

    match sorted.len() {
        0 => f64::NAN,
        length if length % 2 == 1 => sorted[middle],
        _ => (sorted[middle - 1] + sorted[middle]) / 2.0,
    }
}
