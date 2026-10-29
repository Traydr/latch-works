//! The differential run against glazier-core (plan 063): this engine scans and analyses its own
//! copy of the committed throwaway archive, with Spot variants off and then on, and its report
//! must equal the one glazier-core's `engine/differential.test.ts` made of the same archive:
//! Overview's numbers, every file's probe, hashes, fingerprint, loudness and detail print, the
//! similar groups at each level, and the duplicate sets with their keepers and Spot variants'
//! pictures.

#[path = "support/report.rs"]
mod report;

use std::fs;
use std::path::Path;

use oriel_core_tidy::passes::Media;
use serde_json::Value;

fn conformance() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/glazier-core")
}

#[test]
fn the_engine_makes_glazier_cores_report_of_the_archive() {
    let media = Media::locate();
    if media.ffmpeg.is_none() || media.vips.is_none() {
        eprintln!(
            "skipped: the differential run needs libvips and the pinned ffmpeg and ffprobe \
             (cargo run -p oriel-tools --bin fetch-media-tools)"
        );
        return;
    }
    let manifest: report::Manifest =
        serde_json::from_str(&fs::read_to_string(conformance().join("archive.json")).unwrap())
            .unwrap();
    let expected: Value =
        serde_json::from_str(&fs::read_to_string(conformance().join("differential.json")).unwrap())
            .unwrap();

    // Under the temp folder, which Tidy's sandbox admits.
    let scratch = std::env::temp_dir().join(format!(
        "oriel-tidy-differential-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let archive = scratch.join("archive");
    report::copy_archive(&conformance().join("archive"), &manifest, &archive);
    let made = report::run(&archive, &scratch.join("data"), media);
    let _ = fs::remove_dir_all(&scratch);
    if let Some(out) = std::env::var_os("ORIEL_RS_DIFFERENTIAL_OUT") {
        fs::write(out, serde_json::to_string_pretty(&made).unwrap()).unwrap();
    }

    let mut expected = expected;
    expected.as_object_mut().unwrap().remove("about");
    let differences = report::differences(&expected, &made);
    assert!(
        differences.is_empty(),
        "{} differences from glazier-core's report:\n{}",
        differences.len(),
        differences.join("\n")
    );
}
