//! Stills to the archive's AVIF, from glazier-core's `encodeStillToAvif`: decoded the way sharp
//! decodes them for the wasm encoder (EXIF orientation applied, 8-bit sRGB RGBA, through the same
//! libvips build), then encoded by the vendored libavif at `media-format`'s settings on one
//! thread, as each of Electron Oriel's encoder processes runs.
//!
//! Electron Oriel hands stills over 64 megapixels to sharp's own AVIF encoder, since the wasm
//! heap cannot hold them. A native libavif has no such heap, so Oriel RS encodes every still the
//! same way and never writes glazier-core's "Encoded with sharp" note.

use std::fs;
use std::path::Path;

use oriel_avif::{Channels, Libavif, Samples, Still};

use crate::similarity::Vips;

/// libavif's output depends on its thread count; one thread, as the wasm encoder runs, gives the
/// same bytes every time and leaves the other cores to the encodes beside it.
const ENCODER_THREADS: u32 = 1;

/// What an encode wrote.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StillEncodeResult {
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
}

/// Encodes the still at `source` to an AVIF at `out`.
pub fn encode_still_to_avif(
    vips: &Vips,
    libavif: &Libavif,
    source: &Path,
    out: &Path,
) -> anyhow::Result<StillEncodeResult> {
    let (width, height, pixels) = vips.rgba_pixels(source)?;
    let encoded = libavif.encode_archive(
        &Still {
            width,
            height,
            channels: Channels::Rgba,
            samples: Samples::Eight(&pixels),
        },
        ENCODER_THREADS,
    )?;
    fs::write(out, &encoded)?;
    Ok(StillEncodeResult {
        width,
        height,
        bytes: encoded.len() as u64,
    })
}
