//! Measures fingerprint parity case by case for the two pipelines plan 063's Phase 0 tries:
//!
//! 1. libvips through `oriel_core_tidy::similarity::Vips`, which repeats sharp's calls;
//! 2. the pure-Rust `image` crates, with the same steps written by hand: decode, EXIF
//!    orientation, flatten on white, linear-light grey as libvips makes it, a box shrink and a
//!    Lanczos-3 resample.
//!
//! It prints a table and asserts nothing; the conformance test is `tests/fingerprints.rs`.
//!
//! ```text
//! cargo run -p oriel-core-tidy --example fingerprint_parity
//! ```

#[path = "../tests/support/mod.rs"]
mod support;

use std::{fs::File, io::BufReader, path::Path};

use image::{AnimationDecoder, DynamicImage, ImageDecoder, ImageReader};
use oriel_core_tidy::similarity::{
    Vips, animation_frame_times, detail_difference, detail_from_grey, detail_of_still,
    fingerprint_animation, fingerprint_still, is_variant, normalize_detail, perceptual_hash,
    sampled_pages,
};
use support::{corpus_dir, from_hex, libvips_path, vectors, write_large_png};

struct Expected<'a> {
    name: &'a str,
    fingerprint: &'a str,
    grey32: &'a str,
    detail: &'a str,
}

fn main() {
    let vips = Vips::open(&libvips_path()).expect("libvips");
    let vectors = vectors();
    println!(
        "libvips {} (vectors made with {})\n",
        vips.version(),
        vectors.libvips
    );
    println!(
        "{:<20} | {:^13} | {:^60}",
        "case", "1: libvips", "2: image crates"
    );
    println!(
        "{:<20} | {:>5} {:>7} | {:>4} {:>14} {:>8} {:>8} {:>18}",
        "", "hash", "detail", "bits", "grey32 max/n", "detail", "variant", "typical/local"
    );

    let scratch = support::Scratch::new("oriel-core-tidy-parity");
    let mut cases: Vec<(std::path::PathBuf, Expected)> = vectors
        .stills
        .iter()
        .map(|still| {
            (
                corpus_dir().join(&still.file),
                Expected {
                    name: &still.file,
                    fingerprint: &still.fingerprint,
                    grey32: &still.grey32,
                    detail: &still.detail,
                },
            )
        })
        .collect();
    for drawn in &vectors.drawn {
        cases.push((
            write_large_png(&scratch.0, drawn),
            Expected {
                name: &drawn.name,
                fingerprint: &drawn.fingerprint,
                grey32: &drawn.grey32,
                detail: &drawn.detail,
            },
        ));
    }

    let (mut vips_exact, mut pure_hash, mut pure_detail, mut pure_decoded) = (0, 0, 0, 0);
    for (path, expected) in &cases {
        let vips_hash = fingerprint_still(&vips, path).map(|print| print.to_string());
        let vips_detail = detail_of_still(&vips, path);
        let hash_ok = vips_hash.as_deref() == Ok(expected.fingerprint);
        let detail_ok = vips_detail.as_ref().ok() == Some(&from_hex(expected.detail));
        vips_exact += usize::from(hash_ok && detail_ok);

        let pure = pure::grey(path, 32).and_then(|grey32| Ok((grey32, pure::grey(path, 256)?)));
        let row = match pure {
            Err(error) => error,
            Ok((grey32, grey256)) => {
                pure_decoded += 1;
                let theirs = from_hex(expected.grey32);
                let max = grey32
                    .iter()
                    .zip(&theirs)
                    .map(|(a, b)| a.abs_diff(*b))
                    .max()
                    .unwrap_or(0);
                let differing = grey32.iter().zip(&theirs).filter(|(a, b)| a != b).count();
                let hash = perceptual_hash(&grey32).expect("32×32");
                let their_hash = expected.fingerprint.trim_start_matches("s:");
                let bits = u64::from_str_radix(their_hash, 16)
                    .map(|theirs| (theirs ^ hash.0).count_ones())
                    .unwrap_or(64);
                let detail = detail_from_grey(&grey256).expect("256×256");
                let their_detail = from_hex(expected.detail);
                let difference =
                    detail_difference(&normalize_detail(&their_detail), &normalize_detail(&detail));
                let variant =
                    is_variant(&normalize_detail(&their_detail), &normalize_detail(&detail));
                pure_hash += usize::from(bits == 0);
                pure_detail += usize::from(detail == their_detail);
                format!(
                    "{bits:>4} {:>14} {:>8} {:>8} {:>18}",
                    format!("{max}/{differing}"),
                    if detail == their_detail {
                        "same"
                    } else {
                        "differs"
                    },
                    if variant { "VARIANT" } else { "copy" },
                    format!("{:.2}/{:.2}", difference.typical, difference.local),
                )
            }
        };
        println!(
            "{:<20} | {:>5} {:>7} | {row}",
            expected.name,
            if hash_ok { "same" } else { "DIFF" },
            if detail_ok { "same" } else { "DIFF" },
        );
        if let (Ok(made), false) = (&vips_detail, detail_ok) {
            let theirs = from_hex(expected.detail);
            let differing = made.iter().zip(&theirs).filter(|(a, b)| a != b).count();
            let max = made.iter().zip(&theirs).map(|(a, b)| a.abs_diff(*b)).max();
            let variant = is_variant(&normalize_detail(&theirs), &normalize_detail(made));
            println!(
                "{:<20} |   libvips detail: {differing} of 4096 bytes differ, by up to {}; \
                 Spot variants would call it {}",
                "",
                max.unwrap_or(0),
                if variant { "a variant" } else { "a copy" }
            );
        }
    }

    println!();
    for animation in &vectors.animations {
        let path = corpus_dir().join(&animation.file);
        let probe = vips.probe(&path).expect("a probe");
        let times = animation_frame_times(&probe.frame_delays_ms, probe.frames);
        let made = fingerprint_animation(&vips, &path, &times).map(|print| print.to_string());
        let vips_same = made.as_deref() == Ok(animation.fingerprint.as_str());
        let theirs: Vec<u64> = animation
            .fingerprint
            .rsplit(':')
            .next()
            .unwrap_or("")
            .split('.')
            .map(|hash| u64::from_str_radix(hash, 16).unwrap_or(0))
            .collect();
        let pure = pure::animation_bits(&path, &sampled_pages(&animation.frame_times_ms), &theirs);
        println!(
            "{:<20} | libvips {} | image crates: {}",
            animation.file,
            if vips_same { "same" } else { "DIFF" },
            match pure {
                Ok(bits) => format!("bits per sampled frame {bits:?}"),
                Err(error) => error,
            }
        );
    }

    println!(
        "\nstills: libvips exact {vips_exact}/{}; image crates decoded {pure_decoded}, hash exact \
         {pure_hash}, detail exact {pure_detail}",
        cases.len()
    );
}

/// The hand-written pipeline on the `image` crates.
mod pure {
    use super::*;

    /// libvips' sRGB curve, both ways, in f64.
    fn to_linear(value: f64) -> f64 {
        if value <= 0.04045 {
            value / 12.92
        } else {
            ((value + 0.055) / 1.055).powf(2.4)
        }
    }

    fn to_srgb(value: f64) -> f64 {
        if value <= 0.0031308 {
            value * 12.92
        } else {
            1.055 * value.powf(1.0 / 2.4) - 0.055
        }
    }

    fn decode(path: &Path) -> Result<DynamicImage, String> {
        let reader = ImageReader::open(path)
            .and_then(ImageReader::with_guessed_format)
            .map_err(|error| error.to_string())?;
        let mut decoder = reader
            .into_decoder()
            .map_err(|error| format!("no decoder: {error}"))?;
        let orientation = decoder.orientation().map_err(|error| error.to_string())?;
        let mut image = DynamicImage::from_decoder(decoder).map_err(|error| error.to_string())?;
        image.apply_orientation(orientation);
        Ok(image)
    }

    /// Flattened on white and made grey, as libvips does before its resize: 0–255, unrounded.
    fn grey_plane(image: &DynamicImage) -> (usize, usize, Vec<f64>) {
        let (width, height) = (image.width() as usize, image.height() as usize);
        let wide = matches!(
            image,
            DynamicImage::ImageRgb16(_)
                | DynamicImage::ImageRgba16(_)
                | DynamicImage::ImageLuma16(_)
                | DynamicImage::ImageLumaA16(_)
        );
        let grey_source = matches!(
            image,
            DynamicImage::ImageLuma8(_)
                | DynamicImage::ImageLumaA8(_)
                | DynamicImage::ImageLuma16(_)
                | DynamicImage::ImageLumaA16(_)
        );
        // sharp's white for a 16-bit image is 255 × 256, not 65535.
        let (max, white) = if wide {
            (65535.0, 65280.0)
        } else {
            (255.0, 255.0)
        };
        let pixels = image.to_rgba16();
        let plane = pixels
            .pixels()
            .map(|pixel| {
                let scale = |value: u16| {
                    if wide {
                        f64::from(value)
                    } else {
                        f64::from(value >> 8)
                    }
                };
                let alpha = scale(pixel[3]) / max;
                let flat = |value: u16| (scale(value) * alpha + white * (1.0 - alpha)) / max;
                let grey = if grey_source {
                    flat(pixel[0])
                } else {
                    let luminance = 0.2126 * to_linear(flat(pixel[0]))
                        + 0.7152 * to_linear(flat(pixel[1]))
                        + 0.0722 * to_linear(flat(pixel[2]));
                    to_srgb(luminance)
                };
                grey * 255.0
            })
            .collect();
        (width, height, plane)
    }

    fn lanczos3(x: f64) -> f64 {
        if x == 0.0 {
            1.0
        } else if x.abs() >= 3.0 {
            0.0
        } else {
            let pi_x = std::f64::consts::PI * x;
            3.0 * pi_x.sin() * (pi_x / 3.0).sin() / (pi_x * pi_x)
        }
    }

    /// One axis: a box shrink by the whole factor libvips leaves to `shrink` (it keeps a gap of
    /// two for the kernel), then Lanczos-3 for the rest, centre-aligned and rounded per pass.
    fn resample(line: &[f64], out: usize) -> Vec<f64> {
        let factor = line.len() as f64 / out as f64;
        let box_shrink = ((factor / 2.0).floor() as usize).max(1);
        let boxed: Vec<f64> = line
            .chunks(box_shrink)
            .filter(|chunk| chunk.len() == box_shrink)
            .map(|chunk| (chunk.iter().sum::<f64>() / box_shrink as f64).round())
            .collect();
        let factor = boxed.len() as f64 / out as f64;
        let stretch = factor.max(1.0);
        (0..out)
            .map(|index| {
                let centre = (index as f64 + 0.5) * factor - 0.5;
                let reach = 3.0 * stretch;
                let (mut sum, mut weights) = (0.0, 0.0);
                for tap in (centre - reach).ceil() as i64..=(centre + reach).floor() as i64 {
                    let weight = lanczos3((tap as f64 - centre) / stretch);
                    let at = tap.clamp(0, boxed.len() as i64 - 1) as usize;
                    sum += boxed[at] * weight;
                    weights += weight;
                }
                (sum / weights).round().clamp(0.0, 255.0)
            })
            .collect()
    }

    fn resize(width: usize, height: usize, plane: &[f64], size: usize) -> Vec<u8> {
        let rows: Vec<Vec<f64>> = plane.chunks(width).map(|row| resample(row, size)).collect();
        let mut out = vec![0u8; size * size];
        for x in 0..size {
            let column: Vec<f64> = (0..height).map(|y| rows[y][x]).collect();
            for (y, value) in resample(&column, size).into_iter().enumerate() {
                out[y * size + x] = value as u8;
            }
        }
        out
    }

    pub fn grey(path: &Path, size: usize) -> Result<Vec<u8>, String> {
        let image = decode(path)?;
        let (width, height, plane) = grey_plane(&image);
        Ok(resize(width, height, &plane, size))
    }

    /// The bit distance of each sampled frame's hash from glazier-core's.
    pub fn animation_bits(path: &Path, pages: &[u32], theirs: &[u64]) -> Result<Vec<u32>, String> {
        let file = BufReader::new(File::open(path).map_err(|error| error.to_string())?);
        let frames = if path.extension().is_some_and(|extension| extension == "gif") {
            image::codecs::gif::GifDecoder::new(file)
                .map_err(|error| error.to_string())?
                .into_frames()
                .collect_frames()
        } else {
            image::codecs::webp::WebPDecoder::new(file)
                .map_err(|error| error.to_string())?
                .into_frames()
                .collect_frames()
        }
        .map_err(|error| error.to_string())?;
        pages
            .iter()
            .zip(theirs)
            .map(|(&page, &their_hash)| {
                let frame = frames.get(page as usize).ok_or("missing page")?;
                let image = DynamicImage::ImageRgba8(frame.buffer().clone());
                let (width, height, plane) = grey_plane(&image);
                let hash = perceptual_hash(&resize(width, height, &plane, 32)).expect("32×32");
                Ok((hash.0 ^ their_hash).count_ones())
            })
            .collect()
    }
}
