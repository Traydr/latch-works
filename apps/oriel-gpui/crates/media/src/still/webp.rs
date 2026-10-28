//! WebP through libwebp, the library sharp's `.webp()` wraps, at the settings Electron Oriel's
//! thumbnail worker passes it (`ThumbnailWorkerRuntime.ts`).

use std::ffi::{c_int, c_void};
use std::mem::MaybeUninit;

use anyhow::{Result, bail};
use libwebp_sys::{
    WEBP_ENCODER_ABI_VERSION, WebPConfig, WebPConfigInitInternal, WebPEncode, WebPMemoryWrite,
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
