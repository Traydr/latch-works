//! Times Tidy's engine on a root, pass by pass: the scan's walk, sniff, probe and hashes, then the
//! analysis (fingerprints of stills and of videos apart, detail prints, loudness), then the
//! queries Overview and Duplicates make. Each phase prints its wall time, the CPU it took in
//! this process and in its ffmpeg and ffprobe children, and how many cores that kept busy on
//! average. Then the memory the process holds, and any rescans asked for, timed the same way.
//!
//! The root must be one Tidy admits: in the data folder's `sandbox` (a link to the real sandbox
//! will do, as the scorecard's runs use) or the temp folder. It is only read.
//!
//! ```sh
//! cargo run --release -p oriel-core-tidy --example tidy_timing -- \
//!   <root> <data-folder> [--rescans <n>] [--spot-variants] [--hold <seconds>] [--changes] \
//!   [--probe] [--query-rounds <n>] [--estimate]
//! ```
//!
//! `--hold` keeps the process alive after the analysis, its pid printed, for `vmmap`, `heap`
//! and `footprint`. `--changes` then makes the changes, on a root that is a copy (it changes
//! files): Convert's stills, Shrink, Clean up, each timed, then Undo of all three; then Tidy up
//! and its Undo. `--probe` stands in for the UI while the scan and analysis run: a thread at the
//! UI's quality of service wakes every 8.33 ms, as a 120 Hz frame would, and reports how late
//! it woke; another at GPUI's background tasks' (the default) does a fixed piece of work over and
//! over, and reports how much slower it went than before the scan, as View's thumbnails would.

use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use futures::executor::block_on;
use oriel_core_paths::DataRoot;
use oriel_core_tidy::TidyEngine;
use oriel_core_tidy::catalog::rows::{FINGERPRINT_VERSION, FINGERPRINTABLE_SQL};
use oriel_core_tidy::contract::{
    DuplicateScope, DuplicateSetRequest, OptimizeCategory, PlanRequest, PlanSummary,
    SimilarityLevel,
};
use oriel_core_tidy::passes::{Media, Progress, Quiet};
use oriel_runtime::{CancelToken, PauseToken};

/// CPU seconds so far, this process's and its waited-for children's.
#[derive(Clone, Copy, Debug, Default)]
struct Cpu {
    own: f64,
    children: f64,
}

#[cfg(unix)]
fn seconds(time: libc::timeval) -> f64 {
    time.tv_sec as f64 + f64::from(time.tv_usec) / 1e6
}

#[cfg(unix)]
fn cpu_now() -> Cpu {
    let usage = |who| {
        // SAFETY: getrusage fills the struct it is given.
        let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
        unsafe { libc::getrusage(who, &mut usage) };
        seconds(usage.ru_utime) + seconds(usage.ru_stime)
    };
    Cpu {
        own: usage(libc::RUSAGE_SELF),
        children: usage(libc::RUSAGE_CHILDREN),
    }
}

/// Resident and footprint bytes, as Activity Monitor and `footprint` count them.
#[cfg(target_os = "macos")]
fn memory_now() -> (u64, u64) {
    // SAFETY: proc_pid_rusage fills a rusage_info_v4 for this process.
    let mut info: libc::rusage_info_v4 = unsafe { std::mem::zeroed() };
    let filled = unsafe {
        libc::proc_pid_rusage(
            libc::getpid(),
            libc::RUSAGE_INFO_V4,
            (&raw mut info).cast::<libc::rusage_info_t>(),
        )
    };
    if filled != 0 {
        return (0, 0);
    }
    (info.ri_resident_size, info.ri_phys_footprint)
}

/// Off macOS the timer reads nothing yet; the Windows agent ports it.
#[cfg(not(unix))]
fn cpu_now() -> Cpu {
    Cpu::default()
}

#[cfg(not(target_os = "macos"))]
fn memory_now() -> (u64, u64) {
    (0, 0)
}

fn megabytes(bytes: u64) -> f64 {
    bytes as f64 / 1_048_576.0
}

struct Phase {
    label: String,
    total: u64,
    started: Instant,
    cpu: Cpu,
    ended: Option<(Instant, Cpu)>,
}

/// Where the timer splits a phase: after this many items of the phase with this label.
struct Split {
    label: String,
    after: u64,
}

/// Progress that writes down when each phase starts and ends.
struct Timed {
    quiet: Quiet,
    phases: Mutex<Vec<Phase>>,
    splits: Mutex<Vec<Split>>,
}

impl Timed {
    fn new() -> Self {
        Self {
            quiet: Quiet::new(),
            phases: Mutex::new(Vec::new()),
            splits: Mutex::new(Vec::new()),
        }
    }

    fn open(&self, label: String, total: u64) {
        let mut phases = self.phases.lock().unwrap();
        let (now, cpu) = (Instant::now(), cpu_now());
        if let Some(last) = phases.last_mut()
            && last.ended.is_none()
        {
            last.ended = Some((now, cpu));
        }
        phases.push(Phase {
            label,
            total,
            started: now,
            cpu,
            ended: None,
        });
    }

    fn close(&self) {
        let mut phases = self.phases.lock().unwrap();
        if let Some(last) = phases.last_mut()
            && last.ended.is_none()
        {
            last.ended = Some((Instant::now(), cpu_now()));
        }
    }

    fn split_after(&self, label: &str, after: u64) {
        self.splits.lock().unwrap().push(Split {
            label: label.to_owned(),
            after,
        });
    }

    /// Prints the phases and forgets them.
    fn report(&self, heading: &str) -> f64 {
        self.close();
        let phases = std::mem::take(&mut *self.phases.lock().unwrap());
        println!("\n{heading}");
        println!(
            "  {:<44} {:>7} {:>9} {:>9} {:>9} {:>6}",
            "phase", "items", "wall s", "own cpu", "children", "cores"
        );
        let mut wall = 0.0;
        for phase in &phases {
            let (ended, cpu) = phase.ended.unwrap();
            let seconds = ended.duration_since(phase.started).as_secs_f64();
            wall += seconds;
            let own = cpu.own - phase.cpu.own;
            let children = cpu.children - phase.cpu.children;
            println!(
                "  {:<44} {:>7} {:>9.2} {:>9.2} {:>9.2} {:>6.1}",
                phase.label,
                phase.total,
                seconds,
                own,
                children,
                (own + children) / seconds.max(1e-9)
            );
        }
        println!("  {:<44} {:>7} {:>9.2}", "total", "", wall);
        wall
    }
}

impl Progress for Timed {
    fn phase(&self, label: &str, total: u64) {
        self.open(label.to_owned(), total);
    }

    fn done(&self, done: u64) {
        let split = {
            let phases = self.phases.lock().unwrap();
            let label = phases.last().map(|phase| phase.label.clone());
            let splits = self.splits.lock().unwrap();
            splits
                .iter()
                .any(|split| Some(&split.label) == label.as_ref() && split.after == done)
                .then(|| label.unwrap())
        };
        if let Some(label) = split {
            self.open(format!("{label} (rest)"), 0);
        }
    }

    fn cancel_token(&self) -> Option<&CancelToken> {
        self.quiet.cancel_token()
    }

    fn pause_token(&self) -> Option<&PauseToken> {
        self.quiet.pause_token()
    }
}

/// Times one query on the catalog's thread.
fn time<T>(label: &str, query: impl FnOnce() -> T) -> T {
    let started = Instant::now();
    let cpu = cpu_now();
    let answer = query();
    println!(
        "  {:<44} {:>9.1} ms wall {:>9.1} ms cpu",
        label,
        started.elapsed().as_secs_f64() * 1000.0,
        (cpu_now().own - cpu.own) * 1000.0
    );
    answer
}

fn queries(engine: &TidyEngine, root_id: i64) {
    println!("\nqueries");
    time("overview", || block_on(engine.overview(root_id)).unwrap());
    for level in SimilarityLevel::ALL {
        let level = *level;
        time(&format!("duplicate sets, {}", level.as_str()), || {
            block_on(engine.duplicate_sets(DuplicateSetRequest {
                root_id: Some(root_id),
                offset: 0,
                limit: 500,
                level,
                scope: DuplicateScope::All,
                dismissed: false,
            }))
            .unwrap()
        });
    }
    time("overview again (cached)", || {
        block_on(engine.overview(root_id)).unwrap()
    });
}

/// What a probe saw: the UI thread's lateness per wake, the background unit's time per round.
#[derive(Default)]
struct Probe {
    stop: AtomicBool,
    late_ms: Mutex<Vec<f64>>,
    unit_ms: Mutex<Vec<f64>>,
}

#[cfg(target_os = "macos")]
fn set_qos(class: libc::qos_class_t) {
    // SAFETY: changes only the calling thread's quality of service.
    unsafe { libc::pthread_set_qos_class_self_np(class, 0) };
}

/// The probe's two classes, which only macOS has; elsewhere both threads run at the default.
#[cfg(target_os = "macos")]
const INTERACTIVE: libc::qos_class_t = libc::qos_class_t::QOS_CLASS_USER_INTERACTIVE;
#[cfg(target_os = "macos")]
const DEFAULT: libc::qos_class_t = libc::qos_class_t::QOS_CLASS_DEFAULT;
#[cfg(not(target_os = "macos"))]
const INTERACTIVE: () = ();
#[cfg(not(target_os = "macos"))]
const DEFAULT: () = ();
#[cfg(not(target_os = "macos"))]
fn set_qos((): ()) {}

/// A fifth of a millisecond of arithmetic on this Mac, the same every time.
fn work_unit() -> u64 {
    let mut value = 0x9e37_79b9_7f4a_7c15_u64;
    for round in 0..400_000_u64 {
        value = value.rotate_left(7) ^ round.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    }
    std::hint::black_box(value)
}

fn time_unit() -> f64 {
    let started = Instant::now();
    work_unit();
    started.elapsed().as_secs_f64() * 1000.0
}

fn percentile(values: &mut [f64], share: f64) -> f64 {
    if values.is_empty() {
        return f64::NAN;
    }
    values.sort_by(f64::total_cmp);
    values[((values.len() - 1) as f64 * share).round() as usize]
}

impl Probe {
    fn start<'scope>(&'scope self, scope: &'scope std::thread::Scope<'scope, '_>) {
        scope.spawn(move || {
            set_qos(INTERACTIVE);
            let frame = Duration::from_micros(8_333);
            while !self.stop.load(Ordering::Acquire) {
                let started = Instant::now();
                std::thread::sleep(frame);
                let late = started.elapsed().saturating_sub(frame);
                self.late_ms
                    .lock()
                    .unwrap()
                    .push(late.as_secs_f64() * 1000.0);
            }
        });
        scope.spawn(move || {
            set_qos(DEFAULT);
            while !self.stop.load(Ordering::Acquire) {
                let unit = time_unit();
                self.unit_ms.lock().unwrap().push(unit);
                // As a thumbnail worker, busy about half the time.
                std::thread::sleep(Duration::from_millis(1));
            }
        });
    }

    fn report(&self, idle_unit: f64) {
        let mut late = std::mem::take(&mut *self.late_ms.lock().unwrap());
        let mut units = std::mem::take(&mut *self.unit_ms.lock().unwrap());
        let over = late.iter().filter(|&&ms| ms > 4.0).count();
        println!(
            "\nprobe: UI thread woke {} times, late p50 {:.2} ms, p99 {:.2} ms, max {:.2} ms, \
             {over} over 4 ms",
            late.len(),
            percentile(&mut late, 0.5),
            percentile(&mut late, 0.99),
            percentile(&mut late, 1.0),
        );
        let p50 = percentile(&mut units, 0.5);
        println!(
            "probe: background unit p50 {p50:.2} ms, p90 {:.2} ms, against {idle_unit:.2} ms \
             idle ({:.2}x as long)",
            percentile(&mut units, 0.9),
            p50 / idle_unit,
        );
    }
}

fn describe(plan: &PlanSummary) -> String {
    format!(
        "{} ({} done, {} skipped, {} failed; {:.1} → {:.1} MB)",
        plan.title,
        plan.done,
        plan.skipped,
        plan.failed,
        plan.bytes_before as f64 / 1_048_576.0,
        plan.bytes_after as f64 / 1_048_576.0
    )
}

/// Times one change, with the follow-up scan and analysis it asks for.
fn timed_change<T>(
    label: &str,
    timed: &Timed,
    change: impl FnOnce() -> T,
    follow_up: impl FnOnce(&T),
) -> T {
    let (started, cpu) = (Instant::now(), cpu_now());
    let made = change();
    let (changed, changed_cpu) = (Instant::now(), cpu_now());
    follow_up(&made);
    let after = cpu_now();
    timed.report(&format!("{label}: its phases"));
    println!(
        "  {label}: {:.2} s wall, {:.2} s cpu, {:.2} s in ffmpeg; follow-up {:.2} s wall, \
         {:.2} s cpu",
        changed.duration_since(started).as_secs_f64(),
        changed_cpu.own - cpu.own,
        changed_cpu.children - cpu.children,
        changed.elapsed().as_secs_f64(),
        after.own - changed_cpu.own + after.children - changed_cpu.children,
    );
    made
}

fn make_changes(engine: &TidyEngine, root_id: i64, timed: &Timed) {
    println!("\nchanges");
    let mut plans = Vec::new();
    for (label, request) in [
        (
            "Convert stills",
            PlanRequest::Optimize {
                root_id,
                categories: vec![OptimizeCategory::StillToAvif],
                file_ids: None,
            },
        ),
        (
            "Shrink",
            PlanRequest::ShrinkVideos {
                root_id,
                limit_bytes: None,
            },
        ),
        ("Clean up", PlanRequest::Cleanup { root_id }),
    ] {
        let performed = timed_change(
            label,
            timed,
            || engine.perform_blocking(request, timed),
            |performed| {
                if let Ok(performed) = performed {
                    engine
                        .follow_up_blocking(&performed.applied.follow_up, timed)
                        .unwrap();
                }
            },
        );
        match performed {
            Ok(performed) => {
                println!("  {}", describe(&performed.applied.plan));
                plans.push(performed.applied.plan.id);
            }
            Err(error) => println!("  {label}: {error:#}"),
        }
    }
    let undone = timed_change(
        "Undo of all three",
        timed,
        || engine.undo_plans_blocking(&plans, timed).unwrap(),
        |undone| {
            engine.follow_up_blocking(&undone.follow_up, timed).unwrap();
        },
    );
    println!(
        "  undid {} plans, complete: {}",
        undone.plans.len(),
        undone.complete
    );

    let tidied = timed_change(
        "Tidy up",
        timed,
        || {
            engine
                .tidy_up_blocking(
                    root_id,
                    &[
                        OptimizeCategory::StillToAvif,
                        OptimizeCategory::RenameAvif,
                        OptimizeCategory::RenameMp4,
                    ],
                    timed,
                )
                .unwrap()
        },
        |tidied| {
            engine.follow_up_blocking(&tidied.follow_up, timed).unwrap();
        },
    );
    for plan in &tidied.plans {
        println!("  {}", describe(plan));
    }
    let undone = timed_change(
        "Undo of Tidy up",
        timed,
        || {
            engine
                .undo_plans_blocking(&tidied.undoable(), timed)
                .unwrap()
        },
        |undone| {
            engine.follow_up_blocking(&undone.follow_up, timed).unwrap();
        },
    );
    println!(
        "  undid {} plans, complete: {}",
        undone.plans.len(),
        undone.complete
    );
    print_memory("after the changes");
}

fn print_memory(when: &str) {
    let (resident, footprint) = memory_now();
    #[cfg(unix)]
    let peak = {
        // SAFETY: getrusage fills the struct it is given.
        let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
        unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
        usage.ru_maxrss as u64
    };
    #[cfg(not(unix))]
    let peak = 0;
    println!(
        "\nmemory {when}: {:.0} MB resident, {:.0} MB footprint, {:.0} MB peak resident",
        megabytes(resident),
        megabytes(footprint),
        // macOS reports ru_maxrss in bytes.
        megabytes(peak)
    );
}

/// The scan, the analysis it calls for, and the queries Overview and Duplicates make, timed.
fn scan_and_analyse(engine: &TidyEngine, root_id: i64, timed: &Timed, started: Instant) {
    let scanned = engine.scan_blocking(root_id, timed).unwrap();
    // The fingerprint pass takes stills first, then videos (it orders by kind).
    let images: u64 = block_on(engine.catalog().call(move |connection| {
        Ok(connection.query_row(
            &format!(
                "SELECT COUNT(*) FROM files f WHERE f.root_id = ?1 AND f.kind = 'image'
                   AND f.fingerprint_version < {FINGERPRINT_VERSION} AND {FINGERPRINTABLE_SQL}"
            ),
            [root_id],
            |row| row.get::<_, i64>(0),
        )?)
    }))
    .unwrap() as u64;
    timed.split_after("Fingerprinting pictures and videos", images);
    engine
        .follow_up_blocking(&scanned.follow_up, timed)
        .unwrap();
    let total = timed.report(&format!(
        "scan and analysis of {} files ({images} images to fingerprint first)",
        scanned.files
    ));
    queries(engine, root_id);
    println!(
        "\nscan to a finished analysis: {total:.1} s (engine open to here {:.1} s)",
        started.elapsed().as_secs_f64()
    );
}

fn main() {
    let mut args = std::env::args().skip(1);
    let (Some(root), Some(data)) = (args.next(), args.next()) else {
        eprintln!(
            "usage: tidy_timing <root> <data-folder> [--rescans <n>] [--spot-variants] \
             [--hold <seconds>] [--changes] [--probe]"
        );
        std::process::exit(2);
    };
    let mut rescans = 0;
    let mut spot_variants = false;
    let mut hold = 0;
    let mut changes = false;
    let mut probing = false;
    let mut query_rounds = 0;
    let mut estimate = false;
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--estimate" => estimate = true,
            "--query-rounds" => {
                query_rounds = args.next().and_then(|n| n.parse().ok()).unwrap_or(10);
            }
            "--probe" => probing = true,
            "--changes" => changes = true,
            "--rescans" => rescans = args.next().and_then(|n| n.parse().ok()).unwrap_or(1),
            "--spot-variants" => spot_variants = true,
            "--hold" => hold = args.next().and_then(|n| n.parse().ok()).unwrap_or(60),
            other => panic!("unknown flag {other}"),
        }
    }

    let data_root = DataRoot::at(PathBuf::from(&data)).unwrap();
    let started = Instant::now();
    let engine = block_on(TidyEngine::open_with(
        data_root.clone(),
        data_root.tidy().join("catalog.sqlite"),
        Media::locate(),
    ))
    .unwrap();
    println!("{:?}", engine.media());
    let root = block_on(engine.add_root(std::path::Path::new(&root))).unwrap();
    if spot_variants {
        let mut settings = block_on(engine.settings()).unwrap();
        settings.spot_variants = true;
        block_on(engine.update_settings(settings)).unwrap();
    }

    let timed = Timed::new();
    let probe = Probe::default();
    let idle_unit = percentile(&mut (0..200).map(|_| time_unit()).collect::<Vec<_>>(), 0.5);
    std::thread::scope(|scope| {
        if probing {
            probe.start(scope);
        }
        scan_and_analyse(&engine, root.id, &timed, started);
        probe.stop.store(true, Ordering::Release);
    });
    if probing {
        probe.report(idle_unit);
    }
    print_memory("after the analysis");
    if estimate {
        let made = time("Convert's estimate for stills", || {
            block_on(engine.estimate_optimize(root.id, OptimizeCategory::StillToAvif)).unwrap()
        });
        println!(
            "  {} sampled, ratio {:.4} ({:.4} to {:.4})",
            made.sampled, made.ratio, made.ratio_low, made.ratio_high
        );
        print_memory("after the estimate");
    }
    if query_rounds > 0 {
        // As the pages ask again after each change: Overview, Convert's and Shrink's summaries.
        for _ in 0..query_rounds {
            block_on(engine.overview(root.id)).unwrap();
            block_on(engine.optimize_summary(root.id)).unwrap();
            block_on(engine.shrink_summary(root.id)).unwrap();
        }
        print_memory(&format!("after {query_rounds} rounds of queries"));
        std::thread::sleep(Duration::from_secs(1));
        print_memory("a second later");
    }

    for round in 1..=rescans {
        let started = Instant::now();
        let cpu = cpu_now();
        let scanned = engine.scan_blocking(root.id, &timed).unwrap();
        engine
            .follow_up_blocking(&scanned.follow_up, &timed)
            .unwrap();
        timed.report(&format!("rescan {round}"));
        println!(
            "  rescan {round}: {:.2} s wall, {:.2} s cpu",
            started.elapsed().as_secs_f64(),
            cpu_now().own - cpu.own
        );
        queries(&engine, root.id);
    }
    if rescans > 0 {
        print_memory("after the rescans");
    }

    if changes {
        make_changes(&engine, root.id, &timed);
    }

    if hold > 0 {
        println!("\nholding for {hold} s; pid {}", std::process::id());
        std::thread::sleep(Duration::from_secs(5));
        print_memory("5 s later");
        std::thread::sleep(Duration::from_secs(hold));
        print_memory("at the end of the hold");
    }
    block_on(engine.catalog().clone().close()).unwrap();
}
