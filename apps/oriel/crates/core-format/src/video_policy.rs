//! How a video file reaches the archive's format, from `media-format`'s `video-policy.ts`: MP4
//! with archive codecs, copying every track that already is one.

use serde::{Deserialize, Serialize};

use crate::{get_file_extension, replace_file_extension};

/// A video track's codec as Mediabunny names it, with `Other` for one it does not. The serde
/// names are Mediabunny's.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VideoCodec {
    Avc,
    Hevc,
    Vp9,
    Av1,
    Vp8,
    Prores,
    Other,
}

impl VideoCodec {
    /// The codec of ffprobe's `codec_name`.
    pub fn from_ffprobe(name: &str) -> Self {
        match name {
            "h264" => Self::Avc,
            "hevc" => Self::Hevc,
            "av1" => Self::Av1,
            "vp9" => Self::Vp9,
            "vp8" => Self::Vp8,
            "prores" => Self::Prores,
            _ => Self::Other,
        }
    }
}

/// An audio track's codec as Mediabunny names it, with `Other` for one it does not.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AudioCodec {
    Aac,
    Opus,
    Mp3,
    Vorbis,
    Flac,
    Ac3,
    Eac3,
    Dts,
    PcmS16,
    PcmS16be,
    PcmS24,
    PcmS24be,
    PcmS32,
    PcmS32be,
    PcmF32,
    PcmF32be,
    PcmF64,
    PcmF64be,
    PcmU8,
    PcmS8,
    Ulaw,
    Alaw,
    Other,
}

impl AudioCodec {
    /// The codec of ffprobe's `codec_name`.
    pub fn from_ffprobe(name: &str) -> Self {
        match name {
            "aac" => Self::Aac,
            "mp3" => Self::Mp3,
            "opus" => Self::Opus,
            "vorbis" => Self::Vorbis,
            "flac" => Self::Flac,
            "ac3" => Self::Ac3,
            "eac3" => Self::Eac3,
            "dts" => Self::Dts,
            "pcm_s16le" => Self::PcmS16,
            "pcm_s16be" => Self::PcmS16be,
            "pcm_s24le" => Self::PcmS24,
            "pcm_s32le" => Self::PcmS32,
            "pcm_f32le" => Self::PcmF32,
            "pcm_u8" => Self::PcmU8,
            _ => Self::Other,
        }
    }
}

/// The video codecs stored as they are when a file moves into MP4. H.264 plays everywhere, HEVC
/// and AV1 only on newer devices, so nothing is re-encoded into them unless the owner asks.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArchiveVideoCodec {
    Avc,
    Hevc,
    Av1,
}

impl ArchiveVideoCodec {
    /// The archive codec `codec` is, if it is one.
    pub fn from_codec(codec: VideoCodec) -> Option<Self> {
        match codec {
            VideoCodec::Avc => Some(Self::Avc),
            VideoCodec::Hevc => Some(Self::Hevc),
            VideoCodec::Av1 => Some(Self::Av1),
            VideoCodec::Vp9 | VideoCodec::Vp8 | VideoCodec::Prores | VideoCodec::Other => None,
        }
    }
}

impl From<ArchiveVideoCodec> for VideoCodec {
    fn from(codec: ArchiveVideoCodec) -> Self {
        match codec {
            ArchiveVideoCodec::Avc => Self::Avc,
            ArchiveVideoCodec::Hevc => Self::Hevc,
            ArchiveVideoCodec::Av1 => Self::Av1,
        }
    }
}

/// Audio codecs MP4 players accept everywhere; other audio becomes AAC.
const ARCHIVE_AUDIO_CODECS: [AudioCodec; 2] = [AudioCodec::Aac, AudioCodec::Mp3];

/// The codec a video track is re-encoded to when its own codec is not an archive codec.
const ARCHIVE_DEFAULT_VIDEO_CODEC: ArchiveVideoCodec = ArchiveVideoCodec::Avc;

/// A video file's container as read from its first bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VideoContainer {
    Mp4,
    Mov,
    Matroska,
    Webm,
    Mpegts,
    Avi,
    Flv,
    Asf,
}

impl VideoContainer {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Mp4 => "mp4",
            Self::Mov => "mov",
            Self::Matroska => "matroska",
            Self::Webm => "webm",
            Self::Mpegts => "mpegts",
            Self::Avi => "avi",
            Self::Flv => "flv",
            Self::Asf => "asf",
        }
    }

    /// Whether a file in this container converts to MP4. These are the containers Mediabunny
    /// reads, which the policy was written for; ffmpeg reads AVI, FLV and ASF too, but Tidy
    /// reports them for a human look instead.
    pub fn is_convertible(self) -> bool {
        matches!(
            self,
            Self::Mp4 | Self::Mov | Self::Matroska | Self::Webm | Self::Mpegts
        )
    }
}

/// What the policy needs to know about a video file, decoded from a probe at its boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ArchiveVideoSource<'a> {
    pub file_name: &'a str,
    pub container: VideoContainer,
    /// The primary video track's codec, or `None` when the file has no video.
    pub video_codec: Option<VideoCodec>,
    /// The primary audio track's codec, or `None` when the file has no audio.
    pub audio_codec: Option<AudioCodec>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case")]
pub enum VideoTrackPlan {
    Copy,
    Encode { codec: ArchiveVideoCodec },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case")]
pub enum AudioTrackPlan {
    Copy,
    EncodeAac,
    Drop,
}

/// What happens to a video. The serde form is the TypeScript's, tagged by `action`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ArchiveVideoPlan {
    RenameMp4 {
        file_name: String,
    },
    ConvertMp4 {
        file_name: String,
        video: VideoTrackPlan,
        audio: AudioTrackPlan,
    },
    Unsupported {
        reason: String,
    },
}

/// Plans how a video file reaches the archive format: MP4 with archive codecs. Returns `None`
/// when the file already is one. Tracks that already use an archive codec are copied, so moving
/// an H.264 MKV or MOV into MP4 is lossless.
pub fn plan_archive_video(source: &ArchiveVideoSource<'_>) -> Option<ArchiveVideoPlan> {
    if !source.container.is_convertible() {
        return Some(ArchiveVideoPlan::Unsupported {
            reason: format!(
                "The {} container cannot be read for conversion.",
                source.container.as_str().to_ascii_uppercase()
            ),
        });
    }
    let Some(video_codec) = source.video_codec else {
        return Some(ArchiveVideoPlan::Unsupported {
            reason: "The file has no video track.".to_owned(),
        });
    };

    let video = plan_video_track(video_codec);
    let audio = plan_audio_track(source.audio_codec);
    let file_name = replace_file_extension(source.file_name, "mp4");

    if source.container == VideoContainer::Mp4
        && video == VideoTrackPlan::Copy
        && audio == AudioTrackPlan::Copy
    {
        return (get_file_extension(source.file_name) != "mp4")
            .then_some(ArchiveVideoPlan::RenameMp4 { file_name });
    }

    Some(ArchiveVideoPlan::ConvertMp4 {
        file_name,
        video,
        audio,
    })
}

/// Plans an explicit re-encode of a video into `codec`, inside MP4. Audio is copied when it is
/// already an archive codec. This is never chosen automatically; the owner asks for it.
pub fn plan_video_reencode(
    source: &ArchiveVideoSource<'_>,
    codec: ArchiveVideoCodec,
) -> ArchiveVideoPlan {
    if !source.container.is_convertible() || source.video_codec.is_none() {
        return ArchiveVideoPlan::Unsupported {
            reason: "This file cannot be re-encoded.".to_owned(),
        };
    }
    ArchiveVideoPlan::ConvertMp4 {
        file_name: replace_file_extension(source.file_name, "mp4"),
        video: VideoTrackPlan::Encode { codec },
        audio: plan_audio_track(source.audio_codec),
    }
}

/// Plans removing the audio from a video while copying its picture into MP4 as it is, or
/// re-encoding it when it is not an archive codec.
pub fn plan_strip_audio(source: &ArchiveVideoSource<'_>) -> ArchiveVideoPlan {
    let Some(video_codec) = source
        .video_codec
        .filter(|_| source.container.is_convertible())
    else {
        return ArchiveVideoPlan::Unsupported {
            reason: "This file cannot be rewritten without its audio.".to_owned(),
        };
    };
    ArchiveVideoPlan::ConvertMp4 {
        file_name: replace_file_extension(source.file_name, "mp4"),
        video: plan_video_track(video_codec),
        audio: AudioTrackPlan::Drop,
    }
}

pub fn is_archive_video_codec(codec: VideoCodec) -> bool {
    ArchiveVideoCodec::from_codec(codec).is_some()
}

/// Whether a video is in the archive's format already: MP4 with an archive video codec.
pub fn is_archive_video(container: VideoContainer, video_codec: Option<VideoCodec>) -> bool {
    container == VideoContainer::Mp4 && video_codec.is_some_and(is_archive_video_codec)
}

fn plan_video_track(codec: VideoCodec) -> VideoTrackPlan {
    if is_archive_video_codec(codec) {
        VideoTrackPlan::Copy
    } else {
        VideoTrackPlan::Encode {
            codec: ARCHIVE_DEFAULT_VIDEO_CODEC,
        }
    }
}

fn plan_audio_track(codec: Option<AudioCodec>) -> AudioTrackPlan {
    match codec {
        None => AudioTrackPlan::Copy,
        Some(codec) if ARCHIVE_AUDIO_CODECS.contains(&codec) => AudioTrackPlan::Copy,
        Some(_) => AudioTrackPlan::EncodeAac,
    }
}
