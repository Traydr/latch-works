//! What an animated image becomes: an MP4, with the settings Tidy's ffmpeg is given.
//!
//! Tidy owns these settings. They make the choices Gather Box's encoder (`media-format`'s
//! `animation-mp4.ts`) makes where ffmpeg's own defaults differ, but nothing ties the two:
//! transparency is drawn over black, an odd size is padded to even with the frame at the top left
//! (ffmpeg's fallback crops), each image frame keeps its own time, and a key frame comes at least
//! every two seconds.

use serde::{Deserialize, Serialize};

use crate::ArchiveVideoCodec;

/// The animated image formats Tidy converts, by MIME type.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum AnimatedImageMimeType {
    #[serde(rename = "image/gif")]
    Gif,
    #[serde(rename = "image/webp")]
    Webp,
    #[serde(rename = "image/png")]
    Png,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AnimationMp4Settings {
    pub codec: ArchiveVideoCodec,
    /// The encoder's constant rate factor: Tidy's "high" quality for H.264.
    pub crf: u32,
    /// The colour (RGB) of transparent pixels and of the padding to an even size. Tidy draws
    /// frames over it by premultiplying their alpha, which is right for black only.
    pub background: [u8; 3],
    /// A key frame at least this often, besides the first frame.
    pub key_frame_interval_seconds: u32,
}

pub const ANIMATION_MP4_SETTINGS: AnimationMp4Settings = AnimationMp4Settings {
    codec: ArchiveVideoCodec::Avc,
    crf: 20,
    background: [0, 0, 0],
    key_frame_interval_seconds: 2,
};
