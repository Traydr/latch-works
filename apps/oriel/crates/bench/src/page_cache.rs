//! Dropping files from the page cache without `sudo purge`, so a run can read them cold.
//!
//! Mapping a file and calling `msync(MS_INVALIDATE)` over the mapping makes macOS discard the
//! file's clean cached pages, which is how `vmtouch -e` evicts there. `mincore` then counts what
//! is still resident. Directory and inode metadata stay cached; only `purge` drops those.

use std::fs::File;
use std::io;
use std::os::fd::AsRawFd;
use std::path::Path;
use std::ptr;

/// A read-only shared mapping of a whole file, unmapped on drop.
struct Mapping {
    address: *mut libc::c_void,
    length: usize,
}

impl Mapping {
    fn new(path: &Path) -> io::Result<Option<Self>> {
        let file = File::open(path)?;
        let length = usize::try_from(file.metadata()?.len()).unwrap_or(usize::MAX);

        if length == 0 {
            return Ok(None);
        }

        // SAFETY: a fresh read-only mapping of an open file; the kernel picks the address, and
        // the mapping outlives the descriptor, which `mmap` does not need kept open.
        let address = unsafe {
            libc::mmap(
                ptr::null_mut(),
                length,
                libc::PROT_READ,
                libc::MAP_SHARED,
                file.as_raw_fd(),
                0,
            )
        };

        if address == libc::MAP_FAILED {
            return Err(io::Error::last_os_error());
        }

        Ok(Some(Self { address, length }))
    }
}

impl Drop for Mapping {
    fn drop(&mut self) {
        // SAFETY: `address` and `length` are exactly what `mmap` returned and was given.
        unsafe {
            libc::munmap(self.address, self.length);
        }
    }
}

/// Asks the kernel to drop the file's cached pages.
pub fn evict(path: &Path) -> io::Result<()> {
    let Some(mapping) = Mapping::new(path)? else {
        return Ok(());
    };

    // SAFETY: the range is the live mapping made above.
    let result = unsafe { libc::msync(mapping.address, mapping.length, libc::MS_INVALIDATE) };

    if result != 0 {
        return Err(io::Error::last_os_error());
    }

    Ok(())
}

/// Resident and total pages of the file.
pub fn resident_pages(path: &Path) -> io::Result<(usize, usize)> {
    let Some(mapping) = Mapping::new(path)? else {
        return Ok((0, 0));
    };

    // SAFETY: `sysconf` has no preconditions.
    let page = usize::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) }).unwrap_or(16384);
    let pages = mapping.length.div_ceil(page);
    let mut residency = vec![0 as libc::c_char; pages];

    // SAFETY: `residency` has one byte for each page of the live mapping.
    let result = unsafe { libc::mincore(mapping.address, mapping.length, residency.as_mut_ptr()) };

    if result != 0 {
        return Err(io::Error::last_os_error());
    }

    let resident = residency.iter().filter(|&&state| state & 1 != 0).count();

    Ok((resident, pages))
}
