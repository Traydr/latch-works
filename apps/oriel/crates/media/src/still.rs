//! Stills: ImageIO decodes them, the right way up and no larger than the screen needs, into
//! frames GPUI draws. GPUI's own decoder reads neither AVIF nor HEIC, and AVIF is the archive's
//! still format (plan 063, "Media in GPUI").
//!
//! A [`Still`] holds BGRA pixels with straight (not premultiplied) alpha, which is what GPUI's
//! `RenderImage` holds: GPUI's decoder swaps RGBA to BGRA and nothing more, and its Metal
//! pipeline blends sprites with source alpha. Decoding blocks, so call [`decode`] on GPUI's
//! background executor, never on the main thread.

#[cfg(target_os = "macos")]
mod imageio;
#[cfg(not(target_os = "macos"))]
mod vips;
mod webp;

use std::path::Path;
use std::sync::Arc;

use anyhow::Result;
use gpui_kit::RenderImage;

pub use webp::WebpSettings;

/// A decoded still: BGRA, straight alpha, rows packed with no padding.
pub struct Still {
    width: u32,
    height: u32,
    bgra: Vec<u8>,
    opaque: bool,
}

impl Still {
    /// A still from packed BGRA pixels with straight alpha. `opaque` says every alpha is 255.
    pub fn from_bgra(width: u32, height: u32, bgra: Vec<u8>, opaque: bool) -> Result<Self> {
        let expected = width as usize * height as usize * 4;
        anyhow::ensure!(
            width > 0 && height > 0 && bgra.len() == expected,
            "a {width}×{height} still needs {expected} bytes, not {}",
            bgra.len()
        );
        Ok(Self {
            width,
            height,
            bgra,
            opaque,
        })
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    /// Whether every pixel's alpha is 255, so an encoder can drop the alpha channel.
    pub fn is_opaque(&self) -> bool {
        self.opaque
    }

    pub fn bgra(&self) -> &[u8] {
        &self.bgra
    }

    /// The pixels as one frame GPUI can paint with `img()`. GPUI uploads it to its sprite atlas
    /// on first paint; whoever drops the last handle should release it there with
    /// `cx.drop_image`, or the atlas keeps the texture.
    pub fn into_render_image(self) -> Arc<RenderImage> {
        // `image::RgbaImage` is only a typed byte buffer here: GPUI reads its bytes as BGRA.
        let buffer = image::RgbaImage::from_raw(self.width, self.height, self.bgra)
            .expect("from_bgra checked the buffer's length");
        Arc::new(RenderImage::new(smallvec::smallvec![image::Frame::new(
            buffer
        )]))
    }

    /// The still as a WebP file's bytes.
    pub fn encode_webp(&self, settings: WebpSettings) -> Result<Vec<u8>> {
        webp::encode(self, settings)
    }
}

/// A one-pixel image under `image`'s id. GPUI paints an image from its sprite atlas by id, and
/// reads the pixels only to upload them the first time, so once they are uploaded this paints
/// the same picture without keeping them (until the atlas is told to drop the id).
pub fn stand_in(image: &RenderImage) -> Arc<RenderImage> {
    let pixel = image::Frame::new(image::RgbaImage::new(1, 1));
    let mut stand_in = RenderImage::new(smallvec::smallvec![pixel]);
    stand_in.id = image.id;
    Arc::new(stand_in)
}

/// Decodes the still at `path` with its EXIF orientation applied and its longer side at most
/// `max_pixel_size` pixels; a smaller still keeps its own size. Reads AVIF, HEIC, JPEG, PNG, WebP,
/// GIF (the first frame) and BMP: whatever ImageIO reads on this Mac, or libvips elsewhere.
pub fn decode(path: &Path, max_pixel_size: u32) -> Result<Still> {
    #[cfg(target_os = "macos")]
    {
        imageio::decode(path, max_pixel_size)
    }
    #[cfg(not(target_os = "macos"))]
    {
        vips::decode(path, max_pixel_size)
    }
}

/// A thumbnail's WebP bytes as GPUI's `img()` would decode them, for the gallery's own tile
/// cache: the same pixels, made faster and with one buffer (see `webp::decode`).
pub fn decode_webp(bytes: &[u8]) -> Result<Still> {
    webp::decode(bytes)
}

/// [`decode`] for an encoded image held in memory (PNG, JPEG and the rest), such as the frame
/// ffmpeg writes for a video's thumbnail.
pub fn decode_bytes(bytes: &[u8], max_pixel_size: u32) -> Result<Still> {
    #[cfg(target_os = "macos")]
    {
        imageio::decode_bytes(bytes, max_pixel_size)
    }
    #[cfg(not(target_os = "macos"))]
    {
        vips::decode_bytes(bytes, max_pixel_size)
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests;
