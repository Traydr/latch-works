//! How many AVIF encodes Convert runs at once. Each runs on one thread (so its bytes never depend
//! on how many run beside it), so the cores set the count; but each also holds about 30 bytes a
//! pixel at its peak (the decoded RGBA, libavif's YUV copy and aom's buffers at speed 6), which
//! for a 50-megapixel still is 1.5 GB. So the encodes in flight also share a budget of memory,
//! a quarter of the machine's, and one that would overrun it waits for others to finish. One
//! encode always runs, however large.

use std::sync::{Arc, Condvar, Mutex, PoisonError};

use oriel_runtime::Cancelled;

use crate::passes::Progress;

/// Bytes an encode holds per pixel at its peak, measured at 28 to 29 on 8-megapixel stills
/// (3.8 GB footprint at 16 at once), with room to spare.
pub const ENCODE_BYTES_PER_PIXEL: u64 = 32;

/// The pixels assumed for a still whose size the catalog does not know: 12 megapixels.
const UNKNOWN_PIXELS: u64 = 12_000_000;

/// The share of the machine's memory the encodes in flight may hold together.
const MEMORY_SHARE: u64 = 4;

/// AVIF encodes at once: the cores but two, at least one; [`EncodeBudget`] bounds the memory.
pub(crate) fn still_concurrency() -> usize {
    std::thread::available_parallelism()
        .map_or(2, |cores| cores.get())
        .saturating_sub(2)
        .max(1)
}

/// The memory the encodes in flight share, one for the process: Convert's changes and its
/// estimates draw on the same budget.
#[derive(Debug)]
pub(crate) struct EncodeBudget {
    limit: u64,
    shared: Arc<Shared>,
}

#[derive(Debug, Default)]
struct Shared {
    used: Mutex<u64>,
    freed: Condvar,
}

impl Shared {
    fn wake(&self) {
        let _used = self.used.lock().unwrap_or_else(PoisonError::into_inner);
        self.freed.notify_all();
    }
}

impl EncodeBudget {
    /// A quarter of this machine's memory.
    pub(crate) fn for_this_machine() -> Self {
        Self::with_limit(physical_memory() / MEMORY_SHARE)
    }

    pub(crate) fn with_limit(limit: u64) -> Self {
        Self {
            limit,
            shared: Arc::default(),
        }
    }

    /// Takes the memory an encode of a still this many pixels needs, waiting while encodes in
    /// flight hold too much for it to fit; held until the returned reservation drops. Fails once
    /// the work is stopped.
    pub(crate) fn reserve(
        &self,
        pixels: Option<u64>,
        progress: &dyn Progress,
    ) -> Result<Reservation<'_>, Cancelled> {
        let bytes = pixels
            .unwrap_or(UNKNOWN_PIXELS)
            .saturating_mul(ENCODE_BYTES_PER_PIXEL);
        let _wakes_on_stop = progress.cancel_token().map(|token| {
            let shared = self.shared.clone();
            token.on_cancel(move || shared.wake())
        });
        let mut used = self
            .shared
            .used
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        while *used > 0 && used.saturating_add(bytes) > self.limit {
            progress.check()?;
            used = self
                .shared
                .freed
                .wait(used)
                .unwrap_or_else(PoisonError::into_inner);
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
pub(crate) struct Reservation<'a> {
    budget: &'a EncodeBudget,
    bytes: u64,
}

impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        let shared = &self.budget.shared;
        let mut used = shared.used.lock().unwrap_or_else(PoisonError::into_inner);
        *used = used.saturating_sub(self.bytes);
        shared.freed.notify_all();
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
    use std::sync::mpsc;
    use std::time::Duration;

    use super::*;
    use crate::passes::Quiet;

    #[test]
    fn encodes_wait_while_the_ones_in_flight_fill_the_budget() {
        let budget = EncodeBudget::with_limit(10 * ENCODE_BYTES_PER_PIXEL);
        let quiet = Quiet::new();
        let first = budget.reserve(Some(4), &quiet).unwrap();
        let second = budget.reserve(Some(4), &quiet).unwrap();
        let (started, third_started) = mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                let _third = budget.reserve(Some(4), &quiet).unwrap();
                started.send(()).unwrap();
            });
            // Two fit in 10, a third does not: it waits until one of them is done.
            assert!(
                third_started
                    .recv_timeout(Duration::from_millis(100))
                    .is_err()
            );
            drop(first);
            third_started.recv().unwrap();
        });
        drop(second);
        // One larger than the whole budget still runs, alone.
        drop(budget.reserve(Some(100), &quiet).unwrap());
    }

    #[test]
    fn a_stop_ends_the_wait() {
        let budget = EncodeBudget::with_limit(ENCODE_BYTES_PER_PIXEL);
        let quiet = Quiet::new();
        let _held = budget.reserve(Some(1), &quiet).unwrap();
        let stopping = quiet.token().clone();
        std::thread::scope(|scope| {
            scope.spawn(move || {
                std::thread::sleep(Duration::from_millis(20));
                stopping.cancel();
            });
            assert!(budget.reserve(Some(1), &quiet).is_err());
        });
    }
}
