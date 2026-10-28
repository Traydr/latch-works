//! One AVIF encode per still through native libavif with aom, at `media-format`'s archive
//! settings, for plan 063's Phase 0.
//!
//! ```text
//! avif-bench <dir> [--threads N] [--speed S] [--runs N]
//! ```
//!
//! `<dir>` is what `bench-glazier.mts avif-prepare` leaves: `list.json` and the RGBA it decoded
//! (`rgba/<name>.rgba`), so this encodes exactly the pixels the wasm encoder got. Writes
//! `<dir>/rust-t<threads>/<name>.avif` and prints a JSON line per still with the median time.

use std::ffi::{CStr, c_char, c_int};
use std::fs;
use std::path::PathBuf;
use std::time::Instant;

use anyhow::{Context, Result, bail};
use oriel_bench::median;
use serde::Deserialize;
use serde_json::json;

/// `bench_avif_options` in `avif_shim.c`.
#[repr(C)]
struct AvifOptions {
    quality: c_int,
    quality_alpha: c_int,
    tile_rows_log2: c_int,
    tile_cols_log2: c_int,
    speed: c_int,
    subsample: c_int,
    chroma_delta_q: c_int,
    sharpness: c_int,
    tune: c_int,
    denoise_level: c_int,
    enable_sharp_yuv: c_int,
    max_threads: c_int,
}

unsafe extern "C" {
    fn bench_avif_version() -> *const c_char;
    fn bench_avif_codec_versions(out: *mut c_char, size: usize);
    fn bench_avif_free(data: *mut u8);
    fn bench_avif_encode(
        rgba: *const u8,
        width: u32,
        height: u32,
        options: *const AvifOptions,
        out: *mut *mut u8,
        out_size: *mut usize,
    ) -> c_int;
}

/// `ARCHIVE_AVIF_OPTIONS`: quality 70, alpha as quality, no denoising, no tiles, speed 6,
/// 4:2:0, no chroma delta-q, sharpness 0, plain (not sharp) YUV, tune auto, 8-bit.
fn archive_options(speed: c_int, threads: c_int) -> AvifOptions {
    AvifOptions {
        quality: 70,
        quality_alpha: -1,
        tile_rows_log2: 0,
        tile_cols_log2: 0,
        speed,
        subsample: 1,
        chroma_delta_q: 0,
        sharpness: 0,
        tune: 0,
        denoise_level: 0,
        enable_sharp_yuv: 0,
        max_threads: threads,
    }
}

fn encode(rgba: &[u8], width: u32, height: u32, options: &AvifOptions) -> Result<Vec<u8>> {
    if rgba.len() != width as usize * height as usize * 4 {
        bail!("{} bytes is not {width}×{height} RGBA", rgba.len());
    }

    let mut out: *mut u8 = std::ptr::null_mut();
    let mut out_size = 0usize;

    // SAFETY: `rgba` holds width × height × 4 bytes, checked above; the shim only reads it and
    // writes a malloc'd buffer and its length into the two out-parameters on success.
    let status = unsafe {
        bench_avif_encode(
            rgba.as_ptr(),
            width,
            height,
            options,
            &mut out,
            &mut out_size,
        )
    };

    if status != 0 || out.is_null() {
        bail!("libavif failed with result {status}");
    }

    // SAFETY: on success `out` points to `out_size` bytes the shim allocated, freed right after.
    let bytes = unsafe { std::slice::from_raw_parts(out, out_size) }.to_vec();
    // SAFETY: `out` came from the shim's malloc and is not used again.
    unsafe { bench_avif_free(out) };

    Ok(bytes)
}

#[derive(Deserialize)]
struct Still {
    name: String,
    width: u32,
    height: u32,
}

fn versions() -> (String, String) {
    let mut codecs = vec![0 as c_char; 256];

    // SAFETY: libavif's version is a static C string; the codec buffer is 256 bytes, as
    // `avifCodecVersions` requires, and the shim writes a terminated string into it.
    unsafe {
        bench_avif_codec_versions(codecs.as_mut_ptr(), codecs.len());
        (
            CStr::from_ptr(bench_avif_version())
                .to_string_lossy()
                .into_owned(),
            CStr::from_ptr(codecs.as_ptr())
                .to_string_lossy()
                .into_owned(),
        )
    }
}

fn main() -> Result<()> {
    let mut arguments = std::env::args().skip(1);
    let dir = PathBuf::from(arguments.next().context("missing directory")?);
    let mut threads: c_int = 1;
    let mut speed: c_int = 6;
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

    let (libavif, codecs) = versions();
    println!(
        "{}",
        json!({ "kind": "avif-rust-versions", "libavif": libavif, "codecs": codecs })
    );

    let stills: Vec<Still> = serde_json::from_slice(&fs::read(dir.join("list.json"))?)?;
    let suffix = if speed == 6 {
        format!("rust-t{threads}")
    } else {
        format!("rust-t{threads}-s{speed}")
    };
    let out_dir = dir.join(suffix);
    fs::create_dir_all(&out_dir)?;
    let options = archive_options(speed, threads);

    for still in &stills {
        let rgba = fs::read(dir.join("rgba").join(format!("{}.rgba", still.name)))?;
        let mut times = Vec::new();
        let mut encoded = Vec::new();

        for _ in 0..runs {
            let started = Instant::now();
            encoded = encode(&rgba, still.width, still.height, &options)?;
            times.push(started.elapsed().as_secs_f64() * 1000.0);
        }

        fs::write(out_dir.join(format!("{}.avif", still.name)), &encoded)?;
        println!(
            "{}",
            json!({
                "kind": "avif-rust", "name": still.name, "width": still.width,
                "height": still.height, "threads": threads, "speed": speed,
                "bytes": encoded.len(), "ms": median(&times),
            })
        );
    }

    Ok(())
}
