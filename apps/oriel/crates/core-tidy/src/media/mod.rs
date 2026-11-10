//! The loudness pass's `volumedetect` (a video's probe is `oriel_tools`'); the one way a file is
//! converted ([`convert`]); and the conversions Convert and Shrink run, in [`transcode`] (ffmpeg)
//! and [`still`] (libavif).

pub(crate) mod convert;
pub mod still;
pub mod transcode;

use std::path::Path;
use std::time::Duration;

use oriel_runtime::CancelToken;
use oriel_tools::{ToolError, ToolRun};

/// Decoding the audio of a long video is fast, but a feature-length file still takes a while.
const LOUDNESS_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// The loudest sample of a video's first audio track, in dBFS, from ffmpeg's `volumedetect`.
pub fn measure_peak_volume(
    ffmpeg: &Path,
    path: &Path,
    cancel: Option<&CancelToken>,
) -> Result<f64, ToolError> {
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
    let output = run.run()?;
    match parse_max_volume(&output.stderr) {
        Some(peak) if output.success() => Ok(peak),
        _ => Err(ToolError::Failed(
            "ffmpeg could not measure the audio.".to_owned(),
        )),
    }
}

/// The number in `max_volume: <n> dB`: `-inf` is −120 dB, and a bare `inf` is not a number
/// (NaN, stored as NULL).
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
