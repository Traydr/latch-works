//! A file's fingerprint, as `glazier-core/src/similarity/fingerprint.ts` makes and stores it: a
//! perceptual hash for a still, five frames' for anything that moves.

use std::{error::Error, fmt, path::Path, time::Duration};

use oriel_runtime::CancelToken;
use oriel_tools::ToolRun;

use super::{
    phash::{Hash64, PHASH_INPUT_SIZE, perceptual_hash},
    vips::{Vips, VipsError},
};

/// A video is sampled at these points of its duration; an animation at the same share of its
/// frames' time.
pub const SAMPLE_POSITIONS: [f64; 5] = [0.1, 0.3, 0.5, 0.7, 0.9];

/// How long ffmpeg may take to hand back one frame, as glazier-core allows.
const FRAME_TIMEOUT: Duration = Duration::from_secs(60);

/// A still's fingerprint, or five frames' for anything that moves.
#[derive(Clone, Debug, PartialEq)]
pub enum Fingerprint {
    Still(Hash64),
    /// `duration_ms` is a JavaScript number in glazier-core, so it stays an f64 here.
    Motion {
        duration_ms: f64,
        frames: Vec<Hash64>,
    },
}

/// Stored as `s:<hash>` or `m:<durationMs>:<hash>.<hash>…`, the catalog's `fingerprint` column.
impl fmt::Display for Fingerprint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Fingerprint::Still(hash) => write!(f, "s:{hash}"),
            Fingerprint::Motion {
                duration_ms,
                frames,
            } => {
                write!(f, "m:{}:", js_integer(js_round(*duration_ms)))?;
                for (index, frame) in frames.iter().enumerate() {
                    if index > 0 {
                        f.write_str(".")?;
                    }
                    write!(f, "{frame}")?;
                }
                Ok(())
            }
        }
    }
}

impl Fingerprint {
    /// Reads what [`fmt::Display`] writes. `None` where glazier-core's `parseFingerprint` throws.
    pub fn parse(stored: &str) -> Option<Fingerprint> {
        if let Some(hash) = stored.strip_prefix("s:") {
            return Hash64::parse(hash).map(Fingerprint::Still);
        }
        let mut parts = stored.split(':');
        let (Some("m"), Some(duration), Some(frames)) = (parts.next(), parts.next(), parts.next())
        else {
            return None;
        };
        let frames = frames
            .split('.')
            .map(Hash64::parse)
            .collect::<Option<Vec<_>>>()?;
        Some(Fingerprint::Motion {
            duration_ms: js_number(duration),
            frames,
        })
    }
}

/// Why a file has no fingerprint; the pass records it as the file's `fingerprint_error`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FingerprintError {
    Decode(VipsError),
    Video(String),
    /// The pass was stopped while ffmpeg ran; nothing is recorded for the file.
    Cancelled,
}

impl fmt::Display for FingerprintError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FingerprintError::Decode(error) => error.fmt(f),
            FingerprintError::Video(message) => f.write_str(message),
            FingerprintError::Cancelled => f.write_str("cancelled"),
        }
    }
}

impl Error for FingerprintError {}

impl From<VipsError> for FingerprintError {
    fn from(error: VipsError) -> Self {
        FingerprintError::Decode(error)
    }
}

/// The fingerprint of a still.
pub fn fingerprint_still(vips: &Vips, path: &Path) -> Result<Fingerprint, FingerprintError> {
    let pixels = vips.grey_pixels(path, PHASH_INPUT_SIZE as u32, None)?;
    Ok(Fingerprint::Still(hash_of(&pixels)?))
}

/// The display time of each frame. Browsers show a frame with no delay (or under 10 ms) for
/// 100 ms, and so does the MP4 Gather Box makes from it, so the durations agree.
pub fn animation_frame_times(delays_ms: &[i32], frame_count: u32) -> Vec<u32> {
    (0..frame_count as usize)
        .map(|index| match delays_ms.get(index).copied().unwrap_or(0) {
            delay if delay <= 10 => 100,
            delay => delay.unsigned_abs(),
        })
        .collect()
}

/// The page on screen at each sample position of an animation with these frame times.
pub fn sampled_pages(frame_times_ms: &[u32]) -> [u32; SAMPLE_POSITIONS.len()] {
    let duration_ms: f64 = frame_times_ms.iter().map(|&time| f64::from(time)).sum();
    let last = frame_times_ms.len().saturating_sub(1);
    SAMPLE_POSITIONS.map(|position| {
        let target = duration_ms * position;
        let mut elapsed = 0.0;
        let mut page = 0;
        while page < last && elapsed + f64::from(frame_times_ms[page]) <= target {
            elapsed += f64::from(frame_times_ms[page]);
            page += 1;
        }
        // An animation has far fewer than u32::MAX pages.
        page as u32
    })
}

/// Fingerprints an animated GIF, WebP or PNG from the frames on screen at the sample positions.
pub fn fingerprint_animation(
    vips: &Vips,
    path: &Path,
    frame_times_ms: &[u32],
) -> Result<Fingerprint, FingerprintError> {
    let duration_ms = frame_times_ms.iter().map(|&time| f64::from(time)).sum();
    let mut frames = Vec::with_capacity(SAMPLE_POSITIONS.len());
    for page in sampled_pages(frame_times_ms) {
        let pixels = vips.grey_pixels(path, PHASH_INPUT_SIZE as u32, Some(page))?;
        frames.push(hash_of(&pixels)?);
    }
    Ok(Fingerprint::Motion {
        duration_ms,
        frames,
    })
}

/// Fingerprints a video from single frames ffmpeg decodes at the sample positions, with
/// glazier-core's arguments and its timeout for each frame, plus one decoding thread. FFmpeg's
/// decoders give the same frame whatever their thread count; a threaded one also decodes frames
/// past the one asked for, which cost a quarter of these runs' CPU on the fixture's videos.
pub fn fingerprint_video(
    ffmpeg: &Path,
    path: &Path,
    duration_ms: f64,
) -> Result<Fingerprint, FingerprintError> {
    fingerprint_video_with(ffmpeg, path, duration_ms, None)
}

/// [`fingerprint_video`], killing ffmpeg when `cancel` is cancelled.
pub fn fingerprint_video_with(
    ffmpeg: &Path,
    path: &Path,
    duration_ms: f64,
    cancel: Option<&CancelToken>,
) -> Result<Fingerprint, FingerprintError> {
    let frames = SAMPLE_POSITIONS
        .iter()
        .map(|position| video_frame_hash(ffmpeg, path, duration_ms * position / 1000.0, cancel))
        .collect::<Result<_, _>>()?;
    Ok(Fingerprint::Motion {
        duration_ms,
        frames,
    })
}

/// The pHash of the frame ffmpeg decodes `seconds` into the video: one of a video's prints.
pub fn video_frame_hash(
    ffmpeg: &Path,
    path: &Path,
    seconds: f64,
    cancel: Option<&CancelToken>,
) -> Result<Hash64, FingerprintError> {
    let expected = PHASH_INPUT_SIZE * PHASH_INPUT_SIZE;
    let mut run = ToolRun::new(ffmpeg, FRAME_TIMEOUT)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-threads",
            "1",
            "-ss",
            &to_fixed_3(seconds),
            "-i",
        ])
        .arg(path)
        .args(["-map", "0:v:0", "-frames:v", "1", "-an", "-sn", "-vf"])
        .arg(format!(
            "scale={PHASH_INPUT_SIZE}:{PHASH_INPUT_SIZE}:flags=area,format=gray"
        ))
        .args(["-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"]);
    if let Some(token) = cancel {
        run = run.cancel_on(token);
    }
    let output = match run.run() {
        Ok(output) => output,
        Err(error) if error.is_cancelled() => return Err(FingerprintError::Cancelled),
        Err(error) => {
            return Err(FingerprintError::Video(format!(
                "Could not run ffmpeg: {error}"
            )));
        }
    };
    if !output.success() || output.stdout.len() < expected {
        let last = output.stderr.trim().lines().last().unwrap_or("").to_owned();
        return Err(FingerprintError::Video(if last.is_empty() {
            "ffmpeg returned no frame.".to_owned()
        } else {
            last
        }));
    }
    hash_of(&output.stdout[..expected])
}

fn hash_of(pixels: &[u8]) -> Result<Hash64, FingerprintError> {
    perceptual_hash(pixels).ok_or_else(|| {
        FingerprintError::Decode(VipsError(format!(
            "A pHash needs 32×32 grey pixels, not {} bytes.",
            pixels.len()
        )))
    })
}

/// `Math.round`: halves round up, toward positive infinity.
fn js_round(value: f64) -> f64 {
    let floor = value.floor();
    if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// An integral number as JavaScript prints it.
fn js_integer(value: f64) -> String {
    if value.is_nan() {
        "NaN".to_owned()
    } else if value.is_infinite() {
        if value > 0.0 { "Infinity" } else { "-Infinity" }.to_owned()
    } else if value == 0.0 {
        // `-0` prints as `0`.
        "0".to_owned()
    } else {
        format!("{value:.0}")
    }
}

/// `Number(text)` for the decimal forms a stored duration takes: blank is 0, junk is NaN.
fn js_number(text: &str) -> f64 {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        0.0
    } else {
        trimmed.parse().unwrap_or(f64::NAN)
    }
}

/// `value.toFixed(3)` for a non-negative value: the exact binary value rounded to three decimals,
/// a tie going up, where Rust's formatting would round a tie to even.
fn to_fixed_3(value: f64) -> String {
    // Eighty decimals hold every bit of any value from 2⁻²⁷ up, and anything smaller is 0.000.
    let exact = format!("{value:.80}");
    let (whole, fraction) = exact.split_once('.').unwrap_or((&exact, ""));
    let mut digits: Vec<u8> = whole.bytes().chain(fraction.bytes().take(3)).collect();
    if fraction
        .as_bytes()
        .get(3)
        .is_some_and(|&digit| digit >= b'5')
    {
        let mut index = digits.len();
        loop {
            if index == 0 {
                digits.insert(0, b'1');
                break;
            }
            index -= 1;
            if digits[index] == b'9' {
                digits[index] = b'0';
            } else {
                digits[index] += 1;
                break;
            }
        }
    }
    let split = digits.len() - 3;
    let text = String::from_utf8_lossy(&digits).into_owned();
    format!("{}.{}", &text[..split], &text[split..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprints_round_trip_through_their_stored_form() {
        let still = Fingerprint::Still(Hash64(0xac24_b64b_b999_4b27));
        assert_eq!(still.to_string(), "s:ac24b64bb9994b27");
        assert_eq!(Fingerprint::parse("s:ac24b64bb9994b27"), Some(still));

        let motion = Fingerprint::Motion {
            duration_ms: 649.5,
            frames: vec![Hash64(1), Hash64(u64::MAX)],
        };
        assert_eq!(
            motion.to_string(),
            "m:650:0000000000000001.ffffffffffffffff"
        );
        assert_eq!(Fingerprint::parse("s:xyz"), None);
        assert_eq!(Fingerprint::parse("m:650"), None);
    }

    #[test]
    fn short_or_missing_delays_show_for_100_ms() {
        assert_eq!(
            animation_frame_times(&[0, 40, 10, 11], 5),
            vec![100, 40, 100, 11, 100]
        );
    }

    #[test]
    fn samples_take_the_frame_on_screen_at_each_position() {
        // 650 ms: the samples fall at 65, 195, 325, 455 and 585 ms.
        assert_eq!(
            sampled_pages(&[100, 40, 100, 100, 250, 60]),
            [0, 2, 3, 4, 4]
        );
        assert_eq!(sampled_pages(&[]), [0; 5]);
    }

    #[test]
    fn seek_times_round_like_to_fixed() {
        assert_eq!(to_fixed_3(0.3), "0.300");
        assert_eq!(to_fixed_3(2.7), "2.700");
        // 0.0625 is exact in binary, so it is a true tie: toFixed takes the larger.
        assert_eq!(to_fixed_3(0.0625), "0.063");
        assert_eq!(to_fixed_3(9.9996), "10.000");
        assert_eq!(to_fixed_3(0.0), "0.000");
    }
}
