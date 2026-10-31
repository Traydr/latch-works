//! How Tidy writes numbers, sizes, lengths, dates and the catalog's values, as Electron Oriel's
//! `lib/format.ts` and `components/library/labels.ts` write them.

use oriel_core_tidy::contract::{AudioState, FileFlag, FileFormat, FileKind, FileRow};

const BYTE_UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];

/// A number of bytes or milliseconds, as the catalog (`i64`) or a sum (`f64`) gives it.
pub trait Number: Copy {
    fn value(self) -> f64;
}

impl Number for f64 {
    fn value(self) -> f64 {
        self
    }
}

impl Number for i64 {
    fn value(self) -> f64 {
        self as f64
    }
}

/// `formatBytes`: decimal units, one decimal under 100.
pub fn bytes(bytes: impl Number) -> String {
    let bytes = bytes.value();
    if bytes < 1000. {
        return format!("{} B", bytes.round() as i64);
    }
    let mut value = bytes;
    let mut unit = 0;
    while value >= 1000. && unit < BYTE_UNITS.len() - 1 {
        value /= 1000.;
        unit += 1;
    }
    if value >= 100. {
        format!("{value:.0} {}", BYTE_UNITS[unit])
    } else {
        format!("{value:.1} {}", BYTE_UNITS[unit])
    }
}

/// `formatCount`: whole numbers grouped by thousands, as `Intl.NumberFormat` writes them in
/// English.
pub fn count(count: i64) -> String {
    let digits = count.unsigned_abs().to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    if count < 0 {
        format!("-{grouped}")
    } else {
        grouped
    }
}

/// `plural`: "1 file", "2 files".
pub fn plural(n: i64, singular: &str) -> String {
    plural_as(n, singular, &format!("{singular}s"))
}

/// `plural` with its own plural form: "1 copy", "2 copies".
pub fn plural_as(n: i64, singular: &str, plural: &str) -> String {
    format!("{} {}", count(n), if n == 1 { singular } else { plural })
}

/// `formatDuration`: "1:05", "1:02:05"; empty without a length.
pub fn duration(ms: Option<f64>) -> String {
    let Some(ms) = ms else {
        return String::new();
    };
    let total = (ms / 1000.).round() as i64;
    let (hours, minutes, seconds) = (total / 3600, total % 3600 / 60, total % 60);
    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes}:{seconds:02}")
    }
}

/// `formatSpan`: a rough length of time, "40 min" or "2 h 40 min".
pub fn span(ms: f64) -> String {
    let minutes = ((ms / 60_000.).round() as i64).max(1);
    if minutes < 60 {
        return format!("{minutes} min");
    }
    let rounded = ((minutes as f64 / 10.).round() as i64) * 10;
    let (hours, rest) = (rounded / 60, rounded % 60);
    if rest == 0 {
        format!("{hours} h")
    } else {
        format!("{hours} h {rest} min")
    }
}

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// A moment in the local time zone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Local {
    year: i64,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
}

#[cfg(target_os = "macos")]
fn local(ms: f64) -> Local {
    let seconds = (ms / 1000.).floor() as libc::time_t;
    // SAFETY: `localtime_r` writes only into the `tm` it is given, which is plain data.
    let tm = unsafe {
        let mut tm = std::mem::zeroed::<libc::tm>();
        libc::localtime_r(&seconds, &mut tm);
        tm
    };
    Local {
        year: i64::from(tm.tm_year) + 1900,
        month: tm.tm_mon as u32 + 1,
        day: tm.tm_mday as u32,
        hour: tm.tm_hour as u32,
        minute: tm.tm_min as u32,
        second: tm.tm_sec as u32,
    }
}

/// Elsewhere, UTC until Phase 8 brings a time zone.
#[cfg(not(target_os = "macos"))]
fn local(ms: f64) -> Local {
    let total = (ms / 1000.).floor() as i64;
    let days = total.div_euclid(86_400);
    let rest = total.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    Local {
        year: yoe + era * 400 + i64::from(month <= 2),
        month,
        day,
        hour: (rest / 3600) as u32,
        minute: (rest / 60 % 60) as u32,
        second: (rest % 60) as u32,
    }
}

/// `formatDate`: "Oct 29, 2026", as `Intl.DateTimeFormat`'s medium date writes it in English.
pub fn date(ms: impl Number) -> String {
    let at = local(ms.value());
    format!("{} {}, {}", MONTHS[at.month as usize - 1], at.day, at.year)
}

/// `formatTime`: "2:31 AM".
pub fn time(ms: impl Number) -> String {
    let at = local(ms.value());
    let hour = match at.hour % 12 {
        0 => 12,
        hour => hour,
    };
    let half = if at.hour < 12 { "AM" } else { "PM" };
    format!("{hour}:{:02} {half}", at.minute)
}

/// `formatDateTime`: "Oct 29, 2026, 2:31 AM".
pub fn date_time(ms: impl Number) -> String {
    format!("{}, {}", date(ms), time(ms))
}

/// `formatDateTimeSeconds`: "Oct 29, 2026, 2:31:05 AM", for telling apart times that share a
/// minute.
pub fn date_time_seconds(ms: impl Number) -> String {
    let at = local(ms.value());
    let hour = match at.hour % 12 {
        0 => 12,
        hour => hour,
    };
    let half = if at.hour < 12 { "AM" } else { "PM" };
    format!(
        "{}, {hour}:{:02}:{:02} {half}",
        date(ms),
        at.minute,
        at.second
    )
}

/// `formatDay`: "Today", "Yesterday", or the date, for grouping by day.
pub fn day(ms: impl Number, now: f64) -> String {
    let ms = ms.value();
    let (at, today, yesterday) = (local(ms), local(now), local(now - 86_400_000.));
    let same = |a: Local, b: Local| (a.year, a.month, a.day) == (b.year, b.month, b.day);
    if same(at, today) {
        "Today".into()
    } else if same(at, yesterday) {
        "Yesterday".into()
    } else {
        date(ms)
    }
}

/// `formatRelative`: "just now", "5 min ago", "3 h ago", or the date.
pub fn relative(ms: Option<f64>, now: f64) -> String {
    let Some(ms) = ms else {
        return "never".into();
    };
    let minutes = ((now - ms) / 60_000.).round() as i64;
    if minutes < 1 {
        return "just now".into();
    }
    if minutes < 60 {
        return format!("{minutes} min ago");
    }
    let hours = (minutes as f64 / 60.).round() as i64;
    if hours < 24 {
        format!("{hours} h ago")
    } else {
        date(ms)
    }
}

/// Milliseconds since 1970, as `Date.now()` gives them.
pub fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0., |elapsed| elapsed.as_millis() as f64)
}

/// `formatLabel`: a format's name as people write it.
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

/// `KIND_LABELS`.
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

/// `AUDIO_LABELS`.
pub fn audio_label(state: AudioState) -> &'static str {
    match state {
        AudioState::None => "No audio track",
        AudioState::Silent => "Silent track",
        AudioState::Sound => "Has sound",
        AudioState::Unmeasured => "Not measured yet",
    }
}

/// `FLAG_LABELS`.
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

/// `ISSUE_FLAGS`: the flags the filter's Issues group offers; junk is a kind.
pub fn issue_flags() -> impl Iterator<Item = FileFlag> {
    FileFlag::ALL
        .iter()
        .copied()
        .filter(|flag| *flag != FileFlag::Junk)
}

/// `isMuteVideo`: a video nobody can hear.
pub fn is_mute_video(row: &FileRow) -> bool {
    row.kind == FileKind::Video
        && matches!(row.audio_state, Some(AudioState::None | AudioState::Silent))
}

/// `convertTarget`: stills become AVIF, everything that moves becomes MP4.
pub fn convert_target(row: &FileRow) -> &'static str {
    if row.kind == FileKind::Video || row.frames.unwrap_or(1) > 1 {
        "MP4"
    } else {
        "AVIF"
    }
}

/// `convertLabel`: "Convert 3", or "Convert 1 of 3".
pub fn convert_label(convertible: i64, files: i64) -> String {
    if convertible < files {
        format!("Convert {} of {}", count(convertible), count(files))
    } else {
        format!("Convert {}", count(convertible))
    }
}

/// A file's pixels, codec and length, or its frames (`describeDetails`).
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
            parts.push(duration(row.duration_ms));
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

/// `codecLabel`.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_numbers_as_the_renderer_does() {
        assert_eq!(bytes(999.), "999 B");
        assert_eq!(bytes(1_500.), "1.5 KB");
        assert_eq!(bytes(250_000_000.), "250 MB");
        assert_eq!(bytes(1_159_079.), "1.2 MB");
        assert_eq!(count(21_135), "21,135");
        assert_eq!(count(-1_000), "-1,000");
        assert_eq!(plural(1, "file"), "1 file");
        assert_eq!(plural(26, "file"), "26 files");
        assert_eq!(plural_as(2, "copy", "copies"), "2 copies");
        assert_eq!(duration(Some(65_000.)), "1:05");
        assert_eq!(duration(Some(3_725_000.)), "1:02:05");
        assert_eq!(span(30_000.), "1 min");
        assert_eq!(span(9_600_000.), "2 h 40 min");
        assert_eq!(relative(None, 0.), "never");
        assert_eq!(relative(Some(0.), 20_000.), "just now");
        assert_eq!(relative(Some(0.), 300_000.), "5 min ago");
    }
}
