//! `--electron`: Electron Oriel's View rows, through the e2e package's existing
//! `scripts/frame-performance.ts` as Phase 9 ran it (Playwright on the stock Electron binary),
//! its JSON lines folded into the same measures as Oriel RS's.

use std::fs;
use std::path::Path;
use std::time::Duration;

use anyhow::{Context as _, Result};
use serde_json::{Value, json};

use super::process::{self, Spec};
use super::{Metric, Record, Row, Settings};
use crate::support;

/// Runs the script once for `round` and returns its numbers as one record per View row. A run
/// that fails is logged and gives no records.
pub fn run(
    settings: &Settings,
    out: &Path,
    round: usize,
    app: usize,
    rounds: usize,
) -> Vec<Record> {
    match run_script(settings, out, round) {
        Ok(events) => {
            let records = fold(&events, app);
            let headline = records
                .iter()
                .flat_map(|record| &record.metrics)
                .next()
                .map_or("no numbers".to_owned(), |metric| {
                    format!("{} {}", metric.label, super::stats::number(metric.value))
                });
            support::log(format!("  r{round}/{rounds} electron: {headline}"));
            records
        }
        Err(error) => {
            support::log(format!("  r{round}/{rounds} electron failed: {error:#}"));
            Vec::new()
        }
    }
}

fn run_script(settings: &Settings, out: &Path, round: usize) -> Result<Vec<Value>> {
    let folder = out.join("Electron").join(format!("r{round}"));
    let work = folder.join("work");
    let _ = fs::remove_dir_all(&work);
    let tmp = out.join("Electron/tmp");
    fs::create_dir_all(&tmp)?;
    fs::create_dir_all(&folder)?;
    let repository = settings
        .workspace
        .ancestors()
        .nth(2)
        .context("apps/oriel-rs sits two folders under the repository")?;
    let stdout = folder.join("electron.jsonl");
    let mut env = vec![
        ("TMPDIR".to_owned(), tmp.into_os_string()),
        (
            "FRAME_PERF_FIXTURE_ROOT".to_owned(),
            settings.fixture.clone().into_os_string(),
        ),
        ("FRAME_PERF_WORK_DIR".to_owned(), work.into_os_string()),
    ];
    env.extend(settings.env.iter().cloned());
    let mut launched = process::launch(Spec {
        program: Path::new("pnpm"),
        args: [
            "--filter",
            "@latch-works/e2e",
            "exec",
            "tsx",
            "scripts/frame-performance.ts",
        ]
        .iter()
        .map(Into::into)
        .chain([format!("r{round}").into()])
        .collect(),
        env,
        cwd: repository,
        stdout: Some(stdout.clone()),
        stderr: folder.join("electron.stderr"),
    })?;
    if !launched.wait_up_to(Duration::from_secs(3_600), Duration::from_secs(1), |_| {}) {
        launched.stop(Duration::from_secs(10));
        anyhow::bail!("frame-performance.ts took over an hour");
    }
    let exit = launched.exit_code();
    let events: Vec<Value> = fs::read_to_string(&stdout)?
        .lines()
        .filter(|line| line.starts_with('{'))
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    let path = folder.join("electron.json");
    fs::write(
        &path,
        serde_json::to_string_pretty(&json!({ "round": round, "exit": exit, "events": events }))?
            + "\n",
    )?;
    Ok(events)
}

/// The script's events as Oriel RS's measures, under the same keys, as `summarize.py` read them:
/// the cold start and the first relaunch (the first screen on disk) inside each round, the warm
/// start after the fill, memory and CPU summed over Electron's processes.
fn fold(events: &[Value], app: usize) -> Vec<Record> {
    let find = |name: &str, field: Option<(&str, &str)>| {
        events.iter().find(|event| {
            event["event"] == name
                && field.is_none_or(|(key, value)| event[key].as_str() == Some(value))
        })
    };
    let at = |event: Option<&Value>, path: &[&str]| {
        path.iter()
            .try_fold(event?, |value, key| value.get(key))
            .and_then(Value::as_f64)
    };
    let mut rows: Vec<(Row, Vec<Metric>)> = Vec::new();
    let mut add = |row: Row, key: &str, value: Option<f64>| {
        let Some(value) = value else { return };
        let metric = Metric {
            key: key.to_owned(),
            label: key.to_owned(),
            value,
        };
        match rows.iter_mut().find(|(found, _)| *found == row) {
            Some((_, metrics)) => metrics.push(metric),
            None => rows.push((row, vec![metric])),
        }
    };

    let cold = find("coldstart-first-thumbnails", None);
    add(
        Row::ColdStart,
        "cold_start.first_thumbnails_ms",
        at(cold, &["sinceSpawnMs"]),
    );
    let open = find("open-first-thumbnails", None);
    add(
        Row::ColdStart,
        "cold_start.listed_ms",
        at(open, &["listedSinceRecursiveMs"]),
    );

    let relaunch = find("warmstart-first-thumbnails", None);
    add(
        Row::WarmStart,
        "warm_start.first_thumbnails_ms",
        at(relaunch, &["sinceSpawnMs"]),
    );
    let idle = find("idle", None);
    add(
        Row::WarmStart,
        "warm_start.cpu_percent",
        at(idle, &["cpuPercent"]),
    );
    add(
        Row::WarmStart,
        "warm_start.resident_mb",
        at(idle, &["memoryAt90s", "residentMb"]),
    );
    add(
        Row::WarmStart,
        "warm_start.footprint_mb",
        at(idle, &["memoryAt90s", "footprintMb"]),
    );

    let warm = find("warm-first-thumbnails", None);
    add(
        Row::Scroll,
        "scroll.warm_start_ms",
        at(warm, &["sinceSpawnMs"]),
    );
    for (event, key) in [("rest", "rest"), ("after-scroll", "after_scroll")] {
        let event = find(event, None);
        add(
            Row::Scroll,
            &format!("{key}.resident_mb"),
            at(event, &["memory", "residentMb"]),
        );
        add(
            Row::Scroll,
            &format!("{key}.footprint_mb"),
            at(event, &["memory", "footprintMb"]),
        );
        add(
            Row::Scroll,
            &format!("{key}.cpu_percent"),
            at(event, &["cpuPercent"]),
        );
    }
    let scroll = find("scroll", None);
    for (field, key) in [
        ("p50Ms", "p50_ms"),
        ("p95Ms", "p95_ms"),
        ("p99Ms", "p99_ms"),
        ("maxMs", "max_ms"),
        ("longFrames", "long_frames"),
        ("frames", "frames"),
    ] {
        add(Row::Scroll, &format!("scroll.{key}"), at(scroll, &[field]));
    }
    for pace in ["steady", "rapid"] {
        let steps = find("steps", Some(("pace", pace)));
        for format in ["avif", "jpeg"] {
            let prefix = format!("steps.{format}.{pace}");
            add(
                Row::Scroll,
                &format!("{prefix}.p50_ms"),
                at(steps, &[format, "p50Ms"]),
            );
            add(
                Row::Scroll,
                &format!("{prefix}.p95_ms"),
                at(steps, &[format, "p95Ms"]),
            );
            let undrawn = at(steps, &[format, "asked"])
                .zip(at(steps, &[format, "drawn"]))
                .map(|(asked, drawn)| asked - drawn);
            add(Row::Scroll, &format!("{prefix}.undrawn"), undrawn);
        }
    }
    for codec in super::video::CODECS {
        let video = find("video", Some(("codec", codec)));
        for (field, what) in [
            ("openMedianMs", "open"),
            ("exactMedianMs", "exact"),
            ("fastMedianMs", "fast"),
        ] {
            add(
                Row::Video,
                &format!("video.{codec}.{what}_ms"),
                at(video, &[field]),
            );
        }
    }

    rows.into_iter()
        .map(|(row, metrics)| Record { row, app, metrics })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Lines as Phase 9's run wrote them, trimmed to the fields read.
    const LINES: &str = r#"{"event":"coldstart-first-thumbnails","sinceSpawnMs":1022.1}
{"event":"warmstart-first-thumbnails","sinceSpawnMs":562.2}
{"event":"idle","cpuPercent":0.55,"memoryAt90s":{"residentMb":1401.26,"footprintMb":428.65}}
{"event":"rest","cpuPercent":7.91,"memory":{"residentMb":1507.9,"footprintMb":432.36}}
{"event":"steps","pace":"rapid","avif":{"asked":20,"drawn":9,"p50Ms":73.2,"p95Ms":98.9}}
{"event":"video","codec":"hevc","openMedianMs":20.7,"exactMedianMs":37.2,"fastMedianMs":24.3}"#;

    #[test]
    fn electrons_events_land_under_oriel_rss_keys() {
        let events: Vec<Value> = LINES
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let records = fold(&events, 2);
        let value = |row: Row, key: &str| {
            records
                .iter()
                .filter(|record| record.row == row && record.app == 2)
                .flat_map(|record| &record.metrics)
                .find(|metric| metric.key == key)
                .map(|metric| metric.value)
        };
        assert_eq!(
            value(Row::ColdStart, "cold_start.first_thumbnails_ms"),
            Some(1022.1)
        );
        assert_eq!(
            value(Row::WarmStart, "warm_start.first_thumbnails_ms"),
            Some(562.2)
        );
        assert_eq!(value(Row::WarmStart, "warm_start.cpu_percent"), Some(0.55));
        assert_eq!(value(Row::Scroll, "rest.footprint_mb"), Some(432.36));
        assert_eq!(value(Row::Scroll, "steps.avif.rapid.undrawn"), Some(11.));
        assert_eq!(value(Row::Video, "video.hevc.exact_ms"), Some(37.2));
        assert_eq!(value(Row::Scroll, "scroll.p50_ms"), None);
    }
}
