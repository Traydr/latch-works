//! Walk and SHA-256 throughput over an archive, for plan 063's Phase 0.
//!
//! ```text
//! scan-bench walk      <root> [--threads N] [--runs N]
//! scan-bench hash-all  <root> [--threads N] [--buffer BYTES] [--runs N] [--cold]
//! scan-bench hash-pass <root> [--runs N] [--cold]
//! scan-bench evict     <root>
//! scan-bench resident  <root>
//! ```
//!
//! Each run prints a JSON line, then a summary line with the median. `--cold` drops the files
//! from the page cache before each run (see `page_cache`); the walk itself is always warm.

use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{Context, Result, bail};
use oriel_bench::hash::{self, NODE_STREAM_CHUNK};
use oriel_bench::walk::{WalkedFile, walk_root};
use oriel_bench::{median, page_cache};
use serde_json::json;

struct Options {
    command: String,
    root: PathBuf,
    threads: usize,
    buffer: usize,
    runs: usize,
    cold: bool,
}

fn parse_options() -> Result<Options> {
    let mut arguments = std::env::args().skip(1);
    let command = arguments.next().context("missing command")?;
    let root = PathBuf::from(arguments.next().context("missing root")?);
    let mut options = Options {
        command,
        root,
        threads: hash::FULL_CONCURRENCY,
        buffer: NODE_STREAM_CHUNK,
        runs: 3,
        cold: false,
    };

    while let Some(flag) = arguments.next() {
        let mut value = || -> Result<usize> {
            let text = arguments
                .next()
                .with_context(|| format!("{flag} needs a value"))?;
            text.parse().with_context(|| format!("{flag} {text}"))
        };

        match flag.as_str() {
            "--threads" => options.threads = value()?,
            "--buffer" => options.buffer = value()?,
            "--runs" => options.runs = value()?,
            "--cold" => options.cold = true,
            other => bail!("unknown flag {other}"),
        }
    }

    Ok(options)
}

fn list(root: &Path) -> Result<Vec<WalkedFile>> {
    Ok(walk_root(root, 4)
        .with_context(|| format!("walking {}", root.display()))?
        .files)
}

/// Evicts every file and returns the share of pages still resident afterwards.
fn evict_all(files: &[WalkedFile]) -> f64 {
    for file in files {
        // A file that cannot be mapped is simply read warm; the residency figure shows it.
        let _ = page_cache::evict(&file.abs_path);
    }

    residency(files)
}

fn residency(files: &[WalkedFile]) -> f64 {
    let (resident, total) = files
        .iter()
        .filter_map(|file| page_cache::resident_pages(&file.abs_path).ok())
        .fold((0, 0), |(resident, total), (r, t)| {
            (resident + r, total + t)
        });

    if total == 0 {
        0.0
    } else {
        resident as f64 / total as f64
    }
}

fn megabytes_per_second(bytes: u64, seconds: f64) -> f64 {
    bytes as f64 / 1e6 / seconds
}

fn main() -> Result<()> {
    let options = parse_options()?;
    let root = &options.root;

    match options.command.as_str() {
        "walk" => {
            let mut rates = Vec::new();

            for run in 1..=options.runs {
                let started = Instant::now();
                let summary = walk_root(root, options.threads)?;
                let seconds = started.elapsed().as_secs_f64();
                let files_per_second = summary.files.len() as f64 / seconds;
                rates.push(files_per_second);
                println!(
                    "{}",
                    json!({
                        "kind": "walk", "run": run, "threads": options.threads,
                        "files": summary.files.len(), "skipped": summary.skipped_entries,
                        "emptyFolders": summary.empty_folders.len(), "seconds": seconds,
                        "filesPerSecond": files_per_second,
                    })
                );
            }

            println!(
                "{}",
                json!({ "kind": "walk-median", "threads": options.threads,
                    "filesPerSecond": median(&rates) })
            );
        }
        "hash-all" => {
            let files = list(root)?;
            let mut file_rates = Vec::new();
            let mut byte_rates = Vec::new();

            for run in 1..=options.runs {
                let resident = if options.cold {
                    evict_all(&files)
                } else {
                    residency(&files)
                };
                let stats = hash::hash_all(&files, options.threads, options.buffer);
                file_rates.push(stats.files as f64 / stats.seconds);
                byte_rates.push(megabytes_per_second(stats.bytes, stats.seconds));
                println!(
                    "{}",
                    json!({
                        "kind": "hash-all", "run": run, "threads": options.threads,
                        "buffer": options.buffer, "cold": options.cold,
                        "residentBefore": resident, "stats": stats,
                        "filesPerSecond": stats.files as f64 / stats.seconds,
                        "megabytesPerSecond": megabytes_per_second(stats.bytes, stats.seconds),
                    })
                );
            }

            println!(
                "{}",
                json!({
                    "kind": "hash-all-median", "threads": options.threads,
                    "buffer": options.buffer, "cold": options.cold,
                    "filesPerSecond": median(&file_rates),
                    "megabytesPerSecond": median(&byte_rates),
                })
            );
        }
        "hash-pass" => {
            let mut seconds = Vec::new();

            for run in 1..=options.runs {
                let started = Instant::now();
                let summary = walk_root(root, 4)?;
                let walk_seconds = started.elapsed().as_secs_f64();
                let resident = if options.cold {
                    evict_all(&summary.files)
                } else {
                    residency(&summary.files)
                };
                let stats = hash::hash_pass(&summary.files);
                seconds.push(walk_seconds + stats.seconds);
                println!(
                    "{}",
                    json!({
                        "kind": "hash-pass", "run": run, "cold": options.cold,
                        "residentBefore": resident, "files": summary.files.len(),
                        "walkSeconds": walk_seconds, "stats": stats,
                        "walkAndHashSeconds": walk_seconds + stats.seconds,
                    })
                );
            }

            println!(
                "{}",
                json!({ "kind": "hash-pass-median", "cold": options.cold,
                    "walkAndHashSeconds": median(&seconds) })
            );
        }
        "evict" => {
            let files = list(root)?;
            let started = Instant::now();
            let resident = evict_all(&files);
            println!(
                "{}",
                json!({ "kind": "evict", "files": files.len(), "residentAfter": resident,
                    "seconds": started.elapsed().as_secs_f64() })
            );
        }
        "resident" => {
            let files = list(root)?;
            println!(
                "{}",
                json!({ "kind": "resident", "files": files.len(), "resident": residency(&files) })
            );
        }
        other => bail!("unknown command {other}"),
    }

    Ok(())
}
