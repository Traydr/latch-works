//! One AVIF encode per still through `oriel-avif` (the vendored libavif with aom), at
//! `media-format`'s archive settings, for plan 063's measurements against the wasm encoder.
//!
//! ```text
//! avif-bench <dir> [--threads N] [--speed S] [--runs N]
//! ```
//!
//! `<dir>` is what `bench-glazier.mts avif-prepare` leaves: `list.json` and the RGBA it decoded
//! (`rgba/<name>.rgba`), so this encodes exactly the pixels the wasm encoder got. Writes
//! `<dir>/rust-t<threads>/<name>.avif` and prints a JSON line per still with the median time.
//! libavif is found as the app finds it: `ORIEL_RS_LIBAVIF`, else `.vendor/libavif/current`.

use std::fs;
use std::path::PathBuf;
use std::time::Instant;

use anyhow::{Context, Result, bail};
use oriel_avif::{ARCHIVE_AVIF_OPTIONS, AvifEncodeOptions, Channels, Libavif, Samples, Still};
use oriel_bench::median;
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
struct Listed {
    name: String,
    width: u32,
    height: u32,
}

fn main() -> Result<()> {
    let mut arguments = std::env::args().skip(1);
    let dir = PathBuf::from(arguments.next().context("missing directory")?);
    let mut threads: u32 = 1;
    let mut speed = ARCHIVE_AVIF_OPTIONS.speed;
    let mut runs = 1;

    while let Some(flag) = arguments.next() {
        let value = arguments
            .next()
            .with_context(|| format!("{flag} needs a value"))?;

        match flag.as_str() {
            "--threads" => threads = value.parse()?,
            "--speed" => speed = value.parse()?,
            "--runs" => runs = value.parse()?,
            other => bail!("unknown flag {other}"),
        }
    }

    let libavif = Libavif::get()?;
    println!(
        "{}",
        json!({
            "kind": "avif-rust-versions", "libavif": libavif.version(),
            "codecs": libavif.codec_versions(), "path": libavif.path(),
        })
    );

    let stills: Vec<Listed> = serde_json::from_slice(&fs::read(dir.join("list.json"))?)?;
    let suffix = if speed == ARCHIVE_AVIF_OPTIONS.speed {
        format!("rust-t{threads}")
    } else {
        format!("rust-t{threads}-s{speed}")
    };
    let out_dir = dir.join(suffix);
    fs::create_dir_all(&out_dir)?;
    let options = AvifEncodeOptions {
        speed,
        ..ARCHIVE_AVIF_OPTIONS
    };

    for listed in &stills {
        let rgba = fs::read(dir.join("rgba").join(format!("{}.rgba", listed.name)))?;
        let still = Still {
            width: listed.width,
            height: listed.height,
            channels: Channels::Rgba,
            samples: Samples::Eight(&rgba),
        };
        let mut times = Vec::new();
        let mut encoded = Vec::new();

        for _ in 0..runs {
            let started = Instant::now();
            encoded = libavif.encode(&still, &options, threads)?;
            times.push(started.elapsed().as_secs_f64() * 1000.0);
        }

        fs::write(out_dir.join(format!("{}.avif", listed.name)), &encoded)?;
        println!(
            "{}",
            json!({
                "kind": "avif-rust", "name": listed.name, "width": listed.width,
                "height": listed.height, "threads": threads, "speed": speed,
                "bytes": encoded.len(), "ms": median(&times),
            })
        );
    }

    Ok(())
}
