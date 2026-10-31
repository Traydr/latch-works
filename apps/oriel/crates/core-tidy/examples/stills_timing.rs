//! Times the work Tidy does per still at several counts at once, over every still under a
//! folder:
//!
//! - `fingerprint`: the fingerprint pass's decode and pHash (`fingerprint_still`), for JPEG,
//!   PNG, WebP, TIFF and AVIF;
//! - `probe`: the probe pass's header read (`Vips::probe`), for the same;
//! - `convert`: Convert's decode and AVIF encode (`encode_still_to_avif`) of every JPEG, PNG,
//!   WebP and TIFF, into a scratch folder.
//!
//! Each round prints its wall time, CPU time, stills a second and the highest footprint it
//! reached, and checks that every round made the same prints or bytes as the first.
//!
//! ```sh
//! cargo run --release -p oriel-core-tidy --example stills_timing -- \
//!   fingerprint|probe|convert <folder> <scratch> 1,4,8,16
//! ```

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use oriel_avif::Libavif;
use oriel_core_tidy::media::still::encode_still_to_avif;
use oriel_core_tidy::similarity::{Vips, fingerprint_still};
use sha2::{Digest as _, Sha256};

#[cfg(unix)]
fn cpu_seconds() -> f64 {
    // SAFETY: getrusage fills the struct it is given.
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
    let seconds = |time: libc::timeval| time.tv_sec as f64 + f64::from(time.tv_usec) / 1e6;
    seconds(usage.ru_utime) + seconds(usage.ru_stime)
}

#[cfg(target_os = "macos")]
fn footprint() -> u64 {
    // SAFETY: proc_pid_rusage fills a rusage_info_v4 for this process.
    let mut info: libc::rusage_info_v4 = unsafe { std::mem::zeroed() };
    let filled = unsafe {
        libc::proc_pid_rusage(
            libc::getpid(),
            libc::RUSAGE_INFO_V4,
            (&raw mut info).cast::<libc::rusage_info_t>(),
        )
    };
    if filled == 0 {
        info.ri_phys_footprint
    } else {
        0
    }
}

/// Off macOS the timer reads nothing yet; the Windows agent ports it.
#[cfg(not(unix))]
fn cpu_seconds() -> f64 {
    0.0
}

#[cfg(not(target_os = "macos"))]
fn footprint() -> u64 {
    0
}

fn stills_under(folder: &Path, avif: bool, found: &mut Vec<PathBuf>) {
    let mut entries: Vec<_> = std::fs::read_dir(folder)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            stills_under(&path, avif, found);
        } else if path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| {
                matches!(
                    ext.to_ascii_lowercase().as_str(),
                    "jpg" | "jpeg" | "png" | "webp" | "tif" | "tiff"
                ) || (avif && ext.eq_ignore_ascii_case("avif"))
            })
        {
            found.push(path);
        }
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let (Some(mode), Some(folder), Some(scratch), Some(rounds)) =
        (args.next(), args.next(), args.next(), args.next())
    else {
        eprintln!(
            "usage: stills_timing fingerprint|probe|convert <folder> <scratch> <jobs,jobs,...>"
        );
        std::process::exit(2);
    };
    let (fingerprint, probe) = match mode.as_str() {
        "fingerprint" => (true, false),
        "probe" => (false, true),
        "convert" => (false, false),
        other => panic!("unknown mode {other}"),
    };
    let rounds: Vec<usize> = rounds.split(',').map(|n| n.parse().unwrap()).collect();
    // `--release-every <n>`: each lane hands free memory back after every n stills.
    let release_every: Option<usize> = match (args.next().as_deref(), args.next()) {
        (Some("--release-every"), Some(n)) => Some(n.parse().unwrap()),
        _ => None,
    };
    let (vips, _, _) = Vips::open_located().unwrap();
    let libavif = Libavif::get().unwrap();
    let mut stills = Vec::new();
    stills_under(Path::new(&folder), fingerprint || probe, &mut stills);
    println!(
        "{} stills; libvips {}, libavif {}",
        stills.len(),
        vips.version(),
        libavif.version()
    );
    let scratch = PathBuf::from(scratch);
    std::fs::create_dir_all(&scratch).unwrap();

    let mut first: Option<HashMap<usize, String>> = None;
    for jobs in rounds {
        let next = AtomicUsize::new(0);
        let bytes = AtomicU64::new(0);
        let finished = AtomicBool::new(false);
        let peak = AtomicU64::new(footprint());
        let hashes = std::sync::Mutex::new(HashMap::new());
        let started = Instant::now();
        let cpu = cpu_seconds();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                while !finished.load(Ordering::Acquire) {
                    peak.fetch_max(footprint(), Ordering::AcqRel);
                    std::thread::sleep(Duration::from_millis(20));
                }
            });
            let lanes: Vec<_> = (0..jobs)
                .map(|_| {
                    scope.spawn(|| {
                        let mut made_here = 0;
                        loop {
                            let index = next.fetch_add(1, Ordering::AcqRel);
                            let Some(source) = stills.get(index) else {
                                return;
                            };
                            let made = if probe {
                                format!("{:?}", vips.probe(source))
                            } else if fingerprint {
                                fingerprint_still(&vips, source)
                                    .map_or_else(|error| error.to_string(), |p| p.to_string())
                            } else {
                                let out = scratch.join(format!("{index}.avif"));
                                let made =
                                    encode_still_to_avif(&vips, libavif, source, &out).unwrap();
                                bytes.fetch_add(made.bytes, Ordering::AcqRel);
                                let hash = Sha256::digest(std::fs::read(&out).unwrap());
                                let _ = std::fs::remove_file(&out);
                                hash.iter().map(|b| format!("{b:02x}")).collect()
                            };
                            hashes.lock().unwrap().insert(index, made);
                            made_here += 1;
                            if release_every.is_some_and(|every| made_here % every == 0) {
                                oriel_runtime::release_free_memory();
                            }
                        }
                    })
                })
                .collect();
            for lane in lanes {
                lane.join().unwrap();
            }
            finished.store(true, Ordering::Release);
        });
        let wall = started.elapsed().as_secs_f64();
        let cpu = cpu_seconds() - cpu;
        let hashes = hashes.into_inner().unwrap();
        let same = match &first {
            Some(first) => {
                if first == &hashes {
                    "the same results as the first round".to_owned()
                } else {
                    let differ = first
                        .iter()
                        .filter(|(k, v)| hashes.get(k) != Some(v))
                        .count();
                    format!("{differ} RESULTS DIFFER from the first round")
                }
            }
            None => "first round".to_owned(),
        };
        println!(
            "{jobs:>3} at once: {wall:>7.2} s wall, {cpu:>8.2} s cpu, {:>6.2} stills/s, \
             peak footprint {:>6.0} MB, {:.1} MB written; {same}",
            stills.len() as f64 / wall,
            peak.load(Ordering::Acquire) as f64 / 1_048_576.0,
            bytes.load(Ordering::Acquire) as f64 / 1_048_576.0,
        );
        if first.is_none() {
            first = Some(hashes);
        }
        let held = footprint();
        oriel_runtime::release_free_memory();
        println!(
            "      footprint after the round {:.0} MB, after release_free_memory {:.0} MB",
            held as f64 / 1_048_576.0,
            footprint() as f64 / 1_048_576.0
        );
    }
}
