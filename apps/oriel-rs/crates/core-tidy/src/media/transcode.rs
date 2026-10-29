//! Videos and animations to MP4 through the pinned ffmpeg, from glazier-core's
//! `media/ffmpeg-transcode.ts`.
//!
//! Electron Oriel converts through Mediabunny on WebCodecs and falls back to ffmpeg; Oriel RS has
//! no WebCodecs, so ffmpeg is its only path (plan 063, "Conversion is slower"). Videos get the
//! fallback's arguments word for word. Animations get them too, with the decisions Mediabunny
//! makes where ffmpeg's own differ (`oriel-core-format`'s `animation` module, and
//! `docs/research/oriel-rs/phase-1.md`), since Electron Oriel keeps Mediabunny's result whenever
//! it passes the executor's check:
//!
//! - an odd size is padded to even, the frame at the top left, where the fallback crops;
//! - transparency is drawn over black ([`ANIMATION_BACKGROUND`]);
//! - each image frame is one video frame at its own time, where ffmpeg would resample to a
//!   constant rate;
//! - a key frame at least every [`ANIMATION_MP4_SETTINGS`]' interval.
//!
//! GIF delays keep ffmpeg's reading (under 20 ms shows for 100 ms): Mediabunny's 10 ms for such
//! a frame makes a result shorter than the catalog's duration, which the executor's check
//! rejects, and Electron Oriel then keeps ffmpeg's. Quality stays the fallback's CRF, not
//! Mediabunny's bitrate.

use std::path::Path;
use std::time::Duration;

use oriel_core_format::{
    ANIMATION_BACKGROUND, ANIMATION_MP4_SETTINGS, ArchiveVideoCodec, AudioTrackPlan, VideoTrackPlan,
};
use oriel_runtime::CancelToken;
use oriel_tools::ToolRun;

use super::ToolFailure;
use crate::contract::VideoQuality;

/// A long video re-encoded in software takes a while; this bounds a hung ffmpeg, not a slow one.
const TRANSCODE_TIMEOUT: Duration = Duration::from_secs(6 * 60 * 60);

/// Constant-rate-factor per encoder and quality: lower is better and larger. AV1's "high" is CRF
/// 35, the balance of size and picture the owner chose from side-by-side encodes of the library.
pub fn crf(codec: ArchiveVideoCodec, quality: VideoQuality) -> u32 {
    match (codec, quality) {
        (ArchiveVideoCodec::Avc, VideoQuality::Medium) => 23,
        (ArchiveVideoCodec::Avc, VideoQuality::High) => 20,
        (ArchiveVideoCodec::Avc, VideoQuality::VeryHigh) => 17,
        (ArchiveVideoCodec::Hevc, VideoQuality::Medium) => 28,
        (ArchiveVideoCodec::Hevc, VideoQuality::High) => 24,
        (ArchiveVideoCodec::Hevc, VideoQuality::VeryHigh) => 21,
        (ArchiveVideoCodec::Av1, VideoQuality::Medium) => 40,
        (ArchiveVideoCodec::Av1, VideoQuality::High) => 35,
        (ArchiveVideoCodec::Av1, VideoQuality::VeryHigh) => 30,
    }
}

/// H.264 and HEVC take only even frame sizes, so an odd-sized video loses its last pixel row or
/// column, as on the Mediabunny path for video.
const EVEN_SIZE_FILTER: &str = "crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0";

/// What one conversion makes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TranscodeJob<'a> {
    Animation {
        src: &'a Path,
        out: &'a Path,
    },
    Video {
        src: &'a Path,
        out: &'a Path,
        video: VideoTrackPlan,
        audio: AudioTrackPlan,
        quality: VideoQuality,
    },
}

fn video_args(video: VideoTrackPlan, quality: VideoQuality) -> Vec<String> {
    let codec = match video {
        VideoTrackPlan::Copy => return vec!["-c:v".into(), "copy".into()],
        VideoTrackPlan::Encode { codec } => codec,
    };
    let common = [
        "-vf".to_owned(),
        EVEN_SIZE_FILTER.to_owned(),
        "-crf".to_owned(),
        crf(codec, quality).to_string(),
    ];
    let eight_bit = ["-pix_fmt", "yuv420p"];
    let head: &[&str] = match codec {
        ArchiveVideoCodec::Avc => &["-c:v", "libx264", "-preset", "medium"],
        // `hvc1` is the tag Apple players need to play HEVC in MP4.
        ArchiveVideoCodec::Hevc => &["-c:v", "libx265", "-preset", "medium", "-tag:v", "hvc1"],
        // SVT-AV1 takes 8- and 10-bit 4:2:0, so a 10-bit (HDR) source stays 10-bit, and its
        // colour tags carry over.
        ArchiveVideoCodec::Av1 => &["-c:v", "libsvtav1", "-preset", "6"],
    };
    let mut args: Vec<String> = head.iter().map(|&arg| arg.to_owned()).collect();
    if codec != ArchiveVideoCodec::Av1 {
        args.extend(eight_bit.iter().map(|&arg| arg.to_owned()));
    }
    args.extend(common);
    args
}

fn audio_args(audio: AudioTrackPlan) -> &'static [&'static str] {
    match audio {
        AudioTrackPlan::Copy => &["-map", "0:a:0?", "-c:a", "copy"],
        AudioTrackPlan::EncodeAac => &["-map", "0:a:0?", "-c:a", "aac", "-b:a", "192k"],
        AudioTrackPlan::Drop => &["-an"],
    }
}

/// The filter an animation goes through: drawn over black (premultiplying by alpha is exactly
/// "source over black"), then padded to even with the frame at the top left.
fn animation_filter() -> String {
    let [red, green, blue] = ANIMATION_BACKGROUND;
    format!(
        "format=gbrap,premultiply=inplace=1,format=gbrp,\
         pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0:color=0x{red:02x}{green:02x}{blue:02x},\
         format=yuv420p"
    )
}

/// ffmpeg's arguments for a job, as glazier-core's `ffmpegArgs` builds them (animations aside,
/// see the module's notes).
pub fn ffmpeg_args(job: &TranscodeJob<'_>) -> Vec<std::ffi::OsString> {
    let (src, out) = match job {
        TranscodeJob::Animation { src, out } | TranscodeJob::Video { src, out, .. } => (src, out),
    };
    let mut args: Vec<std::ffi::OsString> = ["-hide_banner", "-loglevel", "error", "-y", "-i"]
        .iter()
        .map(Into::into)
        .collect();
    args.push(src.as_os_str().to_owned());
    let mut push = |items: &[&str]| args.extend(items.iter().map(Into::into));
    match job {
        TranscodeJob::Video {
            video,
            audio,
            quality,
            ..
        } => {
            push(&["-map", "0:v:0"]);
            let video = video_args(*video, *quality);
            push(&video.iter().map(String::as_str).collect::<Vec<_>>());
            push(audio_args(*audio));
        }
        TranscodeJob::Animation { .. } => {
            let crf = crf(ANIMATION_MP4_SETTINGS.codec, VideoQuality::High).to_string();
            let key_frames = format!(
                "expr:gte(t,n_forced*{})",
                ANIMATION_MP4_SETTINGS.key_frame_interval_seconds
            );
            let filter = animation_filter();
            push(&[
                "-map",
                "0:v:0",
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                &crf,
                "-vf",
                &filter,
                "-pix_fmt",
                "yuv420p",
                "-fps_mode",
                "passthrough",
                "-force_key_frames",
                &key_frames,
                "-an",
            ]);
        }
    }
    push(&["-map_metadata", "0", "-movflags", "+faststart", "-f", "mp4"]);
    args.push(out.as_os_str().to_owned());
    args
}

/// Whether this ffmpeg was built with SVT-AV1; false when it cannot be asked.
pub fn has_svt_av1(ffmpeg: &Path) -> bool {
    let Ok(output) = ToolRun::new(ffmpeg, Duration::from_secs(15))
        .args(["-hide_banner", "-encoders"])
        .run()
    else {
        return false;
    };
    output.success()
        && String::from_utf8_lossy(&output.stdout)
            .split(|character: char| !(character.is_alphanumeric() || character == '_'))
            .any(|word| word == "libsvtav1")
}

/// Runs one conversion with ffmpeg, killed when `cancel` is.
pub fn transcode_with_ffmpeg(
    ffmpeg: &Path,
    job: &TranscodeJob<'_>,
    cancel: Option<&CancelToken>,
) -> Result<(), ToolFailure> {
    let mut run = ToolRun::new(ffmpeg, TRANSCODE_TIMEOUT).args(ffmpeg_args(job));
    if let Some(token) = cancel {
        run = run.cancel_on(token);
    }
    let output = match run.run() {
        Ok(output) => output,
        Err(error) if error.is_cancelled() => return Err(ToolFailure::Cancelled),
        Err(error) => return Err(ToolFailure::Failed(format!("{error}"))),
    };
    if !output.success() {
        let last = output.stderr.trim().lines().last().unwrap_or("").to_owned();
        return Err(ToolFailure::Failed(if last.is_empty() {
            "ffmpeg could not convert the file.".to_owned()
        } else {
            last
        }));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(args: Vec<std::ffi::OsString>) -> String {
        args.iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(" ")
    }

    #[test]
    fn video_arguments_are_the_fallbacks() {
        let job = TranscodeJob::Video {
            src: Path::new("/a/in.webm"),
            out: Path::new("/a/out.mp4"),
            video: VideoTrackPlan::Encode {
                codec: ArchiveVideoCodec::Avc,
            },
            audio: AudioTrackPlan::EncodeAac,
            quality: VideoQuality::High,
        };
        assert_eq!(
            text(ffmpeg_args(&job)),
            "-hide_banner -loglevel error -y -i /a/in.webm -map 0:v:0 -c:v libx264 -preset \
             medium -pix_fmt yuv420p -vf crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0 -crf 20 -map \
             0:a:0? -c:a aac -b:a 192k -map_metadata 0 -movflags +faststart -f mp4 /a/out.mp4"
        );
        let shrink = TranscodeJob::Video {
            src: Path::new("/a/in.mp4"),
            out: Path::new("/a/in.mp4.glazier-tmp"),
            video: VideoTrackPlan::Encode {
                codec: ArchiveVideoCodec::Av1,
            },
            audio: AudioTrackPlan::Copy,
            quality: VideoQuality::High,
        };
        assert_eq!(
            text(ffmpeg_args(&shrink)),
            "-hide_banner -loglevel error -y -i /a/in.mp4 -map 0:v:0 -c:v libsvtav1 -preset 6 \
             -vf crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0 -crf 35 -map 0:a:0? -c:a copy \
             -map_metadata 0 -movflags +faststart -f mp4 /a/in.mp4.glazier-tmp"
        );
        let remux = TranscodeJob::Video {
            src: Path::new("/a/in.mov"),
            out: Path::new("/a/in.mp4"),
            video: VideoTrackPlan::Copy,
            audio: AudioTrackPlan::Drop,
            quality: VideoQuality::High,
        };
        assert_eq!(
            text(ffmpeg_args(&remux)),
            "-hide_banner -loglevel error -y -i /a/in.mov -map 0:v:0 -c:v copy -an \
             -map_metadata 0 -movflags +faststart -f mp4 /a/in.mp4"
        );
    }
}
