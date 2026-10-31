//! Checks that the fingerprint pass's runs of several samples make the bytes its single runs
//! make, over every video under a folder, and times both ways. For each video it reads the
//! duration as the probe pass does, makes each of the five samples' 32×32 grey frame in its own
//! ffmpeg run (`video_frame_pixels`, the path every sample took before), plans the runs
//! (`plan_frame_runs`) and makes each run of two or more samples in one ffmpeg run
//! (`frame_run_pixels`), comparing every frame byte for byte. A run that fails falls back to
//! single runs in the pass, so it is counted, never compared. Then the prints both ways, timed:
//! wall time and the CPU of ffmpeg and ffprobe.
//!
//! ```sh
//! cargo run --release -p oriel-core-tidy --example video_frames -- <folder> [--lanes <n>]
//! ```

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use oriel_core_tidy::media::probe_video;
use oriel_core_tidy::passes::Media;
use oriel_core_tidy::similarity::{
    SAMPLE_POSITIONS, fingerprint_video_in_runs, fingerprint_video_with, frame_run_pixels,
    plan_frame_runs, video_frame_pixels,
};

/// CPU seconds of the waited-for children: ffmpeg and ffprobe.
#[cfg(unix)]
fn children_cpu() -> f64 {
    // SAFETY: getrusage fills the struct it is given.
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_CHILDREN, &mut usage) };
    let seconds = |time: libc::timeval| time.tv_sec as f64 + f64::from(time.tv_usec) / 1e6;
    seconds(usage.ru_utime) + seconds(usage.ru_stime)
}

/// Off macOS the timer reads nothing yet; the Windows agent ports it.
#[cfg(not(unix))]
fn children_cpu() -> f64 {
    0.0
}

fn videos_under(folder: &Path, found: &mut Vec<PathBuf>) {
    let mut entries: Vec<_> = std::fs::read_dir(folder)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            videos_under(&path, found);
        } else if path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| {
                matches!(
                    ext.to_ascii_lowercase().as_str(),
                    "mp4" | "m4v" | "mov" | "webm" | "mkv" | "avi" | "3gp"
                )
            })
        {
            found.push(path);
        }
    }
}

/// Runs `work` over `items` on `lanes` threads.
fn on_lanes<T: Sync>(items: &[T], lanes: usize, work: impl Fn(&T) + Sync) {
    let next = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        for _ in 0..lanes {
            scope.spawn(|| {
                while let Some(item) = items.get(next.fetch_add(1, Ordering::AcqRel)) {
                    work(item);
                }
            });
        }
    });
}

#[derive(Default)]
struct Tally {
    runs_by_size: [usize; SAMPLE_POSITIONS.len() + 1],
    compared: usize,
    identical: usize,
    fell_back: usize,
    differ: Vec<String>,
}

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(folder) = args.next() else {
        eprintln!("usage: video_frames <folder> [--lanes <n>]");
        std::process::exit(2);
    };
    let lanes = match (args.next().as_deref(), args.next()) {
        (Some("--lanes"), Some(n)) => n.parse().unwrap(),
        _ => std::thread::available_parallelism().map_or(4, std::num::NonZero::get),
    };
    let media = Media::locate();
    let (Some(ffmpeg), Some(ffprobe)) = (media.ffmpeg.as_deref(), media.ffprobe.as_deref()) else {
        panic!("needs the pinned ffmpeg and ffprobe");
    };
    let mut paths = Vec::new();
    videos_under(Path::new(&folder), &mut paths);
    let videos: Vec<(PathBuf, f64)> = paths
        .into_iter()
        .filter_map(|path| {
            let duration_ms = probe_video(ffprobe, &path, None).ok()?.duration_ms?;
            Some((path, duration_ms))
        })
        .collect();
    println!("{} videos with a duration, {lanes} lanes", videos.len());

    // Every frame both ways, byte for byte.
    let tally = Mutex::new(Tally::default());
    on_lanes(&videos, lanes, |(path, duration_ms)| {
        let singles: Vec<_> = SAMPLE_POSITIONS
            .iter()
            .map(|position| video_frame_pixels(ffmpeg, path, duration_ms * position / 1000.0, None))
            .collect();
        let runs = plan_frame_runs(ffprobe, path, *duration_ms, None).unwrap();
        for run in &runs {
            tally.lock().unwrap().runs_by_size[run.positions().len()] += 1;
            if run.positions().len() < 2 {
                continue;
            }
            let made = frame_run_pixels(ffmpeg, path, run, None).unwrap();
            let mut tally = tally.lock().unwrap();
            let Some(frames) = made else {
                tally.fell_back += 1;
                continue;
            };
            for (frame, position) in frames.iter().zip(run.positions()) {
                tally.compared += 1;
                match &singles[position] {
                    Ok(single) if single == frame => tally.identical += 1,
                    single => {
                        let single = single.as_ref().map(Vec::len);
                        tally.differ.push(format!(
                            "{} sample {position}: {single:?} against {} bytes",
                            path.display(),
                            frame.len()
                        ));
                    }
                }
            }
        }
    });
    let tally = tally.into_inner().unwrap();
    println!(
        "runs by samples (1 to 5): {:?}; {} frames compared, {} identical, {} differ; {} runs \
         fell back to single runs",
        &tally.runs_by_size[1..],
        tally.compared,
        tally.identical,
        tally.differ.len(),
        tally.fell_back
    );
    for difference in tally.differ.iter().take(20) {
        println!("  DIFFERS {difference}");
    }

    // The prints both ways, timed, the single runs first.
    let mut prints = Vec::new();
    for in_runs in [false, true] {
        let made = Mutex::new(vec![String::new(); videos.len()]);
        let indexes: Vec<usize> = (0..videos.len()).collect();
        let (started, cpu) = (Instant::now(), children_cpu());
        on_lanes(&indexes, lanes, |&index| {
            let (path, duration_ms) = &videos[index];
            let print = if in_runs {
                fingerprint_video_in_runs(ffmpeg, ffprobe, path, *duration_ms, None)
            } else {
                fingerprint_video_with(ffmpeg, path, *duration_ms, None)
            };
            made.lock().unwrap()[index] =
                print.map_or_else(|e| format!("error: {e}"), |p| p.to_string());
        });
        println!(
            "{:<13} {:>7.2} s wall, {:>8.2} s cpu in ffmpeg and ffprobe",
            if in_runs { "in runs:" } else { "single runs:" },
            started.elapsed().as_secs_f64(),
            children_cpu() - cpu
        );
        prints.push(made.into_inner().unwrap());
    }
    let differ = prints[0]
        .iter()
        .zip(&prints[1])
        .filter(|(single, run)| single != run)
        .count();
    println!("prints: {differ} of {} differ", videos.len());
    if differ > 0 || !tally.differ.is_empty() {
        std::process::exit(1);
    }
}
