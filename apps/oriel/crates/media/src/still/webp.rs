//! WebP through libwebp, the library sharp's `.webp()` wraps, at the settings Electron Oriel's
//! thumbnail worker passes it (`ThumbnailWorkerRuntime.ts`), and read back for the gallery's tiles.

use std::ffi::{c_int, c_void};
use std::mem::MaybeUninit;

use anyhow::{Result, bail};
use libwebp_sys::{
    VP8StatusCode, WEBP_ENCODER_ABI_VERSION, WebPBitstreamFeatures, WebPConfig,
    WebPConfigInitInternal, WebPDecodeBGRAInto, WebPEncode, WebPGetFeatures, WebPMemoryWrite,
    WebPMemoryWriter, WebPMemoryWriterClear, WebPMemoryWriterInit, WebPPicture, WebPPictureFree,
    WebPPictureImportBGRA, WebPPictureImportBGRX, WebPPictureInitInternal, WebPPreset,
    WebPValidateConfig,
};

use super::Still;

/// What libwebp is asked for: sharp's `quality`, its `effort` (libwebp's `method`, 0 fastest
/// to 6 smallest) and `lossless`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WebpSettings {
    quality: f32,
    method: i32,
    lossless: bool,
}

impl WebpSettings {
    /// A lossy WebP at `quality` (0–100) and `method` (0–6).
    pub const fn lossy(quality: f32, method: i32) -> Self {
        Self {
            quality,
            method,
            lossless: false,
        }
    }

    /// A lossless WebP at `method` (0–6). The quality is sharp's default, 80, which libwebp
    /// reads as how hard to compress.
    pub const fn lossless(method: i32) -> Self {
        Self {
            quality: 80.0,
            method,
            lossless: true,
        }
    }

    pub fn quality(&self) -> f32 {
        self.quality
    }

    pub fn method(&self) -> i32 {
        self.method
    }

    pub fn is_lossless(&self) -> bool {
        self.lossless
    }
}

pub(super) fn encode(still: &Still, settings: WebpSettings) -> Result<Vec<u8>> {
    let width = c_int::try_from(still.width())?;
    let height = c_int::try_from(still.height())?;
    let stride = width * 4;

    // SAFETY: each libwebp struct is initialised by its own init function before use, the
    // picture reads `still`'s pixels only during the import, and the writer's buffer is copied
    // out before it is cleared.
    unsafe {
        let mut config = MaybeUninit::<WebPConfig>::uninit();
        if WebPConfigInitInternal(
            config.as_mut_ptr(),
            WebPPreset::WEBP_PRESET_DEFAULT,
            settings.quality,
            WEBP_ENCODER_ABI_VERSION as c_int,
        ) == 0
        {
            bail!("libwebp is not the version this was built against");
        }
        let mut config = config.assume_init();
        config.method = settings.method;
        config.lossless = c_int::from(settings.lossless);
        if WebPValidateConfig(&config) == 0 {
            bail!("libwebp refuses the settings {settings:?}");
        }

        let mut picture = MaybeUninit::<WebPPicture>::uninit();
        if WebPPictureInitInternal(picture.as_mut_ptr(), WEBP_ENCODER_ABI_VERSION as c_int) == 0 {
            bail!("libwebp could not start a picture");
        }
        let mut picture = picture.assume_init();
        picture.use_argb = c_int::from(settings.lossless);
        picture.width = width;
        picture.height = height;
        // An opaque still is imported without its alpha, so the file has no alpha channel, as
        // sharp writes for a JPEG or AVIF without one.
        let imported = if still.is_opaque() {
            WebPPictureImportBGRX(&mut picture, still.bgra().as_ptr(), stride)
        } else {
            WebPPictureImportBGRA(&mut picture, still.bgra().as_ptr(), stride)
        };
        if imported == 0 {
            WebPPictureFree(&mut picture);
            bail!("libwebp could not take the pixels");
        }

        let mut writer = MaybeUninit::<WebPMemoryWriter>::uninit();
        WebPMemoryWriterInit(writer.as_mut_ptr());
        let mut writer = writer.assume_init();
        picture.writer = Some(WebPMemoryWrite);
        picture.custom_ptr = (&raw mut writer).cast::<c_void>();

        let encoded = WebPEncode(&config, &mut picture);
        let error = picture.error_code;
        WebPPictureFree(&mut picture);
        let bytes = if encoded != 0 && !writer.mem.is_null() {
            std::slice::from_raw_parts(writer.mem, writer.size).to_vec()
        } else {
            Vec::new()
        };
        WebPMemoryWriterClear(&mut writer);
        if encoded == 0 {
            bail!("libwebp could not encode the picture: {error:?}");
        }
        Ok(bytes)
    }
}

/// The `VP8X` chunk's flags for an EXIF chunk and for an animation.
const EXIF_FLAG: u8 = 0x08;
const ANIMATION_FLAG: u8 = 0x02;

/// Decodes a WebP file's bytes into the pixels GPUI's `img()` makes of them: the `image` crate's
/// decoder, turned by any EXIF orientation, RGBA swapped to BGRA, straight alpha.
///
/// A plain WebP, as [`encode`] writes, goes through libwebp straight into one BGRA buffer, which
/// gives the same bytes as the `image` crate (checked on the fixture's thumbnails, lossy and
/// lossless, with and without alpha) in about a third of the time and without its RGB and RGBA
/// copies. A file with an EXIF chunk or an animation is decoded by the `image` crate as GPUI
/// decodes it, orientation and all, the first frame of an animation only.
pub(super) fn decode(bytes: &[u8]) -> Result<Still> {
    // The flags byte of an extended file's `VP8X` chunk, right after the RIFF header.
    let flags = (bytes.get(12..16) == Some(b"VP8X"))
        .then(|| bytes.get(20).copied())
        .flatten()
        .unwrap_or(0);
    if flags & (EXIF_FLAG | ANIMATION_FLAG) != 0 {
        return decode_as_gpui(bytes);
    }
    // SAFETY: plain data, filled in by libwebp.
    let mut features: WebPBitstreamFeatures = unsafe { std::mem::zeroed() };
    // SAFETY: `bytes` is readable for its length and `features` is writable.
    let status = unsafe { WebPGetFeatures(bytes.as_ptr(), bytes.len(), &mut features) };
    if status != VP8StatusCode::VP8_STATUS_OK {
        bail!("libwebp cannot read the WebP: {status:?}");
    }
    if features.has_animation != 0 {
        return decode_as_gpui(bytes);
    }
    let (width, height) = (
        u32::try_from(features.width)?,
        u32::try_from(features.height)?,
    );
    let stride = c_int::try_from(width as usize * 4)?;
    let mut bgra = vec![0u8; width as usize * height as usize * 4];
    // SAFETY: `bgra` holds `stride * height` bytes, which libwebp writes and no more.
    let written = unsafe {
        WebPDecodeBGRAInto(
            bytes.as_ptr(),
            bytes.len(),
            bgra.as_mut_ptr(),
            bgra.len(),
            stride,
        )
    };
    if written.is_null() {
        bail!("libwebp could not decode the WebP");
    }
    let opaque = features.has_alpha == 0;
    Still::from_bgra(width, height, bgra, opaque)
}

/// GPUI's own decode of a static image (`decode_static_image_from_decoder`), for the WebP files
/// libwebp is not trusted to give the same pixels for.
pub(super) fn decode_as_gpui(bytes: &[u8]) -> Result<Still> {
    use image::ImageDecoder as _;

    let mut decoder = image::codecs::webp::WebPDecoder::new(std::io::Cursor::new(bytes))?;
    let orientation = decoder.orientation()?;
    let mut image = image::DynamicImage::from_decoder(decoder)?;
    image.apply_orientation(orientation);
    let opaque = !image.color().has_alpha();
    let image = image.into_rgba8();
    let (width, height) = image.dimensions();
    let mut bgra = image.into_raw();
    for pixel in bgra.as_chunks_mut::<4>().0 {
        pixel.swap(0, 2);
    }
    Still::from_bgra(width, height, bgra, opaque)
}
