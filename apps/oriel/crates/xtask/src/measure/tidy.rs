//! Tidy's rows and the modes at rest: the Library spike (`crates/mode-tidy/src/spike.rs`) as
//! `run_rest.sh` drove it, the fixture's analysis as `rs_tidy.py` timed it, and each mode at rest
//! as `mode_idle.py` read it.

use std::ffi::OsString;
use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result, bail};
use serde_json::{Value, json};

use super::process::{self, Launched, Sample, Spec};
use super::spike_log::{self, LogReader};
use super::{Outcome, Row, Settings, Turn};

fn launch(
    turn: &Turn<'_>,
    settings: &Settings,
    name: &str,
    env: Vec<(String, OsString)>,
) -> Result<Launched> {
    let mut env = env;
    env.extend(settings.env.iter().cloned());
    process::launch(Spec {
        program: &turn.app.binary,
        args: Vec::new(),
        env,
        cwd: &turn.folder,
        stdout: None,
        stderr: turn.folder.join(format!("{name}.stderr")),
    })
}

/// Writes the shell's remembered state, so the app opens in `mode` (and on `tidy_view`).
fn remember(data: &Path, mode: &str, tidy_view: Option<&str>) -> Result<()> {
    let shell = data.join("shell");
    fs::create_dir_all(&shell)?;
    let mut storage = json!({ "oriel.mode": mode });
    if let Some(view) = tidy_view {
        storage["oriel.tidy.view"] = json!(view);
    }
    fs::write(shell.join("local-storage.json"), storage.to_string())?;
    Ok(())
}

/// The Library table with 100,000 synthetic rows: sorts, a scroll at 30,000 px/s, selections.
pub fn library(turn: &Turn<'_>, settings: &Settings) -> Result<Outcome> {
    // The synthetic rows show only once Tidy has a root, an empty folder in the data folder's
    // sandbox: a first short launch adds it, as a remembered root the second opens on Library.
    let data = turn.folder.join("data-library");
    let _ = fs::remove_dir_all(&data);
    let root = data.join("sandbox/library-root");
    fs::create_dir_all(&root)?;
    let log = turn.folder.join("library.log.jsonl");
    let _ = fs::remove_file(&log);
    let base = vec![
        ("ORIEL_DATA_DIR".to_owned(), OsString::from(&data)),
        ("ORIEL_TIDY_ROOT".to_owned(), OsString::from(&root)),
    ];
    let mut first = launch(turn, settings, "library-root", base.clone())?;
    std::thread::sleep(Duration::from_secs(5));
    first.stop(Duration::from_secs(10));
    std::thread::sleep(Duration::from_secs(2));

    let mut env = base;
    for (key, value) in [
        ("ORIEL_TIDY_PAGE", "library"),
        ("ORIEL_SPIKE_LIBRARY", "100000"),
        ("ORIEL_SPIKE_SCROLL", "30000"),
    ] {
        env.push((key.to_owned(), value.into()));
    }
    env.push(("ORIEL_SPIKE_LOG".to_owned(), log.clone().into()));
    let mut launched = launch(turn, settings, "library", env)?;
    // The table draws only while the window is in front.
    std::thread::sleep(Duration::from_secs(3));
    turn.app.bring_forward(launched.pid());
    let finished =
        launched.wait_up_to(Duration::from_secs(240), Duration::from_millis(250), |_| {});
    let exit = if finished {
        launched.exit_code()
    } else {
        launched.stop(Duration::from_secs(10))
    };
    let events = LogReader::new(&log).new_events();

    let mut outcome = Outcome::default();
    let number = |name: &str, field: &str| spike_log::number(&events, name, field);
    outcome.metric(
        "library.rows_ms",
        "Library: 100,000 rows made (ms)",
        number("rows", "made_ms"),
    );
    outcome.metric(
        "library.rows.resident_mb",
        "Library: resident as Tidy starts (MB)",
        number("rows", "resident_mb"),
    );
    outcome.metric(
        "library.rows.footprint_mb",
        "Library: footprint as Tidy starts (MB)",
        number("rows", "footprint_mb"),
    );
    for column in [
        "name",
        "folder",
        "kind",
        "format",
        "size",
        "dimensions",
        "duration",
        "modified",
    ] {
        let sort = spike_log::find(&events, "sort", &[("column", column), ("order", "asc")]);
        for (field, what) in [("rows_ms", "rows"), ("to_frame_ms", "to the frame")] {
            outcome.metric(
                format!("library.sort.{column}.{field}"),
                format!("Library: sort by {column}, {what} (ms)"),
                sort.and_then(|sort| sort[field].as_f64())
                    .unwrap_or(f64::NAN),
            );
        }
    }
    for (field, label) in [
        ("p50_ms", "p50 (ms)"),
        ("p95_ms", "p95 (ms)"),
        ("max_ms", "max (ms)"),
        ("long_frames", "long frames"),
        ("frames", "frames"),
    ] {
        outcome.metric(
            format!("library.scroll.{field}"),
            format!("Library: scroll at 30,000 px/s, {label}"),
            number("scroll", field),
        );
    }
    outcome.metric(
        "library.select.p50_ms",
        "Library: select a row to the frame showing it, p50 (ms)",
        number("select", "p50_ms"),
    );
    outcome.metric(
        "library.select.max_ms",
        "Library: select a row to the frame showing it, max (ms)",
        number("select", "max_ms"),
    );
    outcome.metric(
        "library.after_scroll.resident_mb",
        "Library: resident after the scroll (MB)",
        number("after-scroll", "resident_mb"),
    );
    outcome.metric(
        "library.after_scroll.footprint_mb",
        "Library: footprint after the scroll (MB)",
        number("after-scroll", "footprint_mb"),
    );
    outcome.raw("exit", json!(exit));
    outcome.raw("finished", finished);
    outcome.raw("events", events);
    Ok(outcome)
}

/// One mode at rest with nothing open: CPU from 30 to 90 s after launch, then memory.
pub fn idle(row: Row, turn: &Turn<'_>, settings: &Settings) -> Result<Outcome> {
    let mode = match row {
        Row::IdleView => "view",
        Row::IdleTidy => "tidy",
        _ => "sync",
    };
    let data = turn.folder.join(format!("data-idle-{mode}"));
    let _ = fs::remove_dir_all(&data);
    remember(&data, mode, None)?;
    let mut launched = launch(
        turn,
        settings,
        row.name(),
        vec![("ORIEL_DATA_DIR".to_owned(), data.into())],
    )?;
    let pid = launched.pid();
    std::thread::sleep(Duration::from_secs(30));
    let from = process::sample(pid);
    std::thread::sleep(Duration::from_secs(60));
    let to = process::sample(pid);
    let footprint = process::footprint_tool(pid);
    let children = process::children(pid);
    let exit = launched.stop(Duration::from_secs(10));
    let (Some(from), Some(to)) = (from, to) else {
        bail!("the app had quit before 90 s (exit {exit:?})");
    };

    let mut outcome = Outcome::default();
    let name = format!("{}{}", mode[..1].to_uppercase(), &mode[1..]);
    outcome.metric(
        format!("idle.{mode}.cpu_percent"),
        format!("CPU at rest in {name}, nothing open, 30–90 s after launch (%)"),
        process::cpu_percent(&from, &to),
    );
    outcome.metric(
        format!("idle.{mode}.resident_mb"),
        format!("{name} at rest: resident at 90 s (MB)"),
        process::mb(to.resident),
    );
    outcome.metric(
        format!("idle.{mode}.footprint_mb"),
        format!("{name} at rest: footprint at 90 s, footprint tool (MB)"),
        footprint.map_or(f64::NAN, process::mb),
    );
    outcome.raw("exit", json!(exit));
    outcome.raw("children", json!(children));
    outcome.raw("samples", json!({ "30s": from.json(), "90s": to.json() }));
    Ok(outcome)
}

/// How long the app and its children must stay quiet before the analysis counts as finished.
const QUIET: Duration = Duration::from_secs(5);
/// Under this share of one core, the app is quiet.
const QUIET_CPU: f64 = 0.05;

/// The fixture added as a root, scanned and analysed to a finished Overview, then CPU at rest.
pub fn analysis(turn: &Turn<'_>, settings: &Settings) -> Result<Outcome> {
    // The fixture must be a root the sandbox admits: the data folder's `sandbox` links to the
    // fixtures' folder (DataRoot::admits_tidy_root accepts the resolved sandbox).
    let fixtures = settings
        .fixtures
        .canonicalize()
        .context("no fixtures at ~/.latch-works/oriel-fixtures")?;
    let Ok(relative) = settings.fixture.strip_prefix(&fixtures) else {
        bail!(
            "Tidy's fixture must be in the fixtures' folder, {}, not {}",
            fixtures.display(),
            settings.fixture.display()
        );
    };
    let data = turn.folder.join("data-tidy");
    let _ = fs::remove_dir_all(&data);
    fs::create_dir_all(&data)?;
    std::os::unix::fs::symlink(&fixtures, data.join("sandbox"))?;
    remember(&data, "tidy", Some("overview"))?;
    let root = data.join("sandbox").join(relative);

    let mut launched = launch(
        turn,
        settings,
        "tidy",
        vec![
            ("ORIEL_DATA_DIR".to_owned(), data.clone().into()),
            ("ORIEL_TIDY_ROOT".to_owned(), root.into()),
            ("ORIEL_TIDY_PAGE".to_owned(), "overview".into()),
        ],
    )?;
    let pid = launched.pid();
    std::thread::sleep(Duration::from_secs(2));
    turn.app.bring_forward(pid);

    // Finished: under 5 % of a core and no ffmpeg or ffprobe child for 5 s; the time is the
    // start of that quiet window.
    let mut recent: Vec<(Instant, Sample)> = Vec::new();
    let mut last = None;
    let mut max_children = 0;
    let mut quiet_since: Option<Instant> = None;
    let mut done_at = None;
    let poll = Duration::from_millis(250);
    while launched.running() && launched.elapsed() < Duration::from_secs(1_800) {
        let Some(sample) = process::sample(pid) else {
            break;
        };
        let children = process::children(pid).len();
        max_children = max_children.max(children);
        let now = Instant::now();
        recent.push((now, sample));
        recent.retain(|(at, _)| now.duration_since(*at) <= Duration::from_secs(1));
        last = Some(sample);
        let rate = match (recent.first(), recent.last()) {
            (Some((from_at, from)), Some((to_at, to))) if recent.len() > 1 => {
                (to.cpu_ns - from.cpu_ns) / 1e9 / to_at.duration_since(*from_at).as_secs_f64()
            }
            _ => 1.,
        };
        if launched.elapsed() > Duration::from_secs(5) && rate < QUIET_CPU && children == 0 {
            let since = *quiet_since.get_or_insert(recent[0].0);
            if now.duration_since(since) >= QUIET {
                done_at = Some(since);
                break;
            }
        } else {
            quiet_since = None;
        }
        std::thread::sleep(poll);
    }
    let footprint_at_done = process::footprint_tool(pid);
    std::thread::sleep(Duration::from_secs(25));
    let at_done = process::sample(pid);
    std::thread::sleep(Duration::from_secs(60));
    let at_rest = process::sample(pid);
    let exit = launched.stop(Duration::from_secs(15));
    let counts = catalog_counts(&data.join("tidy/catalog.sqlite"));

    let mut outcome = Outcome::default();
    let done_s = done_at.map_or(f64::NAN, |at| {
        at.duration_since(launched.started).as_secs_f64()
    });
    outcome.metric(
        "tidy.done_s",
        "Tidy: launch to a finished Overview (s)",
        done_s,
    );
    let cpu_to_done = last.map_or(f64::NAN, |sample| sample.cpu_ns / 1e9);
    outcome.metric(
        "tidy.cpu_s",
        "Tidy: the app's CPU time to the finished Overview (s)",
        cpu_to_done,
    );
    outcome.metric(
        "tidy.child_cpu_s",
        "Tidy: ffmpeg's and ffprobe's CPU time to then (s)",
        last.map_or(f64::NAN, |sample| sample.child_cpu_ns / 1e9),
    );
    outcome.metric(
        "tidy.resident_mb",
        "Tidy: resident when the analysis is done (MB)",
        at_done.map_or(f64::NAN, |sample| process::mb(sample.resident)),
    );
    outcome.metric(
        "tidy.footprint_mb",
        "Tidy: footprint when the analysis is done, footprint tool (MB)",
        footprint_at_done.map_or(f64::NAN, process::mb),
    );
    outcome.metric(
        "tidy.max_children",
        "Tidy: most ffmpeg and ffprobe children at once",
        max_children as f64,
    );
    outcome.metric(
        "tidy.rest_cpu_percent",
        "CPU at rest in Tidy, on Overview after the analysis (%)",
        match (at_done, at_rest) {
            (Some(from), Some(to)) => process::cpu_percent(&from, &to),
            _ => f64::NAN,
        },
    );
    for (key, label) in [
        ("files", "files in the catalog"),
        ("fingerprinted", "fingerprinted"),
        ("fingerprint_errors", "fingerprint errors"),
        ("probe_errors", "probe errors"),
        ("loudness", "soundtracks measured"),
        ("sha256", "hashed"),
    ] {
        outcome.metric(
            format!("tidy.{key}"),
            format!("Tidy: {label}"),
            counts
                .as_ref()
                .ok()
                .and_then(|counts| counts[key].as_f64())
                .unwrap_or(f64::NAN),
        );
    }
    outcome.raw("exit", json!(exit));
    outcome.raw("finished", done_at.is_some());
    outcome.raw(
        "catalog",
        counts.unwrap_or_else(|error| json!({ "error": format!("{error:#}") })),
    );
    Ok(outcome)
}

/// The catalog's counts, read with the system's `sqlite3` once the app has quit, so the harness
/// carries no SQLite of its own.
fn catalog_counts(catalog: &Path) -> Result<Value> {
    const COUNTS: [(&str, &str); 7] = [
        ("files", "select count(*) from files"),
        (
            "fingerprinted",
            "select count(*) from files where fingerprint is not null",
        ),
        (
            "fingerprint_errors",
            "select count(*) from files where fingerprint_error is not null",
        ),
        (
            "probe_errors",
            "select count(*) from files where probe_error is not null",
        ),
        (
            "loudness",
            "select count(*) from files where loudness_version > 0",
        ),
        (
            "sha256",
            "select count(*) from files where sha256 is not null",
        ),
        ("last_scan_at", "select last_scan_at from roots"),
    ];
    let query = format!(
        "select {};",
        COUNTS
            .iter()
            .map(|(_, sql)| format!("({sql})"))
            .collect::<Vec<_>>()
            .join(", ")
    );
    let output = Command::new("/usr/bin/sqlite3")
        .arg("-readonly")
        .arg(catalog)
        .arg(&query)
        .stdin(Stdio::null())
        .output()
        .context("running /usr/bin/sqlite3")?;
    if !output.status.success() {
        bail!(
            "sqlite3 {}: {}",
            catalog.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let values: Vec<&str> = text.trim().split('|').collect();
    if values.len() != COUNTS.len() {
        bail!("sqlite3 gave {text:?}");
    }
    Ok(Value::Object(
        COUNTS
            .iter()
            .zip(values)
            .map(|((key, _), value)| ((*key).to_owned(), json!(value.parse::<f64>().ok())))
            .collect(),
    ))
}
