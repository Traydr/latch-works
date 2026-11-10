//! A file's fingerprint: a perceptual hash for a still, five frames' for anything that moves,
//! stored in the catalog's `fingerprint` column in the text form Electron Oriel's catalogs hold.

use std::{error::Error, fmt, path::Path, time::Duration};

use oriel_core_domain::number::{js_number, js_round, to_fixed};
use oriel_runtime::CancelToken;
use oriel_tools::{ToolError, ToolRun};
use oriel_vips::{Vips, VipsError};

use super::phash::{Hash64, PHASH_INPUT_SIZE, perceptual_hash};

/// Bumped when prints are made differently, so the catalog makes the old ones again.
pub const FINGERPRINT_VERSION: i64 = 1;

/// How a still's stored print starts; a moving picture's starts `m:`.
const STILL_PREFIX: &str = "s:";

/// Whether a stored print is a still's, the only kind detail prints are made for.
pub fn is_still_print(stored: &str) -> bool {
    stored.starts_with(STILL_PREFIX)
}

/// [`is_still_print`] as a SQL condition on the column `column`.
pub fn still_print_sql(column: &str) -> String {
    format!("{column} LIKE '{STILL_PREFIX}%'")
}

/// A video is sampled at these points of its duration; an animation at the same share of its
/// frames' time.
pub const SAMPLE_POSITIONS: [f64; 5] = [0.1, 0.3, 0.5, 0.7, 0.9];

/// How long ffmpeg may take to hand back one frame.
pub(super) const FRAME_TIMEOUT: Duration = Duration::from_secs(60);

/// A still's fingerprint, or five frames' for anything that moves.
#[derive(Clone, Debug, PartialEq)]
pub enum Fingerprint {
    Still(Hash64),
    /// Stored as a JavaScript number, so prints made before match the ones made now.
    Motion {
        duration_ms: f64,
        frames: Vec<Hash64>,
    },
}

/// Stored as `s:<hash>` or `m:<durationMs>:<hash>.<hash>…`, the catalog's `fingerprint` column.
impl fmt::Display for Fingerprint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Fingerprint::Still(hash) => write!(f, "{STILL_PREFIX}{hash}"),
            Fingerprint::Motion {
                duration_ms,
                frames,
            } => {
                write!(f, "m:{}:", to_fixed(js_round(*duration_ms), 0))?;
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
    /// Reads what [`fmt::Display`] writes; `None` for a malformed print.
    pub fn parse(stored: &str) -> Option<Fingerprint> {
        if let Some(hash) = stored.strip_prefix(STILL_PREFIX) {
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
            duration_ms: js_number(duration).unwrap_or(f64::NAN),
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
    /// Something outside the app stopped ffmpeg; nothing is recorded, and the pass goes on.
    Interrupted,
}

impl fmt::Display for FingerprintError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FingerprintError::Decode(error) => error.fmt(f),
            FingerprintError::Video(message) => f.write_str(message),
            FingerprintError::Cancelled => f.write_str("cancelled"),
            FingerprintError::Interrupted => f.write_str("ffmpeg was stopped from outside the app"),
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

/// Fingerprints a video from single frames ffmpeg decodes at the sample positions, with the
/// arguments Electron Oriel's prints were made with and a timeout for each frame, plus one
/// decoding thread. FFmpeg's
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
    hash_of(&video_frame_pixels(ffmpeg, path, seconds, cancel)?)
}

/// The 32×32 grey pixels [`video_frame_hash`] hashes, from one ffmpeg run for this frame.
pub fn video_frame_pixels(
    ffmpeg: &Path,
    path: &Path,
    seconds: f64,
    cancel: Option<&CancelToken>,
) -> Result<Vec<u8>, FingerprintError> {
    let expected = PHASH_INPUT_SIZE * PHASH_INPUT_SIZE;
    let mut run = ToolRun::new(ffmpeg, FRAME_TIMEOUT)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-threads",
            "1",
            "-ss",
            &to_fixed(seconds, 3),
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
        Err(ToolError::Killed) => return Err(FingerprintError::Interrupted),
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
    let mut pixels = output.stdout;
    pixels.truncate(expected);
    Ok(pixels)
}

pub(super) fn hash_of(pixels: &[u8]) -> Result<Hash64, FingerprintError> {
    perceptual_hash(pixels).ok_or_else(|| {
        FingerprintError::Decode(VipsError(format!(
            "A pHash needs 32×32 grey pixels, not {} bytes.",
            pixels.len()
        )))
    })
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
}
