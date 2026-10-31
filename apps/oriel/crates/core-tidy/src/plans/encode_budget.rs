//! How many AVIF encodes Convert runs at once. Each runs on one thread (so its bytes never depend
//! on how many run beside it), so the cores set the count; but each also holds about 30 bytes a
//! pixel at its peak (the decoded RGBA, libavif's YUV copy and aom's buffers at speed 6), which
//! for a 50-megapixel still is 1.5 GB. So the encodes in flight also share a budget of memory,
//! a quarter of the machine's, and one that would overrun it waits for others to finish. One
//! encode always runs, however large.

use std::sync::{Condvar, Mutex, PoisonError};
use std::time::Duration;

use oriel_runtime::Cancelled;

use crate::passes::Progress;

/// Bytes an encode holds per pixel at its peak, measured at 28 to 29 on 8-megapixel stills
/// (3.8 GB footprint at 16 at once), with room to spare.
pub const ENCODE_BYTES_PER_PIXEL: u64 = 32;

/// The pixels assumed for a still whose size the catalog does not know: 12 megapixels.
const UNKNOWN_PIXELS: u64 = 12_000_000;

/// The share of the machine's memory the encodes in flight may hold together.
const MEMORY_SHARE: u64 = 4;

/// AVIF encodes at once: the cores but two, at least one. Electron Oriel's encoder pool stops at
/// 4 as well; here [`EncodeBudget`] bounds the memory instead.
pub fn still_concurrency() -> usize {
    std::thread::available_parallelism()
        .map_or(2, |cores| cores.get())
        .saturating_sub(2)
        .max(1)
}

/// The memory the encodes in flight share.
#[derive(Debug)]
pub struct EncodeBudget {
    limit: u64,
    used: Mutex<u64>,
    freed: Condvar,
}

impl EncodeBudget {
    /// A quarter of this machine's memory.
    pub fn for_this_machine() -> Self {
        Self::with_limit(physical_memory() / MEMORY_SHARE)
    }

    pub fn with_limit(limit: u64) -> Self {
        Self {
            limit,
            used: Mutex::new(0),
            freed: Condvar::new(),
        }
    }

    /// Takes the memory an encode of a still this many pixels needs, waiting while encodes in
    /// flight hold too much for it to fit; held until the returned reservation drops. Fails once
    /// the work is stopped.
    pub fn reserve(
        &self,
        pixels: Option<u64>,
        progress: &dyn Progress,
    ) -> Result<Reservation<'_>, Cancelled> {
        let bytes = pixels
            .unwrap_or(UNKNOWN_PIXELS)
            .saturating_mul(ENCODE_BYTES_PER_PIXEL);
        let mut used = self.used.lock().unwrap_or_else(PoisonError::into_inner);
        while *used > 0 && used.saturating_add(bytes) > self.limit {
            progress.check()?;
            // A stop is noticed within a quarter of a second.
            used = self
                .freed
                .wait_timeout(used, Duration::from_millis(250))
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        *used += bytes;
        Ok(Reservation {
            budget: self,
            bytes,
        })
    }
}

/// Memory an encode holds in an [`EncodeBudget`].
#[derive(Debug)]
pub struct Reservation<'a> {
    budget: &'a EncodeBudget,
    bytes: u64,
}

impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        let mut used = self
            .budget
            .used
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        *used = used.saturating_sub(self.bytes);
        self.budget.freed.notify_all();
    }
}

/// The machine's memory in bytes; 8 GB where it cannot be read.
fn physical_memory() -> u64 {
    const FALLBACK: u64 = 8 << 30;
    #[cfg(target_os = "macos")]
    {
        let mut bytes: u64 = 0;
        let mut length = std::mem::size_of::<u64>();
        // SAFETY: `hw.memsize` is a 64-bit integer, written into `bytes`.
        let failed = unsafe {
            libc::sysctlbyname(
                c"hw.memsize".as_ptr(),
                (&raw mut bytes).cast(),
                &mut length,
                std::ptr::null_mut(),
                0,
            )
        } != 0;
        if failed || bytes == 0 {
            FALLBACK
        } else {
            bytes
        }
    }
    #[cfg(not(target_os = "macos"))]
    FALLBACK
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;
    use crate::passes::Quiet;

    #[test]
    fn encodes_wait_while_the_ones_in_flight_fill_the_budget() {
        let budget = EncodeBudget::with_limit(10 * ENCODE_BYTES_PER_PIXEL);
        let quiet = Quiet::new();
        let (most, peak) = (AtomicU64::new(0), AtomicU64::new(0));
        std::thread::scope(|scope| {
            for _ in 0..6 {
                scope.spawn(|| {
                    let _held = budget.reserve(Some(4), &quiet).unwrap();
                    let now = most.fetch_add(4, Ordering::AcqRel) + 4;
                    peak.fetch_max(now, Ordering::AcqRel);
                    std::thread::sleep(Duration::from_millis(20));
                    most.fetch_sub(4, Ordering::AcqRel);
                });
            }
        });
        // Two fit in 10, a third would not.
        assert_eq!(peak.load(Ordering::Acquire), 8);
        // One larger than the whole budget still runs, alone.
        drop(budget.reserve(Some(100), &quiet).unwrap());
    }

    #[test]
    fn a_stop_ends_the_wait() {
        let budget = EncodeBudget::with_limit(ENCODE_BYTES_PER_PIXEL);
        let quiet = Quiet::new();
        let _held = budget.reserve(Some(1), &quiet).unwrap();
        quiet.token().cancel();
        assert!(budget.reserve(Some(1), &quiet).is_err());
    }
}
