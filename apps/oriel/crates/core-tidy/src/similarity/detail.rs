//! The detail print Spot variants compares, as `glazier-core/src/similarity/detail.ts` makes it.
//!
//! A detail print is a still as 64×64 grey: twice the fingerprint's side, so a changed face, an
//! outfit or a caption in another language still shows, where the 64-bit fingerprint calls the
//! pictures the same. The thresholds below were measured on the owner's decisions, so the
//! arithmetic keeps glazier-core's types: f64 sums, rounded to f32 where it stores a
//! `Float32Array`.

use std::path::Path;

use super::vips::{Vips, VipsError};

/// The print's side.
pub const DETAIL_SIZE: usize = 64;

/// Bumped when prints are made differently; older ones are made again.
pub const DETAIL_VERSION: u32 = 1;

/// Stills are decoded at four times the print's side and averaged down. Resized straight to 64,
/// a JPEG decoded at an eighth and its resized copy alias differently, and on the owner's copies
/// the print then called three in five of them variants.
const AVERAGED: usize = 4;

/// The side of the grey pixels a print is averaged from.
pub const DETAIL_DECODE_SIZE: usize = DETAIL_SIZE * AVERAGED;

/// Prints are compared in 4×4 blocks, a 16×16 grid.
const BLOCK: usize = 4;

const GRID: usize = DETAIL_SIZE / BLOCK;

/// Each print is scaled to zero mean and this spread, so a re-encode's shifted tones cancel out.
const SPREAD: f64 = 48.0;

/// How far the most changed block may stand above the typical one for two prints to still show
/// one picture. Measured on the owner's decisions: copies they removed stood under 4 in 95 of 100
/// pairs, and versions they kept together stood above it in 98 of 100.
const VARIANT_LOCAL: f64 = 4.0;

/// Two lossless files that match everywhere but one spot (closed eyes, a moved signature) have a
/// typical block difference of nothing, so a smaller standout already means a change.
const LOSSLESS_TYPICAL: f64 = 0.05;

const LOSSLESS_LOCAL: f64 = 1.0;

/// The print of a still from its 256×256 grey pixels: each 4×4 block's mean, rounded half up as
/// `Math.round` does. Returns `None` when `pixels` is not 256×256.
pub fn detail_from_grey(pixels: &[u8]) -> Option<Vec<u8>> {
    if pixels.len() != DETAIL_DECODE_SIZE * DETAIL_DECODE_SIZE {
        return None;
    }
    let mut print = vec![0u8; DETAIL_SIZE * DETAIL_SIZE];
    for row in 0..DETAIL_SIZE {
        for column in 0..DETAIL_SIZE {
            let mut sum = 0u32;
            for y in 0..AVERAGED {
                let start = (row * AVERAGED + y) * DETAIL_DECODE_SIZE + column * AVERAGED;
                sum += pixels[start..start + AVERAGED]
                    .iter()
                    .map(|&value| u32::from(value))
                    .sum::<u32>();
            }
            let count = (AVERAGED * AVERAGED) as u32;
            // A mean of bytes is at most 255, so it fits.
            print[row * DETAIL_SIZE + column] = ((sum + count / 2) / count) as u8;
        }
    }
    Some(print)
}

/// The detail print of a still file.
pub fn detail_of_still(vips: &Vips, path: &Path) -> Result<Vec<u8>, VipsError> {
    let pixels = vips.grey_pixels(path, DETAIL_DECODE_SIZE as u32, None)?;
    detail_from_grey(&pixels)
        .ok_or_else(|| VipsError("The grey pixels were the wrong size.".into()))
}

/// A print scaled for comparing; make it once per print, not once per pair.
pub fn normalize_detail(print: &[u8]) -> Vec<f32> {
    let length = print.len() as f64;
    let mut mean = 0.0;
    for &value in print {
        mean += f64::from(value);
    }
    mean /= length;

    let mut variance = 0.0;
    for &value in print {
        let offset = f64::from(value) - mean;
        // V8 computes `offset ** 2` as `offset * offset`.
        variance += offset * offset;
    }

    let deviation = (variance / length).sqrt();
    // `|| 1` in glazier-core: a flat print (or an empty one, NaN) is not scaled.
    let deviation = if deviation == 0.0 || deviation.is_nan() {
        1.0
    } else {
        deviation
    };

    print
        .iter()
        .map(|&value| ((f64::from(value) - mean) / deviation * SPREAD) as f32)
        .collect()
}

/// How two prints differ: the typical block, and how far the most changed one stands above it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DetailDifference {
    pub typical: f64,
    pub local: f64,
}

/// Compares two normalized prints block by block. Both must be 64×64.
pub fn detail_difference(left: &[f32], right: &[f32]) -> DetailDifference {
    let mut blocks = [0.0f32; GRID * GRID];
    for row in 0..GRID {
        for column in 0..GRID {
            let mut sum = 0.0f64;
            for y in 0..BLOCK {
                let start = (row * BLOCK + y) * DETAIL_SIZE + column * BLOCK;
                for x in 0..BLOCK {
                    sum += (f64::from(left[start + x]) - f64::from(right[start + x])).abs();
                }
            }
            blocks[row * GRID + column] = (sum / (BLOCK * BLOCK) as f64) as f32;
        }
    }
    blocks.sort_by(f32::total_cmp);

    let typical = f64::from(blocks[blocks.len() / 2]);
    DetailDifference {
        typical,
        local: f64::from(blocks[blocks.len() - 1]) - typical,
    }
}

/// Whether two similar stills are variants, different pictures that share most of their pixels
/// (another face or outfit, a caption's language), rather than copies of one picture, which
/// differ a little everywhere when one was resized or recompressed.
pub fn is_variant(left: &[f32], right: &[f32]) -> bool {
    let DetailDifference { typical, local } = detail_difference(left, right);
    local > VARIANT_LOCAL || (typical <= LOSSLESS_TYPICAL && local > LOSSLESS_LOCAL)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_print_rounds_each_block_mean_half_up() {
        let mut pixels = vec![0u8; DETAIL_DECODE_SIZE * DETAIL_DECODE_SIZE];
        // The first block sums to 8 over 16 pixels: a mean of 0.5, which rounds up.
        pixels[0] = 8;
        // The second block sums to 7: 0.4375, which rounds down.
        pixels[4] = 7;
        let print = detail_from_grey(&pixels).expect("a 256×256 input");
        assert_eq!(&print[..2], &[1, 0]);
    }

    /// A print with structure everywhere: a diagonal ramp.
    fn ramp() -> Vec<u8> {
        (0..DETAIL_SIZE * DETAIL_SIZE)
            .map(|index| ((index % DETAIL_SIZE) * 2 + (index / DETAIL_SIZE)) as u8)
            .collect()
    }

    fn variant(left: &[u8], right: &[u8]) -> bool {
        is_variant(&normalize_detail(left), &normalize_detail(right))
    }

    #[test]
    fn a_changed_spot_is_a_variant_and_a_change_everywhere_is_a_copy() {
        let ramp = ramp();
        assert!(!variant(&ramp, &ramp));
        // A re-encode's shifted and stretched tones cancel out.
        let toned: Vec<u8> = ramp.iter().map(|&value| value / 2 + 20).collect();
        assert!(!variant(&ramp, &toned));
        // A little noise everywhere, as recompression leaves, is still the same picture.
        let noisy: Vec<u8> = ramp
            .iter()
            .enumerate()
            .map(|(index, &value)| value.saturating_add((index % 3) as u8))
            .collect();
        assert!(!variant(&ramp, &noisy));
        // One block of 64 changed hard, as another face or a caption changes it, is another
        // picture.
        let mut patched = ramp.clone();
        for row in 8..16 {
            for column in 8..16 {
                patched[row * DETAIL_SIZE + column] = 255;
            }
        }
        assert!(variant(&ramp, &patched));
    }

    #[test]
    fn between_lossless_files_a_small_spot_is_enough() {
        let ramp = ramp();
        // One 4×4 block nudged: nothing else differs, so a standout past 1 already counts.
        let mut nudged = ramp.clone();
        for row in 0..4 {
            for column in 0..4 {
                nudged[row * DETAIL_SIZE + column] += 2;
            }
        }
        let difference = detail_difference(&normalize_detail(&ramp), &normalize_detail(&nudged));
        assert!(difference.local < VARIANT_LOCAL, "{difference:?}");
        assert!(difference.typical <= LOSSLESS_TYPICAL, "{difference:?}");
        assert!(variant(&ramp, &nudged));
        // The same nudge on a recompressed copy, which differs a little everywhere, is not.
        let lossy: Vec<u8> = nudged
            .iter()
            .enumerate()
            .map(|(index, &value)| value.saturating_add((index % 3) as u8))
            .collect();
        assert!(!variant(&ramp, &lossy));
    }

    #[test]
    fn a_flat_print_is_left_unscaled() {
        let flat = vec![9u8; DETAIL_SIZE * DETAIL_SIZE];
        assert!(normalize_detail(&flat).iter().all(|&value| value == 0.0));
    }
}
