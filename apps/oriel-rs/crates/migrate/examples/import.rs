//! A dry run of the import, without the window: reads Electron Oriel's data under
//! `ORIEL_RS_IMPORT_FROM` (a copy of a home folder) into the scratch data root `ORIEL_RS_DATA_DIR`,
//! puts it in place at once, and prints what came over as counts and sizes, never names.
//!
//! ```sh
//! ORIEL_RS_DATA_DIR=/tmp/oriel-rs-dry-run ORIEL_RS_IMPORT_FROM=/tmp/home-clone \
//!   cargo run -p oriel-migrate --example import
//! ```
//!
//! Both variables are required, so the run never writes Oriel RS's real data root or reads the
//! real home.

use oriel_core_paths::{DATA_DIR_VARIABLE, DataRoot};
use oriel_migrate::{ElectronData, IMPORT_FROM_VARIABLE, Progress, Survey, import_now};

fn main() -> anyhow::Result<()> {
    if std::env::var_os(DATA_DIR_VARIABLE).is_none_or(|value| value.is_empty()) {
        anyhow::bail!("set {DATA_DIR_VARIABLE} to a scratch folder");
    }
    let data = DataRoot::from_environment()?;
    let Some(source) = ElectronData::from_environment() else {
        anyhow::bail!("set {IMPORT_FROM_VARIABLE} to the folder that stands in for the home");
    };
    data.create_folders()?;

    let survey = Survey::of(&source, &data);
    println!("Found:");
    for (mode, line) in survey.rows() {
        println!("  {mode}: {line}");
    }
    if !survey.running.is_empty() {
        println!("  Running: {}", survey.running.join(", "));
    }
    let moved: Vec<&str> = survey
        .moves_aside(&data)
        .iter()
        .map(|area| area.folder())
        .collect();
    println!("Moved aside: {}", moved.join(", "));

    let started = std::time::Instant::now();
    let report = import_now(&source, &data, &Progress::default())?;
    println!("Imported in {:.1} s:", started.elapsed().as_secs_f64());
    for area in &report.areas {
        let state = if area.imported { "ok" } else { "not imported" };
        println!("  {} ({state}): {}", area.area, area.details.join("; "));
        for skipped in &area.skipped {
            println!("    left out: {skipped}");
        }
        if let Some(error) = &area.error {
            println!("    error: {error}");
        }
    }
    println!(
        "Tokens: {} open, {} do not; {} preferences; {} folders known",
        report.tokens.migrated,
        report.tokens.failed,
        report.preferences.len(),
        report.folders.len()
    );
    Ok(())
}
