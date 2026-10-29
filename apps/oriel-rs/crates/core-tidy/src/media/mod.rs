//! What Tidy reads from ffprobe and ffmpeg, from glazier-core's `media/video-probe.ts` and the
//! loudness pass's `volumedetect`.

use std::path::Path;
use std::time::Duration;

use oriel_runtime::CancelToken;
use oriel_tools::ToolRun;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::number::js_round;

const PROBE_TIMEOUT: Duration = Duration::from_secs(30);

/// Decoding the audio of a long video is fast, but a feature-length file still takes a while.
const LOUDNESS_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// What the catalog keeps of a video's probe.
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

/// Why a tool gave no answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ToolFailure {
    /// The tool ran and said why; the pass records the message.
    Failed(String),
    Cancelled,
}

impl std::fmt::Display for ToolFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Failed(message) => f.write_str(message),
            Self::Cancelled => f.write_str("cancelled"),
        }
    }
}

/// Runs ffprobe on a file and reads its streams and format, as glazier-core's `probeVideo` does.
pub fn probe_video(
    ffprobe: &Path,
    path: &Path,
    cancel: Option<&CancelToken>,
) -> Result<VideoProbe, ToolFailure> {
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
    let output = match run.run() {
        Ok(output) => output,
        Err(error) if error.is_cancelled() => return Err(ToolFailure::Cancelled),
        Err(error) => return Err(ToolFailure::Failed(format!("{error}"))),
    };
    if !output.success() {
        let last = output.stderr.trim().lines().last().unwrap_or("").to_owned();
        return Err(ToolFailure::Failed(if last.is_empty() {
            "ffprobe could not read the file.".to_owned()
        } else {
            last
        }));
    }
    parse_video_probe(&String::from_utf8_lossy(&output.stdout)).map_err(ToolFailure::Failed)
}

/// `Number(value)` for a JSON string or number, as glazier-core's `NumericStringSchema` reads it:
/// anything that is not a finite or infinite number is no value.
fn numeric(value: Option<&Value>) -> Option<f64> {
    let number = match value? {
        Value::Number(number) => number.as_f64()?,
        Value::String(text) => js_number(text)?,
        _ => return None,
    };
    (!number.is_nan()).then_some(number)
}

/// JavaScript's `Number(text)` for the forms ffprobe writes: blank is 0, junk is NaN (`None`).
fn js_number(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }
    match trimmed {
        "Infinity" | "+Infinity" => Some(f64::INFINITY),
        "-Infinity" => Some(f64::NEG_INFINITY),
        _ if trimmed.bytes().all(|byte| {
            byte.is_ascii_digit() || matches!(byte, b'.' | b'-' | b'+' | b'e' | b'E')
        }) =>
        {
            trimmed.parse().ok()
        }
        _ => None,
    }
}

/// Reads ffprobe's `-show_streams -show_format` JSON into a probe, as glazier-core's
/// `FfprobeOutputSchema` and `probeVideo` do.
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

/// The loudest sample of a video's first audio track, in dBFS, from ffmpeg's `volumedetect`.
pub fn measure_peak_volume(
    ffmpeg: &Path,
    path: &Path,
    cancel: Option<&CancelToken>,
) -> Result<f64, ToolFailure> {
    let mut run = ToolRun::new(ffmpeg, LOUDNESS_TIMEOUT)
        .args(["-hide_banner", "-nostats", "-i"])
        .arg(path)
        .args([
            "-map",
            "0:a:0",
            "-vn",
            "-sn",
            "-dn",
            "-af",
            "volumedetect",
            "-f",
            "null",
            "-",
        ]);
    if let Some(token) = cancel {
        run = run.cancel_on(token);
    }
    let output = match run.run() {
        Ok(output) => output,
        Err(error) if error.is_cancelled() => return Err(ToolFailure::Cancelled),
        Err(error) => return Err(ToolFailure::Failed(format!("{error}"))),
    };
    match parse_max_volume(&output.stderr) {
        Some(peak) if output.success() => Ok(peak),
        _ => Err(ToolFailure::Failed(
            "ffmpeg could not measure the audio.".to_owned(),
        )),
    }
}

/// glazier-core's `/max_volume:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dB/` and what it makes of the
/// match: `-inf` is −120 dB, and a bare `inf` is not a number (`None` here, stored as NULL).
pub fn parse_max_volume(stderr: &str) -> Option<f64> {
    let mut rest = stderr;
    while let Some(start) = rest.find("max_volume:") {
        let after = &rest[start + "max_volume:".len()..];
        rest = after;
        let value = after.trim_start_matches(|character: char| character.is_whitespace());
        let (negative, body) = match value.strip_prefix('-') {
            Some(body) => (true, body),
            None => (false, value),
        };
        let digits = |text: &str| text.bytes().take_while(u8::is_ascii_digit).count();
        let (number, length) = if body.starts_with("inf") {
            (None, 3)
        } else {
            let whole = digits(body);
            if whole == 0 {
                continue;
            }
            let mut length = whole;
            if let Some(fraction) = body[whole..].strip_prefix('.') {
                let fraction_digits = digits(fraction);
                if fraction_digits > 0 {
                    length += 1 + fraction_digits;
                }
            }
            (body[..length].parse::<f64>().ok(), length)
        };
        let unit = body[length..].trim_start_matches(|character: char| character.is_whitespace());
        if !unit.starts_with("dB") {
            continue;
        }
        return Some(match (negative, number) {
            (true, None) => -120.0,
            (false, None) => f64::NAN,
            (true, Some(number)) => -number,
            (false, Some(number)) => number,
        });
    }
    None
}
