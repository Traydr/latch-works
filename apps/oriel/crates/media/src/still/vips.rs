//! Stills off macOS, where ImageIO is not: libvips decodes them, the same build of sharp's that
//! Tidy loads (`oriel_core_tidy::similarity::Vips`), so AVIF and HEIC read through its libheif.
//! On Windows that is `libvips-42.dll` from `@img/sharp-libvips-win32-x64`, beside the app.
//!
//! libvips gives the still at full size, the right way up, in sRGB with alpha; the scale down to
//! `max_pixel_size` is `image`'s. A thumbnail decoded this way costs more than ImageIO's, which
//! decodes at the reduced size directly: `vips_thumbnail` is the faster route when it matters.
//! Frames held in memory (ffmpeg's for a video's thumbnail) decode through `image`.

use std::path::Path;
use std::sync::OnceLock;

use anyhow::{Result, anyhow};
use image::imageops::FilterType;
use oriel_core_tidy::similarity::Vips;

use super::Still;

static VIPS: OnceLock<std::result::Result<Vips, String>> = OnceLock::new();

fn vips() -> Result<&'static Vips> {
    VIPS.get_or_init(|| {
        Vips::open_located()
            .map(|(vips, _, _)| vips)
            .map_err(|error| error.to_string())
    })
    .as_ref()
    .map_err(|error| anyhow!("{error}"))
}

pub fn decode(path: &Path, max_pixel_size: u32) -> Result<Still> {
    let (width, height, rgba) = vips()?.rgba_pixels(path)?;
    let image = image::RgbaImage::from_raw(width, height, rgba)
        .ok_or_else(|| anyhow!("libvips gave {} the wrong number of bytes", path.display()))?;
    from_rgba(image, max_pixel_size)
}

pub fn decode_bytes(bytes: &[u8], max_pixel_size: u32) -> Result<Still> {
    from_rgba(image::load_from_memory(bytes)?.into_rgba8(), max_pixel_size)
}

/// The still no larger than `max_pixel_size` on its longer side, as BGRA.
fn from_rgba(image: image::RgbaImage, max_pixel_size: u32) -> Result<Still> {
    let (width, height) = image.dimensions();
    let longer = width.max(height);
    let image = if max_pixel_size > 0 && longer > max_pixel_size {
        let scale = f64::from(max_pixel_size) / f64::from(longer);
        let fit = |side: u32| ((f64::from(side) * scale).round() as u32).max(1);
        image::imageops::resize(&image, fit(width), fit(height), FilterType::Triangle)
    } else {
        image
    };
    let (width, height) = image.dimensions();
    let mut pixels = image.into_raw();
    let mut opaque = true;
    for pixel in pixels.as_chunks_mut::<4>().0 {
        pixel.swap(0, 2);
        opaque &= pixel[3] == 255;
    }
    Still::from_bgra(width, height, pixels, opaque)
}
