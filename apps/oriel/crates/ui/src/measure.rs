//! What every spike (plan 063's measurements) writes, on top of `oriel_runtime::ProcessUsage`'s
//! readings: frame statistics, memory as fields, and the JSON-lines log that `xtask measure`
//! parses.

use std::fs::{File, OpenOptions};
use std::io::Write as _;
use std::time::Instant;

use oriel_runtime::ProcessUsage;

/// A spike's log: one JSON object per line, appended to the file the launch named.
pub struct SpikeLog(File);

impl SpikeLog {
    /// The log at `path`, or `None`, said in the app's log, when it cannot be opened.
    pub fn open(path: &str) -> Option<Self> {
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map(Self)
            .map_err(|error| log::error!("cannot open the spike log {path}: {error}"))
            .ok()
    }

    /// Writes `fields`, a JSON object's members without the braces, as one line.
    pub fn write(&mut self, fields: &str) {
        if let Err(error) = writeln!(self.0, "{{{fields}}}") {
            log::error!("cannot write the spike log: {error}");
        }
    }
}

/// The value at `share` (0 to 1) of `sorted`, nearest rank; 0 when it is empty.
pub fn percentile(sorted: &[f64], share: f64) -> f64 {
    if sorted.is_empty() {
        return 0.;
    }
    sorted[((sorted.len() - 1) as f64 * share).round() as usize]
}

/// A `scroll` event's fields: the intervals between consecutive frames, in milliseconds.
pub fn frame_stats(frames: &[Instant], speed: f32) -> String {
    let mut intervals: Vec<f64> = frames
        .windows(2)
        .map(|pair| pair[1].duration_since(pair[0]).as_secs_f64() * 1e3)
        .collect();
    let duration = match (frames.first(), frames.last()) {
        (Some(first), Some(last)) => last.duration_since(*first).as_secs_f64(),
        _ => 0.,
    };
    intervals.sort_by(f64::total_cmp);
    let p50 = percentile(&intervals, 0.5);
    // A frame that took more than one and a half times the typical interval missed its vsync.
    let long = intervals
        .iter()
        .filter(|interval| **interval > p50 * 1.5)
        .count();
    format!(
        r#""event":"scroll","px_per_s":{speed},"frames":{},"duration_s":{duration:.2},"p50_ms":{p50:.2},"p95_ms":{:.2},"p99_ms":{:.2},"max_ms":{:.2},"long_frames":{long}"#,
        frames.len(),
        percentile(&intervals, 0.95),
        percentile(&intervals, 0.99),
        intervals.last().copied().unwrap_or_default(),
    )
}

/// `"resident_mb":…,"footprint_mb":…` for this process now; zeros where there is no reading.
pub fn memory_fields() -> String {
    let (resident, footprint) =
        ProcessUsage::of_this_process().map_or((0, 0), |usage| (usage.resident, usage.footprint));
    format!(
        r#""resident_mb":{:.1},"footprint_mb":{:.1}"#,
        resident as f64 / 1e6,
        footprint as f64 / 1e6,
    )
}

/// Milliseconds since the kernel started this process; 0 where there is no reading.
pub fn since_launch_ms() -> f64 {
    ProcessUsage::of_this_process().map_or(0., |usage| usage.alive_ms)
}

/// This process's CPU time on every thread, user and system, in milliseconds; 0 where there is
/// no reading.
pub fn process_cpu_ms() -> f64 {
    ProcessUsage::of_this_process().map_or(0., |usage| usage.cpu_ns / 1e6)
}
