//! Handing memory back to the system after heavy work.
//!
//! Tidy's analysis decodes thousands of stills through libvips, each into buffers of 10 to 40 MB
//! that libvips, libheif and aom take from `malloc` and free again. macOS's allocator (measured
//! on macOS 27) keeps the last 64 large blocks it freed, anything over 2 MiB whatever its size,
//! dirty for reuse, so after an analysis the process holds a gigabyte it no longer uses, counted
//! in its footprint, and `malloc_zone_pressure_relief` gives none of it back. A large allocation
//! that no kept block serves pushes the oldest one out and unmaps it, so [`release_free_memory`]
//! allocates and frees enough fresh blocks, never touched and so never resident, to push every
//! kept one out.

/// Gives memory the allocator keeps free back to the system, after work that allocated large
/// buffers and is done with them. Returns the bytes `malloc_zone_pressure_relief` reported; the
/// large blocks pushed out are not counted there, so read the footprint to see them go. It takes
/// a fifth of a millisecond.
pub fn release_free_memory() -> usize {
    platform::release_free_memory()
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::c_void;

    /// Blocks pushed through: twice the 64 the allocator keeps.
    const FLUSH_BLOCKS: usize = 128;

    /// Just over 2 MiB, the smallest size the allocator keeps as a large block, so no kept block
    /// is small enough to be handed out for one of these instead of being pushed out.
    const FLUSH_BLOCK_BYTES: usize = 2 * 1024 * 1024 + 16 * 1024;

    unsafe extern "C" {
        fn malloc_zone_pressure_relief(zone: *mut c_void, goal: usize) -> usize;
    }

    pub fn release_free_memory() -> usize {
        // SAFETY: NULL asks every zone; a goal of 0 asks for as much as each can give.
        let relieved = unsafe { malloc_zone_pressure_relief(std::ptr::null_mut(), 0) };
        let mut blocks = [std::ptr::null_mut::<c_void>(); FLUSH_BLOCKS];
        for block in &mut blocks {
            // SAFETY: plain allocation, never written to, freed below.
            *block = unsafe { libc::malloc(FLUSH_BLOCK_BYTES) };
        }
        for block in blocks {
            // SAFETY: each pointer came from malloc above (or is NULL, which free ignores).
            unsafe { libc::free(block) };
        }
        relieved
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    pub fn release_free_memory() -> usize {
        0
    }
}
