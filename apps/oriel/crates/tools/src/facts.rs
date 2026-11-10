//! What the modes read of a video with the pinned tools: ffprobe's facts ([`VideoProbe`]) and a
//! poster frame from ffmpeg, the same for View's tiles and viewer and for Tidy's catalog and
//! thumbnails.

use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;

use oriel_core_domain::number::{js_number, js_round};
use oriel_runtime::CancelToken;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{LocateError, MediaTools, ToolError, ToolRun};

/// How long ffprobe may take: a file on a slow volume can take a while to open.
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
/// How long ffmpeg may take for one frame.
const FRAME_TIMEOUT: Duration = Duration::from_secs(12);

impl MediaTools {
    /// The process's tools, found on first use.
    pub fn shared() -> Result<&'static MediaTools, &'static LocateError> {
        static SHARED: OnceLock<Result<MediaTools, LocateError>> = OnceLock::new();
        SHARED.get_or_init(MediaTools::locate).as_ref()
    }
}

/// `ffprobe`'s facts about the video at `path`.
pub fn probe_video(
    ffprobe: &Path,
    path: &Path,
    cancel: Option<&CancelToken>,
) -> Result<VideoProbe, ToolError> {
    let mut run = ToolRun::new(ffprobe, PROBE_TIMEOUT)
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_streams",
            "-show_format",
        ])
        .arg(path);
    if let Some(token) = cancel {
        run = run.cancel_on(token);
    }
    let output = run.run()?;
    if !output.success() {
        let last = output.stderr.trim().lines().last().unwrap_or("").to_owned();
        return Err(ToolError::Failed(if last.is_empty() {
            "ffprobe could not read the file.".to_owned()
        } else {
            last
        }));
    }
    parse_video_probe(&String::from_utf8_lossy(&output.stdout)).map_err(ToolError::Failed)
}

/// One frame of the video at `path` as PNG bytes from `ffmpeg`: a second in, or its first frame
/// when it is shorter than that.
///
/// The PNG is compressed at zlib's quickest level, not ffmpeg's default: it only crosses a pipe to
/// be decoded at once, and decodes to the same pixels, while the default's compression of a
/// full-size frame took most of the run. Stored outright it would be a little quicker still, but
/// five times the size, and the allocator keeps what such frames leave behind.
pub fn poster_frame(
    ffmpeg: &Path,
    path: &Path,
    cancel: Option<&CancelToken>,
) -> Result<Vec<u8>, ToolError> {
    let mut failure = ToolError::Failed("ffmpeg could not read a frame.".to_owned());
    for start in ["00:00:01", "00:00:00"] {
        let mut run = ToolRun::new(ffmpeg, FRAME_TIMEOUT)
            .args(["-hide_banner", "-loglevel", "error", "-ss", start, "-i"])
            .arg(path)
            .args([
                "-frames:v",
                "1",
                "-f",
                "image2pipe",
                "-vcodec",
                "png",
                "-compression_level",
                "1",
                "pipe:1",
            ]);
        if let Some(token) = cancel {
            run = run.cancel_on(token);
        }
        match run.run() {
            Ok(output) if output.success() && !output.stdout.is_empty() => return Ok(output.stdout),
            Ok(output) => {
                if !output.stderr.trim().is_empty() {
                    failure = ToolError::Failed(output.stderr.trim().to_owned());
                }
            }
            Err(error @ (ToolError::Cancelled | ToolError::Killed)) => return Err(error),
            Err(error) => failure = error,
        }
    }
    Err(failure)
}

/// A video's facts from ffprobe.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoProbe {
    /// Display dimensions, after rotation metadata; `None` when the file has no picture.
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_ms: Option<f64>,
    /// ffprobe's codec name for the primary video track, such as `h264`.
    pub video_codec: Option<String>,
    /// ffprobe's codec name for the first audio track.
    pub audio_codec: Option<String>,
    pub audio_streams: i64,
    pub bitrate: Option<f64>,
}

/// `Number(value)` for a JSON string or number: anything that is not a finite or infinite
/// number is no value.
fn numeric(value: Option<&Value>) -> Option<f64> {
    let number = match value? {
        Value::Number(number) => number.as_f64()?,
        Value::String(text) => js_number(text)?,
        _ => return None,
    };
    (!number.is_nan()).then_some(number)
}

/// Reads ffprobe's `-show_streams -show_format` JSON: the first video stream that is not cover
/// art, its size turned by its rotation, the stream's duration if it is a number and else the
/// container's, rounded to whole milliseconds, the first audio stream's codec and the count of
/// audio streams, and the container's bit rate.
pub fn parse_video_probe(stdout: &str) -> Result<VideoProbe, String> {
    let output: Value = serde_json::from_str(stdout).map_err(|error| error.to_string())?;
    let empty = Vec::new();
    let streams = output
        .get("streams")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    fn text<'a>(stream: &'a Value, key: &str) -> Option<&'a str> {
        stream.get(key).and_then(Value::as_str)
    }
    let video = streams.iter().find(|stream| {
        text(stream, "codec_type") == Some("video")
            && stream
                .get("disposition")
                .and_then(|disposition| disposition.get("attached_pic"))
                .and_then(Value::as_f64)
                != Some(1.0)
    });
    let audio: Vec<&Value> = streams
        .iter()
        .filter(|stream| text(stream, "codec_type") == Some("audio"))
        .collect();
    let rotation = video
        .and_then(|video| video.get("side_data_list"))
        .and_then(Value::as_array)
        .and_then(|list| {
            list.iter()
                .find_map(|entry| entry.get("rotation").and_then(Value::as_f64))
        });
    let tag_rotation = video
        .and_then(|video| video.get("tags"))
        .and_then(|tags| numeric(tags.get("rotate")));
    let turns = js_round(rotation.or(tag_rotation).unwrap_or(0.0) / 90.0).abs() % 2.0;
    let dimension = |key: &str| {
        video
            .and_then(|video| video.get(key))
            .and_then(Value::as_f64)
            .map(|value| value as i64)
    };
    let (width, height) = (dimension("width"), dimension("height"));
    let format = output.get("format");
    let seconds = video
        .and_then(|video| numeric(video.get("duration")))
        .or_else(|| format.and_then(|format| numeric(format.get("duration"))));
    let quarter_turn = turns == 1.0;
    Ok(VideoProbe {
        width: if quarter_turn { height } else { width },
        height: if quarter_turn { width } else { height },
        duration_ms: seconds
            .filter(|seconds| seconds.is_finite())
            .map(|seconds| js_round(seconds * 1000.0)),
        video_codec: video.and_then(|video| text(video, "codec_name").map(str::to_owned)),
        audio_codec: audio
            .first()
            .and_then(|stream| text(stream, "codec_name").map(str::to_owned)),
        audio_streams: audio.len() as i64,
        bitrate: format.and_then(|format| numeric(format.get("bit_rate"))),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The video stream's facts, turned by its rotation, with the container's duration standing
    /// in for a stream without one (MKV's), and cover art never taken for the picture.
    #[test]
    fn reads_the_video_stream_and_falls_back_to_the_container() {
        let probe = parse_video_probe(
            r#"{"streams":[{"codec_type":"audio","codec_name":"aac","duration":"9.0"},
            {"codec_type":"video","codec_name":"h264","width":1920,"height":1080,
            "duration":"4.0006","side_data_list":[{"rotation":-90}]}],
            "format":{"duration":"9.1","bit_rate":"800000"}}"#,
        )
        .unwrap();
        assert_eq!(
            probe,
            VideoProbe {
                width: Some(1080),
                height: Some(1920),
                duration_ms: Some(4001.),
                video_codec: Some("h264".into()),
                audio_codec: Some("aac".into()),
                audio_streams: 1,
                bitrate: Some(800_000.),
            }
        );
        let mkv = parse_video_probe(
            r#"{"streams":[{"codec_type":"video","codec_name":"mjpeg","width":300,"height":300,
            "disposition":{"attached_pic":1}},
            {"codec_type":"video","codec_name":"av1","width":640,"height":360}],
            "format":{"duration":"12.5"}}"#,
        )
        .unwrap();
        assert_eq!(mkv.duration_ms, Some(12_500.));
        assert_eq!(mkv.video_codec.as_deref(), Some("av1"));
        assert!(parse_video_probe("not json").is_err());
    }
}
