//! `measure`: Phase 9's scorecard rows for Oriel RS, taken as the scorecard took them, so every
//! optimization can be measured again in the same units (plan 063, decision 11).
//!
//! ```text
//! cargo run -p xtask -- measure <rows…> [--app [<label>=]<Oriel RS.app or binary>]…
//!     [--rounds N] [--out <folder>] [--fixture <folder>] [--env K=V]…
//!     [--sync-url <http://127.0.0.1:port>] [--sync-token <token>] [--sync-source <folder>]
//! ```
//!
//! It replaces the scratch drivers Phase 9 used (`rs_run.py`, `rs_tidy.py`, `mode_idle.py`, the
//! `run_*.sh` series and `summarize.py`, and the `sync-timer` binary, now `oriel-core-sync`'s
//! `sync_bench` example), which were not kept. Each row launches the app with the spikes' variables and
//! reads the spike's log, the app's `proc_pid_rusage` from outside, and the tools' output:
//!
//! - `cold-start`: a fresh data folder; launch to the first thumbnails, and the stills listed;
//! - `fill`: a fresh data folder; every thumbnail made;
//! - `scroll`: the fill's folder (its first screen evicted): the warm start, memory and CPU in the
//!   60 s at rest, the gallery scroll at 5,000 px/s, memory and CPU 60 s after it, the viewer
//!   steps;
//! - `warm-start`: the cold start's folder (its first screen on disk); the warm start, and CPU
//!   from 30 to 90 s after the first thumbnails;
//! - `video`: `mpv_spike sweep` on the first ten videos of each codec;
//! - `library`: the Library spike's 100,000 rows;
//! - `idle-view`, `idle-tidy`, `idle-sync`: CPU from 30 to 90 s after launch in each mode, with
//!   nothing open, and memory;
//! - `sync`: `sync_bench`'s plan, then push, into a Pane View on this Mac only;
//! - `tidy`: the fixture's scan to a finished Overview, then CPU at rest.
//!
//! `view` is the four View rows, `idle` the three modes, `all` every row (Sync only with
//! `--sync-url`). With several `--app`s each round interleaves them, A, B then B, A, so one
//! command is an A/B. Each run's raw JSON goes to `<out>/<app>/r<round>/<row>.json`; the medians
//! and spreads go to `<out>/summary.md` and `summary.json`, and to stdout.

mod process;
mod spike_log;
mod stats;
mod sync;
mod table;
mod tidy;
mod video;
mod view;

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{Context as _, Result, bail};
use serde_json::{Value, json};

use crate::support;

/// The rows, in the order a round runs them: each View row before the one that reuses its data
/// folder, and Tidy, the longest and the busiest, last.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Row {
    ColdStart,
    Fill,
    Scroll,
    WarmStart,
    Video,
    Library,
    IdleView,
    IdleTidy,
    IdleSync,
    Sync,
    Tidy,
}

impl Row {
    const ALL: [Row; 11] = [
        Row::ColdStart,
        Row::Fill,
        Row::Scroll,
        Row::WarmStart,
        Row::Video,
        Row::Library,
        Row::IdleView,
        Row::IdleTidy,
        Row::IdleSync,
        Row::Sync,
        Row::Tidy,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Row::ColdStart => "cold-start",
            Row::Fill => "fill",
            Row::Scroll => "scroll",
            Row::WarmStart => "warm-start",
            Row::Video => "video",
            Row::Library => "library",
            Row::IdleView => "idle-view",
            Row::IdleTidy => "idle-tidy",
            Row::IdleSync => "idle-sync",
            Row::Sync => "sync",
            Row::Tidy => "tidy",
        }
    }

    /// The row whose data folder this one reuses, which then runs too.
    fn needs(self) -> Option<Row> {
        match self {
            Row::Scroll => Some(Row::Fill),
            Row::WarmStart => Some(Row::ColdStart),
            _ => None,
        }
    }
}

/// The rows named on the command line, aliases expanded and the rows they reuse added, in the
/// order a round runs them. `all` takes Sync only when a URL is given.
fn parse_rows(names: &[String], has_sync_url: bool) -> Result<Vec<Row>> {
    let mut rows = Vec::new();
    for name in names {
        match name.as_str() {
            "view" => rows.extend([Row::ColdStart, Row::Fill, Row::Scroll, Row::WarmStart]),
            "idle" => rows.extend([Row::IdleView, Row::IdleTidy, Row::IdleSync]),
            "all" => rows.extend(
                Row::ALL
                    .into_iter()
                    .filter(|row| *row != Row::Sync || has_sync_url),
            ),
            other => match Row::ALL.into_iter().find(|row| row.name() == other) {
                Some(row) => rows.push(row),
                None => bail!("measure: unknown row {other}\n\n{USAGE}"),
            },
        }
    }
    if rows.is_empty() {
        bail!("measure: name at least one row\n\n{USAGE}");
    }
    let needed: Vec<Row> = rows.iter().filter_map(|row| row.needs()).collect();
    rows.extend(needed);
    rows.sort();
    rows.dedup();
    if rows.contains(&Row::Sync) && !has_sync_url {
        bail!("measure: the sync row needs --sync-url, a Pane View on this Mac");
    }
    Ok(rows)
}

const USAGE: &str = "usage: cargo run -p xtask -- measure <rows…> [options]

rows: cold-start fill scroll warm-start video library idle-view idle-tidy idle-sync sync tidy,
      or view (the four View rows), idle (the three modes at rest), all
options:
  --app [<label>=]<path>   an Oriel RS.app or a binary; repeat it for an A/B (default: the bundle
                           in target/release/bundle)
  --rounds N               rounds of every row (default 3)
  --out <folder>           where the data folders, raw JSON and summary go
                           (default /tmp/oriel-rs-measure/run-<seconds>)
  --fixture <folder>       View's, video's and Tidy's fixture
                           (default ~/.latch-works/oriel-rs/sandbox/spike-fixture)
  --env K=V                a variable for every launch (ORIEL_RS_* from the shell are dropped)
  --sync-url <url>         Sync's Pane View: http://127.0.0.1 or http://localhost only
  --sync-token <token>     its token (default the e2e stack's)
  --sync-source <folder>   what Sync plans and pushes
                           (default ~/.latch-works/oriel-rs/sandbox/spike-fixture-smoke)";

/// One app under measurement.
pub struct App {
    pub label: String,
    pub path: PathBuf,
    /// What runs: `Contents/MacOS/oriel-rs` of a bundle, or the binary given.
    pub binary: PathBuf,
    /// The bundle it runs from, if any: `open -a` brings it to the front, and the video row
    /// loads its libmpv.
    pub bundle: Option<PathBuf>,
}

impl App {
    fn resolve(label: String, path: &Path) -> Result<Self> {
        let path = path
            .canonicalize()
            .with_context(|| format!("--app {}: no such file", path.display()))?;
        if path.extension().is_some_and(|extension| extension == "app") {
            let binary = path.join("Contents/MacOS/oriel-rs");
            if !binary.is_file() {
                bail!("{} has no Contents/MacOS/oriel-rs", path.display());
            }
            return Ok(Self {
                label,
                bundle: Some(path.clone()),
                path,
                binary,
            });
        }
        if !path.is_file() {
            bail!("--app {}: neither a .app nor a binary", path.display());
        }
        let bundle = path
            .ancestors()
            .nth(3)
            .filter(|bundle| {
                bundle
                    .extension()
                    .is_some_and(|extension| extension == "app")
                    && path.parent().and_then(Path::file_name) == Some("MacOS".as_ref())
            })
            .map(Path::to_path_buf);
        Ok(Self {
            label,
            binary: path.clone(),
            path,
            bundle,
        })
    }

    /// Brings the app's window to the front, where GPUI draws it: `open -a` on its bundle, as
    /// Phase 9's drivers did, or System Events by process id for a bare binary.
    fn bring_forward(&self, pid: u32) {
        let status = match &self.bundle {
            Some(bundle) => std::process::Command::new("/usr/bin/open")
                .arg("-a")
                .arg(bundle)
                .status(),
            None => std::process::Command::new("/usr/bin/osascript")
                .arg("-e")
                .arg(format!(
                    "tell application \"System Events\" to set frontmost of (first process \
                     whose unix id is {pid}) to true"
                ))
                .status(),
        };
        if !status.is_ok_and(|status| status.success()) {
            support::log(format!("  could not bring {} to the front", self.label));
        }
    }

    /// A tool built beside the binary, as in a cargo target's `release/` folder (`mpv_spike` in
    /// `examples/`, `sync_bench`), so that an A/B of video or Sync measures each side's own code.
    fn sibling(&self, names: &[&str]) -> Option<PathBuf> {
        if self.bundle.is_some() {
            return None;
        }
        let folder = self.binary.parent()?;
        names
            .iter()
            .map(|name| folder.join(name))
            .find(|path| path.is_file())
    }
}

/// What every row shares.
pub struct Settings {
    pub workspace: PathBuf,
    pub fixture: PathBuf,
    pub sandbox: PathBuf,
    pub env: Vec<(String, OsString)>,
    pub sync: Option<sync::Target>,
    pub sync_source: PathBuf,
    /// The workspace's own builds of `mpv_spike` and `sync_bench`, for apps without their own.
    pub mpv_spike: Option<PathBuf>,
    pub sync_bench: Option<PathBuf>,
}

/// One app's turn at one row in one round.
pub struct Turn<'a> {
    pub app: &'a App,
    pub round: usize,
    /// `<out>/<app>/r<round>`, where the run's data folders, logs and JSON go.
    pub folder: PathBuf,
}

/// One number a run measured, under a key the table groups by and the label it shows.
#[derive(Clone, Debug)]
pub struct Metric {
    pub key: String,
    pub label: String,
    pub value: f64,
}

/// What a run gives back: its numbers, and everything it saw, for the raw JSON.
#[derive(Default)]
pub struct Outcome {
    pub metrics: Vec<Metric>,
    pub raw: serde_json::Map<String, Value>,
}

impl Outcome {
    /// Adds a number; NaN marks one the run did not measure, which the summary leaves out.
    pub fn metric(&mut self, key: impl Into<String>, label: impl Into<String>, value: f64) {
        self.metrics.push(Metric {
            key: key.into(),
            label: label.into(),
            value,
        });
    }

    pub fn raw(&mut self, key: &str, value: impl Into<Value>) {
        self.raw.insert(key.to_owned(), value.into());
    }
}

/// A finished run, as the summary reads it.
pub struct Record {
    pub row: Row,
    /// Index into the apps.
    pub app: usize,
    pub metrics: Vec<Metric>,
}

struct Options {
    rows: Vec<String>,
    apps: Vec<(Option<String>, PathBuf)>,
    rounds: usize,
    out: Option<PathBuf>,
    fixture: Option<PathBuf>,
    env: Vec<(String, OsString)>,
    sync_url: Option<String>,
    sync_token: Option<String>,
    sync_source: Option<PathBuf>,
}

fn parse_options(args: &[String]) -> Result<Options> {
    let current = std::env::current_dir()?;
    let mut options = Options {
        rows: Vec::new(),
        apps: Vec::new(),
        rounds: 3,
        out: None,
        fixture: None,
        env: Vec::new(),
        sync_url: None,
        sync_token: None,
        sync_source: None,
    };
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        let mut value = || {
            args.next()
                .with_context(|| format!("{arg} needs a value"))
                .cloned()
        };
        match arg.as_str() {
            "--app" => {
                let value = value()?;
                // `label=path`, when what comes before `=` is a plain name.
                let (label, path) = match value.split_once('=') {
                    Some((label, path)) if !label.is_empty() && !label.contains('/') => {
                        (Some(label.to_owned()), path.to_owned())
                    }
                    _ => (None, value),
                };
                options.apps.push((label, current.join(path)));
            }
            "--rounds" => {
                options.rounds = value()?
                    .parse::<usize>()
                    .ok()
                    .filter(|rounds| *rounds > 0)
                    .context("--rounds takes a whole number from 1")?;
            }
            "--out" => options.out = Some(current.join(value()?)),
            "--fixture" => options.fixture = Some(current.join(value()?)),
            "--env" => {
                let value = value()?;
                let (key, setting) = value
                    .split_once('=')
                    .with_context(|| format!("--env {value}: not K=V"))?;
                options.env.push((key.to_owned(), setting.into()));
            }
            "--sync-url" => options.sync_url = Some(value()?),
            "--sync-token" => options.sync_token = Some(value()?),
            "--sync-source" => options.sync_source = Some(current.join(value()?)),
            flag if flag.starts_with("--") => bail!("measure: unknown option {flag}\n\n{USAGE}"),
            row => options.rows.push(row.to_owned()),
        }
    }
    Ok(options)
}

fn home() -> Result<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .context("HOME is not set")
}

pub fn command(args: &[String]) -> Result<()> {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("{USAGE}");
        return Ok(());
    }
    if !support::is_mac_arm64() {
        bail!("measure runs on macOS arm64 only, where the scorecard was taken");
    }
    let options = parse_options(args)?;
    let rows = parse_rows(&options.rows, options.sync_url.is_some())?;
    let workspace = support::workspace();
    let sandbox = home()?.join(".latch-works/oriel-rs/sandbox");

    let sync = match &options.sync_url {
        Some(url) => Some(sync::Target::new(
            url,
            options
                .sync_token
                .clone()
                .unwrap_or_else(|| sync::E2E_TOKEN.to_owned()),
        )?),
        None => None,
    };

    let mut apps = Vec::new();
    if options.apps.is_empty() {
        let bundle = workspace.join("target/release/bundle/Oriel RS.app");
        apps.push(App::resolve("A".into(), &bundle).context(
            "no --app given and no bundle in target/release/bundle: run `cargo run -p xtask -- \
             bundle`, or name one",
        )?);
    }
    for (index, (label, path)) in options.apps.iter().enumerate() {
        let label = label
            .clone()
            .unwrap_or_else(|| char::from(b'A' + (index % 26) as u8).to_string());
        if apps.iter().any(|app: &App| app.label == label) {
            bail!("two apps are labelled {label}");
        }
        apps.push(App::resolve(label, path)?);
    }

    let fixture = match &options.fixture {
        Some(fixture) => fixture.clone(),
        None => sandbox.join("spike-fixture"),
    };
    let sync_source = match &options.sync_source {
        Some(source) => source.clone(),
        None => sandbox.join("spike-fixture-smoke"),
    };
    let out = match &options.out {
        Some(out) => out.clone(),
        None => PathBuf::from(format!(
            "/tmp/oriel-rs-measure/run-{}",
            (process::epoch_ms() / 1e3) as u64
        )),
    };
    fs::create_dir_all(&out).with_context(|| format!("creating {}", out.display()))?;
    let out = out.canonicalize()?;
    check_inputs(&rows, &fixture, &sandbox, &sync_source)?;

    let mut settings = Settings {
        workspace,
        fixture: fixture.canonicalize()?,
        sandbox,
        env: options.env.clone(),
        sync,
        sync_source,
        mpv_spike: None,
        sync_bench: None,
    };
    // The tools build before anything is timed, so no build runs beside a measurement.
    let needs = |row: Row, names: &[&str]| {
        rows.contains(&row) && apps.iter().any(|app| app.sibling(names).is_none())
    };
    if needs(Row::Video, video::MPV_SPIKE) {
        settings.mpv_spike = Some(build_tool(
            &settings.workspace,
            &["-p", "oriel-media", "--example", "mpv_spike"],
            "examples/mpv_spike",
        )?);
    }
    if needs(Row::Sync, sync::SYNC_BENCH) {
        settings.sync_bench = Some(build_tool(
            &settings.workspace,
            &["-p", "oriel-core-sync", "--example", "sync_bench"],
            "examples/sync_bench",
        )?);
    }

    let labels: Vec<String> = apps.iter().map(|app| app.label.clone()).collect();
    support::log(format!(
        "measure: {} round(s) of {} into {}",
        options.rounds,
        rows.iter()
            .map(|row| row.name())
            .collect::<Vec<_>>()
            .join(", "),
        out.display()
    ));
    for app in &apps {
        support::log(format!("  {}: {}", app.label, app.path.display()));
    }

    let started = Instant::now();
    let mut records: Vec<Record> = Vec::new();
    for round in 1..=options.rounds {
        let order = stats::turns(round - 1, apps.len());
        for row in &rows {
            for &index in &order {
                let app = &apps[index];
                let turn = Turn {
                    app,
                    round,
                    folder: out.join(&app.label).join(format!("r{round}")),
                };
                records.push(run_one(*row, &turn, &settings, index, options.rounds)?);
            }
        }
        write_summary(&out, &labels, &apps, &rows, &records, options.rounds)?;
    }
    support::log(format!(
        "\nmeasure: done in {:.0} s",
        started.elapsed().as_secs_f64()
    ));
    let markdown = write_summary(&out, &labels, &apps, &rows, &records, options.rounds)?;
    println!("\n{markdown}");
    Ok(())
}

/// Refuses inputs a row would fail on halfway through a long series.
fn check_inputs(rows: &[Row], fixture: &Path, sandbox: &Path, sync_source: &Path) -> Result<()> {
    let view = rows.iter().any(|row| {
        matches!(
            row,
            Row::ColdStart | Row::Fill | Row::Scroll | Row::WarmStart
        )
    });
    if view && !fixture.join("stills").is_dir() {
        bail!("the fixture {} has no stills/ folder", fixture.display());
    }
    if rows.contains(&Row::Video) && !fixture.join("videos").is_dir() {
        bail!("the fixture {} has no videos/ folder", fixture.display());
    }
    if rows.contains(&Row::Tidy)
        && !fixture
            .canonicalize()
            .is_ok_and(|fixture| fixture.starts_with(sandbox.canonicalize().unwrap_or_default()))
    {
        bail!(
            "Tidy's fixture {} must be in the sandbox, {}",
            fixture.display(),
            sandbox.display()
        );
    }
    if rows.contains(&Row::Sync) && !sync_source.is_dir() {
        bail!("Sync's source {} is not a folder", sync_source.display());
    }
    Ok(())
}

/// Builds a workspace tool in release, in `CARGO_TARGET_DIR` if set, and returns its path.
fn build_tool(workspace: &Path, args: &[&str], relative: &str) -> Result<PathBuf> {
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| OsString::from("cargo"));
    support::log(format!("measure: cargo build --release {}", args.join(" ")));
    let status = std::process::Command::new(&cargo)
        .args(["build", "--release"])
        .args(args)
        .current_dir(workspace)
        .status()
        .context("starting cargo")?;
    if !status.success() {
        bail!("cargo build --release {} failed ({status})", args.join(" "));
    }
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .filter(|value| !value.is_empty())
        .map_or_else(|| workspace.join("target"), |folder| workspace.join(folder));
    Ok(target.join("release").join(relative))
}

fn run_row(row: Row, turn: &Turn<'_>, settings: &Settings) -> Result<Outcome> {
    match row {
        Row::ColdStart | Row::Fill | Row::Scroll | Row::WarmStart => view::run(row, turn, settings),
        Row::Video => video::run(turn, settings),
        Row::Library => tidy::library(turn, settings),
        Row::IdleView | Row::IdleTidy | Row::IdleSync => tidy::idle(row, turn, settings),
        Row::Sync => sync::run(turn, settings),
        Row::Tidy => tidy::analysis(turn, settings),
    }
}

/// Runs one row for one app, writes its raw JSON, and keeps its numbers. A run that fails is
/// written down and leaves its numbers out, so one crash does not end a long series.
fn run_one(
    row: Row,
    turn: &Turn<'_>,
    settings: &Settings,
    app: usize,
    rounds: usize,
) -> Result<Record> {
    fs::create_dir_all(&turn.folder)
        .with_context(|| format!("creating {}", turn.folder.display()))?;
    let load_before = process::load_average();
    let started = Instant::now();
    let started_epoch_ms = process::epoch_ms();
    let result = run_row(row, turn, settings);
    let wall_s = started.elapsed().as_secs_f64();
    let (outcome, error) = match result {
        Ok(outcome) => (outcome, None),
        Err(error) => (Outcome::default(), Some(format!("{error:#}"))),
    };
    let mut raw = json!({
        "row": row.name(),
        "app": turn.app.label,
        "app_path": turn.app.path,
        "binary": turn.app.binary,
        "round": turn.round,
        "started_epoch_ms": started_epoch_ms,
        "wall_s": (wall_s * 10.).round() / 10.,
        "load_before": load_before,
        "error": error,
        "metrics": outcome
            .metrics
            .iter()
            .map(|metric| (metric.key.clone(), json!(metric.value)))
            .collect::<serde_json::Map<_, _>>(),
    });
    if let Value::Object(fields) = &mut raw {
        fields.extend(outcome.raw);
    }
    let path = turn.folder.join(format!("{}.json", row.name()));
    fs::write(&path, serde_json::to_string_pretty(&raw)? + "\n")
        .with_context(|| format!("writing {}", path.display()))?;
    let headline = outcome.metrics.first().map_or_else(
        || format!("failed: {}", error.as_deref().unwrap_or("no numbers")),
        |metric| format!("{} {}", metric.label, stats::number(metric.value)),
    );
    support::log(format!(
        "  r{}/{rounds} {} {}: {headline} ({wall_s:.0} s)",
        turn.round,
        row.name(),
        turn.app.label,
    ));
    Ok(Record {
        row,
        app,
        metrics: outcome.metrics,
    })
}

/// Writes `summary.md` and `summary.json`, and returns the Markdown.
fn write_summary(
    out: &Path,
    labels: &[String],
    apps: &[App],
    rows: &[Row],
    records: &[Record],
    rounds: usize,
) -> Result<String> {
    let lines = table::lines(labels.len(), rows, records);
    let legend: Vec<String> = apps
        .iter()
        .map(|app| format!("{}: `{}`", app.label, app.path.display()))
        .collect();
    let markdown = table::markdown(labels, &lines, rounds, &legend);
    fs::write(out.join("summary.md"), &markdown)?;
    let summary = json!({
        "rounds": rounds,
        "apps": labels,
        "paths": apps.iter().map(|app| &app.path).collect::<Vec<_>>(),
        "rows": rows.iter().map(|row| row.name()).collect::<Vec<_>>(),
        "metrics": lines.iter().map(table::Line::json).collect::<Vec<_>>(),
    });
    fs::write(
        out.join("summary.json"),
        serde_json::to_string_pretty(&summary)? + "\n",
    )?;
    Ok(markdown)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(rows: &[&str]) -> Vec<String> {
        rows.iter().map(|row| (*row).to_owned()).collect()
    }

    #[test]
    fn rows_run_in_order_with_the_folders_they_reuse() {
        let rows = parse_rows(&names(&["tidy", "scroll", "warm-start"]), false).unwrap();
        assert_eq!(
            rows,
            [
                Row::ColdStart,
                Row::Fill,
                Row::Scroll,
                Row::WarmStart,
                Row::Tidy
            ]
        );
    }

    #[test]
    fn sync_runs_only_against_a_url_given() {
        assert!(parse_rows(&names(&["sync"]), false).is_err());
        assert!(
            !parse_rows(&names(&["all"]), false)
                .unwrap()
                .contains(&Row::Sync)
        );
        assert!(
            parse_rows(&names(&["all"]), true)
                .unwrap()
                .contains(&Row::Sync)
        );
        assert!(parse_rows(&names(&["nothing"]), false).is_err());
    }
}
