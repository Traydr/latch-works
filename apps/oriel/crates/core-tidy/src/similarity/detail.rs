//! What Spot variants compares, measured on the owner's decisions (plan 061): a detail print of
//! each still, kept in the catalog, and a closer look at the pairs the prints call copies.
//!
//! A detail print is a still as 64×64 grey: twice the fingerprint's side, so a changed face, an
//! outfit or a caption in another language still shows, where the 64-bit fingerprint calls the
//! pictures the same. A closer look holds the still at 512×512 with its colour, too large to keep
//! for every still, so it is made only when a pair needs it and only its answer is kept.

use std::path::Path;

use oriel_vips::{Vips, VipsError};

/// The print's side.
pub const DETAIL_SIZE: usize = 64;

/// Bumped when prints or closer looks are made differently; older ones are made again.
pub const DETAIL_VERSION: u32 = 2;

/// The side of the grey pixels a closer look compares.
pub const LOOK_SIZE: usize = 512;

/// A print's pixels are means of this many of a look's on a side.
const AVERAGED: usize = LOOK_SIZE / DETAIL_SIZE;

/// Prints are compared in 4×4 blocks, a 16×16 grid.
const BLOCK: usize = 4;

const GRID: usize = DETAIL_SIZE / BLOCK;

/// Each print is scaled to zero mean and this spread, so a re-encode's shifted tones cancel out.
const SPREAD: f64 = 48.0;

/// How far the most changed block may stand above the typical one for two prints to still show
/// one picture. A closer look catches what stands under it between files of one size, so this
/// favours copies: past 5, more of them stayed copies and no more versions were lost.
const VARIANT_LOCAL: f64 = 5.0;

/// A closer look compares grey in blocks of this many pixels on a side, about 0.006% of the
/// picture.
const SPOT_BLOCK: usize = 4;

/// Two files of one size match when at least this share of their pixels is within a grey level.
/// Versions exported together do, since the encoder treats what they share alike; a re-encode
/// that sharpens or shifts tones does not.
const MATCHING_SHARE: f64 = 0.8;

const MATCHING_LEVELS: f32 = 1.0;

/// How far a matching pair's most changed block may stray from the other picture's nearby pixels
/// for them to still be one picture.
const MATCHING_SPOT: f32 = 4.0;

/// A spot this far off is another picture even when the files do not match elsewhere: no
/// re-encode of the owner's stills went past 16, even sharpened.
const ANY_SPOT: f32 = 20.0;

/// Colour is compared in blocks of this many pixels on a side, a 32×32 grid: coarse enough that
/// recompression's blurred colour cancels out.
const COLOUR_BLOCK: usize = 16;

const COLOUR_GRID: usize = LOOK_SIZE / COLOUR_BLOCK;

/// How far one colour block may move for two files to still be one picture; a recoloured area
/// (hair, skin) can leave grey alone. Generated copies stayed under it, resized ones too.
const COLOUR_SPOT: f32 = 12.0;

/// A still as a closer look holds it. A still is always read whole and averaged down, whatever
/// its format: resized by the decoder, a JPEG decoded at an eighth and an AVIF of the same picture
/// alias differently, and on generated copies the print then called one in nine of them variants.
#[derive(Clone, Debug, PartialEq)]
pub struct StillLook {
    width: u32,
    height: u32,
    /// `LOOK_SIZE`² grey levels.
    grey: Vec<f32>,
    /// Blue and red difference per colour block.
    colour: [Vec<f32>; 2],
}

/// A cell's share of the source pixels it overlaps: the first pixel's index, then each one's weight,
/// summing to one. Rounding a cell's edges to whole pixels would alias a still only a little larger
/// than a look, which on generated copies called one in eight of those a third the size variants.
fn cell_weights(cell: usize, cells: usize, length: usize) -> (usize, Vec<f32>) {
    let per_cell = length as f64 / cells as f64;
    let (start, end) = (cell as f64 * per_cell, (cell + 1) as f64 * per_cell);
    let first = start as usize;
    let last = (end.ceil() as usize).min(length);
    let weights = (first..last)
        .map(|pixel| {
            let overlap = end.min((pixel + 1) as f64) - start.max(pixel as f64);
            (overlap / per_cell) as f32
        })
        .collect();
    (first, weights)
}

impl StillLook {
    /// Averages 8-bit RGBA, rows top to bottom, laying transparency on white as prints always
    /// have. Returns `None` when `rgba` is not `width`×`height` of them.
    pub fn from_rgba(width: u32, height: u32, rgba: &[u8]) -> Option<StillLook> {
        let (columns, rows) = (width as usize, height as usize);
        if columns == 0 || rows == 0 || rgba.len() != columns * rows * 4 {
            return None;
        }
        let across: Vec<_> = (0..LOOK_SIZE)
            .map(|cell| cell_weights(cell, LOOK_SIZE, columns))
            .collect();
        let mut laid = vec![[0.0f32; 3]; columns];
        let mut grey = vec![0.0f32; LOOK_SIZE * LOOK_SIZE];
        let mut colour = [
            vec![0.0f32; COLOUR_GRID * COLOUR_GRID],
            vec![0.0f32; COLOUR_GRID * COLOUR_GRID],
        ];
        let mut means = vec![[0.0f32; 3]; LOOK_SIZE];
        for cell_y in 0..LOOK_SIZE {
            means.fill([0.0; 3]);
            let (first_row, row_weights) = cell_weights(cell_y, LOOK_SIZE, rows);
            for (offset, &row_weight) in row_weights.iter().enumerate() {
                let row = first_row + offset;
                let pixels = &rgba[row * columns * 4..(row + 1) * columns * 4];
                for (pixel, out) in pixels.as_chunks::<4>().0.iter().zip(&mut laid) {
                    let alpha = f32::from(pixel[3]) / 255.0;
                    for (channel, value) in out.iter_mut().enumerate() {
                        *value = f32::from(pixel[channel]) * alpha + 255.0 * (1.0 - alpha);
                    }
                }
                for (mean, (first, weights)) in means.iter_mut().zip(&across) {
                    for (pixel, &weight) in laid[*first..].iter().zip(weights) {
                        for (channel, value) in mean.iter_mut().enumerate() {
                            *value += pixel[channel] * weight * row_weight;
                        }
                    }
                }
            }
            for (cell_x, &[red, green, blue]) in means.iter().enumerate() {
                grey[cell_y * LOOK_SIZE + cell_x] = 0.299 * red + 0.587 * green + 0.114 * blue;
                let block = (cell_y / COLOUR_BLOCK) * COLOUR_GRID + cell_x / COLOUR_BLOCK;
                colour[0][block] += -0.169 * red - 0.331 * green + 0.5 * blue;
                colour[1][block] += 0.5 * red - 0.419 * green - 0.081 * blue;
            }
        }
        for channel in &mut colour {
            for value in channel.iter_mut() {
                *value /= (COLOUR_BLOCK * COLOUR_BLOCK) as f32;
            }
        }
        Some(StillLook {
            width,
            height,
            grey,
            colour,
        })
    }

    /// The still's detail print: each print pixel's mean of the look's grey, rounded half up.
    pub fn print(&self) -> Vec<u8> {
        let mut print = vec![0u8; DETAIL_SIZE * DETAIL_SIZE];
        for row in 0..DETAIL_SIZE {
            for column in 0..DETAIL_SIZE {
                let mut sum = 0.0;
                for y in 0..AVERAGED {
                    let start = (row * AVERAGED + y) * LOOK_SIZE + column * AVERAGED;
                    sum += self.grey[start..start + AVERAGED]
                        .iter()
                        .map(|&value| f64::from(value))
                        .sum::<f64>();
                }
                let mean = sum / (AVERAGED * AVERAGED) as f64;
                // A mean of bytes is at most 255, so it fits.
                print[row * DETAIL_SIZE + column] = (mean + 0.5) as u8;
            }
        }
        print
    }
}

/// A still file as a closer look holds it, read through libvips' own loaders. An answer of "copy"
/// can lead to a file's removal, and the hardware route reads damaged files that these refuse.
pub fn look_at_still(vips: &Vips, path: &Path) -> Result<StillLook, VipsError> {
    let (width, height, rgba) = vips.rgba_pixels_through_libvips(path)?;
    StillLook::from_rgba(width, height, &rgba)
        .ok_or_else(|| VipsError("The pixels were the wrong size.".into()))
}

/// How far `left` strays from what `right` holds nearby, pixel by pixel: nothing while it stays
/// within the range of the 3×3 pixels around it, which is all a shift of an edge or a resize
/// leaves.
fn outside_neighbours(left: &[f32], right: &[f32], strays: &mut [f32]) {
    for y in 0..LOOK_SIZE {
        for x in 0..LOOK_SIZE {
            let (mut low, mut high) = (f32::MAX, f32::MIN);
            for row in y.saturating_sub(1)..(y + 2).min(LOOK_SIZE) {
                let columns = x.saturating_sub(1)..(x + 2).min(LOOK_SIZE);
                for &value in &right[row * LOOK_SIZE + columns.start..row * LOOK_SIZE + columns.end]
                {
                    low = low.min(value);
                    high = high.max(value);
                }
            }
            let value = left[y * LOOK_SIZE + x];
            let stray = (value - high).max(low - value).max(0.0);
            let at = &mut strays[y * LOOK_SIZE + x];
            *at = at.max(stray);
        }
    }
}

/// A look's grey scaled like a print's.
fn scaled(grey: &[f32]) -> Vec<f32> {
    let length = grey.len() as f64;
    let mean = grey.iter().map(|&value| f64::from(value)).sum::<f64>() / length;
    let variance = grey
        .iter()
        .map(|&value| (f64::from(value) - mean).powi(2))
        .sum::<f64>()
        / length;
    let deviation = if variance > 0.0 { variance.sqrt() } else { 1.0 };
    grey.iter()
        .map(|&value| ((f64::from(value) - mean) / deviation * SPREAD) as f32)
        .collect()
}

/// The mean of the most changed `SPOT_BLOCK`-sided block in grey, in a print's scale.
fn largest_spot(left: &StillLook, right: &StillLook) -> f32 {
    let (left, right) = (scaled(&left.grey), scaled(&right.grey));
    let mut strays = vec![0.0f32; LOOK_SIZE * LOOK_SIZE];
    outside_neighbours(&left, &right, &mut strays);
    outside_neighbours(&right, &left, &mut strays);
    let grid = LOOK_SIZE / SPOT_BLOCK;
    let mut blocks = vec![0.0f32; grid * grid];
    for y in 0..LOOK_SIZE {
        for x in 0..LOOK_SIZE {
            blocks[(y / SPOT_BLOCK) * grid + x / SPOT_BLOCK] += strays[y * LOOK_SIZE + x];
        }
    }
    let largest = blocks.into_iter().fold(0.0, f32::max);
    largest / (SPOT_BLOCK * SPOT_BLOCK) as f32
}

/// The share of two looks' pixels within a grey level of each other.
fn matching_share(left: &StillLook, right: &StillLook) -> f64 {
    let matching = left
        .grey
        .iter()
        .zip(&right.grey)
        .filter(|(left, right)| (*left - *right).abs() <= MATCHING_LEVELS)
        .count();
    matching as f64 / left.grey.len() as f64
}

/// How far the most moved colour block moved.
fn largest_colour_shift(left: &StillLook, right: &StillLook) -> f32 {
    left.colour
        .iter()
        .zip(&right.colour)
        .flat_map(|(left, right)| left.iter().zip(right))
        .map(|(left, right)| (left - right).abs())
        .fold(0.0, f32::max)
}

/// What a closer look measures of two stills, each against its threshold below.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LookMeasures {
    pub same_size: bool,
    pub colour_shift: f32,
    pub spot: f32,
    pub matching: f64,
}

/// Measures two looks. Costs a few milliseconds, nearly all of it in the spot.
pub fn look_measures(left: &StillLook, right: &StillLook) -> LookMeasures {
    LookMeasures {
        same_size: (left.width, left.height) == (right.width, right.height),
        colour_shift: largest_colour_shift(left, right),
        spot: largest_spot(left, right),
        matching: matching_share(left, right),
    }
}

/// Whether a closer look shows two stills the prints call copies to be variants: a colour moved
/// in one area, or, between files of one size, a spot of grey no re-encode would change. A resized
/// copy can differ from its original by more than a small changed spot, so between files of
/// different sizes only colour counts. In doubt the thresholds lean to variants: one wrongly
/// removed risks losing a picture, while a copy wrongly kept costs only its bytes.
pub fn look_shows_variant(left: &StillLook, right: &StillLook) -> bool {
    let measures = look_measures(left, right);
    measures.colour_shift > COLOUR_SPOT
        || (measures.same_size
            && (measures.spot > ANY_SPOT
                || (measures.spot > MATCHING_SPOT && measures.matching >= MATCHING_SHARE)))
}

/// The detail print of a still file.
pub fn detail_of_still(vips: &Vips, path: &Path) -> Result<Vec<u8>, VipsError> {
    let (width, height, rgba) = vips.rgba_pixels(path)?;
    let look = StillLook::from_rgba(width, height, &rgba)
        .ok_or_else(|| VipsError("The pixels were the wrong size.".into()))?;
    Ok(look.print())
}

/// The bits the typical sample frame's fingerprint may differ by between two videos of one size
/// and length, whose frames line up, for them still to be one piece of footage. Re-encodes of the
/// owner's videos at Shrink's settings stayed at 0 and those of drawn test clips at 4, while
/// copies at another frame rate or a frame's trim rarely passed it.
const FRAME_BITS: u32 = 4;

/// Whether the frames of two videos of one size and length show variants, by the bits between
/// each pair of sample frames: another cut or overlay moves most of them, a re-encode next to
/// none. Videos that differ in size or length do not line up, so this says nothing about them.
pub fn frames_show_variant(distances: &[u32]) -> bool {
    let mut sorted = distances.to_vec();
    sorted.sort_unstable();
    sorted
        .get(sorted.len() / 2)
        .is_some_and(|&typical| typical > FRAME_BITS)
}

/// A print scaled for comparing; make it once per print, not once per pair.
///
/// A set's rebuild scales every print of the catalog, so this counts them once by value. The sums
/// stay whole numbers, so the mean and spread are the very floats Electron Oriel's running sums
/// gave: a print is 4096 bytes, so scaled by its length each offset fits 20 bits, its square 40
/// and their sum 52, which a double holds exactly at every step in either order.
pub fn normalize_detail(print: &[u8]) -> Vec<f32> {
    let length = print.len() as i64;
    let mut counts = [0i64; 256];
    for &value in print {
        counts[usize::from(value)] += 1;
    }
    let values = 0..256i64;
    let total: i64 = values
        .clone()
        .map(|value| value * counts[value as usize])
        .sum();
    let mean = total as f64 / length as f64;
    let squares: i64 = values
        .map(|value| (value * length - total).pow(2) * counts[value as usize])
        .sum();
    // `length` is a power of two at every print's size, so these divisions are exact too.
    let variance = squares as f64 / (length * length) as f64;

    let deviation = (variance / length as f64).sqrt();
    // A flat print (or an empty one, NaN) is not scaled.
    let deviation = if deviation == 0.0 || deviation.is_nan() {
        1.0
    } else {
        deviation
    };

    let scaled: [f32; 256] =
        std::array::from_fn(|value| ((value as f64 - mean) / deviation * SPREAD) as f32);
    print
        .iter()
        .map(|&value| scaled[usize::from(value)])
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
    // The middle block and the largest, without sorting the rest: every pair of every set comes
    // through here as a set's rebuild runs.
    let (_, &mut typical, above) = blocks.select_nth_unstable_by(GRID * GRID / 2, f32::total_cmp);
    let largest = above.iter().copied().fold(typical, f32::max);
    let typical = f64::from(typical);
    DetailDifference {
        typical,
        local: f64::from(largest) - typical,
    }
}

/// Whether two prints show variants, different pictures that share most of their pixels (another
/// face or outfit, a caption's language), rather than copies of one picture, which differ a little
/// everywhere when one was resized or recompressed. Prints that call a pair copies are not the
/// last word: see [`look_shows_variant`].
pub fn is_variant(left: &[f32], right: &[f32]) -> bool {
    detail_difference(left, right).local > VARIANT_LOCAL
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A flat grey look of one size, with room for a patch.
    fn rgba(width: u32, height: u32, paint: impl Fn(u32, u32) -> [u8; 4]) -> Vec<u8> {
        let mut pixels = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height {
            for x in 0..width {
                pixels.extend_from_slice(&paint(x, y));
            }
        }
        pixels
    }

    /// Structure everywhere, so a print's scale is about that of a picture.
    fn drawing(x: u32, y: u32) -> [u8; 4] {
        let value = ((x / 32 + y / 32) % 2 * 120 + 60) as u8;
        [value, value, value, 255]
    }

    #[test]
    fn a_print_averages_the_whole_still_and_lays_transparency_on_white() {
        let half = rgba(1024, 1024, |x, _| {
            if x % 2 == 0 {
                [10, 10, 10, 255]
            } else {
                [20, 20, 20, 255]
            }
        });
        let look = StillLook::from_rgba(1024, 1024, &half).expect("the pixels of a still");
        // Each pixel of the print is the mean of both, 15, however fine the stripes are.
        assert!(look.print().iter().all(|&value| value == 15));
        let clear = rgba(64, 64, |_, _| [0, 0, 0, 0]);
        let look = StillLook::from_rgba(64, 64, &clear).expect("a small still repeats its pixels");
        assert!(look.print().iter().all(|&value| value == 255));
        assert_eq!(StillLook::from_rgba(2, 2, &[0; 3]), None);
    }

    #[test]
    fn a_closer_look_finds_a_small_spot_a_print_misses_between_files_of_one_size() {
        let plain = rgba(2048, 2048, drawing);
        let look = StillLook::from_rgba(2048, 2048, &plain).expect("a still");
        // A 40-pixel patch of 2048: a fiftieth of the side, like a closed eye.
        let patched = rgba(2048, 2048, |x, y| {
            if (1000..1040).contains(&x) && (1000..1040).contains(&y) {
                [250, 250, 250, 255]
            } else {
                drawing(x, y)
            }
        });
        let other = StillLook::from_rgba(2048, 2048, &patched).expect("a still");
        assert!(look_shows_variant(&look, &other));
        assert!(!look_shows_variant(&look, &look));

        // A little noise everywhere, as recompression leaves, is one picture.
        let noisy = rgba(2048, 2048, |x, y| {
            let [value, ..] = drawing(x, y);
            let value = value + ((x * 7 + y * 13) % 3) as u8;
            [value, value, value, 255]
        });
        let noisy = StillLook::from_rgba(2048, 2048, &noisy).expect("a still");
        assert!(!look_shows_variant(&look, &noisy));

        // At another size a small grey spot is not enough, since resizing leaves as much.
        let smaller = rgba(1024, 1024, |x, y| {
            if (500..520).contains(&x) && (500..520).contains(&y) {
                [250, 250, 250, 255]
            } else {
                drawing(x * 2, y * 2)
            }
        });
        let smaller = StillLook::from_rgba(1024, 1024, &smaller).expect("a still");
        assert!(!look_shows_variant(&look, &smaller));
    }

    #[test]
    fn a_closer_look_finds_a_recoloured_area_at_any_size() {
        // Red and a green of nearly the same grey: a print would not see the area change.
        let area = |x: u32, y: u32| (256..768).contains(&x) && (256..768).contains(&y);
        let red = rgba(1024, 1024, |x, y| {
            if area(x, y) {
                [200, 60, 60, 255]
            } else {
                drawing(x, y)
            }
        });
        let green = rgba(512, 512, |x, y| {
            if area(x * 2, y * 2) {
                [60, 133, 60, 255]
            } else {
                drawing(x * 2, y * 2)
            }
        });
        let red = StillLook::from_rgba(1024, 1024, &red).expect("a still");
        let green = StillLook::from_rgba(512, 512, &green).expect("a still");
        assert!(look_shows_variant(&red, &green));
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

    /// The sums over a print's bytes, one at a time in floats, as Electron Oriel ran them. The
    /// thresholds were measured on these values, so every print must keep them to the last bit.
    fn normalized_by_running_sums(print: &[u8]) -> Vec<f32> {
        let length = print.len() as f64;
        let mean = print.iter().fold(0.0, |sum, &value| sum + f64::from(value)) / length;
        let variance = print.iter().fold(0.0, |sum, &value| {
            let offset = f64::from(value) - mean;
            sum + offset * offset
        });
        let deviation = (variance / length).sqrt();
        print
            .iter()
            .map(|&value| ((f64::from(value) - mean) / deviation * SPREAD) as f32)
            .collect()
    }

    #[test]
    fn a_scaled_print_keeps_the_running_sums_values_to_the_bit() {
        let prints = (1u32..=64).map(|seed| {
            (0..DETAIL_SIZE * DETAIL_SIZE)
                .map(|index| {
                    let index = index as u32;
                    (index.wrapping_mul(seed.wrapping_mul(2_654_435_761)) >> (seed % 24)) as u8
                })
                .collect::<Vec<u8>>()
        });
        for print in prints {
            let expected = normalized_by_running_sums(&print);
            let scaled = normalize_detail(&print);
            assert!(
                expected
                    .iter()
                    .zip(&scaled)
                    .all(|(a, b)| a.to_bits() == b.to_bits()),
                "the print scaled differently"
            );
        }
    }

    #[test]
    fn a_flat_print_is_left_unscaled() {
        let flat = vec![9u8; DETAIL_SIZE * DETAIL_SIZE];
        assert!(normalize_detail(&flat).iter().all(|&value| value == 0.0));
    }
}
