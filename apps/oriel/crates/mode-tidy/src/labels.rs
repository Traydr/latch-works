//! The names Tidy gives the catalog's values, folders and paths. Numbers, sizes and dates are
//! `oriel_core_domain::format`'s.

use std::path::Path;

use oriel_core_domain::format;
use oriel_core_tidy::contract::{
    AudioState, FileFlag, FileFormat, FileKind, FileRow, OptimizeCategory, SkipReason,
};

/// A format's name as people write it.
pub fn format_label(format: Option<FileFormat>) -> &'static str {
    let Some(format) = format else {
        return "Unread";
    };
    match format {
        FileFormat::Jpeg => "JPEG",
        FileFormat::Png => "PNG",
        FileFormat::Gif => "GIF",
        FileFormat::Webp => "WebP",
        FileFormat::Bmp => "BMP",
        FileFormat::Tiff => "TIFF",
        FileFormat::Avif => "AVIF",
        FileFormat::Heic => "HEIC",
        FileFormat::Psd => "PSD",
        FileFormat::Svg => "SVG",
        FileFormat::Mp4 => "MP4",
        FileFormat::Mov => "MOV",
        FileFormat::Matroska => "MKV",
        FileFormat::Webm => "WebM",
        FileFormat::Mpegts => "MPEG-TS",
        FileFormat::Avi => "AVI",
        FileFormat::Flv => "FLV",
        FileFormat::Asf => "WMV",
        FileFormat::Mp3 => "MP3",
        FileFormat::M4a => "M4A",
        FileFormat::Wav => "WAV",
        FileFormat::Flac => "FLAC",
        FileFormat::Ogg => "Ogg",
        FileFormat::Pdf => "PDF",
        FileFormat::Zip => "ZIP",
        FileFormat::Rar => "RAR",
        FileFormat::SevenZ => "7z",
        FileFormat::Empty => "Empty",
        FileFormat::Unknown => "Other",
    }
}

/// A kind's name in the Library's filters.
pub fn kind_label(kind: FileKind) -> &'static str {
    match kind {
        FileKind::Image => "Images",
        FileKind::Video => "Videos",
        FileKind::Audio => "Audio",
        FileKind::Pdf => "PDFs",
        FileKind::Other => "Other",
        FileKind::Junk => "System junk",
    }
}

/// What a file's sound is, in words.
pub fn audio_label(state: AudioState) -> &'static str {
    match state {
        AudioState::None => "No audio track",
        AudioState::Silent => "Silent track",
        AudioState::Sound => "Has sound",
        AudioState::Unmeasured => "Not measured yet",
    }
}

/// A flag's name in the Library's filters.
pub fn flag_label(flag: FileFlag) -> &'static str {
    match flag {
        FileFlag::Duplicate => "Duplicates",
        FileFlag::Convertible => "Can be converted",
        FileFlag::ExtensionMismatch => "Wrong extension",
        FileFlag::Undecodable => "Won't open",
        FileFlag::ZeroByte => "Empty files",
        FileFlag::Animated => "Animated",
        FileFlag::Unsupported => "No app shows these",
        FileFlag::Junk => "System junk",
    }
}

/// Why Convert or Shrink left files as they are, after their count: "3 came out no smaller",
/// "1 video is already AV1". `nouns` names what is counted, for one and for several, or the count
/// stands alone.
pub fn skip_reason(reason: &SkipReason, files: i64, nouns: Option<(&str, &str)>) -> String {
    let count = match nouns {
        Some((one, many)) => format::plural_as(files, one, many),
        None => format::count(files),
    };
    let one = files == 1;
    let is = if one { "is" } else { "are" };
    let words = match reason {
        SkipReason::NotSmaller => "came out no smaller".to_owned(),
        SkipReason::NotSmallerAsAv1 => "came out no smaller as AV1".to_owned(),
        SkipReason::WontDecode => "won't open".to_owned(),
        SkipReason::NameTaken => "would take a name already in use".to_owned(),
        SkipReason::StillKept(format) => {
            let format = format_label(Some(*format));
            if one {
                format!("is a {format} still, left as it is")
            } else {
                format!("are {format} stills, left as they are")
            }
        }
        SkipReason::AlreadyAv1 => format!("{is} already AV1"),
        SkipReason::AlreadyCompact => format!("{is} already compact, so AV1 would save little"),
        SkipReason::CannotReencode => "can't be re-encoded".to_owned(),
        SkipReason::SizeUnknown => {
            format!(
                "{} no known size or bitrate",
                if one { "has" } else { "have" }
            )
        }
        // The archive policy's own words.
        SkipReason::Unsupported(reason) => return format!("{count}: {reason}"),
    };
    format!("{count} {words}")
}

/// The flags the filter's Issues group offers; junk is a kind.
pub fn issue_flags() -> impl Iterator<Item = FileFlag> {
    FileFlag::ALL
        .iter()
        .copied()
        .filter(|flag| *flag != FileFlag::Junk)
}

/// A video nobody can hear.
pub fn is_mute_video(row: &FileRow) -> bool {
    row.kind == FileKind::Video
        && matches!(row.audio_state, Some(AudioState::None | AudioState::Silent))
}

/// What the Convert button says Convert does to one file.
pub fn convert_as(category: OptimizeCategory) -> &'static str {
    match category {
        OptimizeCategory::StillToAvif => "Convert to AVIF",
        OptimizeCategory::AnimationToMp4
        | OptimizeCategory::VideoRemux
        | OptimizeCategory::VideoConvert => "Convert to MP4",
        OptimizeCategory::RenameAvif => "Rename to .avif",
        OptimizeCategory::RenameMp4 => "Rename to .mp4",
    }
}

/// "Convert 3", or "Convert 1 of 3".
pub fn convert_label(convertible: i64, files: i64) -> String {
    if convertible < files {
        format!(
            "Convert {} of {}",
            format::count(convertible),
            format::count(files)
        )
    } else {
        format!("Convert {}", format::count(convertible))
    }
}

/// A file's pixels, codec and length, or its frames.
pub fn details(row: &FileRow) -> String {
    let mut parts = Vec::new();
    if let Some(dimensions) = dimensions(row) {
        parts.push(dimensions);
    }
    if row.kind == FileKind::Video {
        let codec = codec_label(row.video_codec.as_deref());
        if !codec.is_empty() {
            parts.push(codec);
        }
        if row.duration_ms.is_some() {
            parts.push(format::duration(row.duration_ms));
        }
    } else if row.frames.unwrap_or(1) > 1 {
        parts.push(format!("{} frames", row.frames.unwrap_or(1)));
    }
    parts.join(" · ")
}

/// Pixels as "640×480", when known.
pub fn dimensions(row: &FileRow) -> Option<String> {
    Some(format!("{}×{}", row.width?, row.height?))
}

/// A codec's name as people write it, from ffprobe's.
pub fn codec_label(codec: Option<&str>) -> String {
    match codec {
        None => String::new(),
        Some("h264") => "H.264".into(),
        Some("hevc") => "HEVC".into(),
        Some("av1") => "AV1".into(),
        Some("vp9") => "VP9".into(),
        Some("vp8") => "VP8".into(),
        Some("prores") => "ProRes".into(),
        Some("mpeg4") => "MPEG-4".into(),
        Some("aac") => "AAC".into(),
        Some("mp3") => "MP3".into(),
        Some("opus") => "Opus".into(),
        Some("vorbis") => "Vorbis".into(),
        Some("flac") => "FLAC".into(),
        Some(other) => other.to_uppercase(),
    }
}

/// A folder inside the root as the pages name it: its path, or "the top folder" for the root.
pub fn folder(dir: &str) -> &str {
    if dir.is_empty() {
        "the top folder"
    } else {
        dir
    }
}

/// [`folder`] at the start of a sentence.
pub fn folder_capitalized(dir: &str) -> &str {
    if dir.is_empty() {
        "The top folder"
    } else {
        dir
    }
}

/// `path` inside the root, or as it is when it lies elsewhere.
pub fn relative_to(root: &str, path: &str) -> String {
    oriel_core_tidy::relative_within(Path::new(path), Path::new(root))
        .unwrap_or_else(|| path.to_string())
}

/// The last name of a path, as the catalog or the OS writes it; the path itself when it has
/// none, as `/` has not.
pub fn file_name(path: &str) -> &str {
    path.rsplit(['/', '\\'])
        .find(|name| !name.is_empty())
        .unwrap_or(path)
}
