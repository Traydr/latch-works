//! Checks the hardware AVIF route against the catalog's stored prints and against libvips' own
//! loader, still by still, and counts which route each still takes. Reads the files and the catalog
//! only, and prints numbers only, never a path or a name. Run it with stderr sent away, since a
//! library can warn with a file's name. Run it again before trusting a new libvips or a new Mac.
//!
//! ```sh
//! cargo run --release -p oriel-core-tidy --example avif_hardware_check -- \
//!   check <catalog> <lanes> [every nth still] 2>/dev/null
//! cargo run --release -p oriel-core-tidy --example avif_hardware_check -- \
//!   time <catalog> <lanes> <every nth still> <rounds> 2>/dev/null
//! ```

#[cfg(target_os = "macos")]
mod check {
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Instant, UNIX_EPOCH};

    use oriel_core_tidy::internals::to_absolute_path;
    use oriel_core_tidy::internals::{
        DETAIL_VERSION, StillLook, detail_of_still, fingerprint_still, open_libvips,
    };
    use oriel_vips::Vips;
    use oriel_vips::hardware_avif::Declined;
    use rusqlite::{Connection, OpenFlags};

    struct Still {
        path: PathBuf,
        size: i64,
        mtime_ms: f64,
        format: String,
        frames: i64,
        fingerprint: Option<String>,
        print: Option<Vec<u8>>,
    }

    fn stills(catalog: &str, every: usize) -> Vec<Still> {
        let connection = Connection::open_with_flags(
            format!("file:{catalog}?mode=ro"),
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
        )
        .unwrap();
        let mut statement = connection
            .prepare(
                "SELECT r.path, f.rel_path, f.size, f.mtime_ms, COALESCE(f.format, ''),
                   COALESCE(f.frames, 1), f.fingerprint, d.print
                 FROM files f JOIN roots r ON r.id = f.root_id
                 LEFT JOIN file_details d ON d.file_id = f.id AND d.version = ?1
                   AND d.size = f.size AND d.mtime_ms = f.mtime_ms
                 WHERE f.kind = 'image' AND f.is_junk = 0 ORDER BY f.id",
            )
            .unwrap();
        let rows = statement
            .query_map([i64::from(DETAIL_VERSION)], |row| {
                Ok(Still {
                    path: to_absolute_path(&row.get::<_, String>(0)?, &row.get::<_, String>(1)?),
                    size: row.get(2)?,
                    mtime_ms: row.get(3)?,
                    format: row.get(4)?,
                    frames: row.get(5)?,
                    fingerprint: row.get(6)?,
                    print: row.get(7)?,
                })
            })
            .unwrap();
        rows.map(Result::unwrap).step_by(every.max(1)).collect()
    }

    /// Whether the file is still the one the catalog describes.
    fn unchanged(still: &Still) -> bool {
        std::fs::metadata(&still.path).is_ok_and(|metadata| {
            let modified = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok());
            metadata.len() as i64 == still.size
                && modified
                    .is_some_and(|time| (time.as_secs_f64() * 1e3 - still.mtime_ms).abs() < 1.0)
        })
    }

    #[derive(Default)]
    struct Counts(Mutex<BTreeMap<String, u64>>);

    impl Counts {
        fn add(&self, key: String) {
            *self.0.lock().unwrap().entry(key).or_default() += 1;
        }
    }

    fn process_cpu_s() -> f64 {
        // SAFETY: getrusage fills the struct it is given.
        let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
        unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
        let seconds = |time: libc::timeval| time.tv_sec as f64 + f64::from(time.tv_usec) / 1e6;
        seconds(usage.ru_utime) + seconds(usage.ru_stime)
    }

    fn lanes<T: Sync>(items: &[T], count: usize, work: impl Fn(&T) + Sync) {
        let next = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for _ in 0..count {
                scope.spawn(|| {
                    while let Some(item) = items.get(next.fetch_add(1, Ordering::AcqRel)) {
                        work(item);
                    }
                });
            }
        });
    }

    fn check(catalog: &str, count: usize, every: usize) {
        let all = stills(catalog, every);
        let hardware = open_libvips().unwrap();
        let software = open_libvips().unwrap();
        let software = software.without_hardware_decoder();
        let counts = Counts::default();
        let done = AtomicUsize::new(0);
        let started = Instant::now();
        lanes(&all, count, |still| {
            let kind = still.format.as_str();
            let progress = done.fetch_add(1, Ordering::AcqRel) + 1;
            if progress.is_multiple_of(2000) {
                println!(
                    "  {progress} of {} in {:.0} s",
                    all.len(),
                    started.elapsed().as_secs_f64()
                );
            }
            if !unchanged(still) {
                counts.add("skipped: changed or missing since the catalog".into());
                return;
            }
            counts.add(format!("stills: {kind}"));
            if still.frames > 1 {
                counts.add("route: animation, always libvips".into());
                return;
            }
            let route = match hardware.hardware_route(&still.path) {
                Ok(Ok(())) => "hardware".to_owned(),
                Ok(Err(Declined::NotAvif)) => format!("libvips, not an AVIF ({kind})"),
                Ok(Err(reason)) => format!("libvips, declined {reason:?} ({kind})"),
                Err(_) => format!("libvips, would not open ({kind})"),
            };
            counts.add(format!("route: {route}"));
            // Each route's pixels, byte for byte, and each result against what the catalog stores.
            let (ours, theirs) = (
                hardware.rgba_pixels(&still.path),
                software.rgba_pixels(&still.path),
            );
            match (&ours, &theirs) {
                (Ok(ours), Ok(theirs)) if ours == theirs => {
                    counts.add(format!("rgba, {route}: same"))
                }
                (Ok(_), Ok(_)) => counts.add(format!("rgba, {route}: DIFFERENT")),
                (Err(_), Err(_)) => counts.add(format!("rgba, {route}: both fail")),
                _ => counts.add(format!("rgba, {route}: ONE FAILS")),
            }
            let print = fingerprint_still(&hardware, &still.path).map(|print| print.to_string());
            let today = fingerprint_still(&software, &still.path).map(|print| print.to_string());
            match (&print, &today) {
                (Ok(print), Ok(today)) if print == today => {
                    counts.add(format!("print against libvips, {route}: same"));
                }
                (Err(_), Err(_)) => {
                    counts.add(format!("print against libvips, {route}: both fail"))
                }
                _ => {
                    counts.add(format!("print against libvips, {route}: DIFFERENT"));
                    // Numbers only: how far apart, and whether each route repeats itself.
                    let grey =
                        |vips: &Vips| vips.grey_pixels(&still.path, 32, None).unwrap_or_default();
                    let (first_ours, first_theirs) = (grey(&hardware), grey(&software));
                    let differing = first_ours
                        .iter()
                        .zip(&first_theirs)
                        .filter(|(a, b)| a != b)
                        .count();
                    let largest = first_ours
                        .iter()
                        .zip(&first_theirs)
                        .map(|(a, b)| a.abs_diff(*b))
                        .max()
                        .unwrap_or(0);
                    let ours_repeat = (0..20).filter(|_| grey(&hardware) == first_ours).count();
                    let theirs_repeat = (0..20).filter(|_| grey(&software) == first_theirs).count();
                    let same = print.as_ref().ok() == today.as_ref().ok();
                    let dims = hardware
                        .rgba_pixels(&still.path)
                        .map(|(w, h, _)| (w, h))
                        .unwrap_or((0, 0));
                    println!(
                        "print differs on one still: {dims:?}, grey now differs in {differing} of 1024 \
                         bytes by at most {largest}; of 20 repeats hardware gave its grey {ours_repeat} \
                         times, libvips {theirs_repeat}; prints same {same}"
                    );
                }
            }
            let compared = |made: &Result<String, _>| match (made, &still.fingerprint) {
                (Ok(made), Some(stored)) if made == stored => "same",
                (Ok(_), Some(_)) => "DIFFERENT",
                (Ok(_), None) => "none stored",
                (Err(_), None) => "fails, none stored",
                (Err(_), Some(_)) => "FAILS",
            };
            counts.add(format!(
                "print against the catalog, {route}: {} (libvips today: {})",
                compared(&print),
                compared(&today)
            ));
            if let Some(stored) = &still.print {
                match ours.as_ref().ok().and_then(|(width, height, rgba)| {
                    StillLook::from_rgba(*width, *height, rgba).map(|look| look.print())
                }) {
                    Some(print) if print == *stored => {
                        counts.add("detail print against the catalog: same".into());
                    }
                    Some(_) => counts.add("detail print against the catalog: DIFFERENT".into()),
                    None => counts.add("detail print against the catalog: FAILS".into()),
                }
            }
        });
        println!(
            "{} stills in {:.0} s",
            all.len(),
            started.elapsed().as_secs_f64()
        );
        for (key, count) in counts.0.lock().unwrap().iter() {
            println!("{count:>7}  {key}");
        }
    }

    fn time(catalog: &str, count: usize, every: usize, rounds: usize) {
        let all = stills(catalog, every);
        let hardware = open_libvips().unwrap();
        let software = open_libvips().unwrap();
        let software = software.without_hardware_decoder();
        let mut by_kind: BTreeMap<String, Vec<&Still>> = BTreeMap::new();
        for still in &all {
            if still.frames <= 1 && unchanged(still) {
                let route = match hardware.hardware_route(&still.path) {
                    Ok(Ok(())) => "hardware route".to_owned(),
                    Ok(Err(Declined::NotAvif)) => format!("not an AVIF ({})", still.format),
                    Ok(Err(reason)) => format!("declined {reason:?} ({})", still.format),
                    Err(_) => format!("would not open ({})", still.format),
                };
                by_kind.entry(route).or_default().push(still);
            }
        }
        for (kind, stills) in &by_kind {
            println!("{kind}: {} stills", stills.len());
            for round in 0..rounds {
                let order: [(&str, &Vips); 2] = if round % 2 == 0 {
                    [("libvips", &software), ("hardware", &hardware)]
                } else {
                    [("hardware", &hardware), ("libvips", &software)]
                };
                for (name, vips) in order {
                    let (cpu, wall) = (process_cpu_s(), Instant::now());
                    lanes(stills, count, |still| {
                        let _ = fingerprint_still(vips, &still.path);
                    });
                    let (print_cpu, print_wall) =
                        (process_cpu_s() - cpu, wall.elapsed().as_secs_f64());
                    let (cpu, wall) = (process_cpu_s(), Instant::now());
                    lanes(stills, count, |still| {
                        let _ = detail_of_still(vips, &still.path);
                    });
                    let (detail_cpu, detail_wall) =
                        (process_cpu_s() - cpu, wall.elapsed().as_secs_f64());
                    let n = stills.len() as f64;
                    println!(
                        "  r{round} {name:<9} print {:>6.1} ms cpu {:>6.1}/s; detail {:>6.1} ms cpu {:>6.1}/s",
                        print_cpu * 1e3 / n,
                        n / print_wall,
                        detail_cpu * 1e3 / n,
                        n / detail_wall
                    );
                }
            }
        }
    }

    pub fn main() {
        let args: Vec<String> = std::env::args().skip(1).collect();
        let number = |index: usize, default: usize| {
            args.get(index)
                .and_then(|n| n.parse().ok())
                .unwrap_or(default)
        };
        match args[0].as_str() {
            "check" => check(&args[1], number(2, 18), number(3, 1)),
            "time" => time(&args[1], number(2, 18), number(3, 20), number(4, 2)),
            other => panic!("unknown mode {other}"),
        }
    }
}

#[cfg(target_os = "macos")]
fn main() {
    check::main();
}

/// The hardware route is the Mac's alone.
#[cfg(not(target_os = "macos"))]
fn main() {}
