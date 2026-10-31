//! The differential run on any folder: copies it under the temp folder (Tidy's sandbox admits
//! nothing else), scans and analyses the copy with Spot variants off and on, and writes the
//! report glazier-core's `engine/differential.test.ts` wrote for a folder. Given an expected
//! report as a third argument, it lists where the two differ.
//!
//! The last report glazier-core made of the smoke fixture (`make-fixture.ts --profile smoke`)
//! is kept as the baseline, `conformance/glazier-core/smoke-fixture.json`:
//!
//! ```sh
//! cargo run --release -p oriel-core-tidy --example tidy_differential -- \
//!   ~/.latch-works/oriel-rs/sandbox/spike-fixture-smoke /tmp/smoke.json \
//!   conformance/glazier-core/smoke-fixture.json
//! ```

#[path = "../tests/support/report.rs"]
mod report;

use std::path::PathBuf;
use std::time::Instant;

use oriel_core_tidy::passes::Media;

fn main() {
    let mut args = std::env::args_os().skip(1);
    let (Some(source), Some(out)) = (args.next(), args.next()) else {
        eprintln!("usage: tidy_differential <folder> <report.json> [<expected.json>]");
        std::process::exit(2);
    };
    let expected = args.next().map(PathBuf::from);
    let scratch =
        std::env::temp_dir().join(format!("oriel-tidy-differential-{}", std::process::id()));
    let archive = scratch.join("archive");
    report::copy_folder(&PathBuf::from(source), &archive);

    let started = Instant::now();
    let made = report::run(&archive, &scratch.join("data"), Media::locate());
    eprintln!(
        "scanned, analysed and reported in {:.1} s",
        started.elapsed().as_secs_f64()
    );
    let _ = std::fs::remove_dir_all(&scratch);
    std::fs::write(&out, serde_json::to_string_pretty(&made).unwrap()).unwrap();

    if let Some(expected) = expected {
        let expected: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(expected).unwrap()).unwrap();
        let differences = report::differences(&expected, &made);
        for difference in differences.iter().take(50) {
            println!("{difference}");
        }
        println!("{} differences", differences.len());
    }
}
