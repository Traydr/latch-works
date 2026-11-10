//! `media-format`'s policies in Rust: which file becomes what in the archive, with which settings.
//!
//! Gather Box runs the TypeScript package; Tidy runs these. The rules both run (file names, the
//! AVIF settings) are checked against conformance vectors the TypeScript makes, in
//! `apps/oriel/conformance/media-format/`; the video and image plans only Tidy runs are Rust's
//! own, and their vectors are frozen Rust fixtures. The functions keep the TypeScript's names, so
//! each can be found in both.
//!
//! File names are `&str`, as the TypeScript's are strings; see `oriel-core-domain`'s paths for
//! what that means for names that are not Unicode.

mod animation;
mod avif;
mod file_names;
mod still_policy;
mod video_policy;

pub use animation::{ANIMATION_MP4_SETTINGS, AnimatedImageMimeType, AnimationMp4Settings};
pub use avif::{
    ARCHIVE_AVIF_LOW_MEMORY_SPEED, ARCHIVE_AVIF_OPTIONS, ARCHIVE_AVIF_QUALITY, ARCHIVE_AVIF_SPEED,
    AvifEncodeOptions, encode_archive_avif,
};
pub use file_names::{get_file_extension, replace_file_extension};
pub use still_policy::{
    ArchiveImageFormat, ArchiveImageSource, ArchiveMediaAction, ArchiveMediaPlan,
    plan_archive_image,
};
pub use video_policy::{
    ArchiveVideoCodec, ArchiveVideoPlan, ArchiveVideoSource, AudioCodec, AudioTrackPlan,
    VideoCodec, VideoContainer, VideoTrackPlan, is_archive_video, is_archive_video_codec,
    plan_archive_video, plan_strip_audio, plan_video_reencode,
};
