//! Launching the app and reading it from outside: `proc_pid_rusage` for its memory and CPU time,
//! its child processes, and the system's `footprint` tool, as Phase 9's drivers read them.

use std::ffi::OsString;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result};
use serde_json::{Value, json};

/// One reading of a process: its resident size and physical footprint in bytes, and its CPU time
/// (user and system) in nanoseconds, its own and its reaped children's.
#[derive(Clone, Copy, Debug)]
pub struct Sample {
    pub epoch_ms: f64,
    pub resident: u64,
    pub footprint: u64,
    pub cpu_ns: f64,
    pub child_cpu_ns: f64,
}

impl Sample {
    pub fn json(&self) -> Value {
        json!({
            "epoch_ms": self.epoch_ms,
            "resident_mb": mb(self.resident),
            "footprint_mb": mb(self.footprint),
            "cpu_s": self.cpu_ns / 1e9,
            "child_cpu_s": self.child_cpu_ns / 1e9,
        })
    }
}

/// Megabytes to one decimal, as the spikes write them.
pub fn mb(bytes: u64) -> f64 {
    (bytes as f64 / 1e5).round() / 10.
}

/// The share of one core `pid` used between two readings, in percent.
pub fn cpu_percent(from: &Sample, to: &Sample) -> f64 {
    let window_s = (to.epoch_ms - from.epoch_ms) / 1e3;
    if window_s <= 0. {
        return f64::NAN;
    }
    (to.cpu_ns - from.cpu_ns) / 1e9 / window_s * 100.
}

/// Reads `pid` through `proc_pid_rusage`, as the scorecard's `procstat` did; `None` once it has
/// gone.
pub fn sample(pid: u32) -> Option<Sample> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage_info_v2>::zeroed();
    // SAFETY: `usage` is a `rusage_info_v2`, the flavour asked for.
    let status = unsafe {
        libc::proc_pid_rusage(
            pid as libc::c_int,
            libc::RUSAGE_INFO_V2,
            usage.as_mut_ptr().cast(),
        )
    };
    if status != 0 {
        return None;
    }
    // SAFETY: zeroed is a valid `rusage_info_v2`, and the call filled it.
    let usage = unsafe { usage.assume_init() };
    let ticks = ticks_to_ns();
    Some(Sample {
        epoch_ms: epoch_ms(),
        resident: usage.ri_resident_size,
        footprint: usage.ri_phys_footprint,
        cpu_ns: (usage.ri_user_time + usage.ri_system_time) as f64 * ticks,
        child_cpu_ns: (usage.ri_child_user_time + usage.ri_child_system_time) as f64 * ticks,
    })
}

/// Nanoseconds per Mach tick. On Apple silicon `rusage_info`'s CPU times count Mach ticks, not
/// nanoseconds. `libc` marks its Mach clock bindings deprecated in favour of the `mach2` crate,
/// which is not worth a dependency for one reading (the View spike says the same).
#[expect(deprecated, reason = "libc's Mach clock is enough for one reading")]
fn ticks_to_ns() -> f64 {
    static RATIO: OnceLock<f64> = OnceLock::new();
    *RATIO.get_or_init(|| {
        let mut timebase = libc::mach_timebase_info { numer: 0, denom: 0 };
        // SAFETY: a plain out-parameter.
        unsafe { libc::mach_timebase_info(&mut timebase) };
        if timebase.denom == 0 {
            1.
        } else {
            f64::from(timebase.numer) / f64::from(timebase.denom)
        }
    })
}

pub fn epoch_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0., |since| since.as_secs_f64() * 1e3)
}

/// The processes `pid` started that still run: ffmpeg and ffprobe, for Tidy.
pub fn children(pid: u32) -> Vec<u32> {
    let mut pids = [0 as libc::pid_t; 256];
    // SAFETY: the buffer is as large as the size passed; the call returns how many it filled.
    let count = unsafe {
        libc::proc_listchildpids(
            pid as libc::pid_t,
            pids.as_mut_ptr().cast(),
            std::mem::size_of_val(&pids) as libc::c_int,
        )
    };
    let count = usize::try_from(count).unwrap_or(0).min(pids.len());
    pids[..count]
        .iter()
        .filter(|&&child| child > 0)
        .map(|&child| child as u32)
        .collect()
}

/// The physical footprint the system's `footprint` tool reports for `pid`, in bytes, as
/// `mode_idle.py` and `rs_tidy.py` read it. It walks the process's memory, so it is never run
/// while something is being timed.
pub fn footprint_tool(pid: u32) -> Option<u64> {
    let output = Command::new("/usr/bin/footprint")
        .args([
            "--format",
            "bytes",
            "--noCategories",
            "-p",
            &pid.to_string(),
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    parse_footprint(&text)
}

fn parse_footprint(text: &str) -> Option<u64> {
    let (_, after) = text.split_once("Footprint: ")?;
    after.split_once(" B")?.0.trim().parse().ok()
}

/// The 1, 5 and 15 minute load averages, recorded with each run so a noisy one shows.
pub fn load_average() -> [f64; 3] {
    let mut load = [0f64; 3];
    // SAFETY: the buffer holds the three values asked for.
    unsafe { libc::getloadavg(load.as_mut_ptr(), 3) };
    load.map(|value| (value * 100.).round() / 100.)
}

/// A launched process: the app, a spike, or a bench binary.
pub struct Launched {
    pub child: Child,
    pub started: Instant,
}

impl Launched {
    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// Whether it still runs; reaps it once it has stopped.
    pub fn running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub fn elapsed(&self) -> Duration {
        self.started.elapsed()
    }

    /// Waits up to `limit` for it to stop by itself, polling every `poll`, calling `each` on every
    /// poll. Returns whether it stopped.
    pub fn wait_up_to(
        &mut self,
        limit: Duration,
        poll: Duration,
        mut each: impl FnMut(&mut Self),
    ) -> bool {
        let until = Instant::now() + limit;
        while self.running() {
            if Instant::now() >= until {
                return false;
            }
            each(self);
            std::thread::sleep(poll);
        }
        true
    }

    /// Asks it to quit (SIGTERM, as the drivers' `terminate` and `kill`), then kills it if it is
    /// still there after `grace`. Returns its exit code, if it had one.
    pub fn stop(&mut self, grace: Duration) -> Option<i32> {
        if self.running() {
            // SAFETY: a signal to the process this launched and has not reaped.
            unsafe { libc::kill(self.pid() as libc::pid_t, libc::SIGTERM) };
            if !self.wait_up_to(grace, Duration::from_millis(50), |_| {}) {
                let _ = self.child.kill();
            }
        }
        self.child.wait().ok().and_then(|status| status.code())
    }

    pub fn exit_code(&mut self) -> Option<i32> {
        self.child.wait().ok().and_then(|status| status.code())
    }
}

/// What to launch, and how.
pub struct Spec<'a> {
    pub program: &'a Path,
    pub args: Vec<OsString>,
    pub env: Vec<(String, OsString)>,
    pub cwd: &'a Path,
    pub stdout: Option<PathBuf>,
    pub stderr: PathBuf,
}

/// Starts `spec` with the caller's environment less its `ORIEL_*` and `ORIEL_SPIKE_*`
/// variables, so a variable left in the shell cannot change a run, plus the run's own.
pub fn launch(spec: Spec<'_>) -> Result<Launched> {
    let mut command = Command::new(spec.program);
    command.args(&spec.args).current_dir(spec.cwd);
    for (key, _) in std::env::vars_os() {
        if key
            .to_str()
            .is_some_and(|key| key.starts_with("ORIEL_") || key.starts_with("ORIEL_SPIKE_"))
        {
            command.env_remove(key);
        }
    }
    command.envs(spec.env.iter().map(|(key, value)| (key, value)));
    let stderr = File::create(&spec.stderr)
        .with_context(|| format!("creating {}", spec.stderr.display()))?;
    let stdout = match &spec.stdout {
        Some(path) => {
            Stdio::from(File::create(path).with_context(|| format!("creating {}", path.display()))?)
        }
        None => Stdio::null(),
    };
    command.stdin(Stdio::null()).stdout(stdout).stderr(stderr);
    let started = Instant::now();
    let child = command
        .spawn()
        .with_context(|| format!("starting {}", spec.program.display()))?;
    Ok(Launched { child, started })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_footprint_tools_total() {
        let text = "======\nzsh [57347]: 64-bit    Footprint: 2277784 B (16384 bytes per page)\n";
        assert_eq!(parse_footprint(text), Some(2_277_784));
        assert_eq!(parse_footprint("footprint: no process"), None);
    }

    #[test]
    fn cpu_is_a_share_of_one_core_over_the_window() {
        let at = |epoch_ms: f64, cpu_ns: f64| Sample {
            epoch_ms,
            resident: 0,
            footprint: 0,
            cpu_ns,
            child_cpu_ns: 0.,
        };
        // 0.21 s of CPU over 60 s is 0.35 % of a core.
        let percent = cpu_percent(&at(1_000., 1e9), &at(61_000., 1.21e9));
        assert!((percent - 0.35).abs() < 1e-9);
        assert!(cpu_percent(&at(5., 0.), &at(5., 1.)).is_nan());
    }
}
