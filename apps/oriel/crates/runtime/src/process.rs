//! What a process uses of the machine, as the spikes and xtask's `measure` read it: macOS's
//! `proc_pid_rusage` for its memory and CPU time, and the calling thread's CPU clock. Elsewhere
//! there is no reading.

/// One reading of a process.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ProcessUsage {
    /// Resident size, in bytes.
    pub resident: u64,
    /// Physical footprint, what Activity Monitor shows, in bytes.
    pub footprint: u64,
    /// CPU time, user and system, in nanoseconds.
    pub cpu_ns: f64,
    /// The CPU time of its children it has reaped, in nanoseconds.
    pub child_cpu_ns: f64,
    /// Milliseconds since the kernel started it.
    pub alive_ms: f64,
}

impl ProcessUsage {
    /// This process's.
    pub fn of_this_process() -> Option<Self> {
        Self::of(std::process::id())
    }

    /// `pid`'s; `None` once it has gone, or off macOS.
    pub fn of(pid: u32) -> Option<Self> {
        platform::usage(pid)
    }
}

/// The CPU time, user and system, of the calling thread, in milliseconds; 0 off macOS. Asked on
/// the main thread, it is what drawing cost there, which frame intervals cannot show once a frame
/// takes less than the display's own interval.
pub fn thread_cpu_ms() -> f64 {
    platform::thread_cpu_ms()
}

#[cfg(target_os = "macos")]
mod platform {
    use std::sync::OnceLock;

    use super::ProcessUsage;

    pub fn usage(pid: u32) -> Option<ProcessUsage> {
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
        let ns = ns_per_tick();
        Some(ProcessUsage {
            resident: usage.ri_resident_size,
            footprint: usage.ri_phys_footprint,
            cpu_ns: (usage.ri_user_time + usage.ri_system_time) as f64 * ns,
            child_cpu_ns: (usage.ri_child_user_time + usage.ri_child_system_time) as f64 * ns,
            alive_ms: now_ticks().saturating_sub(usage.ri_proc_start_abstime) as f64 * ns / 1e6,
        })
    }

    /// Nanoseconds per Mach tick: on Apple silicon `rusage_info`'s times count Mach ticks, not
    /// nanoseconds. `libc` marks its Mach clock bindings deprecated in favour of the `mach2`
    /// crate, which is not worth a dependency for one reading.
    #[expect(deprecated, reason = "libc's Mach clock is enough for one reading")]
    fn ns_per_tick() -> f64 {
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

    #[expect(deprecated, reason = "libc's Mach clock is enough for one reading")]
    fn now_ticks() -> u64 {
        // SAFETY: a clock read.
        unsafe { libc::mach_absolute_time() }
    }

    pub fn thread_cpu_ms() -> f64 {
        let mut time = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: a plain out-parameter.
        if unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut time) } != 0 {
            return 0.;
        }
        time.tv_sec as f64 * 1e3 + time.tv_nsec as f64 / 1e6
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::ProcessUsage;

    pub fn usage(_: u32) -> Option<ProcessUsage> {
        None
    }

    pub fn thread_cpu_ms() -> f64 {
        0.
    }
}
