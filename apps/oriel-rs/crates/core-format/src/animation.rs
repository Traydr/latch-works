//! What an animated image becomes, from the decisions in `media-format`'s `animation-mp4.ts`:
//! the MP4's settings, its size, and each frame's time.
//!
//! The encoding itself is not here. Electron Oriel encodes through Mediabunny and WebCodecs; the
//! port will encode through ffmpeg (plan 063), which must be given these decisions, since its own
//! defaults differ: its GIF reader turns delays under 20 ms into 100 ms where this keeps 10 ms,
//! and the ffmpeg fallback crops an odd size to even where this pads it.

use std::{error::Error, fmt};

use serde::{Deserialize, Serialize};

use crate::ArchiveVideoCodec;

/// The animated image formats Electron Oriel converts, by MIME type.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum AnimatedImageMimeType {
    #[serde(rename = "image/gif")]
    Gif,
    #[serde(rename = "image/webp")]
    Webp,
    #[serde(rename = "image/png")]
    Png,
}

/// The MP4 an animation becomes, as `ANIMATION_MP4_SETTINGS` gives it to Mediabunny.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimationMp4Settings {
    pub codec: ArchiveVideoCodec,
    /// Mediabunny's quality level, which it turns into a bitrate for the frame size.
    pub quality: &'static str,
    /// Transparency is dropped: each frame is drawn over [`ANIMATION_BACKGROUND`].
    pub alpha: &'static str,
    /// A key frame at least this often, besides the first frame.
    pub key_frame_interval_seconds: u32,
    /// The MP4's index goes before its media, so it plays while it loads.
    pub fast_start: &'static str,
}

pub const ANIMATION_MP4_SETTINGS: AnimationMp4Settings = AnimationMp4Settings {
    codec: ArchiveVideoCodec::Avc,
    quality: "high",
    alpha: "discard",
    key_frame_interval_seconds: 2,
    fast_start: "in-memory",
};

/// The colour (RGB) each frame is drawn over, so transparent pixels and the padding from rounding
/// the size up are black.
pub const ANIMATION_BACKGROUND: [u8; 3] = [0, 0, 0];

/// How long a frame shows when the image gives no duration.
pub const DEFAULT_FRAME_DURATION_MICROSECONDS: u64 = 100_000;

/// The shortest a frame shows; shorter durations, zero among them, are raised to this.
pub const MINIMUM_FRAME_DURATION_MICROSECONDS: u64 = 10_000;

/// The video's size for a first frame of `width` by `height`: each rounded up to even, as H.264
/// needs. The frame is drawn at the top left, so the extra row or column is background.
pub fn animation_canvas_size(width: u64, height: u64) -> (u64, u64) {
    (width.div_ceil(2) * 2, height.div_ceil(2) * 2)
}

/// One video frame: when it starts and how long it shows, in whole microseconds as the image
/// decoder gives them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AnimationFrame {
    pub timestamp_microseconds: u64,
    pub duration_microseconds: u64,
    /// Only the first frame is forced to be a key frame; the encoder places the rest.
    pub key_frame: bool,
}

impl AnimationFrame {
    /// The start in seconds, as the TypeScript hands it to the encoder. Microseconds are summed
    /// first and divided once, so the times do not drift.
    pub fn timestamp_seconds(&self) -> f64 {
        self.timestamp_microseconds as f64 / 1_000_000.0
    }

    pub fn duration_seconds(&self) -> f64 {
        self.duration_microseconds as f64 / 1_000_000.0
    }
}

/// An animation with no frames to decode.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NoDecodableFrames;

impl fmt::Display for NoDecodableFrames {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("The animation does not contain any decodable frames.")
    }
}

impl Error for NoDecodableFrames {}

/// Times each frame from the durations its decoder reports, `None` where it reports none: one
/// video frame per image frame, each keeping its own duration, back to back from zero.
pub fn plan_animation_frames(
    durations: impl IntoIterator<Item = Option<u64>>,
) -> Result<Vec<AnimationFrame>, NoDecodableFrames> {
    let mut timestamp_microseconds = 0;
    let frames: Vec<AnimationFrame> = durations
        .into_iter()
        .enumerate()
        .map(|(index, duration)| {
            let duration_microseconds = duration
                .unwrap_or(DEFAULT_FRAME_DURATION_MICROSECONDS)
                .max(MINIMUM_FRAME_DURATION_MICROSECONDS);
            let frame = AnimationFrame {
                timestamp_microseconds,
                duration_microseconds,
                key_frame: index == 0,
            };
            timestamp_microseconds += duration_microseconds;
            frame
        })
        .collect();
    if frames.is_empty() {
        return Err(NoDecodableFrames);
    }
    Ok(frames)
}
