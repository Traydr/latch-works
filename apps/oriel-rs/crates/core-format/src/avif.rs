//! The archive's AVIF settings, from `media-format`'s `avif.ts`. The encoder is not here: the
//! TypeScript drives libavif in wasm, and the port will drive libavif natively (plan 063,
//! Phase 6), with these settings.

use serde::{Deserialize, Serialize};

/// The archive stores every still as an AVIF at this libavif quality (0 to 100).
pub const ARCHIVE_AVIF_QUALITY: i32 = 70;

/// libavif speed (0 slowest, 10 fastest) for archive stills.
pub const ARCHIVE_AVIF_SPEED: i32 = 6;

/// The speed of the second attempt. The wasm codec's heap stops at 2 GiB, and hard-edged line
/// art makes the encoder build block-matching tables at speeds 6 and 7 that double its memory,
/// so such an image fails from roughly 30 megapixels up. Speed 8 skips those tables and fits
/// anything up to about 64 megapixels, for a file around half again as large.
pub const ARCHIVE_AVIF_LOW_MEMORY_SPEED: i32 = 8;

/// Above this many pixels the wasm encoder cannot fit the image at any speed, so Electron Oriel
/// encodes it with sharp instead (see [`ARCHIVE_AVIF_SHARP_OPTIONS`]). A native libavif has no
/// such heap; whether the port keeps this switch is Phase 6's choice.
pub const ARCHIVE_AVIF_WASM_PIXEL_LIMIT: u64 = 64_000_000;

/// The libavif options the wasm encoder (`@jsquash/avif`) takes, with its field names and codes:
/// `subsample` 1 is 4:2:0, `tune` 0 is libavif's default tuning, and `quality_alpha` -1 means the
/// alpha plane takes `quality`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvifEncodeOptions {
    pub quality: i32,
    pub quality_alpha: i32,
    pub denoise_level: i32,
    pub tile_rows_log2: i32,
    pub tile_cols_log2: i32,
    pub speed: i32,
    pub subsample: i32,
    pub chroma_delta_q: bool,
    pub sharpness: i32,
    #[serde(rename = "enableSharpYUV")]
    pub enable_sharp_yuv: bool,
    pub tune: i32,
    pub bit_depth: i32,
}

pub const ARCHIVE_AVIF_OPTIONS: AvifEncodeOptions = AvifEncodeOptions {
    quality: ARCHIVE_AVIF_QUALITY,
    quality_alpha: -1,
    denoise_level: 0,
    tile_rows_log2: 0,
    tile_cols_log2: 0,
    speed: ARCHIVE_AVIF_SPEED,
    subsample: 1,
    chroma_delta_q: false,
    sharpness: 0,
    enable_sharp_yuv: false,
    tune: 0,
    bit_depth: 8,
};

/// sharp's (libheif and aom) closest settings, for images too large for the wasm encoder. sharp
/// takes `effort` 0 to 9 and passes `9 - effort` to aom as its speed, so effort 3 is speed 6. Its
/// quality scale is libheif's rather than libavif's, so the files are close to, not identical
/// with, the wasm encoder's.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharpAvifOptions {
    pub bitdepth: i32,
    pub chroma_subsampling: &'static str,
    pub effort: i32,
    pub quality: i32,
}

pub const ARCHIVE_AVIF_SHARP_OPTIONS: SharpAvifOptions = SharpAvifOptions {
    bitdepth: 8,
    chroma_subsampling: "4:2:0",
    effort: 3,
    quality: ARCHIVE_AVIF_QUALITY,
};

/// Encodes with [`ARCHIVE_AVIF_OPTIONS`], and once more at [`ARCHIVE_AVIF_LOW_MEMORY_SPEED`]
/// when that fails, as `createArchiveAvifEncoder` does. The first failure is dropped; the
/// second is returned. There is no third attempt.
pub fn encode_archive_avif<T, E>(
    mut encode: impl FnMut(&AvifEncodeOptions) -> Result<T, E>,
) -> Result<T, E> {
    encode(&ARCHIVE_AVIF_OPTIONS).or_else(|_| {
        encode(&AvifEncodeOptions {
            speed: ARCHIVE_AVIF_LOW_MEMORY_SPEED,
            ..ARCHIVE_AVIF_OPTIONS
        })
    })
}
