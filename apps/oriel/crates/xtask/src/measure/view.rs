//! View's rows, through View's spike (`crates/mode-view/src/spike.rs`) as `rs_run.py` drove it:
//! the fixture's `stills/` opened at start in a 1280 × 900 window, one JSON line per event, and
//! the app read from outside at each event.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::time::{Duration, Instant};

use anyhow::Result;
use serde_json::{Value, json};

use super::process::{self, Sample, Spec};
use super::spike_log::{self, LogReader};
use super::{Outcome, Row, Settings, Turn};

/// How often the log is read and the app sampled, as `rs_run.py` polled.
const POLL: Duration = Duration::from_millis(20);
/// A run that has not quit by then is stopped.
const LIMIT: Duration = Duration::from_secs(1_800);
/// When the warm start's CPU at rest is read, after the first thumbnails.
const SETTLED: [(u64, &str); 3] = [(30, "idle-30s"), (60, "idle-60s"), (90, "idle-90s")];

pub fn run(row: Row, turn: &Turn<'_>, settings: &Settings) -> Result<Outcome> {
    // The warm start reopens the cold start's folder, whose first screen of thumbnails is on
    // disk; the scroll reopens the fill's, whose first screen the fill evicted (View keeps 5,000
    // thumbnails, as Electron Oriel does).
    let data = turn.folder.join(match row {
        Row::ColdStart | Row::WarmStart => "data-cold-start",
        _ => "data-fill",
    });
    if matches!(row, Row::ColdStart | Row::Fill) {
        let _ = fs::remove_dir_all(&data);
    }
    let log = turn.folder.join(format!("{}.log.jsonl", row.name()));
    let _ = fs::remove_file(&log);

    let mut env: Vec<(String, OsString)> = vec![
        ("ORIEL_DATA_DIR".into(), data.clone().into()),
        ("ORIEL_OPEN".into(), settings.fixture.join("stills").into()),
        ("ORIEL_SPIKE_LOG".into(), log.clone().into()),
        ("ORIEL_SPIKE_WINDOW".into(), "1280x900".into()),
        ("ORIEL_SPIKE_QUIT".into(), "1".into()),
    ];
    let variables: &[(&str, &str)] = match row {
        Row::ColdStart => &[("ORIEL_SPIKE_REST_MS", "1000")],
        Row::Fill => &[("ORIEL_SPIKE_FILL", "1"), ("ORIEL_SPIKE_REST_MS", "10000")],
        Row::Scroll => &[
            ("ORIEL_SPIKE_REST_MS", "60000"),
            ("ORIEL_SPIKE_SCROLL", "5000"),
            ("ORIEL_SPIKE_STEPS", "20"),
        ],
        _ => &[("ORIEL_SPIKE_REST_MS", "100000")],
    };
    env.extend(
        variables
            .iter()
            .map(|(key, value)| ((*key).to_owned(), OsString::from(value))),
    );
    env.extend(settings.env.iter().cloned());

    let mut launched = process::launch(Spec {
        program: &turn.app.binary,
        args: Vec::new(),
        env,
        cwd: &turn.folder,
        stdout: None,
        stderr: turn.folder.join(format!("{}.stderr", row.name())),
    })?;
    let pid = launched.pid();
    let mut reader = LogReader::new(&log);
    let mut events: Vec<Value> = Vec::new();
    // The first reading at each event, taken as soon as its line shows.
    let mut at_event: BTreeMap<String, Sample> = BTreeMap::new();
    let mut first_at: Option<Instant> = None;
    let mut settled: BTreeMap<&str, Sample> = BTreeMap::new();
    let mut footprint_tool_at_90s = None;
    let finished = launched.wait_up_to(LIMIT, POLL, |_| {
        if let (Row::WarmStart, Some(first)) = (row, first_at) {
            for (after, name) in SETTLED {
                if !settled.contains_key(name)
                    && first.elapsed() >= Duration::from_secs(after)
                    && let Some(sample) = process::sample(pid)
                {
                    settled.insert(name, sample);
                    // The footprint tool walks the app's memory, so it reads after the CPU
                    // window has closed.
                    if after == 90 {
                        footprint_tool_at_90s = process::footprint_tool(pid);
                    }
                }
            }
        }
        for event in reader.new_events() {
            let name = event["event"].as_str().unwrap_or_default().to_owned();
            if name == "first-thumbnails" {
                first_at = Some(Instant::now());
            }
            if let Some(sample) = process::sample(pid) {
                at_event.entry(name).or_insert(sample);
            }
            events.push(event);
        }
    });
    let exit = if finished {
        launched.exit_code()
    } else {
        launched.stop(Duration::from_secs(10))
    };
    events.extend(reader.new_events());

    let cpu = |from: Option<&Sample>, to: Option<&Sample>| match (from, to) {
        (Some(from), Some(to)) => process::cpu_percent(from, to),
        _ => f64::NAN,
    };
    // CPU time moves less than wall time when other work shares the Mac, so an A/B can lean on
    // it: the app's CPU seconds between two events' readings.
    let cpu_s = |from: &str, to: &str| match (at_event.get(from), at_event.get(to)) {
        (Some(from), Some(to)) => (to.cpu_ns - from.cpu_ns) / 1e9,
        _ => f64::NAN,
    };
    let mut outcome = Outcome::default();
    let number = |name: &str, field: &str| spike_log::number(&events, name, field);
    match row {
        Row::ColdStart => {
            outcome.metric(
                "cold_start.first_thumbnails_ms",
                "Cold start: launch to first thumbnails (ms)",
                number("first-thumbnails", "since_launch_ms"),
            );
            outcome.metric(
                "cold_start.view_created_ms",
                "Cold start: launch to View created (ms)",
                number("start", "since_launch_ms"),
            );
            outcome.metric(
                "cold_start.view_to_first_thumbnails_ms",
                "Cold start: View created to first thumbnails (ms)",
                number("first-thumbnails", "since_view_ms"),
            );
            outcome.metric(
                "cold_start.listed_ms",
                "All stills listed, after View opens (ms)",
                number("listed", "since_view_ms"),
            );
            outcome.metric(
                "cold_start.listed_items",
                "Stills listed",
                number("listed", "items"),
            );
            outcome.metric(
                "cold_start.cpu_s",
                "Cold start: the app's CPU time to first thumbnails (s)",
                at_event
                    .get("first-thumbnails")
                    .map_or(f64::NAN, |sample| sample.cpu_ns / 1e9),
            );
        }
        Row::Fill => {
            outcome.metric(
                "fill.per_second",
                "Fill: thumbnails made per second",
                number("fill", "per_second"),
            );
            outcome.metric(
                "fill.unavailable",
                "Fill: stills without a thumbnail",
                number("fill", "unavailable"),
            );
            outcome.metric(
                "fill.mean_generate_ms",
                "Fill: mean time to make one (ms)",
                number("fill", "mean_generate_ms"),
            );
            outcome.metric(
                "fill.cpu_s",
                "Fill: the app's CPU time, first thumbnails to the last (s)",
                cpu_s("first-thumbnails", "fill"),
            );
        }
        Row::Scroll => {
            scroll_metrics(&mut outcome, &events, &at_event, cpu);
            outcome.metric(
                "scroll.cpu_s",
                "Gallery scroll: the app's CPU time during it (s)",
                cpu_s("scroll-start", "scroll"),
            );
        }
        _ => {
            outcome.metric(
                "warm_start.first_thumbnails_ms",
                "Warm start, first screen on disk: launch to first thumbnails (ms)",
                number("first-thumbnails", "since_launch_ms"),
            );
            outcome.metric(
                "warm_start.from_disk",
                "Warm start: thumbnails from disk at first thumbnails",
                number("first-thumbnails", "from_disk"),
            );
            outcome.metric(
                "warm_start.cpu_percent",
                "CPU at rest in View, settled, 30–90 s after opening (%)",
                cpu(settled.get("idle-30s"), settled.get("idle-90s")),
            );
            let at_90 = settled.get("idle-90s");
            outcome.metric(
                "warm_start.resident_mb",
                "Warm start: resident at 90 s, from outside (MB)",
                at_90.map_or(f64::NAN, |sample| process::mb(sample.resident)),
            );
            outcome.metric(
                "warm_start.footprint_mb",
                "Warm start: footprint at 90 s, footprint tool (MB)",
                footprint_tool_at_90s.map_or(f64::NAN, process::mb),
            );
        }
    }
    outcome.raw("exit", json!(exit));
    outcome.raw("finished", finished);
    outcome.raw("events", events);
    let mut samples: serde_json::Map<String, Value> = at_event
        .iter()
        .map(|(name, sample)| (name.clone(), sample.json()))
        .collect();
    samples.extend(
        settled
            .iter()
            .map(|(name, sample)| ((*name).to_owned(), sample.json())),
    );
    outcome.raw("samples", samples);
    Ok(outcome)
}

fn scroll_metrics(
    outcome: &mut Outcome,
    events: &[Value],
    at_event: &BTreeMap<String, Sample>,
    cpu: impl Fn(Option<&Sample>, Option<&Sample>) -> f64,
) {
    let number = |name: &str, field: &str| spike_log::number(events, name, field);
    outcome.metric(
        "scroll.warm_start_ms",
        "Warm start after a full fill (first screen evicted): launch to first thumbnails (ms)",
        number("first-thumbnails", "since_launch_ms"),
    );
    for (event, key, when) in [
        ("rest", "rest", "60 s after opening"),
        ("after-scroll", "after_scroll", "60 s after scrolling"),
    ] {
        outcome.metric(
            format!("{key}.resident_mb"),
            format!("Memory {when}: resident (MB)"),
            number(event, "resident_mb"),
        );
        outcome.metric(
            format!("{key}.footprint_mb"),
            format!("Memory {when}: footprint (MB)"),
            number(event, "footprint_mb"),
        );
    }
    outcome.metric(
        "rest.cpu_percent",
        "CPU in View, the first 60 s after opening (%)",
        cpu(at_event.get("first-thumbnails"), at_event.get("rest")),
    );
    outcome.metric(
        "after_scroll.cpu_percent",
        "CPU in View, the 60 s after the scroll (%)",
        cpu(at_event.get("scroll"), at_event.get("after-scroll")),
    );
    for (field, label) in [
        ("p50_ms", "p50 (ms)"),
        ("p95_ms", "p95 (ms)"),
        ("p99_ms", "p99 (ms)"),
        ("max_ms", "max (ms)"),
        ("long_frames", "long frames (over 1.5 × p50)"),
        ("frames", "frames"),
    ] {
        outcome.metric(
            format!("scroll.{field}"),
            format!("Gallery scroll at 5,000 px/s: {label}"),
            number("scroll", field),
        );
    }
    for format in ["avif", "jpeg"] {
        for (pace, gap) in [("steady", "500 ms"), ("rapid", "100 ms")] {
            let steps = spike_log::find(events, "steps", &[("format", format), ("pace", pace)]);
            let field = |name: &str| {
                steps
                    .and_then(|steps| steps[name].as_f64())
                    .unwrap_or(f64::NAN)
            };
            let name = format.to_uppercase();
            outcome.metric(
                format!("steps.{format}.{pace}.p50_ms"),
                format!("Viewer step, {name}, {gap} apart: p50 (ms)"),
                field("p50_ms"),
            );
            outcome.metric(
                format!("steps.{format}.{pace}.p95_ms"),
                format!("Viewer step, {name}, {gap} apart: p95 (ms)"),
                field("p95_ms"),
            );
            outcome.metric(
                format!("steps.{format}.{pace}.undrawn"),
                format!("Viewer step, {name}, {gap} apart: steps not drawn"),
                field("asked") - field("drawn"),
            );
        }
    }
}
