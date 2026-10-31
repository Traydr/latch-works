//! A video's five sample frames in fewer ffmpeg runs. Each of [`video_frame_hash`]'s runs seeks
//! to the keyframe before its sample and decodes from there, and the fixture's videos have a
//! keyframe every few seconds, so five runs decode the start of a video up to five times over.
//!
//! Samples that ffmpeg reaches from the same keyframe are decoded in one run here, and they come
//! out byte for byte as five runs make them, by construction:
//! - the run seeks as the first sample's single run does, so it starts at the same keyframe, the
//!   one every sample in the run starts from, and its decoder sees the same packets as theirs;
//! - each later sample is the first frame whose timestamp reaches that sample's seek time, worked
//!   out in the stream's time base with ffmpeg's own rounding, which is how a single run's
//!   `-ss` picks it (the timeline shift and the `trim` that accurate seeking adds);
//! - each frame is scaled and turned grey alone, by the same filters.
//!
//! ffprobe says which keyframe each sample starts from, reading one packet after a seek made as
//! ffmpeg's `-ss` makes it. A file this cannot be sure of is planned as five single runs, today's
//! path: anything but MP4 and QuickTime (whose seeks go by presentation time), a start time other
//! than zero, more than one video stream or a cover picture, or any answer it cannot read. A run
//! that fails in any way is made again as single runs, so errors are exactly theirs too.

use std::ops::Range;
use std::path::Path;
use std::time::Duration;

use oriel_runtime::CancelToken;
use oriel_tools::ToolRun;
use serde_json::Value;

use super::fingerprint::{
    FRAME_TIMEOUT, Fingerprint, FingerprintError, SAMPLE_POSITIONS, hash_of, to_fixed_3,
    video_frame_hash,
};
use super::phash::{Hash64, PHASH_INPUT_SIZE};

/// How long ffprobe may take to read where a video's samples start.
const PLAN_TIMEOUT: Duration = Duration::from_secs(30);

/// The demuxer whose seeks ffprobe and ffmpeg make alike: ffmpeg's `mov`, which reads MP4,
/// QuickTime and their kin, and seeks by presentation time.
const MOV_FORMAT: &str = "mov,mp4,m4a,3gp,3g2,mj2";

/// One ffmpeg run of a video: consecutive sample positions that start from the same keyframe.
#[derive(Clone, Debug, PartialEq)]
pub struct FrameRun {
    /// The first sample position, an index into [`SAMPLE_POSITIONS`].
    first: usize,
    /// Each sample's seek time, in seconds.
    seconds: Vec<f64>,
    /// Each sample's first timestamp, in the stream's time base, from the first sample's.
    offsets: Vec<i64>,
    /// Seconds of video the run decodes, from its keyframe to its last sample; an estimate for
    /// a run planned without ffprobe.
    decoded_seconds: f64,
}

impl FrameRun {
    /// The single run [`video_frame_hash`] makes of one sample.
    fn single(position: usize, seconds: f64) -> Self {
        Self {
            first: position,
            seconds: vec![seconds],
            offsets: vec![0],
            // Without the keyframe, the most it could decode.
            decoded_seconds: seconds,
        }
    }

    /// The sample positions the run makes, in order.
    pub fn positions(&self) -> Range<usize> {
        self.first..self.first + self.seconds.len()
    }

    /// Each sample's seek time, in seconds.
    pub fn seconds(&self) -> &[f64] {
        &self.seconds
    }

    /// Seconds of video the run decodes, to order runs longest first.
    pub fn decoded_seconds(&self) -> f64 {
        self.decoded_seconds
    }
}

/// Each sample's seek time, in seconds, as [`super::fingerprint_video`] takes them.
fn sample_seconds(duration_ms: f64) -> [f64; SAMPLE_POSITIONS.len()] {
    SAMPLE_POSITIONS.map(|position| duration_ms * position / 1000.0)
}

/// Five single runs, one a sample: the path for a video the plan cannot be sure of.
pub fn single_frame_runs(duration_ms: f64) -> Vec<FrameRun> {
    sample_seconds(duration_ms)
        .into_iter()
        .enumerate()
        .map(|(position, seconds)| FrameRun::single(position, seconds))
        .collect()
}

/// The runs that make a video's five samples, asking ffprobe where each starts. Fails only when
/// cancelled; a video it cannot be sure of gets [`single_frame_runs`].
pub fn plan_frame_runs(
    ffprobe: &Path,
    path: &Path,
    duration_ms: f64,
    cancel: Option<&CancelToken>,
) -> Result<Vec<FrameRun>, FingerprintError> {
    let seconds = sample_seconds(duration_ms);
    let seeks = seconds.map(to_fixed_3);
    let intervals: Vec<String> = seeks.iter().map(|seek| format!("{seek}%+#1")).collect();
    let mut run = ToolRun::new(ffprobe, PLAN_TIMEOUT)
        .args(["-v", "error", "-select_streams", "v", "-read_intervals"])
        .arg(intervals.join(","))
        .args([
            "-show_entries",
            "packet=pts,flags:stream=time_base:stream_disposition=attached_pic:\
             format=format_name,start_time",
            "-of",
            "json",
        ])
        .arg(path);
    if let Some(token) = cancel {
        run = run.cancel_on(token);
    }
    let output = match run.run() {
        Ok(output) => output,
        Err(error) if error.is_cancelled() => return Err(FingerprintError::Cancelled),
        Err(_) => return Ok(single_frame_runs(duration_ms)),
    };
    let probe = output
        .success()
        .then(|| serde_json::from_slice::<Value>(&output.stdout).ok())
        .flatten();
    Ok(probe
        .and_then(|probe| runs_from_probe(&probe, &seconds, &seeks))
        .unwrap_or_else(|| single_frame_runs(duration_ms)))
}

/// What ffprobe read of a video's samples: the stream's time base and the timestamp of the
/// keyframe each sample starts from.
#[derive(Debug, PartialEq)]
struct SampleStarts {
    time_base: (i64, i64),
    keyframes: Vec<i64>,
}

/// Reads ffprobe's answer, `None` for anything the runs cannot be sure of.
fn sample_starts(probe: &Value) -> Option<SampleStarts> {
    let format = probe.get("format")?;
    if format.get("format_name")?.as_str()? != MOV_FORMAT
        || format.get("start_time")?.as_str()? != "0.000000"
    {
        return None;
    }
    let [stream] = probe.get("streams")?.as_array()?.as_slice() else {
        return None;
    };
    let attached = stream.get("disposition")?.get("attached_pic")?.as_i64()?;
    let (num, den) = stream.get("time_base")?.as_str()?.split_once('/')?;
    let time_base = (num.parse::<i64>().ok()?, den.parse::<i64>().ok()?);
    if attached != 0 || time_base.0 <= 0 || time_base.1 <= 0 {
        return None;
    }
    let keyframes = probe
        .get("packets")?
        .as_array()?
        .iter()
        .map(|packet| {
            let keyframe = packet.get("flags")?.as_str()?.starts_with('K');
            keyframe.then(|| packet.get("pts")?.as_i64()).flatten()
        })
        .collect::<Option<Vec<i64>>>()?;
    (keyframes.len() == SAMPLE_POSITIONS.len()).then_some(SampleStarts {
        time_base,
        keyframes,
    })
}

/// The runs ffprobe's answer allows: samples that start from the same keyframe share one.
fn runs_from_probe(
    probe: &Value,
    seconds: &[f64; SAMPLE_POSITIONS.len()],
    seeks: &[String; SAMPLE_POSITIONS.len()],
) -> Option<Vec<FrameRun>> {
    let starts = sample_starts(probe)?;
    let firsts = seeks
        .iter()
        .map(|seek| Some(first_timestamp(seek_microseconds(seek)?, starts.time_base)))
        .collect::<Option<Vec<i64>>>()?;
    let (num, den) = starts.time_base;
    let mut runs: Vec<FrameRun> = Vec::new();
    for position in 0..SAMPLE_POSITIONS.len() {
        let keyframe = starts.keyframes[position];
        match runs.last_mut() {
            Some(run) if starts.keyframes[run.first] == keyframe => {
                run.seconds.push(seconds[position]);
                run.offsets.push(firsts[position] - firsts[run.first]);
            }
            _ => runs.push(FrameRun::single(position, seconds[position])),
        }
        let run = runs.last_mut().expect("a run was just pushed");
        run.decoded_seconds =
            (seconds[position] - keyframe as f64 * num as f64 / den as f64).max(0.0);
    }
    Some(runs)
}

/// `-ss`'s seconds in microseconds, as `av_parse_time` reads the three decimals
/// [`to_fixed_3`] writes.
fn seek_microseconds(seek: &str) -> Option<i128> {
    let (whole, millis) = seek.split_once('.')?;
    if millis.len() != 3 || !(whole.bytes().chain(millis.bytes())).all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((whole.parse::<i128>().ok()? * 1000 + millis.parse::<i128>().ok()?) * 1000)
}

/// The first timestamp a single run at `microseconds` keeps, in a stream of time base `num/den`:
/// `av_rescale_q(microseconds, AV_TIME_BASE_Q, time_base)`, which rounds halves away from zero.
/// ffmpeg shifts the stream's timestamps back by this much and keeps the first frame at or after
/// zero. Every value here is positive.
fn first_timestamp(microseconds: i128, (num, den): (i64, i64)) -> i64 {
    let divisor = i128::from(num) * 1_000_000;
    let rounded = (microseconds * i128::from(den) + divisor / 2) / divisor;
    i64::try_from(rounded).unwrap_or(i64::MAX)
}

/// The filters that decode a run's samples once: a copy of the stream for each, the first frame
/// at or after its timestamp, then each frame scaled and turned grey as a single run does it.
fn run_filters(offsets: &[i64]) -> String {
    let count = offsets.len();
    let mut graph = format!("[0:v:0]split={count}");
    for index in 0..count {
        graph.push_str(&format!("[s{index}]"));
    }
    for (index, offset) in offsets.iter().enumerate() {
        graph.push_str(&format!(
            ";[s{index}]trim=start_pts={offset},trim=end_frame=1[c{index}]"
        ));
    }
    graph.push(';');
    for index in 0..count {
        graph.push_str(&format!("[c{index}]"));
    }
    graph.push_str(&format!(
        "concat=n={count}:v=1:a=0,scale={PHASH_INPUT_SIZE}:{PHASH_INPUT_SIZE}:flags=area,\
         format=gray[out]"
    ));
    graph
}

/// The pHash of each sample of a run, in order. A run of one is [`video_frame_hash`]'s single
/// run; a longer one that fails in any way is made again as single runs, so a failed sample has
/// exactly the error a single run gives it.
pub fn frame_run_hashes(
    ffmpeg: &Path,
    path: &Path,
    run: &FrameRun,
    cancel: Option<&CancelToken>,
) -> Vec<Result<Hash64, FingerprintError>> {
    if run.seconds.len() > 1 {
        match frame_run_pixels(ffmpeg, path, run, cancel) {
            Err(cancelled) => return vec![Err(cancelled)],
            Ok(Some(frames)) => return frames.iter().map(|frame| hash_of(frame)).collect(),
            Ok(None) => {}
        }
    }
    run.seconds
        .iter()
        .map(|&seconds| video_frame_hash(ffmpeg, path, seconds, cancel))
        .collect()
}

/// A video's print as [`super::fingerprint_video_with`] makes it, in [`plan_frame_runs`]' runs.
pub fn fingerprint_video_in_runs(
    ffmpeg: &Path,
    ffprobe: &Path,
    path: &Path,
    duration_ms: f64,
    cancel: Option<&CancelToken>,
) -> Result<Fingerprint, FingerprintError> {
    let mut frames = Vec::with_capacity(SAMPLE_POSITIONS.len());
    for run in plan_frame_runs(ffprobe, path, duration_ms, cancel)? {
        for frame in frame_run_hashes(ffmpeg, path, &run, cancel) {
            frames.push(frame?);
        }
    }
    Ok(Fingerprint::Motion {
        duration_ms,
        frames,
    })
}

/// The 32×32 grey pixels of each sample of a run, from one ffmpeg run: `None` when that run
/// failed in any way or made other than one frame a sample. Fails only when cancelled.
pub fn frame_run_pixels(
    ffmpeg: &Path,
    path: &Path,
    run: &FrameRun,
    cancel: Option<&CancelToken>,
) -> Result<Option<Vec<Vec<u8>>>, FingerprintError> {
    let frame = PHASH_INPUT_SIZE * PHASH_INPUT_SIZE;
    let mut tool = ToolRun::new(ffmpeg, FRAME_TIMEOUT)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-threads",
            "1",
            "-ss",
            &to_fixed_3(run.seconds[0]),
            "-i",
        ])
        .arg(path)
        .arg("-filter_complex")
        .arg(run_filters(&run.offsets))
        .args(["-map", "[out]", "-an", "-sn", "-fps_mode", "passthrough"])
        .args(["-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"]);
    if let Some(token) = cancel {
        tool = tool.cancel_on(token);
    }
    match tool.run() {
        Err(error) if error.is_cancelled() => Err(FingerprintError::Cancelled),
        Ok(output) if output.success() && output.stdout.len() == frame * run.seconds.len() => Ok(
            Some(output.stdout.chunks(frame).map(<[u8]>::to_vec).collect()),
        ),
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn probe(keyframes: [i64; 5]) -> Value {
        json!({
            "packets": keyframes.map(|pts| json!({ "pts": pts, "flags": "K__" })),
            "streams": [{ "time_base": "1/15360", "disposition": { "attached_pic": 0 } }],
            "format": { "format_name": MOV_FORMAT, "start_time": "0.000000" },
        })
    }

    #[test]
    fn first_timestamps_round_as_av_rescale_q_does() {
        // 0.6 s at 1/15360 is exactly frame 36 of a 60 fps video.
        assert_eq!(first_timestamp(600_000, (1, 15360)), 9216);
        // 1.001 s is 15375.36 ticks, and 0.0325 s at 1/1000 a true half, which goes up.
        assert_eq!(first_timestamp(1_001_000, (1, 15360)), 15375);
        assert_eq!(first_timestamp(32_500, (1, 1000)), 33);
        assert_eq!(first_timestamp(1_000, (1001, 30000)), 0);
        assert_eq!(seek_microseconds("12.345"), Some(12_345_000));
        assert_eq!(seek_microseconds("NaN"), None);
    }

    #[test]
    fn samples_from_one_keyframe_share_a_run() {
        // A 9 s video with keyframes at 0 and 8.333 s: every sample starts from the first.
        let seconds = sample_seconds(9000.0);
        let seeks = seconds.map(to_fixed_3);
        let runs = runs_from_probe(&probe([0; 5]), &seconds, &seeks).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].positions(), 0..5);
        assert_eq!(runs[0].offsets, [0, 27648, 55296, 82944, 110592]);

        // A keyframe at 4.5 s starts a second run with the third sample.
        let runs = runs_from_probe(&probe([0, 0, 69120, 69120, 69120]), &seconds, &seeks).unwrap();
        assert_eq!(
            runs.iter().map(FrameRun::positions).collect::<Vec<_>>(),
            [0..2, 2..5]
        );
        assert_eq!(runs[1].offsets, [0, 27648, 55296]);
        assert!((runs[1].decoded_seconds - 3.6).abs() < 1e-9);
    }

    #[test]
    fn files_it_cannot_be_sure_of_get_single_runs() {
        let seconds = sample_seconds(9000.0);
        let seeks = seconds.map(to_fixed_3);
        let with = |change: &dyn Fn(&mut Value)| {
            let mut probe = probe([0; 5]);
            change(&mut probe);
            runs_from_probe(&probe, &seconds, &seeks)
        };
        assert!(with(&|_| {}).is_some());
        assert!(with(&|p| p["format"]["format_name"] = json!("matroska,webm")).is_none());
        assert!(with(&|p| p["format"]["start_time"] = json!("0.023220")).is_none());
        assert!(with(&|p| p["streams"][0]["disposition"]["attached_pic"] = json!(1)).is_none());
        assert!(with(&|p| p["packets"][3]["flags"] = json!("___")).is_none());
        assert!(with(&|p| p["packets"].as_array_mut().unwrap().truncate(4)).is_none());
        assert!(
            with(&|p| {
                let stream = p["streams"][0].clone();
                p["streams"].as_array_mut().unwrap().push(stream);
            })
            .is_none()
        );
        assert_eq!(single_frame_runs(9000.0).len(), 5);
    }

    #[test]
    fn a_run_keeps_one_frame_from_each_samples_timestamp() {
        assert_eq!(
            run_filters(&[0, 27648]),
            "[0:v:0]split=2[s0][s1];[s0]trim=start_pts=0,trim=end_frame=1[c0];\
             [s1]trim=start_pts=27648,trim=end_frame=1[c1];[c0][c1]concat=n=2:v=1:a=0,\
             scale=32:32:flags=area,format=gray[out]"
        );
    }
}
