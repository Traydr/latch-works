//! The macOS decoder: ImageIO makes a thumbnail of the primary image at the size asked for, and
//! Core Graphics draws it into an sRGB BGRA bitmap.

use std::ffi::c_void;
use std::path::Path;

use anyhow::{Context as _, Result, bail};
use objc2_core_foundation::{
    CFBoolean, CFData, CFDictionary, CFNumber, CFRetained, CFString, CFType, CFURL, CGPoint,
    CGRect, CGSize,
};
use objc2_core_graphics::{
    CGBitmapContextCreate, CGColorSpace, CGContext, CGImage, CGImageAlphaInfo,
    CGImageByteOrderInfo, CGInterpolationQuality, kCGColorSpaceSRGB,
};
use objc2_image_io::{
    CGImageSource, kCGImageSourceCreateThumbnailFromImageAlways,
    kCGImageSourceCreateThumbnailWithTransform, kCGImageSourceShouldCacheImmediately,
    kCGImageSourceThumbnailMaxPixelSize,
};

use super::Still;

pub(super) fn decode(path: &Path, max_pixel_size: u32) -> Result<Still> {
    anyhow::ensure!(max_pixel_size > 0, "a still needs a size to decode at");
    let url = CFURL::from_file_path(path)
        .with_context(|| format!("{} is not a file path ImageIO takes", path.display()))?;
    // SAFETY: no options, so nothing of the wrong type.
    let source = unsafe { CGImageSource::with_url(&url, None) }
        .with_context(|| format!("ImageIO cannot open {}", path.display()))?;
    // SAFETY: `source` is a valid image source.
    if unsafe { source.count() } == 0 {
        bail!("ImageIO finds no image in {}", path.display());
    }

    let image = thumbnail(&source, max_pixel_size)
        .with_context(|| format!("ImageIO cannot decode {}", path.display()))?;
    draw_bgra(&image).with_context(|| format!("{} could not be drawn", path.display()))
}

/// [`decode`] for an image held in memory, such as a frame ffmpeg wrote to its stdout.
pub(super) fn decode_bytes(bytes: &[u8], max_pixel_size: u32) -> Result<Still> {
    anyhow::ensure!(max_pixel_size > 0, "a still needs a size to decode at");
    anyhow::ensure!(!bytes.is_empty(), "there is no image in no bytes");
    let data = CFData::from_bytes(bytes);
    // SAFETY: no options, so nothing of the wrong type.
    let source = unsafe { CGImageSource::with_data(&data, None) }
        .context("ImageIO cannot read the image")?;
    // SAFETY: `source` is a valid image source.
    if unsafe { source.count() } == 0 {
        bail!("ImageIO finds no image in the bytes");
    }
    let image = thumbnail(&source, max_pixel_size).context("ImageIO cannot decode the image")?;
    draw_bgra(&image).context("the image could not be drawn")
}

/// The primary image at most `max_pixel_size` on its longer side, made from the full image
/// rather than any thumbnail the file embeds, turned by its EXIF orientation, and decoded now
/// (on this thread) rather than when it is first drawn.
fn thumbnail(source: &CGImageSource, max_pixel_size: u32) -> Option<CFRetained<CGImage>> {
    let yes = CFBoolean::new(true);
    let size = CFNumber::new_i64(i64::from(max_pixel_size));
    // SAFETY: the keys are ImageIO's own constants, read once each.
    let keys: [&CFString; 4] = unsafe {
        [
            kCGImageSourceCreateThumbnailFromImageAlways,
            kCGImageSourceCreateThumbnailWithTransform,
            kCGImageSourceShouldCacheImmediately,
            kCGImageSourceThumbnailMaxPixelSize,
        ]
    };
    let values: [&CFType; 4] = [yes, yes, yes, &size];
    let options = CFDictionary::from_slices(&keys, &values);
    // SAFETY: the options are the types ImageIO documents for these keys.
    unsafe {
        let index = source.primary_image_index();
        source.thumbnail_at_index(index, Some(options.as_opaque()))
    }
}

/// Draws `image` into a packed sRGB BGRA buffer and undoes Core Graphics' premultiplied alpha,
/// since GPUI blends straight alpha. An 8-bit bitmap context can only hold premultiplied alpha,
/// so the draw also turns 16-bit and float (HDR) stills into what GPUI's atlas holds.
fn draw_bgra(image: &CGImage) -> Result<Still> {
    let width = CGImage::width(Some(image));
    let height = CGImage::height(Some(image));
    anyhow::ensure!(width > 0 && height > 0, "the image is empty");
    let width_u32 = u32::try_from(width).context("the image is too wide")?;
    let height_u32 = u32::try_from(height).context("the image is too tall")?;
    let stride = width * 4;
    let mut bgra = vec![0u8; stride * height];

    // SAFETY: the sRGB name is Core Graphics' constant.
    let space = CGColorSpace::with_name(Some(unsafe { kCGColorSpaceSRGB }))
        .context("no sRGB color space")?;
    // 32-bit little-endian ARGB is B, G, R, A in memory.
    let info = CGImageAlphaInfo::PremultipliedFirst.0 | CGImageByteOrderInfo::Order32Little.0;
    // SAFETY: `bgra` holds `stride * height` bytes and outlives the context, which is dropped
    // at the end of this block.
    unsafe {
        let context = CGBitmapContextCreate(
            bgra.as_mut_ptr().cast::<c_void>(),
            width,
            height,
            8,
            stride,
            Some(&space),
            info,
        )
        .context("Core Graphics could not make a bitmap context")?;
        draw(&context, image, width, height);
    }

    // An alpha channel is often all 255 (encoders keep the channel of an opaque source), so
    // the pixels decide, and an opaque still is encoded without one.
    let opaque = !has_alpha(CGImage::alpha_info(Some(image)))
        || bgra.as_chunks::<4>().0.iter().all(|pixel| pixel[3] == 255);
    if !opaque {
        unpremultiply(&mut bgra);
    }
    Still::from_bgra(width_u32, height_u32, bgra, opaque)
}

fn draw(context: &CGContext, image: &CGImage, width: usize, height: usize) {
    // The thumbnail is already at the size wanted, so this draw is a copy and a color
    // conversion, never a scale; the quality only matters if it ever is one.
    CGContext::set_interpolation_quality(Some(context), CGInterpolationQuality::High);
    let rect = CGRect::new(
        CGPoint::new(0.0, 0.0),
        CGSize::new(width as f64, height as f64),
    );
    CGContext::draw_image(Some(context), rect, Some(image));
}

fn has_alpha(info: CGImageAlphaInfo) -> bool {
    !matches!(
        info,
        CGImageAlphaInfo::None | CGImageAlphaInfo::NoneSkipFirst | CGImageAlphaInfo::NoneSkipLast
    )
}

/// Premultiplied BGRA to straight BGRA, in place. Fully opaque and fully clear pixels are left
/// alone: the first are already straight, and the second have no color to recover.
fn unpremultiply(bgra: &mut [u8]) {
    for pixel in bgra.as_chunks_mut::<4>().0 {
        let alpha = u32::from(pixel[3]);
        if alpha == 0 || alpha == 255 {
            continue;
        }
        for channel in &mut pixel[..3] {
            *channel = ((u32::from(*channel) * 255 + alpha / 2) / alpha).min(255) as u8;
        }
    }
}
