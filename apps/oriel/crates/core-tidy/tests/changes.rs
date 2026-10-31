//! The differential run of changes against glazier-core (plan 063, Phase 6): every Tidy case of
//! Electron's e2e (Convert, Clean up, Shrink, Tidy up, duplicates, Spot variants) as the
//! scenario of decisions glazier-core's `engine/differential.test.ts` made, replayed through this
//! engine on its own copy of the same archive. After each decision, and again after each Undo,
//! the archive, holding (rows and files), the journal (plans and their steps) and Overview must
//! be what glazier-core left.
//!
//! Files that hold the same bytes must hash the same. Files a conversion made cannot: glazier-core
//! encodes stills with libavif in wasm (jSquash) and Oriel with the vendored native libavif,
//! and videos go through Homebrew's ffmpeg there and the pinned build here. For those what must
//! match does: the path, the format, the picture's size, the codecs and tracks, the original's
//! modification time, the length to within [`TOLERANCE`]'s `duration_ms`, and the size to within
//! its `size_share`, with every byte count that adds re-encoded sizes up (a plan's bytes after,
//! Overview's bytes and Shrink's) to within the same share. Step messages drop what only differs
//! by path: glazier-core's harness notes that it fell back to ffmpeg, which is Oriel's only
//! path, and a kept original's message names the re-encode's size.
//!
//! `ORIEL_CHANGES_OUT` names a file to write Rust's report to, for a closer look.

#[path = "support/changes.rs"]
mod changes;
#[path = "support/report.rs"]
mod report;

use std::fs;
use std::path::{Path, PathBuf};

use oriel_core_tidy::passes::Media;
use serde_json::{Map, Value};

use changes::{Replay, Tolerance, compare_decision, scenario_report};

/// How far a re-encode may stray from glazier-core's (see the module docs). Sizes: on the
/// committed archives the two came out within 3% (stills: native libavif 1.4.2 with aom 3.15.2
/// against jSquash's wasm build; videos: the pinned ffmpeg 9.0.2 against Homebrew's, which differ
/// by a few bytes of encoder tag; animations by Mediabunny's decisions, see
/// `media/transcode.rs`). 10% leaves room for the encoders' next releases on either side and
/// still catches a wrong quality, codec or size, each of which moves a file by far more. Length:
/// one frame of the archive's slowest clip (10 fps) is 100 ms; so far the lengths are equal.
const TOLERANCE: Tolerance = Tolerance {
    size_share: 0.10,
    duration_ms: 100.0,
};

fn conformance() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/glazier-core")
}

fn scratch(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "oriel-tidy-changes-{label}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

#[test]
fn the_engine_makes_glazier_cores_changes() {
    let media = Media::locate();
    if media.ffmpeg.is_none() || media.ffprobe.is_none() || media.vips.is_none() {
        eprintln!(
            "skipped: the changes differential needs libvips and the pinned ffmpeg and ffprobe \
             (cargo run -p oriel-tools --bin fetch-media-tools)"
        );
        return;
    }
    if let Err(error) = oriel_avif::Libavif::get() {
        eprintln!("skipped: the changes differential needs libavif: {error}");
        return;
    }
    let expected: Value =
        serde_json::from_str(&fs::read_to_string(conformance().join("changes.json")).unwrap())
            .unwrap();
    let only = std::env::var("ORIEL_CHANGES_ONLY").ok();
    let mut made = Map::new();
    let mut differences = Vec::new();

    for (name, scenario) in expected["scenarios"].as_object().unwrap() {
        if only.as_deref().is_some_and(|only| only != name) {
            continue;
        }
        let archive_name = scenario["archive"].as_str().unwrap();
        let manifest: report::Manifest = serde_json::from_str(
            &fs::read_to_string(conformance().join(format!("{archive_name}.json"))).unwrap(),
        )
        .unwrap();
        // Under the temp folder, which Tidy's sandbox admits.
        let scratch = scratch(name);
        let archive = scratch.join("archive");
        report::copy_archive(&conformance().join(archive_name), &manifest, &archive);
        let replay = Replay::open(&scratch, &archive, media.clone());

        let mut decisions = Vec::new();
        for (index, recorded) in scenario["decisions"].as_array().unwrap().iter().enumerate() {
            let result = replay.decide(&recorded["decision"]);
            let state = replay.state();
            differences.extend(compare_decision(
                &format!("{name}[{index}] {}", recorded["decision"]["do"]),
                recorded,
                &result,
                &state,
                &TOLERANCE,
            ));
            decisions.push((recorded["decision"].clone(), result, state));
        }
        made.insert(name.clone(), scenario_report(archive_name, decisions));
        futures::executor::block_on(replay.engine.catalog().clone().close()).unwrap();
        let _ = fs::remove_dir_all(&scratch);
    }

    if let Some(out) = std::env::var_os("ORIEL_CHANGES_OUT") {
        fs::write(
            out,
            serde_json::to_string_pretty(&Value::Object(made)).unwrap(),
        )
        .unwrap();
    }
    assert!(
        differences.is_empty(),
        "{} differences from glazier-core's changes:\n{}",
        differences.len(),
        differences.join("\n")
    );
}
