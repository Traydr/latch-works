//! `media-format`'s policies in Rust: which file becomes what in the archive, with which settings.
//!
//! The TypeScript package stays, since Gather Box and Electron Oriel use it. The encoders are not
//! ported here: the wasm AVIF encoder and Mediabunny become libavif and ffmpeg in the port (plan
//! 063), and this crate gives them the same decisions. Each rule is checked against conformance
//! vectors the TypeScript makes, in `apps/oriel-gpui/conformance/media-format/`. The functions keep
//! the TypeScript's names, so each can be found in both.
//!
//! File names are `&str`, as the TypeScript's are strings; see `oriel-core-domain`'s paths for
//! what that means for names that are not Unicode.

mod animation;
mod avif;
mod file_names;
mod still_policy;
mod video_policy;

pub use animation::{
    ANIMATION_BACKGROUND, ANIMATION_MP4_SETTINGS, AnimatedImageMimeType, AnimationFrame,
    AnimationMp4Settings, DEFAULT_FRAME_DURATION_MICROSECONDS, MINIMUM_FRAME_DURATION_MICROSECONDS,
    NoDecodableFrames, animation_canvas_size, plan_animation_frames,
};
pub use avif::{
    ARCHIVE_AVIF_LOW_MEMORY_SPEED, ARCHIVE_AVIF_OPTIONS, ARCHIVE_AVIF_QUALITY,
    ARCHIVE_AVIF_SHARP_OPTIONS, ARCHIVE_AVIF_SPEED, ARCHIVE_AVIF_WASM_PIXEL_LIMIT,
    AvifEncodeOptions, SharpAvifOptions, encode_archive_avif,
};
pub use file_names::{get_file_extension, replace_file_extension};
pub use still_policy::{
    ArchiveImageFormat, ArchiveImageSource, ArchiveMediaAction, ArchiveMediaPlan,
    get_expected_archive_target, plan_archive_image, plan_archive_media,
};
pub use video_policy::{
    ARCHIVE_AUDIO_CODECS, ARCHIVE_DEFAULT_VIDEO_CODEC, ARCHIVE_VIDEO_CODECS, ArchiveVideoCodec,
    ArchiveVideoPlan, ArchiveVideoSource, AudioCodec, AudioTrackPlan, VIDEO_CONTAINERS, VideoCodec,
    VideoContainer, VideoTrackPlan, is_archive_video_codec, plan_archive_video, plan_strip_audio,
    plan_video_reencode,
};
