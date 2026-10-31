//! Video through libmpv: `oriel-media`'s `mpv_spike sweep` on the first ten videos of each codec,
//! as `run_series.sh` ran it, read from the medians it prints per folder.

use std::ffi::OsString;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context as _, Result, bail};
use serde_json::json;

use super::process::{self, Spec};
use super::{Outcome, Settings, Turn};

pub const CODECS: [&str; 3] = ["h264", "hevc", "av1"];
/// Where to look beside an app's binary for its own `mpv_spike`.
pub const MPV_SPIKE: &[&str] = &["examples/mpv_spike", "mpv_spike"];

pub fn run(turn: &Turn<'_>, settings: &Settings) -> Result<Outcome> {
    let spike = turn
        .app
        .sibling(MPV_SPIKE)
        .or_else(|| settings.mpv_spike.clone())
        .context("no mpv_spike to run")?;
    let videos: Vec<OsString> = CODECS
        .iter()
        .flat_map(|codec| {
            (1..=10).map(move |index| {
                settings
                    .fixture
                    .join(format!("videos/{codec}/VID_{index}.mp4"))
            })
        })
        .map(PathBuf::into_os_string)
        .collect();
    let mut env = Vec::new();
    // A bundle's own libmpv, the one the app plays through.
    if let Some(bundle) = &turn.app.bundle
        && let Some(libmpv) = fs::read_dir(bundle.join("Contents/Frameworks"))?
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .find(|path| {
                path.file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with("libmpv"))
            })
    {
        env.push(("ORIEL_LIBMPV".to_owned(), libmpv.into_os_string()));
    }
    env.extend(settings.env.iter().cloned());
    let log = turn.folder.join("video.log");
    let mut args = vec![OsString::from("sweep")];
    args.extend(videos);
    let mut launched = process::launch(Spec {
        program: &spike,
        args,
        env,
        cwd: &turn.folder,
        stdout: Some(log.clone()),
        stderr: turn.folder.join("video.stderr"),
    })?;
    let finished =
        launched.wait_up_to(Duration::from_secs(900), Duration::from_millis(250), |_| {});
    let exit = if finished {
        launched.exit_code()
    } else {
        launched.stop(Duration::from_secs(10))
    };
    let text = fs::read_to_string(&log)?;
    let sweep = parse_sweep(&text);
    if sweep.is_empty() {
        bail!(
            "mpv_spike printed no medians (exit {exit:?}); see {}",
            log.display()
        );
    }

    let mut outcome = Outcome::default();
    for codec in CODECS {
        let name = match codec {
            "h264" => "H.264",
            "hevc" => "HEVC",
            _ => "AV1",
        };
        for (what, label) in [
            ("open", "open to first frame"),
            ("exact", "exact seek to frame"),
            ("fast", "fast seek to frame"),
        ] {
            outcome.metric(
                format!("video.{codec}.{what}_ms"),
                format!("Video, {name}: {label}, median (ms)"),
                sweep
                    .iter()
                    .find(|(folder, kind, _)| folder == codec && kind == what)
                    .map_or(f64::NAN, |(_, _, value)| *value),
            );
        }
        outcome.metric(
            format!("video.{codec}.without_picture"),
            format!("Video, {name}: files without a picture"),
            sweep
                .iter()
                .find(|(folder, kind, _)| folder == codec && kind == "failed")
                .map_or(f64::NAN, |(_, _, value)| *value),
        );
    }
    let (on_target, off_target) = exact_landings(&text);
    outcome.metric(
        "video.exact_before_target",
        "Video: exact seeks that landed before their target",
        off_target as f64,
    );
    outcome.raw("exit", json!(exit));
    outcome.raw("spike", json!(spike));
    outcome.raw("exact_on_target", on_target);
    Ok(outcome)
}

/// The sweep's per-folder lines: `h264: open to first picture median 97 ms …` and
/// `h264: 10 files, 0 without a picture`, as (folder, `open` | `exact` | `fast` | `failed`, value).
fn parse_sweep(text: &str) -> Vec<(String, String, f64)> {
    let mut rows = Vec::new();
    for line in text.lines() {
        let Some((folder, rest)) = line.split_once(": ") else {
            continue;
        };
        if folder.contains('/') {
            continue;
        }
        for (prefix, kind) in [
            ("open to first picture median ", "open"),
            ("exact seek to its picture median ", "exact"),
            ("fast seek to its picture median ", "fast"),
        ] {
            if let Some(value) = rest
                .strip_prefix(prefix)
                .and_then(|value| value.split_once(" ms"))
                .and_then(|(value, _)| value.parse().ok())
            {
                rows.push((folder.to_owned(), kind.to_owned(), value));
            }
        }
        if let Some(failed) = rest
            .strip_suffix(" without a picture")
            .and_then(|rest| rest.rsplit_once(", "))
            .and_then(|(_, failed)| failed.parse().ok())
        {
            rows.push((folder.to_owned(), "failed".to_owned(), failed));
        }
    }
    rows
}

/// How many exact seeks landed on their target and how many before it, from the per-file lines'
/// `(target 3.000 s, landed 3.000 s)`. AVPlayer's AV1 seeks landed on the keyframe before;
/// libmpv's land on the frame that holds the target.
fn exact_landings(text: &str) -> (usize, usize) {
    let mut on = 0;
    let mut before = 0;
    for line in text.lines() {
        let Some((_, rest)) = line.split_once("(target ") else {
            continue;
        };
        let parsed = rest.split_once(" s, landed ").and_then(|(target, rest)| {
            let landed = rest.split_once(" s)")?.0;
            Some((target.parse::<f64>().ok()?, landed.parse::<f64>().ok()?))
        });
        match parsed {
            Some((target, landed)) if landed + 0.001 < target => before += 1,
            Some(_) => on += 1,
            None => {}
        }
    }
    (on, before)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SWEEP: &str = "\
/fixture/videos/av1/VID_5.mp4: first picture 79 ms, exact seek 335 ms (target 4.500 s, landed \
4.533 s), fast seek 30 ms
/fixture/videos/av1/VID_6.mp4: first picture 93 ms, exact seek 139 ms (target 6.500 s, landed \
6.000 s), fast seek 31 ms
av1: 10 files, 0 without a picture
av1: open to first picture median 88 ms p95 125 ms max 125 ms
av1: exact seek to its picture median 335 ms p95 468 ms max 468 ms
av1: fast seek to its picture median 31 ms p95 39 ms max 39 ms
";

    #[test]
    fn reads_the_sweeps_medians_per_folder() {
        let rows = parse_sweep(SWEEP);
        let get = |kind: &str| {
            rows.iter()
                .find(|(folder, found, _)| folder == "av1" && found == kind)
                .map(|row| row.2)
        };
        assert_eq!(get("open"), Some(88.));
        assert_eq!(get("exact"), Some(335.));
        assert_eq!(get("fast"), Some(31.));
        assert_eq!(get("failed"), Some(0.));
        assert_eq!(exact_landings(SWEEP), (1, 1));
    }
}
